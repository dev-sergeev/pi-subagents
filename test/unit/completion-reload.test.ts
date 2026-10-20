import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerNotify from "../../src/runs/background/notify.ts";
import { createSettlementHost, type SettlementHost } from "../support/settlement-host.ts";

function harness(host: SettlementHost, appended = false) {
	const sent: Parameters<typeof host.pi.sendMessage>[0][] = [];
	const notifier = registerNotify({
		...host.pi,
		sendMessage(message, options) {
			sent.push(message);
			host.pi.sendMessage(message, options);
			return appended;
		},
	}, { currentSessionId: host.manager.getSessionId(), completionOwnerId: "owner" }, { batchConfig: { enabled: false } });
	return {
		notifier, sent,
		bind: () => notifier.bindSession(host.manager),
		deliver: () => notifier.deliver({
			id: randomUUID(), sessionId: host.manager.getSessionId(), completionOwnerId: "owner",
			success: true, agent: "workflow", summary: "Saved report ready.",
		}),
	};
}

for (const appended of [false, true]) {
	for (const reminded of [false, true]) {
		it(`retains completion reminder ownership on reload (appended=${appended}, reminded=${reminded})`, async () => {
			const host = createSettlementHost();
			const first = harness(host, appended);
			first.bind();
			assert.equal(await first.deliver(), true);
			const completion = { ...first.sent[0], role: "custom" as const, timestamp: Date.now() };
			if (reminded) {
				first.notifier.messageStarted(completion);
				host.finishTurn();
				assert.equal(host.consumeQueued()[0].customType, "subagent-completion-unanswered");
			}
			first.notifier.sessionShutdown("reload");
			first.notifier.dispose();
			const replacement = harness(host, appended);
			try {
				replacement.bind();
				assert.equal(replacement.notifier.hasPendingDelivery(), !appended && !reminded);
				replacement.notifier.messageStarted(completion);
				host.finishTurn();
				if (!reminded) {
					assert.equal(host.consumeQueued()[0].customType, "subagent-completion-unanswered");
					host.finishTurn();
				}
				assert.equal(host.messageTypes().at(-1), "subagent-completion-unhandled", "reload must not reset the consumed reminder budget");
				const count = host.sent.length;
				host.finishTurn();
				assert.equal(host.sent.length, count, "no further retry or warning");
				assert.equal(replacement.sent.filter(message => message.customType === "subagent-notify").length, 0, "reload does not redeliver the completed workflow");
			} finally {
				replacement.notifier.sessionShutdown("quit");
				replacement.notifier.dispose();
			}
		});
	}
}

it("isolates retained ownership by manager and merges completions accepted before bind", async () => {
	const host = createSettlementHost();
	const first = harness(host);
	first.bind();
	await first.deliver();
	first.notifier.sessionShutdown("reload");
	first.notifier.dispose();
	const other = createSettlementHost(SessionManager.inMemory());
	other.manager.getSessionId = () => host.manager.getSessionId();
	other.pi.sendMessage(first.sent[0], { triggerTurn: false });
	const otherManager = harness(other);
	otherManager.bind();
	other.finishTurn();
	assert.equal(other.sent.length, 1, "another manager with the same UUID and notice cannot inherit reminder ownership");
	otherManager.notifier.dispose();
	const replacement = harness(host);
	try {
		await replacement.deliver();
		replacement.bind();
		host.finishTurn();
		assert.equal(host.consumeQueued().length, 1);
		host.finishTurn();
		assert.equal(host.messageTypes().at(-1), "subagent-completion-unhandled");
		assert.doesNotMatch(String(host.sent.at(-1)!.message.content), /Saved report ready/);
		await replacement.deliver();
		host.manager.newSession();
		replacement.bind();
		const count = host.sent.length;
		host.finishTurn();
		assert.equal(host.sent.length, count, "changing the UUID on the same manager drops old state");
	} finally { replacement.notifier.dispose(); }
});

it("spends shared retained ownership once per native lifecycle event and keeps the surviving owner live", async () => {
	const host = createSettlementHost();
	const first = harness(host, true);
	const second = harness(host, true);
	first.bind();
	second.bind();
	try {
		await first.deliver();
		host.finishTurn();
		assert.equal(host.consumeQueued().length, 1, "duplicate owners cannot spend reminder and exhaustion in the same event");
		first.notifier.dispose();
		host.finishTurn();
		assert.equal(host.messageTypes().at(-1), "subagent-completion-unhandled");
		assert.equal(host.queued.length, 0);
	} finally {
		first.notifier.dispose();
		second.notifier.sessionShutdown("quit");
		second.notifier.dispose();
	}
});

it("quit clears retained completion tracking while stable old-host handlers remain inert", async () => {
	const host = createSettlementHost();
	const first = harness(host);
	first.bind();
	await first.deliver();
	first.notifier.sessionShutdown("quit");
	first.notifier.dispose();
	const replacement = harness(host);
	try {
		replacement.bind();
		const count = host.sent.length;
		host.finishTurn();
		assert.equal(host.sent.length, count);
	} finally { replacement.notifier.dispose(); }
});
