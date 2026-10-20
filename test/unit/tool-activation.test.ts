import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerSubagentToolActivation } from "../../src/extension/tool-activation.ts";
import { registerBackgroundWorkProvider } from "../../src/api/background-work.ts";
import type { ToolActivationMode } from "../../src/shared/types.ts";

type Handler = (event: { type: string; systemPrompt: string }, ctx: ExtensionContext) => unknown | Promise<unknown>;
interface StateEntry { type: "custom"; customType: string; data: unknown }
interface RuntimeOptions { mode?: ToolActivationMode; excluded?: string[]; branch?: StateEntry[]; pending?: () => boolean }

function createRuntime(options: RuntimeOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const names = ["read", "subagent", "contact_supervisor", "subagent_supervisor", "bg_wait"];
	let active = [...names];
	let branch = options.branch ?? [];
	const excluded = options.excluded ?? [];
	const pi = {
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); names.push(tool.name); active.push(tool.name); },
		getAllTools: () => names.filter((name) => !excluded.includes(name)).map((name) => ({ name })),
		getActiveTools: () => active.filter((name) => !excluded.includes(name)),
		setActiveTools(next: string[]) { active = [...new Set(next.filter((name) => names.includes(name) && !excluded.includes(name)))]; },
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
	};
	const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
	registerSubagentToolActivation(pi as unknown as ExtensionAPI, { mode: options.mode, advertisedPrompt: () => "Current catalog", hasPendingSupervisorRequest: options.pending });
	return {
		tools, branch: () => branch, active: pi.getActiveTools,
		select: pi.setActiveTools,
		setBranch(next: StateEntry[]) { branch = next; },
		async emit(name: string) { for (const handler of handlers.get(name) ?? []) await handler({ type: name, systemPrompt: "Earlier extension prompt" }, ctx); },
		async enable() {
			const loader = tools.get("subagents_enable");
			assert.ok(loader);
			return loader.execute("enable", {}, new AbortController().signal, undefined, ctx);
		},
	};
}

function selection(selected: string[]): StateEntry[] {
	return [{ type: "custom", customType: "subagent-tool-activation", data: { version: 1, selected } }];
}

describe("Pi 0.85.1 activation", () => {
	it("defaults auto to eager without inventing newer model capabilities", async () => {
		const runtime = createRuntime();
		await runtime.emit("session_start");
		assert.deepEqual(runtime.active(), ["read", "subagent", "contact_supervisor", "subagent_supervisor", "bg_wait"]);
		assert.ok(runtime.branch().some((entry) => entry.customType === "subagent-tool-activation"));
	});

	it("starts dynamic cold, then activates real tools without launching work", async () => {
		const runtime = createRuntime({ mode: "dynamic" });
		await runtime.emit("session_start");
		assert.deepEqual(runtime.active(), ["read", "subagents_enable"]);
		const loader = runtime.tools.get("subagents_enable")!;
		assert.deepEqual(validateToolArguments(loader, { type: "toolCall", id: "enable", name: "subagents_enable", arguments: { action: "enable" } }), { action: "enable" });
		const result = await runtime.enable();
		assert.deepEqual(result.details, { enabled: ["subagent"] });
		assert.match(JSON.stringify(result.content), /Current catalog/);
		assert.deepEqual(runtime.active(), ["read", "subagents_enable", "subagent", "contact_supervisor", "subagent_supervisor", "bg_wait"]);
		const count = runtime.branch().length;
		await runtime.enable();
		assert.equal(runtime.branch().length, count, "idempotent activation does not write redundant state");
		assert.deepEqual(runtime.branch().at(-1)?.data, { version: 1, selected: ["subagents_enable", "subagent", "contact_supervisor", "subagent_supervisor", "bg_wait"] });
	});

	it("restores cold/warm selection on resume/reload and reads only the current branch", async () => {
		const coldBranch = selection(["subagents_enable"]);
		const runtime = createRuntime({ mode: "dynamic", branch: coldBranch });
		await runtime.emit("session_start");
		assert.deepEqual(runtime.active(), ["read", "subagents_enable"]);
		await runtime.enable();
		const warmBranch = structuredClone(runtime.branch());
		const resumed = createRuntime({ branch: warmBranch });
		await resumed.emit("session_start");
		assert.ok(resumed.active().includes("subagent"));
		resumed.setBranch(selection(["subagents_enable"]));
		await resumed.emit("session_tree");
		assert.deepEqual(resumed.active(), ["read", "subagents_enable"]);
		resumed.setBranch(warmBranch);
		await resumed.emit("session_tree");
		assert.ok(resumed.active().includes("subagent"));
	});

	it("uses configured initial selection for old history without activation metadata", async () => {
		const dynamic = createRuntime({ mode: "dynamic" });
		await dynamic.emit("session_start");
		assert.deepEqual(dynamic.active(), ["read", "subagents_enable"]);
		const eager = createRuntime({ mode: "eager", branch: selection(["subagents_enable"]) });
		await eager.emit("session_start");
		assert.equal(eager.tools.has("subagents_enable"), false);
		assert.ok(eager.active().includes("subagent"));
	});

	it("honors exclusions and keeps full tools eager when the loader is excluded", async () => {
		const restricted = createRuntime({ mode: "dynamic", excluded: ["subagents_enable", "subagent_supervisor"] });
		await restricted.emit("session_start");
		assert.ok(restricted.active().includes("subagent"));
		assert.equal(restricted.active().includes("subagent_supervisor"), false);
		const unavailable = createRuntime({ mode: "dynamic", excluded: ["subagent"] });
		await unavailable.emit("session_start");
		await assert.rejects(unavailable.enable(), /Cannot enable unavailable tools: subagent/);
		assert.equal(unavailable.active().includes("bg_wait"), false);
	});

	it("keeps pending supervisor replies and late provider waits available without enabling delegation", async () => {
		const runtime = createRuntime({ mode: "dynamic", pending: () => true });
		await runtime.emit("session_start");
		assert.ok(runtime.active().includes("subagent_supervisor"));
		assert.equal(runtime.active().includes("subagent"), false);
		const dispose = registerBackgroundWorkProvider({ name: "activation", listActiveWork: () => [] });
		try {
			await runtime.emit("before_agent_start");
			assert.ok(runtime.active().includes("bg_wait"));
			assert.equal(runtime.active().includes("subagent"), false);
		} finally { dispose(); }
	});

	it("does not activate from prompt text and restores the loader without mutating prompt options", async () => {
		const runtime = createRuntime({ mode: "dynamic" });
		await runtime.emit("session_start");
		runtime.select(["read"]);
		await runtime.emit("before_agent_start");
		assert.deepEqual(runtime.active(), ["read", "subagents_enable"]);
	});
});
