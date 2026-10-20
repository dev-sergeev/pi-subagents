import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { openRuntime, rememberSecret, runtimeOptions, StringValue, writeEvidence } from "./runtime.mjs";

const endpoint = "https://api.giga.chat/v1/functions/validate";
const help = `Usage: node examples/gigachat-compatibility/validate.mjs
  --input /private/collector-evidence --out /private/new/validation-evidence
  [--token-env GIGACHAT_ACCESS_TOKEN]
  [--provider /absolute/path/to/installed/extension.js --model provider/model]
  [--allow-sdk-only]

POSTs each exact collected function to the official GigaChat validator.
An environment access token is used when present; otherwise saved provider auth
is resolved if --provider is supplied. With neither, the real anonymous response
is saved (401 is a hard failure, not successful validation).
For local certificate prerequisites use NODE_EXTRA_CA_CERTS=/trusted/root.pem;
TLS verification is never disabled. No request headers or credentials are saved.
Only 'Function is valid', no errors, a rules version, and missing-field warnings
solely for return_parameters/few_shot_examples count as success.
--allow-sdk-only permits diagnostic raw-SDK validation, NEVER provider acceptance.
`;
const { values } = parseArgs({ options: { ...runtimeOptions, input: { type: "string" }, out: { type: "string" }, "token-env": { type: "string", default: "GIGACHAT_ACCESS_TOKEN" }, "allow-sdk-only": { type: "boolean" }, help: { type: "boolean" } } });
if (values.help) { console.log(help); process.exit(0); }
if (!values.input || !values.out) throw new Error("--input and --out are required. Use --help for the official validation contract.");
const input = path.resolve(values.input);
const out = path.resolve(values.out);
const manifest = JSON.parse(fs.readFileSync(path.join(input, "manifest.json"), "utf8"));
if (!manifest.complete || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error("A complete nonempty collector manifest is required.");
const sdkOnly = manifest.evidenceKind === "sdk-only-not-gigachat-acceptance";
if (sdkOnly && !values["allow-sdk-only"]) throw new Error("SDK-only declarations are not Pi -> GigaChat acceptance. Pass --allow-sdk-only for explicitly labeled diagnostic validation.");
if (!sdkOnly && manifest.evidenceKind !== "pi-gigachat-http-functions") throw new Error("Unrecognized collector evidence boundary.");
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.mkdirSync(out, { mode: 0o700 });
const results = [];
let host;

const missingOptionalFieldWarnings = {
	"#/properties/return_parameters": "Value is null but should be object",
	"#/properties/few_shot_examples": "Value is null but should be array",
};

function permittedWarning(warning) {
	const location = warning?.schema_location;
	// Exact official missing-field diagnostics only; unknown locations or causes fail closed.
	return StringValue.Check(location) && Object.hasOwn(missingOptionalFieldWarnings, location)
		&& warning.description === missingOptionalFieldWarnings[location];
}

try {
	let token = process.env[values["token-env"]];
	if (!token && values.provider) {
		host = await openRuntime(values);
		if (new URL(host.model.baseUrl).hostname !== "api.giga.chat") throw new Error("Refusing to send credentials belonging to a non-official model endpoint to the official validator.");
		token = host.auth.apiKey;
	}
	rememberSecret(token);
	for (const entry of manifest.cases) {
		if (!/^[a-zA-Z0-9_-]+$/.test(entry.id) || !/^functions\/[a-zA-Z0-9_-]+\.json$/.test(entry.file)) throw new Error("Invalid collector evidence file path.");
		const fn = JSON.parse(fs.readFileSync(path.join(input, entry.file), "utf8"));
		const sha256 = createHash("sha256").update(JSON.stringify(fn)).digest("hex");
		if (sha256 !== entry.sha256 || fn.name !== entry.name) throw new Error("Collected function identity/hash changed; recollect instead of modifying evidence.");
		writeEvidence(path.join(out, `${entry.id}.function.json`), fn);
		let response;
		const headers = { "Content-Type": "application/json" };
		if (token) headers.Authorization = `Bearer ${token}`;
		try {
			response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(fn), signal: AbortSignal.timeout(60_000), redirect: "error" });
		} catch (error) {
			writeEvidence(path.join(out, `${entry.id}.transport-failure.json`), { endpoint, errorType: error?.name ?? "Error", code: error?.cause?.code ?? null });
			throw new Error("Official validator transport failed. Check network access and trusted CA configuration; no validation success is claimed.");
		}
		const text = await response.text();
		writeEvidence(path.join(out, `${entry.id}.response.txt`), text);
		let body;
		try { body = JSON.parse(text); } catch { body = null; }
		const errorsEmpty = body?.errors == null || (Array.isArray(body.errors) && body.errors.length === 0);
		const warnings = body?.warnings ?? [];
		const rulesVersion = body?.json_ai_rules_version ?? null;
		const accepted = response.ok && body?.message === "Function is valid" && errorsEmpty
			&& Array.isArray(warnings) && warnings.every(permittedWarning)
			&& StringValue.Check(rulesVersion) && rulesVersion.trim().length > 0;
		writeEvidence(path.join(out, `${entry.id}.response.json`), { endpoint, httpStatus: response.status, body, json_ai_rules_version: rulesVersion, accepted });
		results.push({ id: entry.id, scenario: entry.scenario, name: entry.name, httpStatus: response.status, json_ai_rules_version: rulesVersion, accepted });
		if (response.status === 401 || response.status === 403) throw new Error("Official validator authentication prerequisite failed. The complete safe response and submitted function were saved; configure a valid access token. No rules version or success is manufactured.");
	}
	const allAccepted = results.length === manifest.cases.length && results.every((result) => result.accepted);
	writeEvidence(path.join(out, "summary.json"), { evidenceKind: manifest.evidenceKind, providerAcceptance: !sdkOnly && allAccepted, allFunctionsAccepted: allAccepted, expectedCount: manifest.cases.length, validatedCount: results.length, results });
	if (!allAccepted) throw new Error("Official validator rejected one or more functions or returned unfamiliar warnings/missing rules version. Inspect complete response files.");
	console.log(`${results.length} functions accepted by the official validator${sdkOnly ? " (SDK-only diagnostic; NOT Pi -> GigaChat acceptance)" : " (real provider declaration boundary only; not a live smoke)"}.`);
} catch (error) {
	const message = error instanceof Error ? error.message : "Official validation failed.";
	writeEvidence(path.join(out, "failure.json"), { message, evidenceKind: manifest.evidenceKind, providerAcceptance: false, allFunctionsAccepted: false, expectedCount: manifest.cases.length, validatedCount: results.length, results });
	console.error(message);
	process.exitCode = 1;
} finally { await host?.dispose(); }
