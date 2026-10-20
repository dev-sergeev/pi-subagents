// Opt-in native SDK tests use one installed Pi package and its own peer modules.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { findHostPeerPackageDir, resolveHostPeerAliases } from "../../src/runs/background/runner-aliases.ts";

const root = process.env.PI_SUBAGENTS_NATIVE_PI_ROOT;
if (!root) throw new Error("PI_SUBAGENTS_NATIVE_PI_ROOT is required for the native SDK tests.");
const { aliases, missing } = resolveHostPeerAliases(root);
if (missing.length) throw new Error(`Native host lacks: ${missing.join(", ")}`);
for (const [name, version] of [
	["@earendil-works/pi-coding-agent", "0.85.1"],
	["@earendil-works/pi-agent-core", "0.85.1"],
	["@earendil-works/pi-ai", "0.85.1"],
	["@earendil-works/pi-tui", "0.85.1"],
	["typebox", "1.3.7"],
]) {
	const packageDir = findHostPeerPackageDir(root, name);
	assert.ok(packageDir, `Native host lacks ${name}`);
	assert.equal(JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version, version, `Native host ${name}`);
}
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = root;
registerHooks({ resolve(specifier, context, nextResolve) {
	return aliases[specifier]
		? { url: pathToFileURL(aliases[specifier]).href, shortCircuit: true }
		: nextResolve(specifier, context);
} });
