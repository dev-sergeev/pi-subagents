import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, FauxResponseFactory, Message } from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import type { BuildInProcessChildLaunchInput } from "../../src/runs/shared/child-launch.ts";
import { topLevelSupervisorTool } from "../../src/intercom/native-supervisor-channel.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import registerSubagentPromptRuntime, { applyForkSessionAffinity, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, modelBefore, stripParentOnlySubagentMessages } from "../../src/runs/shared/subagent-prompt-runtime.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";

const FORKED_AT = 1_000;
const user = (timestamp: number, content = "task"): Message => ({ role: "user", content, timestamp });
const subagentCalls = (messages: Message[]) => messages.flatMap((entry) => entry.role === "assistant" ? entry.content.flatMap((block) => block.type === "toolCall" && block.name === "subagent" ? [block.id] : []) : []);

describe("a forked child's session-affinity header", () => {
	const anthropic = (compat?: Record<string, unknown>, id = "claude") => ({ api: "anthropic-messages", provider: "gateway", id, ...(compat ? { compat } : {}) }) as never;
	const reply = (timestamp: number, model: string) => ({ role: "assistant", content: [], api: "anthropic-messages", provider: "gateway", model, timestamp }) as unknown as Message;
	const parentModel = modelBefore([reply(30, "claude"), user(FORKED_AT + 1), reply(FORKED_AT + 2, "other")], FORKED_AT);

	it("uses only the native Anthropic x-session-affinity header", () => {
		const headers: Record<string, string> = {};
		applyForkSessionAffinity(headers, anthropic({ sendSessionAffinityHeaders: true }), "parent-session", parentModel);
		assert.deepEqual(headers, { "x-session-affinity": "parent-session" });
	});

	it("adds nothing where Pi sends no session-affinity header", () => {
		const headers: Record<string, string> = {};
		applyForkSessionAffinity(headers, anthropic(), "parent-session", parentModel);
		applyForkSessionAffinity(headers, { api: "openai-responses", compat: { sendSessionAffinityHeaders: true } } as never, "parent-session", parentModel);
		applyForkSessionAffinity(headers, anthropic({ sendSessionAffinityHeaders: true }), undefined, parentModel);
		assert.deepEqual(headers, {});
	});

	it("keeps the child's header for a different model, provider or API, or unknown history", () => {
		const headers: Record<string, string> = { "x-session-affinity": "child-session" };
		const model = anthropic({ sendSessionAffinityHeaders: true });
		applyForkSessionAffinity(headers, anthropic({ sendSessionAffinityHeaders: true }, "other"), "parent-session", parentModel);
		applyForkSessionAffinity(headers, model, "parent-session", { ...parentModel!, provider: "other" });
		applyForkSessionAffinity(headers, model, "parent-session", { ...parentModel!, api: "other" });
		applyForkSessionAffinity(headers, model, "parent-session", undefined);
		assert.deepEqual(headers, { "x-session-affinity": "child-session" });
	});
});

