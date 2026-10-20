import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import registerSubagentExtension from "../../src/extension/index.ts";
import { currentCompletionOwnerId } from "../../src/shared/completion-owner.ts";
import { createParentWake, PARENT_WAKE_TEXT } from "../../src/shared/parent-wake.ts";
import { createNativeSupervisorChannel } from "../../src/intercom/native-supervisor-channel.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, type SubagentState } from "../../src/shared/types.ts";

function createHarness(sessionManager: { getSessionId(): string } = SessionManager.inMemory()) {
	const calls: unknown[][] = [];
	let idle = true;
	let time = 0;
	const wake = createParentWake({
		sendMessage: (...args: unknown[]) => { calls.push(["sendMessage", ...args]); },
		sendUserMessage: (...args: unknown[]) => { calls.push(["sendUserMessage", ...args]); },
	} as never, () => time);
	wake.bindSession({ isIdle: () => idle, sessionManager } as never);
	return {
		wake,
		calls,
		wakes: () => calls.filter(([method]) => method === "sendUserMessage").length,
		setIdle(value: boolean) { idle = value; },
		advance(ms: number) { time += ms; },
	};
}

const notice = (content: string) => ({ customType: "subagent-test", content, display: true });

it("appends a notice to an idle parent and wakes it once through a user prompt", () => {
	const { wake, calls } = createHarness();
	assert.equal(wake.sendMessage(notice("first"), { triggerTurn: true }), true);
	assert.equal(wake.sendMessage(notice("second"), { triggerTurn: true }), true);
	assert.deepEqual(calls, [
		["sendMessage", notice("first"), { triggerTurn: false }],
		["sendUserMessage", PARENT_WAKE_TEXT, { deliverAs: "steer" }],
		["sendMessage", notice("second"), { triggerTurn: false }],
	]);
});

it("steers a busy parent as before and passes non-waking messages through", () => {
	const { wake, calls, setIdle } = createHarness();
	assert.equal(wake.sendMessage(notice("context"), { triggerTurn: false }), false);
	assert.equal(wake.sendMessage(notice("plain")), false);
	setIdle(false);
	assert.equal(wake.sendMessage(notice("busy"), { triggerTurn: true }), false);
	assert.deepEqual(calls, [
		["sendMessage", notice("context"), { triggerTurn: false }],
		["sendMessage", notice("plain"), undefined],
		["sendMessage", notice("busy"), { triggerTurn: true }],
	]);
});

it("wakes again after the woken run starts or after a wake that never started expires", () => {
	const { wake, wakes, advance } = createHarness();
	wake.sendMessage(notice("first"), { triggerTurn: true });
	wake.agentStarted();
	wake.sendMessage(notice("after start"), { triggerTurn: true });
	advance(9_999);
	wake.sendMessage(notice("still pending"), { triggerTurn: true });
	advance(1);
	wake.sendMessage(notice("expired"), { triggerTurn: true });
	assert.equal(wakes(), 3);
});

it("keeps one pending wake per session manager and session across reload, and none for another session", () => {
	const manager = SessionManager.inMemory();
	const first = createHarness(manager);
	first.wake.sendMessage(notice("first"), { triggerTurn: true });
	first.wake.sessionShutdown("reload");
	const reloaded = createHarness(manager);
	assert.equal(reloaded.wake.isPending(), true, "reload keeps the wake that is still in preflight");
	reloaded.wake.sendMessage(notice("during preflight"), { triggerTurn: true });
	assert.equal(reloaded.wakes(), 0, "the reloaded extension must not send a second wake");
	const other = createHarness({ getSessionId: () => manager.getSessionId() });
	assert.equal(other.wake.isPending(), false, "another session manager does not inherit the wake");
	manager.newSession();
	const switched = createHarness(manager);
	assert.equal(switched.wake.isPending(), false, "a new session on the same manager does not inherit the wake");
	switched.wake.sendMessage(notice("new session"), { triggerTurn: true });
	assert.equal(switched.wakes(), 1);
	switched.wake.sessionShutdown("quit");
	assert.equal(createHarness(manager).wake.isPending(), false, "quit clears the wake");
});

