import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { closeSession, openRuntime, packageModule, rememberSecret, runtimeOptions, StringValue, writeEvidence } from "./runtime.mjs";

const EvidenceObject = Compile(Type.Object({}, { additionalProperties: true }));
const ChildResult = Compile(Type.Union([
	Type.Object({ agent: Type.String(), exitCode: Type.Number() }),
	Type.Object({ agent: Type.String(), success: Type.Boolean() }),
]));

const scenarioNames = ["single-agent", "workflow-file", "async", "supervisor", "structured-output", "watchdog"];
const help = `Usage: node examples/gigachat-compatibility/smoke.mjs
  --provider /absolute/path/to/installed/pi-gigachat/extension.js
  --model provider/GigaChat-3-Ultra --agent-dir /private/configured/profile
  --out /private/new/evidence-directory [--package-root /path/to/package]
  [--scenario single-agent,workflow-file,async,supervisor,structured-output,watchdog]

Executes paid, real-model inference with Pi SDK 0.85.1 and the installed provider.
Use Node 24 --experimental-strip-types for source packages; do not use test loaders.
The existing private profile must contain the saved provider connection, dynamic
subagent activation, and disabled retry/compaction settings. This runner never
writes to the profile, exchanges credentials, or modifies global settings.
Every case has a ten-minute wall-clock deadline, with abort/shutdown on failure
and up to thirty additional seconds to observe real async runner exit proof.
Safe controlled prompts, tool arguments/results, provider payload messages and
function names are recorded; authentication, headers and transport options are not.
An optional, recorded real user clarification is sent only if a case is incomplete.
`;
const { values } = parseArgs({ options: { ...runtimeOptions, out: { type: "string" }, scenario: { type: "string" }, help: { type: "boolean" } } });
if (values.help) { console.log(help); process.exit(0); }
if (!values.out) throw new Error("--out is required and must name a fresh directory.");
if (!values["agent-dir"]) throw new Error("--agent-dir must name an existing configured private profile.");
if (values.model?.slice(values.model.indexOf("/") + 1) !== "GigaChat-3-Ultra") throw new Error("This acceptance runner requires --model provider/GigaChat-3-Ultra.");
const selected = values.scenario ? values.scenario.split(",").map((name) => name.trim()) : scenarioNames;
if (!selected.length || selected.some((name) => !scenarioNames.includes(name)) || new Set(selected).size !== selected.length) throw new Error(`--scenario accepts unique comma-separated names: ${scenarioNames.join(",")}`);
const out = path.resolve(values.out);
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.mkdirSync(out, { mode: 0o700 });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-gigachat-live-")));
fs.chmodSync(root, 0o700);
const previousTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
let preserveRuntimeRoot = false;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runtime");
const summary = { format: 1, evidenceKind: "pi-gigachat-real-model-smoke", model: values.model, startedAt: new Date().toISOString(), selectedScenarios: selected, providerRetries: process.env.GIGACHAT_MAX_RETRIES ?? "provider-default", complete: false, passed: false, cases: [] };
const wallClockMs = 10 * 60 * 1000;
let host;
let restoreStream;
let current;

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const text = (message) => StringValue.Check(message?.content) ? message.content : (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
function walk(value, visit) {
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit);
		return;
	}
	if (!EvidenceObject.Check(value)) return;
	visit(value);
	for (const child of Object.values(value)) walk(child, visit);
}
function messagesForEvidence(messages) {
	return (messages ?? []).map((message) => {
		const picked = {};
		for (const key of ["role", "content", "name", "toolName", "toolCallId", "isError", "function_call", "tool_calls"]) if (message[key] !== undefined) picked[key] = clone(message[key]);
		return picked;
	});
}
// Deliberately whitelist payload fields: no headers/options/auth or opaque provider objects.
function payloadForEvidence(payload) {
	if (!EvidenceObject.Check(payload)) throw new Error("Provider onPayload did not supply an object.");
	return {
		model: payload.model,
		functionNames: (payload.functions ?? payload.tools ?? []).map((item) => item.name ?? item.function?.name).filter((name) => StringValue.Check(name)),
		functions: clone(payload.functions ?? []),
		messages: messagesForEvidence(payload.messages),
	};
}
function observation(context, model, kind) {
	const record = { sequence: current.requests.length + 1, kind, model: `${model.provider}/${model.id}`, functionNames: (context.tools ?? []).map((tool) => tool.name), messages: messagesForEvidence(context.messages), payloads: [], responseStatuses: [] };
	current.requests.push(record);
	return record;
}
function observeOptions(options, record) {
	return {
		...options,
		onPayload: async (payload, model) => {
			const replaced = await options?.onPayload?.(payload, model);
			record.payloads.push(payloadForEvidence(replaced === undefined ? payload : replaced));
			return replaced;
		},
		onResponse: async (response, model) => {
			record.responseStatuses.push(response.status);
			await options?.onResponse?.(response, model);
		},
	};
}
function captureResult(stream, record) {
	// result() observes the final value without consuming the stream iterator.
	stream.result().then((message) => { record.result = messagesForEvidence([message])[0]; record.stopReason = message.stopReason; }, () => { record.resultObservationFailed = true; });
	return stream;
}
function calls(state, name) { return state.events.filter((event) => event.type === "tool_execution_start" && event.toolName === name); }
function toolEnds(state, name) { return state.events.filter((event) => event.type === "tool_execution_end" && (!name || event.toolName === name)); }
function children(state) {
	const found = [];
	for (const result of [...toolEnds(state).map((event) => event.result), ...state.asyncResults.map((entry) => entry.result)]) walk(result, (node) => {
		if (!ChildResult.Check(node)) return;
		const transcript = StringValue.Check(node.sessionFile) ? state.childTranscripts.find((entry) => entry.file === path.resolve(state.cwd, node.sessionFile)) : undefined;
		if (Array.isArray(node.messages) || transcript || StringValue.Check(node.finalOutput) || StringValue.Check(node.output) || node.structuredOutput !== undefined) {
			const child = { ...node, finalOutput: node.finalOutput ?? node.output };
			if (transcript) child.messages = transcript.messages;
			found.push(child);
		}
	});
	return found;
}
function collectChildTranscripts(state, result) {
	walk(result, (node) => {
		if (!StringValue.Check(node.sessionFile)) return;
		const file = path.resolve(state.cwd, node.sessionFile);
		if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Child session escaped the owned temporary directory.");
		if (!fs.existsSync(file)) return;
		const messages = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "message" && entry.message).map((entry) => entry.message);
		const existing = state.childTranscripts.find((entry) => entry.file === file);
		if (existing) existing.messages = clone(messages);
		else state.childTranscripts.push({ file, messages: clone(messages) });
	});
}
function childToolCall(child, name, predicate = () => true) {
	return (child.messages ?? []).some((message) => message.role === "assistant" && Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall" && block.name === name && predicate(block.arguments)));
}
function finalAnswer(session) { return text(session.state.messages.findLast((message) => message.role === "assistant")); }
function requireFact(condition, message) { if (!condition) throw new Error(message); }
function nonceReturnedToModel(state) {
	return state.requests.some((request) => request.kind === "parent" && request.responseStatuses.some((status) => status >= 200 && status < 300) && request.result && !["error", "aborted"].includes(request.stopReason) && request.payloads.some((payload) => payload.messages.some((message) => ["function", "tool", "toolResult", "user"].includes(message.role) && JSON.stringify(message).includes(state.nonce))));
}
function delegateFacts(state, session) {
	const completed = children(state).filter((child) => (child.exitCode === 0 || child.success === true) && !child.detached && !child.stopped && !child.structuredOutputFailed);
	return {
		activation: calls(state, "subagents_enable").length > 0 && toolEnds(state, "subagents_enable").some((event) => !event.isError && !event.result?.isError),
		childRead: completed.some((child) => childToolCall(child, "read", (args) => path.resolve(state.cwd, args?.path ?? "") === state.fixture) && JSON.stringify(child).includes(state.nonce)),
		childCompleted: completed.some((child) => JSON.stringify(child).includes(state.nonce)),
		nonceInFinalParentAnswer: finalAnswer(session).includes(state.nonce),
		nonceInProviderDeliveredResult: nonceReturnedToModel(state),
	};
}
function validateDelegate(state, session) {
	const facts = delegateFacts(state, session);
	const launches = calls(state, "subagent").filter((event) => !event.args?.action && (event.args?.agent || event.args?.workflow) && toolEnds(state, "subagent").some((end) => end.toolCallId === event.toolCallId && !end.isError && !end.result?.isError));
	facts.publicStringOutputAndFreshOptions = launches.length > 0 && launches.every(({ args }) => (args.output === undefined || args.output === "false") && args.options?.acceptance === false && args.options?.mission === false && args.options?.context === "fresh");
	if (state.name === "single-agent" || state.name === "structured-output") facts.foregroundSingleLaunch = launches.some(({ args }) => args.agent === (state.name === "structured-output" ? "live-structured" : "live-worker") && args.async === false && args.workflow === undefined);
	if (state.name === "structured-output") facts.configuredStructuredProfile = launches.some(({ args }) => args.agent === "live-structured" && args.options?.outputSchema === undefined);
	if (state.name === "workflow-file") facts.fileWorkflow = calls(state, "subagent").some((event) => event.args?.workflow === "./workflow.js" && event.args.async === false) && toolEnds(state, "subagent").some((event) => event.result?.details?.mode === "workflow" && !event.isError && !event.result?.isError);
	if (state.name === "async" || state.name === "supervisor") {
		facts.actualAsyncRunId = state.runIds.size > 0 && calls(state, "subagent").some((event) => event.args?.async === true && event.args?.agent === (state.name === "supervisor" ? "live-decision" : "live-worker"));
		facts.awaitedActualRunId = calls(state, "bg_wait").some((event) => state.runIds.has(event.args?.id));
		facts.actualAsyncResult = state.asyncResults.some((entry) => entry.result.success === true && (JSON.stringify(entry.result).includes(state.nonce) || (entry.result.results ?? []).some((child) => state.childTranscripts.some((transcript) => transcript.file === child.sessionFile && JSON.stringify(transcript.messages).includes(state.nonce)))));
	}
	if (state.name === "supervisor") {
		const pendingIds = new Set();
		for (const event of toolEnds(state, "subagent_supervisor")) for (const request of event.result?.details?.pending ?? []) if (request.reason === "need_decision" && state.runIds.has(request.runId)) pendingIds.add(request.id);
		// A native notice can already supply the ID, so a redundant pending query
		// is not required. Match the real child receipt as independent proof.
		for (const child of children(state)) {
			if (!childToolCall(child, "contact_supervisor", (args) => args?.reason === "need_decision")) continue;
			for (const message of child.messages ?? []) if (message.role === "toolResult" && message.toolName === "contact_supervisor" && message.details?.reason === "need_decision" && StringValue.Check(message.details.requestId)) pendingIds.add(message.details.requestId);
		}
		facts.pendingActualDecision = pendingIds.size > 0;
		facts.repliedActualDecision = calls(state, "subagent_supervisor").some((event) => event.args?.action === "reply" && pendingIds.has(event.args.replyTo) && event.args.replyText === "Use VERIFIED" && toolEnds(state, "subagent_supervisor").some((end) => end.toolCallId === event.toolCallId && !end.isError && end.result?.details?.replyTo === event.args.replyTo));
		facts.childSupervisorTool = children(state).some((child) => childToolCall(child, "contact_supervisor", (args) => args?.reason === "need_decision") && (child.messages ?? []).some((message) => message.role === "toolResult" && message.toolName === "contact_supervisor" && text(message).includes("Use VERIFIED")) && (child.finalOutput ?? text((child.messages ?? []).findLast((message) => message.role === "assistant"))).includes("VERIFIED"));
		facts.verifiedFinalAnswer = finalAnswer(session).includes("VERIFIED");
	}
	if (state.name === "structured-output") facts.validatedChildStructuredCapture = children(state).some((child) => child.exitCode === 0 && !child.structuredOutputFailed && child.structuredOutput?.nonce === state.nonce && Object.keys(child.structuredOutput).length === 1 && childToolCall(child, "structured_output", (args) => args?.value?.nonce === state.nonce));
	state.facts = facts;
	return Object.values(facts).every(Boolean);
}

try {
	host = await openRuntime(values);
	rememberSecret(host.auth?.apiKey);
	const { sdk, runtime, model, packageRoot, agentDir } = host;
	const load = (relative) => import(packageModule(packageRoot, relative));
	const register = (await load("index")).default;
	const provider = (await import(pathToFileURL(host.providerEntry).href)).default;
	const { createMainWatchdogReview } = await load("src/watchdog/review");
	const { DEFAULT_WATCHDOG_CONFIG } = await load("src/watchdog/settings");
	const { streamRegistryModel } = await load("src/shared/registry-stream");
	const { DIRS } = await load("src/shared/types");
	const { resultPayloadPathForSessionRun } = await load("src/runs/background/result-files");
	const { readCompletionReplay, completionReplayPath } = await load("src/runs/background/completion-replay");
	const { deliverAsyncRunStop } = await load("src/runs/foreground/async-stop-action");
	const { readStatus } = await load("src/shared/utils");
	const { readProcessTerminal } = await load("src/runs/background/process-terminal");
	function stopFailedAsyncJobs(state, sessionId) {
		if (state.passed) return;
		for (const job of state.asyncJobs) {
			requireFact(path.resolve(job.asyncDir).startsWith(`${root}${path.sep}`), "Async cleanup refused a directory outside the owned temporary root.");
			const status = readStatus(job.asyncDir);
			requireFact(status?.runId === job.id && status.sessionId === sessionId, "Async cleanup could not establish exact run/session ownership.");
			if (!["queued", "running", "paused"].includes(status.state)) continue;
			const error = deliverAsyncRunStop({ asyncDir: job.asyncDir, status, resultsDir: DIRS.results, source: "gigachat-live-smoke-teardown" });
			if (error) throw new Error(`Production async cleanup refused stop: ${error}`);
			job.cleanupStopRequested = true;
		}
	}
	async function awaitAsyncExit(state) {
		const cleanupDeadline = Date.now() + 30_000;
		for (const job of state.asyncJobs) {
			while (Date.now() < cleanupDeadline) {
				const proof = readProcessTerminal(job.asyncDir, { runId: job.id });
				if (proof?.state === "observed" || proof?.state === "not-started") { job.processTerminal = proof; break; }
				if (proof?.state === "unknown") throw new Error(`Async runner exit is unverified: ${proof.reason}`);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			requireFact(job.processTerminal, "Async runner did not publish terminal process proof within the thirty-second cleanup deadline.");
		}
	}
	const originalStream = runtime.streamSimple;
	runtime.streamSimple = function (requestModel, context, options) {
		if (!current) return originalStream.call(this, requestModel, context, options);
		const record = observation(context, requestModel, "parent");
		// No fetch replacement: the installed provider keeps its original transport/dispatcher.
		return captureResult(originalStream.call(this, requestModel, context, observeOptions(options, record)), record);
	};
	restoreStream = () => { runtime.streamSimple = originalStream; };

	for (const name of selected) {
		const state = { name, parentThinkingLevel: "off", startedAt: new Date().toISOString(), cwd: path.join(root, name, "project"), nonce: `LIVE_${randomUUID().replaceAll("-", "")}`, events: [], requests: [], prompts: [], asyncResults: [], asyncJobs: [], childTranscripts: [], runIds: new Set(), references: new Set(), warnings: [], passed: false };
		current = state;
		fs.mkdirSync(path.join(state.cwd, ".pi", "agents"), { recursive: true, mode: 0o700 });
		state.fixture = path.join(state.cwd, "fixture.txt");
		writeEvidence(state.fixture, name === "watchdog" ? `Fixture constraint: deployment target MUST be staging; production is forbidden.\nActual deployment target: production\nnonce: ${state.nonce}\n` : `nonce: ${state.nonce}\n`);
		writeEvidence(path.join(state.cwd, ".pi", "settings.json"), { retry: { enabled: false }, compaction: { enabled: false } });
		const structuredSchema = { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"], additionalProperties: false };
		for (const agent of ["live-worker", "live-decision", "live-structured"]) {
			const profile = ["---", `name: ${agent}`, "description: Read-only actual-model compatibility worker", `model: ${values.model}`, "thinking: off", `tools: ${agent === "live-decision" ? "read, contact_supervisor" : "read"}`, `extensions: ${JSON.stringify(host.providerEntry)}`, "inheritGlobalContext: false", "inheritProjectContext: false", "inheritSkills: false", "acceptanceRole: read-only"];
			if (agent === "live-structured") profile.push(`outputSchema: ${JSON.stringify(structuredSchema)}`);
			profile.push("---", "Read ./fixture.txt with the real read tool. Never edit files. Return the exact nonce from that file, never invent it.", agent === "live-decision" ? "After reading the fixture, call contact_supervisor with reason need_decision and ask which verification marker to append. Wait for its real reply, then report the nonce and the marker from that reply." : "If structured_output is available and requested, call that actual tool with {value:{nonce:<exact fixture nonce>}}; prose JSON is not a substitute.");
			writeEvidence(path.join(state.cwd, ".pi", "agents", `${agent}.md`), profile.join("\n"));
		}
		const task = "Read ./fixture.txt using the read tool and return its exact nonce. Do not modify files.";
		const sessionDir = path.join(root, name, "sessions");
		const workflowSource = `const worker = await runs.run("worker", ${JSON.stringify({ agent: "live-worker", task, context: "fresh", async: false, output: "false", acceptance: false, mission: false, sessionDir, timeoutMs: wallClockMs - 30000 })});\nreturn worker;\n`;
		writeEvidence(path.join(state.cwd, "workflow.js"), workflowSource);
		if (name === "workflow-file") state.workflowFile = { path: path.join(state.cwd, "workflow.js"), source: workflowSource };
		let session;
		let timer;
		let unsubscribe;
		const controller = new AbortController();
		let timedOut = false;
		const deadline = Date.now() + wallClockMs;
		try {
			timer = setTimeout(() => { timedOut = true; controller.abort(); void session?.abort().catch(() => {}); }, Math.max(1, deadline - Date.now()));
			const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
			const guard = { name: "live-smoke-read-boundary", factory(pi) {
				pi.on("tool_call", (event) => {
					if (event.toolName !== "read") return;
					const target = path.resolve(state.cwd, event.input?.path ?? "");
					if (target === state.fixture || !state.references.has(target)) return { block: true, reason: "Parent may read only actual result references returned by tools, never fixture.txt. Delegate fixture inspection to the assigned child." };
				});
			} };
			const loader = new sdk.DefaultResourceLoader({ cwd: state.cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [provider, register, guard] });
			await loader.reload();
			requireFact(loader.getExtensions().errors.length === 0, "Real package/provider extension registration failed.");
			// The SDK allowlist is an authority ceiling, not just the initial active selection.
			({ session } = await sdk.createAgentSession({ cwd: state.cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime, model, thinkingLevel: state.parentThinkingLevel, tools: ["read", "subagents_enable", "subagent", "bg_wait", "subagent_supervisor", "contact_supervisor"], sessionManager: sdk.SessionManager.inMemory(state.cwd) }));
			const extensionErrors = [];
			await session.bindExtensions({ mode: "print", onError: (error) => { extensionErrors.push({ extensionPath: error.extensionPath, event: error.event }); } });
			requireFact(extensionErrors.length === 0, "Real package/provider extension startup failed.");
			requireFact(session.getActiveToolNames().includes("subagents_enable") && !session.getActiveToolNames().includes("subagent"), "Private profile must use dynamic tool activation (cold session exposes read + subagents_enable).");
			session.setActiveToolsByName(["read", "subagents_enable"]);
			unsubscribe = session.subscribe((event) => {
				if (!["tool_execution_start", "tool_execution_end", "agent_settled"].includes(event.type)) return;
				state.events.push(clone(event));
				if (event.type !== "tool_execution_end") return;
				collectChildTranscripts(state, event.result);
				if (state.name === "supervisor" && event.toolName === "subagent_supervisor" && text(event.result).includes("replyText is required for supervisor replies.")) {
					const failedCall = calls(state, "subagent_supervisor").findLast((call) => call.toolCallId === event.toolCallId);
					if (!StringValue.Check(failedCall?.args?.replyTo)) throw new Error("Invalid reply did not retain a real request target.");
					if (state.supervisorClarification) controller.abort(new Error("Model omitted replyText after the explicit supervisor clarification."));
					else state.supervisorClarification = { replyTo: failedCall.args.replyTo, failedToolCallId: event.toolCallId };
					void session.abort().catch(() => controller.abort(new Error("Parent interruption for supervisor clarification failed.")));
				}
				if (event.toolName === "subagent" && event.result?.details?.asyncId && !event.isError && !event.result.isError) {
					const { asyncId: id, asyncDir } = event.result.details;
					state.runIds.add(id);
					if (StringValue.Check(asyncDir) && !state.asyncJobs.some((job) => job.id === id)) state.asyncJobs.push({ id, asyncDir });
				}
				const body = JSON.stringify(event.result);
				for (const match of body.matchAll(/\/(?:[^\s"\\<>]|\\\/)+/g)) {
					const target = match[0].replace(/[),.;]+$/, "");
					if (target.startsWith(`${root}${path.sep}`) && fs.existsSync(target) && fs.statSync(target).isFile() && target !== state.fixture) state.references.add(path.resolve(target));
				}
				walk(event.result, (node) => {
					for (const key of ["path", "outputPath", "savedOutputPath", "resultPath", "transcriptPath", "sessionFile", "sessionPath", "structuredOutputPath"]) if (StringValue.Check(node[key])) {
						const target = path.resolve(state.cwd, node[key]);
						if (target.startsWith(`${root}${path.sep}`) && target !== state.fixture && fs.existsSync(target) && fs.statSync(target).isFile()) state.references.add(target);
					}
				});
			});
			async function prompt(message, clarification = false) {
				controller.signal.throwIfAborted();
				state.prompts.push({ role: "user", clarification, content: message });
				await session.prompt(message);
				await session.waitForIdle();
				controller.signal.throwIfAborted();
			}
			function collectAsyncResults() {
				for (const id of state.runIds) {
					if (state.asyncResults.some((entry) => entry.id === id)) continue;
					const sessionId = session.sessionManager.getSessionId();
					const payloadFile = resultPayloadPathForSessionRun(DIRS.results, sessionId, id);
					const replay = readCompletionReplay(DIRS.results, id, { sessionId });
					if (!payloadFile && !replay) continue;
					const file = payloadFile ?? completionReplayPath(DIRS.results, id);
					const result = payloadFile ? JSON.parse(fs.readFileSync(payloadFile, "utf8")) : replay.completion;
					const published = { id, file, evidenceKind: payloadFile ? "real-published-result" : "real-durable-completion-replay", result };
					if (replay) published.replay = replay;
					state.asyncResults.push(published);
					collectChildTranscripts(state, result);
				}
			}
			async function settleAsync() {
				// A parent's idle state alone is not child completion. Observe actual durable
				// publication first, then allow native queued completion turns to settle.
				while (state.runIds.size && state.asyncResults.length < state.runIds.size) {
					controller.signal.throwIfAborted();
					collectAsyncResults();
					if (state.asyncResults.length === state.runIds.size) break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				await session.waitForIdle();
				// Result watcher notifications are scheduled after atomic publication.
				await new Promise((resolve) => setTimeout(resolve, 500));
				await session.waitForIdle();
				collectAsyncResults();
				controller.signal.throwIfAborted();
			}

			if (name === "watchdog") {
				const ctx = session.extensionRunner.createContext();
				const observationStreamFn = (selectedModel, context, options) => {
					const record = observation(context, selectedModel, "watchdog");
					// Exact production default routing, with unchanged model/context/options.
					return captureResult(streamRegistryModel(ctx.modelRegistry, selectedModel, context, observeOptions(options, record)), record);
				};
				const review = createMainWatchdogReview(ctx, { streamFn: observationStreamFn, getThinkingLevel: () => "off" });
				const config = { ...structuredClone(DEFAULT_WATCHDOG_CONFIG), enabled: true, guidance: { watchdogMd: false }, main: { enabled: true, thinking: false } };
				state.review = await review({ delta: "User constraint: deployment target MUST be staging; production is forbidden. The parent accepted deployment state in ./fixture.txt as safe and complete without checking that constraint. Read ./fixture.txt to verify its actual state. Report the concrete constraint violation using watchdog_warn; do not edit files or execute commands.", epoch: 1, hasScope: false, reviewId: 1, config, allowClarification: false, signal: controller.signal, emitWarning(warning) { state.warnings.push(clone(warning)); return true; } });
				state.facts = {
					readActualFixture: state.requests.some((request) => request.result?.content?.some((block) => block.type === "toolCall" && block.name === "read" && path.resolve(state.cwd, block.arguments?.path ?? "") === state.fixture)),
					realWarnToolCall: state.requests.some((request) => request.result?.content?.some((block) => block.type === "toolCall" && block.name === "watchdog_warn")),
					recordedWarning: state.warnings.length > 0 && state.warnings.some((warning) => /production|staging/i.test(JSON.stringify(warning))),
					laterRealRequestWithWarningResult: state.requests.some((request) => request.result && !["error", "aborted"].includes(request.stopReason) && request.responseStatuses.some((status) => status >= 200 && status < 300) && request.payloads.some((payload) => payload.messages.some((message) => ["function", "tool", "toolResult"].includes(message.role) && JSON.stringify(message).includes("Watchdog warning recorded.")))),
					cleanReviewCompletion: state.review.stopReason === "stop",
				};
				state.passed = Object.values(state.facts).every(Boolean);
			} else {
				const common = `This is an actual-model read-only delegation acceptance case. First call subagents_enable to activate the real package tools. Never read fixture.txt yourself: only the assigned child may inspect it. Do not invent a nonce, run ID, child result, tool call, or supervisor request. Use only returned real IDs/references. You may read an actual child result file reference returned by a tool if its content is not inline. Do not create or change files. Finish with the exact nonce obtained from the child's actual result, not just a launch acknowledgment. Every public subagent launch must use output as string "false" and options ${JSON.stringify({ acceptance: false, mission: false, context: "fresh", timeoutMs: wallClockMs - 30000, chatProgress: "off", sessionDir })}; these controls belong in options, not extra top-level fields. Do not pass boolean workflow or output values. `;
				let instruction;
				if (name === "single-agent") instruction = `Call subagent with agent live-worker, task ${JSON.stringify(task)}, async:false. Obtain its real result and report the nonce.`;
				if (name === "workflow-file") instruction = "An actual ./workflow.js file already exists. It uses await runs.run('worker', ...) for a live-worker reading ./fixture.txt. Call the real subagent tool with workflow:\"./workflow.js\", async:false, output:\"false\" and the required options. Do not pass agent/task alongside workflow and do not replace the file workflow with inline code or a direct child. Report the actual workflow child's nonce.";
				if (name === "async") instruction = `Launch live-worker with task ${JSON.stringify(task)} and async:true. From its actual returned run ID, call bg_wait({id:<actual run id>,timeoutMs:570000,stopOnAttention:false}). This bg_wait call is required even if completion arrives as a notification. Read the actual result reference if needed and report the child's nonce.`;
				if (name === "supervisor") instruction = 'Launch agent live-decision with async:true; its task is to read ./fixture.txt, call contact_supervisor with reason need_decision and message "Which verification marker should I append?", wait for the actual reply, and report its nonce plus the chosen marker. After launch call bg_wait with the actual run ID, timeoutMs:570000 and stopOnAttention:true, so it returns when the real child needs a decision. Obtain the exact pending request ID from the native notice or subagent_supervisor({"action":"pending"}). You are authorized to answer exactly "Use VERIFIED". Call subagent_supervisor with all THREE fields {"action":"reply","replyTo":"<actual pending request ID>","replyText":"Use VERIFIED"}. Replace only the ID placeholder; do not omit replyText. Do not guess an ID or steer a substitute answer. After the successful reply, call bg_wait again with the actual launched run ID and timeoutMs:570000, stopOnAttention:false. Obtain the actual finished child result and give its nonce plus VERIFIED in your final answer.';
				if (name === "structured-output") instruction = `Launch agent live-structured with async:false and task ${JSON.stringify(`${task} Call the actual structured_output tool with {value:{nonce:<exact fixture nonce>}}; JSON prose is not sufficient.`)}. This agent already has a strict nonce-only outputSchema in its profile; do not override options.outputSchema. Keep acceptance:false and mission:false. Obtain the actual child structured_output capture, then report the validated nonce.`;
				await prompt(common + instruction);
				if (state.supervisorClarification) {
					await prompt(`The last reply was rejected because you omitted replyText. Answer the SAME actual pending request; do not relaunch or stop the child. Call subagent_supervisor with exactly ${JSON.stringify({ action: "reply", replyTo: state.supervisorClarification.replyTo, replyText: "Use VERIFIED" })}. The marker belongs only in the final answer, not in a file. After the reply, use bg_wait with the existing run ID and obtain the actual finished nonce plus VERIFIED.`, true);
				}
				if (state.runIds.size) await settleAsync();
				if (!validateDelegate(state, session)) {
					await prompt(`The actual scenario is not complete. Missing acceptance observations: ${Object.entries(state.facts).filter(([, passed]) => !passed).map(([fact]) => fact).join(", ")}. Continue the existing real tools/results only. Do not invent evidence or launch a duplicate if the intended child already exists. ${instruction}`, true);
					if (state.runIds.size) await settleAsync();
				}
				state.passed = validateDelegate(state, session);
			}
			requireFact(state.passed, `Acceptance failed: ${Object.entries(state.facts).filter(([, passed]) => !passed).map(([fact]) => fact).join(", ")}`);
		} catch (error) {
			state.passed = false;
			state.failure = timedOut ? "Scenario exceeded its ten-minute wall-clock deadline and was aborted." : error instanceof Error ? error.message : "Scenario failed.";
		} finally {
			clearTimeout(timer);
			if (!state.passed) controller.abort();
			try {
				if (session && !state.passed) await session.abort();
				stopFailedAsyncJobs(state, session?.sessionManager.getSessionId());
				if (session) {
					await session.waitForIdle();
					state.parentMessages = messagesForEvidence(session.state.messages);
					state.finalParentAnswer = finalAnswer(session);
				}
			} catch (error) { state.passed = false; state.cleanupFailure = error instanceof Error ? error.message : "Real session abort failed."; }
			finally {
				try { await closeSession(session); }
				catch { state.passed = false; state.cleanupFailure = "Real session shutdown failed."; }
			}
			try { await awaitAsyncExit(state); }
			catch (error) {
				state.passed = false;
				state.cleanupFailure = error instanceof Error ? error.message : "Real async runner cleanup failed.";
				try {
					stopFailedAsyncJobs(state, session?.sessionManager.getSessionId());
					await awaitAsyncExit(state);
				} catch {
					preserveRuntimeRoot = true;
					state.runtimeRootRetained = root;
				}
			}
			unsubscribe?.();
			state.completedAt = new Date().toISOString();
			state.runIds = [...state.runIds];
			state.references = [...state.references];
			writeEvidence(path.join(out, `${name}.json`), state);
			const caseResult = { name, passed: state.passed, evidence: `${name}.json`, facts: state.facts };
			if (state.failure) caseResult.failure = state.failure;
			if (state.cleanupFailure) caseResult.cleanupFailure = state.cleanupFailure;
			summary.cases.push(caseResult);
			console.log(`${state.passed ? "PASS" : "FAIL"} ${name}${state.failure ? `: ${state.failure}` : ""}`);
			current = undefined;
		}
	}
	summary.complete = summary.cases.length === selected.length;
	summary.passed = summary.complete && summary.cases.every((entry) => entry.passed);
} catch (error) {
	summary.failure = error instanceof Error ? error.message : "Smoke runtime prerequisite failed.";
	for (const name of selected) if (!summary.cases.some((entry) => entry.name === name)) summary.cases.push({ name, passed: false, notRun: true, failure: "Runtime prerequisite or evidence persistence failed; no scenario success claimed." });
	console.error(summary.failure);
} finally {
	restoreStream?.();
	try { await host?.dispose(); }
	catch { summary.passed = false; summary.cleanupFailure = "Provider bootstrap session disposal failed."; }
	finally {
		if (previousTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previousTempRoot;
		if (preserveRuntimeRoot) summary.runtimeRootRetained = root;
		else fs.rmSync(root, { recursive: true, force: true });
	}
	summary.completedAt = new Date().toISOString();
	writeEvidence(path.join(out, "summary.json"), summary);
	if (!summary.passed) process.exitCode = 1;
}
