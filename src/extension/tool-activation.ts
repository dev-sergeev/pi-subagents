import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import { MODEL_ONLY_TOOL } from "../shared/extension-context.ts";
import type { ToolActivationMode } from "../shared/types.ts";
import { listBackgroundWorkProviders } from "../api/background-work.ts";
import { CONTACT_SUPERVISOR_TOOL_NAME as SUPERVISOR_NAME, NATIVE_SUPERVISOR_TOOL_NAME as PARENT_SUPERVISOR_NAME } from "../intercom/native-supervisor-channel.ts";

interface ActivationDetails {
	enabled: string[];
}

const LOADER_NAME = "subagents_enable";
const SUBAGENT_NAME = "subagent";
const WAIT_NAME = "bg_wait";
const ACTIVATION_ENTRY = "subagent-tool-activation";
const ActivationSelectionSchema = Type.Object({
	version: Type.Literal(1),
	selected: Type.Array(Type.Union([
		Type.Literal(LOADER_NAME),
		Type.Literal(SUBAGENT_NAME),
		Type.Literal(SUPERVISOR_NAME),
		Type.Literal(PARENT_SUPERVISOR_NAME),
		Type.Literal(WAIT_NAME),
	])),
});
type ActivationSelection = Static<typeof ActivationSelectionSchema>;
const OWNED_NAMES: ActivationSelection["selected"] = [LOADER_NAME, SUBAGENT_NAME, SUPERVISOR_NAME, PARENT_SUPERVISOR_NAME, WAIT_NAME];
const activationSelectionValidator = Compile(ActivationSelectionSchema);

/** Selection is extension state, not a snapshot of tool declarations or other extensions' tools. */
function recordedSelection(ctx: ExtensionContext): ActivationSelection | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== ACTIVATION_ENTRY) continue;
		const data: unknown = entry.data;
		if (!activationSelectionValidator.Check(data)) {
			throw new Error("Invalid pi-subagents activation state; start a new session (/new).");
		}
		return data;
	}
	return undefined;
}

export function registerSubagentToolActivation(
	pi: ExtensionAPI,
	options: { advertisedPrompt: () => string | undefined | Promise<string | undefined>; mode?: ToolActivationMode; hasPendingSupervisorRequest?: () => boolean },
): void {
	const mode = options.mode ?? "auto";
	let selected: ActivationSelection["selected"] = [];
	const persist = () => {
		const next = OWNED_NAMES.filter((name) => pi.getActiveTools().includes(name));
		if (JSON.stringify(next) === JSON.stringify(selected)) return;
		selected = next;
		pi.appendEntry<ActivationSelection>(ACTIVATION_ENTRY, { version: 1, selected });
	};
	const apply = (names: readonly string[]) => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools([...new Set([...pi.getActiveTools().filter((name) => !OWNED_NAMES.some((owned) => owned === name)), ...names.filter((name) => available.has(name))])]);
	};
	const requiredNames = () => [
		...(options.hasPendingSupervisorRequest?.() ? [PARENT_SUPERVISOR_NAME] : []),
		...(listBackgroundWorkProviders().length > 0 ? [WAIT_NAME] : []),
	];

	if (mode !== "eager") {
		// Takes no arguments, but an extra field from a model must not fail validation.
		const parameters = Type.Object({});
		const loader: ToolDefinition<typeof parameters, ActivationDetails> = {
			name: LOADER_NAME,
			...MODEL_ONLY_TOOL,
			label: "Enable Subagents",
			description: "Enable subagent tools for the next request; launches nothing. Delegate only when the request or applicable instructions authorize it; complexity alone is not authorization. Otherwise work directly. Use also for existing-run management.",
			promptSnippet: "pi-subagents is installed. For authorized specialist, independent-review, or parallel work, call subagents_enable, then subagent. Authorization must come from the current request or applicable instructions; complexity alone is not authorization.",
			parameters,
			async execute() {
				if (!pi.getAllTools().some((tool) => tool.name === SUBAGENT_NAME)) throw new Error("Cannot enable unavailable tools: subagent.");
				try {
					apply(OWNED_NAMES);
				} catch (error) {
					throw new Error(`Activation failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
				}
				if (!pi.getActiveTools().includes(SUBAGENT_NAME)) throw new Error("Activation failed: subagent.");
				persist();
				const advertised = await options.advertisedPrompt();
				return {
					content: [{ type: "text", text: `Enabled: subagent. If your tool list includes subagent (possibly prefixed), call it now. Otherwise, wait for the next user prompt; do not retry now. Start Pi with --exclude-tools subagents_enable to keep subagent always available.${advertised ? `\n\n${advertised}` : ""}` }],
					details: { enabled: [SUBAGENT_NAME] },
				};
			},
		};
		pi.registerTool(loader);
	}

	const restore = (ctx: ExtensionContext) => {
		const recorded = recordedSelection(ctx);
		selected = recorded?.selected ?? [];
		const loaderAvailable = pi.getAllTools().some((tool) => tool.name === LOADER_NAME);
		// Pi 0.85.1 has no newer cache-checkpoint capability contract. Auto is conservatively eager.
		const initial = mode === "dynamic" && loaderAvailable ? [LOADER_NAME] : OWNED_NAMES.filter((name) => name !== LOADER_NAME);
		const names = mode === "eager" || !loaderAvailable ? initial : recorded?.selected ?? initial;
		apply([...names, ...requiredNames()]);
		persist();
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", () => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const required = [...(selected.includes(LOADER_NAME) ? [LOADER_NAME] : []), ...requiredNames()].filter((name) => available.has(name));
		const active = pi.getActiveTools();
		if (required.some((name) => !active.includes(name))) {
			pi.setActiveTools([...new Set([...active, ...required])]);
			persist();
		}
	});
}