it("holds a pending wake until its run starts, and abandons it only once an idle parent passes the deadline", () => {
	const { wake, setIdle, advance } = createHarness();
	wake.sendMessage(notice("first"), { triggerTurn: true });
	assert.equal(wake.isPending(), true);
	wake.agentStarted();
	assert.equal(wake.isPending(), false);
	wake.sendMessage(notice("second"), { triggerTurn: true });
	advance(10_000);
	setIdle(false);
	assert.equal(wake.isPending(), true, "a busy parent may still be in the wake's preflight");
	setIdle(true);
	assert.equal(wake.isPending(), false, "an idle parent past the deadline has abandoned the wake");
});

it("after a user abort, appends waking notices without a wake until the next run starts", () => {
	const { wake, calls, wakes, setIdle } = createHarness();
	wake.userAborted();
	assert.equal(wake.sendMessage(notice("idle"), { triggerTurn: true }), true);
	setIdle(false);
	assert.equal(wake.sendMessage(notice("still finishing"), { triggerTurn: true }), true);
	assert.equal(wake.sendMessage(notice("context"), { triggerTurn: false }), false);
	assert.deepEqual(calls, [
		["sendMessage", notice("idle"), { triggerTurn: false }],
		["sendMessage", notice("still finishing"), { triggerTurn: false }],
		["sendMessage", notice("context"), { triggerTurn: false }],
	]);
	assert.equal(wake.isPending(), false, "a held notice leaves no wake outstanding");
	setIdle(true);
	wake.agentStarted();
	wake.sendMessage(notice("after the next run"), { triggerTurn: true });
	assert.equal(wakes(), 1);
});

it("drops a user-abort hold when the session changes or a resume releases it", () => {
	const manager = SessionManager.inMemory();
	const { wake, wakes } = createHarness(manager);
	wake.userAborted();
	manager.newSession();
	wake.bindSession({ isIdle: () => true, sessionManager: manager } as never);
	wake.sendMessage(notice("new session"), { triggerTurn: true });
	assert.equal(wakes(), 1);
	wake.userAborted();
	wake.releaseHold();
	wake.sendMessage(notice("during the pending wake"), { triggerTurn: true });
	assert.equal(wakes(), 1, "releasing the hold keeps the pending wake reservation");
});

it("shares one idle wake per session with other extensions, such as pi-intercom", () => {
	const manager = SessionManager.inMemory();
	const reservations = (globalThis as Record<symbol, WeakMap<object, { sessionId: string; sentAt?: number }>>)[Symbol.for("pi.idle-wake.v1")];
	const { wake, wakes, advance } = createHarness(manager);
	reservations.set(manager, { sessionId: manager.getSessionId(), sentAt: 0 });
	wake.sendMessage(notice("during the other wake's preflight"), { triggerTurn: true });
	assert.equal(wakes(), 0, "a second wake prompt in that preflight throws in Pi");
	wake.agentStarted();
	advance(1);
	wake.sendMessage(notice("after start"), { triggerTurn: true });
	assert.equal(wakes(), 1);
	assert.equal(reservations.get(manager)?.sentAt, 1, "other extensions see this wake");
});

