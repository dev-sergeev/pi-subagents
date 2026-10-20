import { isDeepStrictEqual } from "node:util";
import { Compile } from "typebox/compile";
import type { Static } from "typebox";
import type { SubagentParams } from "./schemas.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { DisabledFeatureSurface } from "../shared/disabled-features.ts";
import { closestMatch } from "../shared/edit-distance.ts";
import { removedModelWorkflowFieldError } from "./public-execution.ts";
import { SUBAGENT_OPTION_KEYS, SubagentOptionParams, createSubagentParamsSchema } from "./schemas.ts";

const optionKeys = new Set(SUBAGENT_OPTION_KEYS);
const ALIAS_HINTS: Record<string, string> = { runId: "id (top-level)", maxRuntimeMs: "options.timeoutMs", isolation: "worktree (top-level)" };
const optionsValidator = Compile(SubagentOptionParams);

/** Reject removed model forms before Pi's schema validator can coerce booleans into strings. */
export function prepareSubagentToolArguments(args: unknown): Static<typeof SubagentParams> {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("subagent: arguments must be an object.");
	if ("workflow" in args && args.workflow !== undefined && typeof args.workflow !== "string") {
		throw new Error("subagent: workflow must be a string; use \"true\" for the reply block, not a boolean.");
	}
	if ("output" in args && args.output !== undefined && typeof args.output !== "string") {
		throw new Error("subagent: output must be a string; use \"false\" to disable saving or \"true\" for the configured default.");
	}
	// SAFETY: Pi requires the post-validation type here and validates all remaining fields against the registered schema immediately after this hook.
	return args as Static<typeof SubagentParams>;
}

/**
 * Lowers a model tool call's `options` into the flat params the executor reads.
 * Management fields given at the top level keep working, as in the flat shape older sessions declared.
 */
export function flattenSubagentToolOptions(params: Record<string, unknown>, disabled?: DisabledFeatureSurface): SubagentParamsLike {
	const removedTopLevel = removedModelWorkflowFieldError(params);
	if (removedTopLevel) throw new Error(removedTopLevel);
	prepareSubagentToolArguments(params);
	const { options, ...topLevel } = params;
	if (options === undefined) return topLevel;
	if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("subagent: options must be an object.");
	const removedField = removedModelWorkflowFieldError(options);
	if (removedField) throw new Error(removedField);
	const entries = Object.entries(options);
	const enabledKeys = SUBAGENT_OPTION_KEYS.filter((key) => !disabled?.params.has(key));
	const unknown = entries.map(([key]) => key).filter((key) => !optionKeys.has(key));
	if (unknown.length > 0) {
		const fields = Object.keys(createSubagentParamsSchema(disabled).properties);
		const hints = unknown.map((key) => {
			if (Object.hasOwn(ALIAS_HINTS, key)) return `unknown options key '${key}'; use ${ALIAS_HINTS[key]}.`;
			if (fields.includes(key)) return `'${key}' is a top-level field, not an option.`;
			const suggestion = closestMatch(key, enabledKeys);
			return `unknown options key '${key}'.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`;
		});
		throw new Error(`subagent: ${hints.join(" ")} Valid options: ${enabledKeys.sort().join(", ")}.`);
	}
	const disabledKey = entries.find(([key]) => disabled?.params.has(key))?.[0];
	if (disabledKey) throw new Error(`subagent option 'options.${disabledKey}' is disabled by config ${disabled!.params.get(disabledKey)}.`);
	if (!optionsValidator.Check(options)) {
		const errors = [...optionsValidator.Errors(options)].slice(0, 4).map((error) => `options${error.instancePath.replaceAll("/", ".")} ${error.message}`);
		throw new Error(`subagent: ${errors.join("; ")}.`);
	}
	const conflicts = entries.filter(([key, value]) => topLevel[key] !== undefined && !isDeepStrictEqual(topLevel[key], value)).map(([key]) => `'${key}'`);
	if (conflicts.length > 0) throw new Error(`subagent: ${conflicts.join(", ")} given both at the top level and in options with different values; give each once.`);
	return { ...topLevel, ...options } as SubagentParamsLike;
}
