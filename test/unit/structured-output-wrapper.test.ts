import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { validateStructuredOutputValue } from "../../src/runs/shared/structured-output.ts";
import type { JsonSchemaObject } from "../../src/shared/types.ts";

type Submission = { value: unknown; acceptanceReport?: unknown };
type RegisteredTool = {
	name: string;
	parameters: JsonSchemaObject;
	execute: (id: string, params: Submission) => Promise<{ terminate?: boolean }>;
};

const parameterMetadata = Compile(Type.Object({
	type: Type.String({ minLength: 1 }),
	description: Type.String({ pattern: "\\S" }),
}));

describe("structured_output final registered wrapper", () => {
	for (const description of [undefined, "", "  ", "The reviewed decision."]) {
		for (const acceptanceReport of [undefined, "optional", "required"] as const) {
			it(`preserves constraints with description ${JSON.stringify(description)} and report ${acceptanceReport ?? "off"}`, async () => {
				const schema: JsonSchemaObject = {
					type: "object",
					$defs: { decision: { type: "string", enum: ["approved", "rejected"] } },
					properties: { decision: { $ref: "#/$defs/decision" }, confidence: { type: "number", minimum: 0, maximum: 1 } },
					required: ["decision", "confidence"],
					additionalProperties: false,
				};
				if (description !== undefined) schema.description = description;
				const original = structuredClone(schema);
				const captured: Submission[] = [];
				let tool: RegisteredTool | undefined;
				// SAFETY: The fixture implements the registration hooks used by this configuration; no session events are emitted.
				registerSubagentPromptRuntime({
					registerTool(registered: RegisteredTool) {
						if (registered.name === "structured_output") tool = registered;
					},
					on() {},
				} as never, {
					fanoutChild: false, depth: 1, waitTool: { enabled: true }, fast: false,
					structuredOutput: { schema, acceptanceReport, capture: (value, report) => captured.push({ value, acceptanceReport: report }) },
				});
				assert.ok(tool);
				// SAFETY: The registered tool owns the object-root wrapper; the caller's schema is nested under value.
				const properties = tool.parameters.properties as Record<string, JsonSchemaObject>;
				for (const property of Object.values(properties)) {
					assert.equal(parameterMetadata.Check(property), true, "The final provider parameter requires a type and meaningful description");
				}
				if (description?.trim()) assert.equal(properties.value!.description, description);
				assert.equal("acceptanceReport" in properties, acceptanceReport !== undefined);
				assert.deepEqual(tool.parameters.required, acceptanceReport === "required" ? ["value", "acceptanceReport"] : ["value"]);
				assert.deepEqual(schema, original);

				const value = { decision: "approved", confidence: 0.9 };
				const report = { manualNotes: "Reviewed the decision and confidence." };
				const submission: Submission = { value };
				if (acceptanceReport) submission.acceptanceReport = report;
				assert.equal((await validateStructuredOutputValue(tool.parameters, submission)).status, "valid");
				for (const invalid of [
					{ decision: "unknown", confidence: 0.9 },
					{ decision: "approved", confidence: 2 },
					{ decision: "approved" },
					{ ...value, unexpected: true },
				]) {
					assert.equal((await validateStructuredOutputValue(tool.parameters, { ...submission, value: invalid })).status, "invalid");
					await assert.rejects(tool.execute("invalid", { ...submission, value: invalid }), /validation failed/);
				}
				assert.deepEqual(captured, []);
				if (acceptanceReport === "required") {
					assert.equal((await validateStructuredOutputValue(tool.parameters, { value })).status, "invalid");
					await assert.rejects(tool.execute("missing-report", { value }), /Missing acceptanceReport/);
					await assert.rejects(tool.execute("invalid-report", { value, acceptanceReport: {} }), /expected at least one acceptance report field/);
				} else {
					assert.equal((await validateStructuredOutputValue(tool.parameters, { value })).status, "valid");
				}
				assert.equal((await tool.execute("valid", submission)).terminate, true);
				assert.deepEqual(captured, [{ value, acceptanceReport: acceptanceReport ? report : undefined }]);
				assert.deepEqual(schema, original);
			});
		}
	}
});