it("abandons a real SDK wake that an input handler consumes", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-wake-handled-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let time = 0;
	let wake: ReturnType<typeof createParentWake> | undefined;
	const inputs: string[] = [];
	let starts = 0;
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(api) => {
			wake = createParentWake(api, () => time);
			api.on("session_start", (_event, ctx) => wake!.bindSession(ctx));
			api.on("agent_start", () => { starts++; wake!.agentStarted(); });
			api.on("input", (event) => { inputs.push(event.text); return { action: "handled" }; });
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: SessionManager.inMemory(root), noTools: "builtin" }));
		await session.bindExtensions({});
		wake!.sendMessage({ customType: "subagent-test", content: "Needs the parent.", display: true }, { triggerTurn: true });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(inputs, [PARENT_WAKE_TEXT]);
		assert.equal(starts, 0);
		assert.equal(wake!.isPending(), true);
		time = 10_000;
		assert.equal(wake!.isPending(), false, "no run will start, so the wake must not hold the session forever");
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const emptyResponse of [false, true]) it(`starts an idle parent's completion run (${emptyResponse ? "empty response" : "tool response"}) through before_agent_start, so it keeps hook-set prompt sections`, { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-wake-sdk-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const sessionManager = SessionManager.inMemory(root);
	const sessionId = sessionManager.getSessionId();
	const faux = fauxProvider({ provider: "parent-wake", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	const requestPrompts: string[] = [];
	faux.setResponses([
		(context) => { requestPrompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage("Started the child."); },
		(context) => { requestPrompts.push(context.systemPrompt ?? ""); return emptyResponse ? fauxAssistantMessage("") : fauxAssistantMessage(fauxToolCall("probe_tool", {}), { stopReason: "toolUse" }); },
		(context) => { requestPrompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage("Handled the child result."); },
	]);
	const prompts: string[] = [];
	let emitCompletion = () => {};
	let settled = () => {};
	let runs = 0;
	const settledAgain = new Promise<void>((resolve) => { settled = resolve; });
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSubagentExtension, (api) => {
			api.registerProvider(faux.provider);
			emitCompletion = () => api.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: "idle-child", sessionId, completionOwnerId: currentCompletionOwnerId(), success: false, summary: "The child needs the parent.",
			});
			api.on("before_agent_start", (event) => {
				prompts.push(event.prompt);
				return { systemPrompt: `${event.systemPrompt}\n\nHook-set section.` };
			});
			api.on("agent_settled", () => { if (++runs === 2) settled(); });
			api.registerTool({ name: "probe_tool", label: "Probe", description: "Return a fixed result", parameters: Type.Object({}), async execute() {
				return { content: [{ type: "text", text: "probed" }], details: {} };
			} });
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" }));
		await session.bindExtensions({});
		await session.prompt("Start a child.");
		assert.equal(session.isIdle, true);
		emitCompletion();
		await settledAgain;
		assert.deepEqual(prompts, ["Start a child.", PARENT_WAKE_TEXT]);
		assert.equal(requestPrompts.length, 3);
		assert.ok(requestPrompts.slice(1).every(prompt => prompt.includes("Hook-set section.")), "every request in the woken run preserves its supported before_agent_start prompt override");
		assert.equal(session.getLastAssistantText(), "Handled the child result.");
	} finally {
		if (session) await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// Pi's compact() aborts a live run first, so a manual /compact mid-tool also ends the run with an aborted signal.
for (const stopWith of ["abort", "compact"] as const) it(`${stopWith === "abort" ? "does not restart" : "resumes"} a parent whose run was stopped mid-tool by ${stopWith}`, { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-wake-abort-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const sessionManager = SessionManager.inMemory(root);
	const sessionId = sessionManager.getSessionId();
	const faux = fauxProvider({ provider: "parent-wake-abort", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("slow_tool", {}), { stopReason: "toolUse" }),
		...Array.from({ length: 6 }, () => () => fauxAssistantMessage("Answered.")),
	]);
	const prompts: string[] = [];
	const notices: string[] = [];
	let emit = (_event: string, _data: unknown) => {};
	let stop = () => {};
	const settingsManager = SettingsManager.inMemory(stopWith === "compact" ? { compaction: { keepRecentTokens: 1 } } : {});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSubagentExtension, (api) => {
			api.registerProvider(faux.provider);
			emit = (event, data) => api.events.emit(event, data);
			api.on("before_agent_start", (event) => { prompts.push(event.prompt); });
			api.on("session_before_compact", (event) => ({
				compaction: { summary: "Compacted.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore },
			}));
			api.registerTool({ name: "slow_tool", label: "Slow", description: "Wait until aborted", parameters: Type.Object({}), execute(_id, _params, signal) {
				setImmediate(stop);
				return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "stopped" }], details: {} }), { once: true }));
			} });
		}],
	});
	const theme = new Proxy({}, { get: () => (...args: unknown[]) => String(args.at(-1) ?? "") });
	const ignore = () => undefined;
	const uiContext = {
		...Object.fromEntries(["select", "confirm", "input", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "custom", "pasteToEditor", "setEditorText", "getEditorText", "editor", "addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded"].map((name) => [name, ignore])),
		theme,
		notify: (text: string) => { notices.push(text); },
	};
	// A failed result skips the completion batch window, so it reaches the parent at once.
	const completion = (id: string) => ({ id, sessionId, completionOwnerId: currentCompletionOwnerId(), success: false, summary: `${id} needs the parent.` });
	const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" }));
		await session.bindExtensions({ uiContext: uiContext as never });
		stop = () => { void (stopWith === "abort" ? session!.abort() : session!.compact()); };
		emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "still-running", sessionId, asyncDir: path.join(root, "still-running"), agent: "worker", task: "Keep going." });
		await session.prompt("Start.");
		if (stopWith === "compact") {
			for (let waited = 0; waited < 2_000 && !prompts.includes(PARENT_WAKE_TEXT); waited += 50) await settle();
			assert.deepEqual(prompts, ["Start.", PARENT_WAKE_TEXT], "the compaction resume must wake the parent");
			return;
		}
		assert.equal(session.isIdle, true);
		assert.ok(notices.some((text) => text.startsWith("1 background subagent run is still active")), notices.join("\n"));

		emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completion("held-child"));
		await settle();
		assert.deepEqual(prompts, ["Start."], "a stopped parent must not be restarted by a background result");
		const notice = (id: string) => String(session!.messages.find((message) => message.role === "custom" && String(message.content).includes(`${id} needs the parent.`))?.content);
		assert.match(notice("held-child"), /Parent action: The user stopped the parent turn\./, "the held result is recorded for the next prompt without asking to resume");

		await session.prompt("Continue.");
		emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completion("later-child"));
		await settle();
		assert.deepEqual(prompts, ["Start.", "Continue.", PARENT_WAKE_TEXT], "a completed run does not hold wakes");
		assert.match(notice("later-child"), /Parent action: Read the saved results above and resume the already-authorized parent task/);
	} finally {
		if (session) await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const handled of [false, true]) it(`drains supervisor and completion reminders through real Pi 0.85.1 before settlement (${handled ? "model handles updates" : "silent budget exhausted"})`, { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settle-compose-"));
	const agentDir = path.join(root, "agent");
	const channelDir = path.join(root, "channel");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const manager = SessionManager.inMemory(root);
	const sessionId = manager.getSessionId();
	const requestFile = path.join(channelDir, "requests", "ask.json");
	fs.writeFileSync(requestFile, JSON.stringify({
		type: "subagent.supervisor.request", id: "ask", createdAt: Date.now(),
		reason: "need_decision", message: "May child proceed?", expectsReply: true,
		orchestratorSessionId: sessionId, runId: "child", agent: "worker", childIndex: 0,
	}));
	const faux = fauxProvider({ provider: "settle-compose", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	const consumedContexts: string[] = [];
	let replied = false;
	const response = (context: Context) => {
		const consumed = JSON.stringify(context.messages);
		consumedContexts.push(consumed);
		// The old host can drain follow-ups one at a time. Do not answer or report
		// until the model has actually received both independently queued reminders.
		if (handled && consumed.includes("Silent supervisor wake") && consumed.includes("Completion wake ended silently")) {
			if (!replied) {
				replied = true;
				return fauxAssistantMessage(fauxToolCall("subagent_supervisor", { action: "reply", replyTo: "ask", replyText: "Stay within the existing task scope." }), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage("Saved results inspected; parent task complete.");
		}
		return fauxAssistantMessage("");
	};
	faux.setResponses(Array.from({ length: 6 }, () => response));
	let disposeChannel = () => {};
	let disposeNotifier = () => {};
	let pending: ReadonlyMap<string, unknown> = new Map();
	let deliverCompletion = async () => false;
	let settled = 0;
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(api) => {
			api.registerProvider(faux.provider);
			api.on("agent_settled", () => { settled++; });
			const state = { currentSessionId: sessionId, supervisorOwnerSessionId: sessionId,
				completionOwnerId: "owner", asyncJobs: new Map(), foregroundControls: new Map() } as SubagentState;
			// Original notices append while idle; reminder delivery still uses the actual SDK queue.
			const parentWake = { sendMessage(message: Parameters<typeof api.sendMessage>[0], options?: Parameters<typeof api.sendMessage>[1]) {
				api.sendMessage(message, { ...options, triggerTurn: options?.deliverAs === "followUp" });
				return options?.deliverAs !== "followUp";
			} };
			const channel = createNativeSupervisorChannel(api, state, { parentWake, getChannelDirs: () => ({ dirs: [channelDir] }) });
			const notifier = registerSubagentNotify({ events: api.events, on: api.on, isHeld: () => false, ...parentWake }, state, { batchConfig: { enabled: false } });
			disposeChannel = channel.dispose;
			disposeNotifier = notifier.dispose;
			pending = channel.pending;
			deliverCompletion = () => notifier.deliver({ id: "completion", sessionId, completionOwnerId: "owner", success: true, summary: "Done" });
			api.on("session_start", () => { notifier.bindSession(manager); channel.start(); });
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: manager, noTools: "builtin" }));
		await session.bindExtensions({});
		assert.equal(await deliverCompletion(), true);
		await session.prompt("Inspect pending updates.");
		const allRemindersConsumedAt = consumedContexts.findIndex(context => context.includes("Silent supervisor wake") && context.includes("Completion wake ended silently"));
		assert.ok(allRemindersConsumedAt > 0, "subsequent real model requests consume both queued reminder messages");
		assert.equal(consumedContexts.length, allRemindersConsumedAt + (handled ? 2 : 1), "once both reminders are consumed, only the requested reply/report tool cycle may make another request; exhaustion itself never retries");
		assert.equal(settled, 1, "queued model consumption finishes before the single settled event");
		const customTypes = manager.getBranch().filter(entry => entry.type === "custom_message").map(entry => entry.customType);
		assert.equal(customTypes.filter(type => type === "subagent-supervisor-unanswered").length, 1);
		assert.equal(customTypes.filter(type => type === "subagent-completion-unanswered").length, 1);
		if (handled) {
			assert.equal(pending.size, 0);
			assert.equal(fs.existsSync(requestFile), false, "the real reply tool resolves its request");
			assert.equal(customTypes.includes("subagent-supervisor-blocked"), false);
			assert.equal(customTypes.includes("subagent-completion-unhandled"), false);
			assert.equal(session.getLastAssistantText(), "Saved results inspected; parent task complete.");
		} else {
			assert.equal(pending.size, 1);
			assert.equal(fs.existsSync(requestFile), true, "exhaustion never approves or deletes an unresolved ask");
			assert.equal(fs.existsSync(path.join(channelDir, "replies", "ask.json")), false);
			assert.ok(customTypes.includes("subagent-supervisor-blocked"), "blocked evidence persists in the real session branch");
			assert.ok(customTypes.includes("subagent-completion-unhandled"), "unhandled results persist without another model turn");
		}
	} finally {
		disposeChannel();
		disposeNotifier();
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("does no idle settle work without delegated work", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-demand-settle-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const manager = SessionManager.inMemory(root);
	const faux = fauxProvider({ provider: "demand-settle", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	let responses = 0;
	faux.setResponses(Array.from({ length: 2 }, () => () => {
		responses++;
		return fauxAssistantMessage("No delegated work.");
	}));
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSubagentExtension, (api) => {
			api.registerProvider(faux.provider);
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: manager, noTools: "builtin" }));
		await session.bindExtensions({});
		const before = manager.getBranch().length;
		await session.prompt("No new delegated work.");
		assert.equal(responses, 1, "no delegated work means no reminder continuation");
		assert.equal(manager.getBranch().filter(entry => entry.type === "custom_message").length, 0, "idle settlement adds no notification evidence");
		assert.ok(manager.getBranch().length > before, "the ordinary prompt still persists normally");
	} finally {
		if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
