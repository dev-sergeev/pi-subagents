import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { createNativeSupervisorChannel } from "../../src/intercom/native-supervisor-channel.ts";
import registerNotify from "../../src/runs/background/notify.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { createSettlementHost } from "../support/settlement-host.ts";

it("queues one supervisor reminder for model consumption, then persists a blocked decision without approving", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-settle-check-"));
	const host = createSettlementHost();
	const owner = host.manager.getSessionId();
	const state = { supervisorOwnerSessionId: owner, foregroundControls: new Map(), asyncJobs: new Map() } as SubagentState;
	const channel = createNativeSupervisorChannel(host.pi as never, state, { getChannelDirs: () => ({ dirs: [dir] }) });
	const request = (id: string, overrides: Record<string, unknown> = {}) => {
		fs.mkdirSync(path.join(dir, "requests"), { recursive: true });
		fs.writeFileSync(path.join(dir, "requests", `${id}.json`), JSON.stringify({
			type: "subagent.supervisor.request", id, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
			reason: "need_decision", message: "Keep strict latency targets?", expectsReply: true,
			runId: "child", agent: "oracle", childIndex: 0, orchestratorSessionId: owner, ...overrides,
		}));
		channel.activateTransport();
	};
	try {
		channel.start();
		host.finishTurn();
		assert.equal(host.sent.length, 0);
		request("first");
		assert.equal(host.sent.length, 1);
		for (const stopReason of ["aborted", "error", "length"] as const) host.finishTurn("", stopReason);
		host.finishTurn("", "stop", true);
		host.setPendingMessages(true);
		host.finishTurn();
		host.setPendingMessages(false);
		assert.equal(host.sent.length, 1, "failed, cancelled, truncated and queued turns do not spend the reminder");
		host.finishTurn([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "   " }]);
		assert.deepEqual(host.queued.map(message => message.customType), ["subagent-supervisor-unanswered"]);
		assert.equal(host.messageTypes().includes("subagent-supervisor-unanswered"), false, "the reminder must pass through the host queue");
		const [reminder] = host.consumeQueued();
		assert.match(String(reminder.content), /explicitly ask the user/);
		assert.doesNotMatch(String(reminder.content), /Keep strict latency targets/);
		host.finishTurn();
		assert.equal(host.queued.length, 0, "exhaustion must not start another model turn");
		assert.equal(host.messageTypes().at(-1), "subagent-supervisor-blocked");
		host.finishTurn();
		assert.equal(host.sent.length, 3, "one initial notice, one reminder, one persistent warning");
		assert.equal(fs.existsSync(path.join(dir, "replies", "first.json")), false);
		assert.equal(channel.pending.has("first"), true);
		await host.tools.get("subagent_supervisor")!.execute("reply", { action: "reply", replyTo: "first", replyText: "Preserve strict targets." }, undefined, undefined, host.ctx);
		assert.equal(channel.pending.has("first"), false);

		request("second");
		host.finishTurn();
		assert.equal(host.consumeQueued().length, 1, "each new request gets its own bounded reminder");
		fs.rmSync(path.join(dir, "requests", "second.json"));
		const beforeRemoved = host.sent.length;
		host.finishTurn();
		assert.equal(host.sent.length, beforeRemoved);
		request("expired", { expiresAt: Date.now() - 1 });
		request("foreign", { orchestratorSessionId: "other" });
		request("progress", { reason: "progress_update", expectsReply: false });
		host.finishTurn();
		assert.equal(host.sent.length, beforeRemoved, "expired, foreign and progress notices cannot wake the model");
		request("inactive");
		state.asyncJobs.set("child", { status: "complete" } as never);
		const beforeInactive = host.sent.length;
		host.finishTurn();
		assert.equal(host.sent.length, beforeInactive);
		state.asyncJobs.clear();
		request("approval");
		host.finishTurn("May I approve this child action?");
		const beforeEscalation = host.sent.length;
		channel.activateTransport();
		host.finishTurn();
		assert.equal(host.sent.length, beforeEscalation, "visible escalation stays acknowledged while its request remains pending");
		assert.equal(channel.pending.has("approval"), true);
		channel.dispose();
		host.finishTurn();
		assert.equal(host.sent.length, beforeEscalation, "disposed owners remain inert even though old-host handlers stay registered");
	} finally {
		channel.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

it("queues one empty-completion reminder, consumes it, then retains an unhandled result without widening authority", async () => {
	const host = createSettlementHost();
	const state = { currentSessionId: host.manager.getSessionId(), completionOwnerId: "owner" };
	const notifier = registerNotify(host.pi, state, { batchConfig: { enabled: false } });
	notifier.bindSession(host.manager);
	const deliver = (overrides: Record<string, unknown> = {}) => notifier.deliver({
		id: randomUUID(), sessionId: state.currentSessionId, completionOwnerId: "owner", source: "async",
		agent: "workflow", mode: "workflow", success: true, state: "complete",
		summary: "Saved results ready.", workflowReceipt: { path: "/tmp/receipt.json" }, ...overrides,
	});
	try {
		assert.equal(await deliver(), true);
		assert.equal(host.sent[0].options?.triggerTurn, true);
		for (const stopReason of ["aborted", "error", "length"] as const) host.finishTurn("", stopReason);
		host.finishTurn("", "stop", true);
		host.setPendingMessages(true);
		host.finishTurn();
		host.setPendingMessages(false);
		assert.equal(host.sent.length, 1);
		host.finishTurn();
		const [reminder] = host.consumeQueued();
		assert.equal(reminder.customType, "subagent-completion-unanswered");
		assert.match(String(reminder.content), /completion notices above/);
		assert.doesNotMatch(String(reminder.content), /\/tmp\/receipt.json|Saved results ready/);
		host.finishTurn("   ");
		assert.equal(host.messageTypes().at(-1), "subagent-completion-unhandled");
		assert.match(String(host.sent.at(-1)!.message.content), /^UNHANDLED:/);
		assert.equal(host.queued.length, 0);
		host.finishTurn();
		assert.equal(host.sent.length, 3, "never rerun or resend the completed workflow");

		await deliver();
		host.finishTurn([{ type: "toolCall", id: "read", name: "read", arguments: {} }]);
		await deliver();
		host.finishTurn("Results ready; approval required before deployment.");
		await deliver({ scheduleOrigin: { id: "quiet", quiet: true } });
		assert.equal(host.sent.at(-1)!.options?.triggerTurn, false);
		await deliver({ triggerTurn: false });
		assert.equal(await deliver({ sessionId: "foreign" }), false);
		host.setFailSend(true);
		assert.equal(await deliver(), false);
		host.setFailSend(false);
		const beforeQuiet = host.sent.length;
		host.finishTurn();
		assert.equal(host.sent.length, beforeQuiet, "acknowledged, quiet, foreign and rejected notices cannot create reminders");
		await deliver();
		host.manager.newSession();
		const beforeRemoved = host.sent.length;
		host.finishTurn();
		assert.equal(host.sent.length, beforeRemoved, "removed context cannot revive stale completion");
		host.setHeld(true);
		await deliver();
		assert.match(String(host.sent.at(-1)!.message.content), /The user stopped the parent turn/);
		const beforeHeld = host.sent.length;
		host.finishTurn();
		assert.equal(host.sent.length, beforeHeld);
		host.setHeld(false);
		await deliver();
		notifier.bindSession({ getSessionId: () => "other" });
		const beforeSwitch = host.sent.length;
		host.finishTurn();
		assert.equal(host.sent.length, beforeSwitch, "session switching drops old acknowledgement ownership");
		notifier.dispose();
		host.finishTurn();
		assert.equal(host.sent.length, beforeSwitch);
	} finally { notifier.dispose(); }
});
