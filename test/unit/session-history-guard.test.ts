import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { assertSupportedSessionHistory, registerSessionHistoryGuard } from "../../src/extension/session-history-guard.ts";

it("rejects foreign declaration history without inferring schemas from ordinary old-host calls", () => {
	assert.doesNotThrow(() => assertSupportedSessionHistory([
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "subagent", arguments: { workflow: true } }] } },
		{ type: "custom", customType: "subagent-tool-activation", data: { version: 1, selected: ["subagent"] } },
	]));
	for (const message of [{ role: "system", content: "foreign" }, { role: "assistant", toolsAdded: [] }, { role: "assistant", sections: {} }]) {
		assert.throws(() => assertSupportedSessionHistory([{ type: "message", message }]), /Start a new session \(\/new\)/);
	}
});

it("real Pi 0.85.1 blocks loaded foreign input, aborts background wakes, and permits a fresh session", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-history-guard-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	const faux = fauxProvider({ provider: "history-guard", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSessionHistoryGuard, (pi) => pi.registerProvider(faux.provider)],
	});
	const manager = SessionManager.inMemory(cwd);
	// Raw foreign data is accepted by the old session store but is not a supported LLM message.
	manager.appendMessage({ role: "system", content: "foreign", toolsAdded: [{ name: "subagent", parameters: { type: "object" } }], timestamp: 1 } as never);
	let session: AgentSession | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: manager, noTools: "builtin" }));
		await session.bindExtensions({});
		await session.prompt("Must not reach the provider.");
		assert.equal(faux.state.callCount, 0, "ordinary input is handled before starting a request");
		assert.ok(manager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "subagent-incompatible-session" && entry.display));
		let unabortedRequests = 0;
		faux.setResponses([(_context, options) => {
			if (!options?.signal?.aborted) unabortedRequests++;
			return fauxAssistantMessage("Must not complete normally.");
		}]);
		await session.sendCustomMessage({ customType: "wake", content: "Background update", display: true }, { triggerTurn: true });
		assert.equal(unabortedRequests, 0, "foreign history must never reach provider work without cancellation; an earlier abort is also valid");
		const last = session.agent.state.messages.at(-1);
		assert.ok(last?.role === "assistant");
		assert.ok(last.stopReason === "aborted" || last.stopReason === "error", "foreign history cannot complete a background model turn");
		assert.doesNotMatch(JSON.stringify(last.content), /Must not complete normally/);
		session.dispose();
		await resourceLoader.reload();
		({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" }));
		await session.bindExtensions({});
		faux.setResponses([fauxAssistantMessage("Fresh history works.")]);
		const priorCalls = faux.state.callCount;
		await session.prompt("Fresh prompt.");
		assert.equal(faux.state.callCount, priorCalls + 1);
	} finally {
		session?.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
