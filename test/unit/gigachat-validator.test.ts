import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
// Observed official /functions/validate response, rules 1.0.6; no credentials or model replies.
const validResponse = {
	status: 200,
	message: "Function is valid",
	json_ai_rules_version: "1.0.6",
	warnings: [
		{ description: "Value is null but should be object", schema_location: "#/properties/return_parameters" },
		{ description: "Value is null but should be array", schema_location: "#/properties/few_shot_examples" },
	],
};

for (const scenario of [
	{ name: "accepts official missing-optional-field warnings", response: validResponse, accepted: true },
	{
		name: "rejects the same diagnostic at an unapproved schema location",
		response: { ...validResponse, warnings: [{ description: "Value is null but should be object", schema_location: "#/properties/parameters" }] },
		accepted: false,
	},
	{
		name: "rejects a non-missing-field diagnostic at an optional field",
		response: { ...validResponse, warnings: [{ description: "Invalid property type", schema_location: "#/properties/return_parameters" }] },
		accepted: false,
	},
	{ name: "rejects HTTP 200 with validation errors", response: { ...validResponse, errors: [{ description: "Invalid parameter" }] }, accepted: false },
	{ name: "rejects a valid message without a rules version", response: { ...validResponse, json_ai_rules_version: undefined }, accepted: false },
]) {
	test(`validator CLI ${scenario.name} without claiming provider-path acceptance`, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gigachat-validator-"));
		try {
			const preload = path.join(root, "transport.mjs");
			fs.writeFileSync(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(scenario.response))}, { status: 200 });\n`);
			const out = path.join(root, "result");
			const child = spawnSync(process.execPath, [
				"--import", pathToFileURL(preload).href,
				"examples/gigachat-compatibility/validate.mjs",
				"--input", "examples/gigachat-compatibility/evidence/sdk",
				"--out", out,
				"--allow-sdk-only",
			], {
				cwd: repository,
				encoding: "utf8",
				env: { ...process.env, GIGACHAT_ACCESS_TOKEN: "", NODE_DEBUG: "" },
				timeout: 30_000,
			});
			assert.equal(child.status, scenario.accepted ? 0 : 1, child.stderr);
			const report = JSON.parse(fs.readFileSync(path.join(out, scenario.accepted ? "summary.json" : "failure.json"), "utf8"));
			assert.equal(report.allFunctionsAccepted, scenario.accepted);
			assert.equal(report.providerAcceptance, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
