import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

const RecordedMessage = Compile(Type.Object({
	type: Type.Literal("message"),
	message: Type.Object({}, { additionalProperties: true }),
}, { additionalProperties: true }));

const registered = new WeakSet<ExtensionAPI>();
const INCOMPATIBLE_SESSION = "pi-subagents: this session contains foreign system/tool-declaration history unsupported by Pi 0.85.1. Start a new session (/new); restarting or reloading cannot repair its history.";

/** Inspect raw entries: the old host's LLM converter silently drops foreign system messages. */
export function assertSupportedSessionHistory(entries: readonly unknown[]): void {
	for (const entry of entries) {
		if (!RecordedMessage.Check(entry)) continue;
		const message = entry.message;
		if (("role" in message && message.role === "system") || Object.hasOwn(message, "toolsAdded") || Object.hasOwn(message, "toolsRemoved") || Object.hasOwn(message, "sections")) {
			throw new Error(INCOMPATIBLE_SESSION);
		}
	}
}

/**
 * Refuse unsupported history on load/input and cancel incompatible resume/tree/fork operations.
 * Context abort also protects background wakes. Pi 0.85.1 still enters its stream callback with
 * an aborted signal; host-owned loaders must call assertSupportedSessionHistory before execution
 * when they require a strict pre-stream veto. A caught context-handler throw is not a veto.
 */
export function registerSessionHistoryGuard(pi: ExtensionAPI): void {
	if (registered.has(pi)) return;
	registered.add(pi);
	let incompatible = false;
	const notice = () => pi.sendMessage({ customType: "subagent-incompatible-session", content: INCOMPATIBLE_SESSION, display: true });
	const supported = (entries: readonly unknown[]) => {
		try { assertSupportedSessionHistory(entries); return true; }
		catch { return false; }
	};
	const refresh = (ctx: ExtensionContext) => {
		incompatible = !supported(ctx.sessionManager.getBranch());
		if (incompatible) { ctx.abort(); notice(); }
	};
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("session_tree", (_event, ctx) => refresh(ctx));
	pi.on("session_before_switch", (event) => {
		if (event.reason !== "resume" || !event.targetSessionFile) return;
		if (!supported(SessionManager.open(event.targetSessionFile).getBranch())) { notice(); return { cancel: true }; }
	});
	pi.on("session_before_tree", (event, ctx) => {
		if (!supported(ctx.sessionManager.getBranch(event.preparation.targetId))) { notice(); return { cancel: true }; }
	});
	pi.on("session_before_fork", (event, ctx) => {
		if (!supported(ctx.sessionManager.getBranch(event.entryId))) { notice(); return { cancel: true }; }
	});
	pi.on("session_before_compact", (event) => {
		if (!supported(event.branchEntries)) { notice(); return { cancel: true }; }
	});
	pi.on("input", (_event, ctx) => {
		incompatible = !supported(ctx.sessionManager.getBranch());
		if (!incompatible) return;
		ctx.abort();
		notice();
		return { action: "handled" };
	});
	pi.on("context", (_event, ctx) => {
		if (!incompatible && supported(ctx.sessionManager.getBranch())) return;
		incompatible = true;
		ctx.abort();
	});
}