describe("a native forked child session", () => {
	let root: string;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-tool-declarations-"));
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	});

	after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	type Request = { tools: NonNullable<Context["tools"]>; systemPrompt: string; messages: Message[]; results: Message[] };
	type Launch = Partial<BuildInProcessChildLaunchInput>;

	/** Capture the actual native Context delivered to an offline SDK provider. */
	async function run(options: { sessionFile: string; tools: string[]; replies: AssistantMessage[]; forkCacheKey?: string; launch?: Launch; hooks?: Array<(pi: ExtensionAPI) => void>; captured?: unknown[] }): Promise<Request[]> {
		const faux = fauxProvider({ provider: "probe", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		const requests: Request[] = [];
		faux.setResponses(options.replies.map((message): FauxResponseFactory => (context) => {
			requests.push({ tools: context.tools ?? [], systemPrompt: context.systemPrompt ?? "", messages: context.messages, results: context.messages.filter((entry) => entry.role === "toolResult") });
			return message;
		}));
		const { session, capture } = buildInProcessChildLaunch({
			host: "parent", cwd: root, childAgentName: "worker", childIndex: 0, sessionEnabled: true, sessionFile: options.sessionFile, waitToolEnabled: false,
			model: "probe/local", systemPrompt: "Role instructions.", systemPromptMode: "append", tools: options.tools,
			inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: true,
			...(options.forkCacheKey ? { forkCacheKey: options.forkCacheKey } : {}), ...options.launch,
		});
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => piCodingAgent });
		const hooks = [(pi: ExtensionAPI) => pi.registerProvider(faux.provider as never), ...options.hooks ?? []];
		const child = await factory.create({ ...session, hooks: [...session.hooks, ...hooks.map((hook, index) => ({ name: `probe-${index}`, factory: hook }))] });
		try {
			await child.prompt("Task");
			const structured = capture.structuredOutput();
			if (structured.called) options.captured?.push(structured.value);
		} finally {
			await child.dispose();
			await factory.dispose();
		}
		return requests;
	}

	async function forkOfParent(name: string, parent: { tools?: string[]; hooks?: Array<(pi: ExtensionAPI) => void> } = {}): Promise<string> {
		const parentFile = path.join(root, `${name}-parent.jsonl`);
		await run({ sessionFile: parentFile, tools: parent.tools ?? ["read", "bash", "ls"], replies: [fauxAssistantMessage("PARENT-ANSWER")], hooks: parent.hooks });
		const manager = piCodingAgent.SessionManager.open(parentFile, path.join(root, `${name}-forks`));
		// Explicit old timestamps keep the inherited boundary deterministic without a clock delay.
		manager.appendMessage({ role: "custom", customType: "subagent-notify", content: "PARENT-NOTICE", display: false, timestamp: 1 } as never);
		manager.appendMessage({ ...fauxAssistantMessage(fauxToolCall("subagent", { agent: "worker", task: "earlier" }, { id: "call_subagent_1" }), { stopReason: "toolUse" }), timestamp: 2 });
		manager.appendMessage({ role: "toolResult", toolCallId: "call_subagent_1", toolName: "subagent", content: [{ type: "text", text: "PARENT-SUBAGENT-RESULT" }], isError: false, timestamp: 3 });
		manager.appendMessage({ ...fauxAssistantMessage(fauxToolCall("subagent", { agent: "worker", task: "this fork" }, { id: "call_subagent_2" }), { stopReason: "toolUse" }), timestamp: 4 });
		return manager.createBranchedSession(manager.getLeafId()!)!;
	}

	const callBash = (marker: string) => [
		fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${JSON.stringify(marker)}` }, { id: "call_bash_1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];

	it("declares only its own tools and never executes a parent-only tool", async () => {
		const forkFile = await forkOfParent("scope");
		const marker = path.join(root, "forbidden-bash-ran");
		const requests = await run({ sessionFile: forkFile, tools: ["read"], replies: callBash(marker), forkCacheKey: "pi-fork:test" });
		assert.equal(requests.length, 2);
		for (const request of requests) {
			assert.ok(request.tools.some((tool) => tool.name === "read"));
			assert.equal(request.tools.some((tool) => tool.name === "bash" || tool.name === "ls" || tool.name === "subagent"), false);
			assert.ok(request.messages.every((entry) => ["user", "assistant", "toolResult"].includes(entry.role)));
		}
		const result = requests[1]!.results.find((entry) => entry.role === "toolResult" && entry.toolName === "bash");
		assert.ok(result?.role === "toolResult" && result.isError);
		assert.match(JSON.stringify(result.content), /Tool bash not found/);
		assert.equal(fs.existsSync(marker), false);
	});

	it("retains inherited conversation and parent tool history without synthesizing system messages", async () => {
		const forkFile = await forkOfParent("history");
		const requests = await run({ sessionFile: forkFile, tools: ["read"], replies: [fauxAssistantMessage("done")], forkCacheKey: "pi-fork:test" });
		for (const { messages } of requests) {
			assert.match(JSON.stringify(messages), /PARENT-ANSWER/);
			assert.match(JSON.stringify(messages), /PARENT-NOTICE/);
			assert.deepEqual(subagentCalls(messages), ["call_subagent_1", "call_subagent_2"]);
			assert.ok(messages.some((entry) => entry.role === "toolResult" && entry.toolName === "subagent"));
			assert.ok(messages.every((entry) => ["user", "assistant", "toolResult"].includes(entry.role)));
		}
	});

	for (const systemPromptMode of ["append", "replace"] as const) {
		it(`sends its own role and boundary as the native system prompt (${systemPromptMode})`, async () => {
			const forkFile = await forkOfParent(`prompt-${systemPromptMode}`);
			const [request] = await run({
				sessionFile: forkFile, tools: ["read"], replies: [fauxAssistantMessage("done")], forkCacheKey: "pi-fork:test",
				launch: { systemPrompt: "FORK-ROLE instructions.", systemPromptMode, inheritProjectContext: false },
			});
			assert.match(request!.systemPrompt, /FORK-ROLE instructions\./);
			assert.ok(request!.systemPrompt.endsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
			assert.doesNotMatch(JSON.stringify(request!.messages.at(-1)), /subagent_instructions|FORK-ROLE/);
		});
	}

	it("declares the structured-output schema the child's capture validates, not the parent's schema", async () => {
		const forkFile = await forkOfParent("structured", { tools: ["read", "structured_output"], hooks: [(pi) => pi.registerTool({
			name: "structured_output", label: "Parent result", description: "Parent-only schema.",
			parameters: { type: "object", properties: { parent: { type: "boolean" } }, required: ["parent"] } as never,
			execute: async () => ({ content: [{ type: "text", text: "parent" }], details: {} }),
		})] });
		const captured: unknown[] = [];
		const requests = await run({
			sessionFile: forkFile, tools: ["read", "structured_output"], forkCacheKey: "pi-fork:test",
			replies: [fauxAssistantMessage(fauxToolCall("structured_output", { value: { child: true } }), { stopReason: "toolUse" })],
			launch: { structuredOutput: createStructuredOutputRuntime({ type: "object", properties: { child: { type: "boolean" } }, required: ["child"] }, root) },
			captured,
		});
		assert.equal(requests.length, 1, "native structured capture terminates the single-tool turn");
		const declaration = requests[0]!.tools.find((tool) => tool.name === "structured_output");
		assert.match(JSON.stringify(declaration?.parameters), /"child"/);
		assert.doesNotMatch(JSON.stringify(declaration?.parameters), /"parent"/);
		assert.deepEqual(captured, [{ child: true }]);
	});

	const supervised = { runId: "run-s3", orchestratorIntercomTarget: "parent-target", parentSessionId: "parent-session" };
	const callSupervisor = [
		fauxAssistantMessage(fauxToolCall("contact_supervisor", { reason: "progress_update", message: "halfway" }, { id: "call_supervisor_1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];
	const supervisorResult = (request: Request) => request.results.find((entry) => entry.role === "toolResult" && entry.toolName === "contact_supervisor");

	it("keeps its own working contact_supervisor without declaring parent-only tools", async () => {
		const forkFile = await forkOfParent("supervised", { tools: ["read", "bash", "contact_supervisor"], hooks: [(pi) => pi.registerTool(topLevelSupervisorTool())] });
		const requests = await run({ sessionFile: forkFile, tools: ["read", "contact_supervisor"], replies: callSupervisor, forkCacheKey: "pi-fork:test", launch: supervised });
		for (const request of requests) {
			assert.ok(request.tools.some((tool) => tool.name === "contact_supervisor"));
			assert.equal(request.tools.some((tool) => tool.name === "bash"), false);
		}
		const result = supervisorResult(requests[1]!);
		assert.ok(result?.role === "toolResult");
		assert.notEqual(result.isError, true);
		assert.match(JSON.stringify(result.content), /Supervisor progress update queued\./);
	});

	it("keeps contact_supervisor when a background runner loads this package as an ambient extension", async () => {
		const extensions = path.join(process.env.PI_CODING_AGENT_DIR!, "extensions");
		fs.mkdirSync(path.join(extensions, "pi-subagents"), { recursive: true });
		const loaded = path.join(root, "ambient-loaded");
		fs.writeFileSync(path.join(extensions, "pi-subagents", "index.ts"), [
			`import * as fs from "node:fs";`,
			`import registerSubagentExtension from ${JSON.stringify(path.resolve(import.meta.dirname, "..", "..", "index.ts"))};`,
			`export default function (pi) { fs.writeFileSync(${JSON.stringify(loaded)}, "1"); return registerSubagentExtension(pi); }`,
		].join("\n"));
		const previous = process.env.PI_SUBAGENT_CHILD;
		process.env.PI_SUBAGENT_CHILD = "1";
		try {
			const requests = await run({ sessionFile: path.join(root, "runner-child.jsonl"), tools: ["read", "contact_supervisor"], replies: callSupervisor, launch: { ...supervised, host: "runner" } });
			assert.ok(fs.existsSync(loaded));
			assert.match(JSON.stringify(supervisorResult(requests[1]!)?.content), /Supervisor progress update queued\./);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = previous;
			fs.rmSync(extensions, { recursive: true, force: true });
		}
	});

	it("without fork affinity, filters parent-only history but keeps ordinary inherited conversation", async () => {
		const forkFile = await forkOfParent("plain");
		const requests = await run({ sessionFile: forkFile, tools: ["read"], replies: [fauxAssistantMessage("done")] });
		for (const { messages } of requests) {
			assert.match(JSON.stringify(messages), /PARENT-ANSWER/);
			assert.deepEqual(subagentCalls(messages), []);
			assert.equal(messages.some((entry) => entry.role === "toolResult" && entry.toolName === "subagent"), false);
			assert.doesNotMatch(JSON.stringify(messages), /PARENT-NOTICE/);
		}
	});
});

describe("a child's native context handler", () => {
	const contextHandler = (config: Partial<ChildRuntimeConfig>) => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
		registerSubagentPromptRuntime({ on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler), registerTool: () => {}, events: { on: () => () => {} } } as never,
			{ fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false, ...config });
		const ctx = { model: { api: "anthropic-messages" }, sessionManager: { getHeader: () => ({ id: "fork", timestamp: new Date(FORKED_AT).toISOString() }) } };
		return (messages: unknown[]) => (handlers.get("context")!({ messages }, ctx) as { messages: unknown[] } | undefined)?.messages ?? messages;
	};
	const notice = (timestamp: number) => ({ role: "custom", customType: "subagent-notify", content: "done", display: false, timestamp });
	const call = (timestamp: number) => ({ role: "assistant", content: [{ type: "toolCall", id: `call_${timestamp}`, name: "subagent", arguments: {} }], timestamp });
	const result = (timestamp: number) => ({ role: "toolResult", toolCallId: `call_${timestamp}`, toolName: "subagent", content: [], isError: false, timestamp });

	it("in a fork, strips only parent-only artifacts the child added", () => {
		const inherited = [user(10), notice(20), call(30), result(40), call(50)];
		const own = [user(FORKED_AT + 1), notice(FORKED_AT + 2), call(FORKED_AT + 3), result(FORKED_AT + 4)];
		assert.deepEqual(contextHandler({ forkCacheKey: "pi-fork:test" })([...inherited, ...own]), [...inherited, own[0]]);
	});

	it("outside a fork, strips parent-only messages and applies the child's fanout policy", () => {
		const messages = [user(10), notice(20), call(30), result(40)];
		assert.deepEqual(contextHandler({})(messages), stripParentOnlySubagentMessages(messages));
		assert.deepEqual(contextHandler({})(messages), [messages[0]]);
		assert.deepEqual(contextHandler({ fanoutChild: true })(messages), [messages[0], messages[2], messages[3]]);
	});

	it("derives affinity from real inherited branch messages, never a transcript projection", () => {
		const handlers = new Map<string, Function>();
		registerSubagentPromptRuntime({ on: (name: string, handler: Function) => handlers.set(name, handler), registerTool: () => {} } as never,
			{ fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false, forkCacheKey: "pi-fork:test", parentSessionId: "parent" });
		const headers = { "x-session-affinity": "child" };
		handlers.get("before_provider_headers")!({ headers }, {
			model: { api: "anthropic-messages", provider: "gateway", id: "claude", compat: { sendSessionAffinityHeaders: true } },
			sessionManager: {
				getHeader: () => ({ id: "fork", timestamp: new Date(FORKED_AT).toISOString() }),
				getBranch: () => [{ type: "message", message: { role: "assistant", provider: "gateway", api: "anthropic-messages", model: "claude", timestamp: 20 } }],
			},
		});
		assert.deepEqual(headers, { "x-session-affinity": "parent" });
		assert.equal(handlers.has("context_with_system"), false);
	});
});
