import { EventEmitter } from "node:events";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ParentWake } from "../../src/shared/parent-wake.ts";

export interface SettlementHost {
	pi: Pick<ExtensionAPI, "on" | "events"> & Pick<ParentWake, "sendMessage" | "isHeld">;
	manager: SessionManager;
	ctx: ExtensionContext;
	sent: Array<{ message: Parameters<ExtensionAPI["sendMessage"]>[0]; options?: Parameters<ExtensionAPI["sendMessage"]>[1] }>;
	queued: Parameters<ExtensionAPI["sendMessage"]>[0][];
	tools: Map<string, Pick<ToolDefinition, "name" | "execute">>;
	setHeld(value: boolean): void;
	setFailSend(value: boolean): void;
	setPendingMessages(value: boolean): void;
	finishTurn(content?: Parameters<typeof fauxAssistantMessage>[0], stopReason?: "stop" | "error" | "aborted" | "length", aborted?: boolean): void;
	consumeQueued(): Parameters<ExtensionAPI["sendMessage"]>[0][];
	messageTypes(): string[];
}

/** Consumer seam for the 0.85.1 queue: agent_end can enqueue a continuation, never return a settlement draft. */
export function createSettlementHost(manager = SessionManager.inMemory()): SettlementHost {
	const lifecycle = new EventEmitter();
	const events = new EventEmitter();
	const sent: Array<{ message: Parameters<ExtensionAPI["sendMessage"]>[0]; options?: Parameters<ExtensionAPI["sendMessage"]>[1] }> = [];
	const queued: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
	const deferred: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
	const tools = new Map<string, Pick<ToolDefinition, "name" | "execute">>();
	let held = false;
	let failSend = false;
	let running = false;
	let pendingMessages = false;
	const ctx = {
		sessionManager: manager,
		hasPendingMessages: () => pendingMessages,
		signal: undefined,
	} as unknown as ExtensionContext;
	const append = (message: Parameters<ExtensionAPI["sendMessage"]>[0]) => {
		manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
	};
	const pi = {
		on: ((name, handler) => {
			lifecycle.on(name, (event: never, context: ExtensionContext) => handler(event, context));
		}) as ExtensionAPI["on"],
		events: {
			on(name: string, handler: (data: unknown) => void) { events.on(name, handler); return () => { events.off(name, handler); }; },
			emit(name: string, data: unknown) { events.emit(name, data); },
		},
		getAllTools: () => [...tools.values()],
		registerTool: (tool: Pick<ToolDefinition, "name" | "execute">) => { tools.set(tool.name, tool); },
		appendEntry() {},
		isHeld: () => held,
		sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0], options?: Parameters<ExtensionAPI["sendMessage"]>[1]): boolean {
			if (failSend) throw new Error("send failed");
			sent.push({ message, options });
			if (running && options?.triggerTurn !== false) queued.push(message);
			else if (running) deferred.push(message);
			else append(message);
			return !running;
		},
	};
	return {
		pi, manager, ctx, sent, queued, tools,
		setHeld(value: boolean) { held = value; },
		setFailSend(value: boolean) { failSend = value; },
		setPendingMessages(value: boolean) { pendingMessages = value; },
		finishTurn(content: Parameters<typeof fauxAssistantMessage>[0] = "", stopReason: "stop" | "error" | "aborted" | "length" = "stop", aborted = false) {
			const message = fauxAssistantMessage(content, { stopReason });
			manager.appendMessage(message);
			ctx.signal = aborted ? AbortSignal.abort() : undefined;
			running = true;
			try { lifecycle.emit("agent_end", { type: "agent_end", messages: [message] }, ctx); }
			finally {
				running = false;
				for (const notice of deferred.splice(0)) append(notice);
			}
			if (!queued.length) lifecycle.emit("agent_settled", { type: "agent_settled" }, ctx);
		},
		consumeQueued() {
			const notices = queued.splice(0);
			for (const message of notices) {
				append(message);
				lifecycle.emit("message_start", { type: "message_start", message: { ...message, role: "custom" } as AgentMessage }, ctx);
			}
			return notices;
		},
		messageTypes: () => manager.getBranch().filter(entry => entry.type === "custom_message").map(entry => entry.customType),
	};
}
