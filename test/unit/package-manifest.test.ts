import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sourceImportPattern = /from\s+["'](@earendil-works\/[^"']+)["']|import\s+["'](@earendil-works\/[^"']+)["']/g;
const oldPiScopePattern = /@mariozechner\/pi-/;
const piPackageJsonSubpathPattern = /@earendil-works\/pi-[^"']+\/package\.json/;
const cjsPiPackageResolutionPattern = /require(?:\.resolve)?\(\s*["']@earendil-works\/pi-/;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

test("the root entrypoint exposes the runtime error flag to TypeScript consumers", () => {
	const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-types-"));
	try {
		fs.writeFileSync(path.join(consumerRoot, "consumer.ts"), `
import "@dev-sergeev/pi-subagents";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { registerWorkflowResource, type RegisterWorkflowResourceInput, type WorkflowResourceDefinition, type WorkflowResourceRegistration } from "@dev-sergeev/pi-subagents/workflow-resources";

const definition: WorkflowResourceDefinition = {
	name: "consumer.check", version: 1,
	resolve: (args) => typeof args.task === "string"
		? { script: "return 1;", hostCommands: [{ key: "check", command: "node --version" }] }
		: { error: "task required" },
};
const input: RegisterWorkflowResourceInput = { sessionId: "consumer", definition };
const registration: WorkflowResourceRegistration = registerWorkflowResource(input);
registration.dispose();

const result: AgentToolResult<undefined> = {
	content: [],
	details: undefined,
	isError: true,
};

void result.isError;
`, "utf-8");
		fs.writeFileSync(path.join(consumerRoot, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				target: "ES2023",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				noEmit: true,
				types: ["node"],
				typeRoots: [path.join(projectRoot, "node_modules", "@types")],
				skipLibCheck: true,
				allowImportingTsExtensions: true,
				baseUrl: consumerRoot,
				paths: {
					"@dev-sergeev/pi-subagents": [path.join(projectRoot, "index.ts")],
					"@dev-sergeev/pi-subagents/workflow-resources": [path.join(projectRoot, "src/api/workflow-resources.ts")],
				"@earendil-works/pi-agent-core": [path.join(projectRoot, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.d.ts")],
				},
			},
			files: [path.join(consumerRoot, "consumer.ts")],
		}, null, 2), "utf-8");

		execFileSync(process.execPath, [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "--project", path.join(consumerRoot, "tsconfig.json")], {
			cwd: consumerRoot,
			stdio: "pipe",
		});
	} finally {
		fs.rmSync(consumerRoot, { recursive: true, force: true });
	}
});

function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSourceFiles(entryPath).forEach((file) => files.push(file));
		} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) {
			files.push(entryPath);
		}
	}
	return files;
}

test("published extension APIs use supported package entrypoints", async () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	assert.equal(packageJson.private, true, "the source checkout must not be publishable");
	assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
	assert.equal(packageJson.files?.includes("index.ts"), true);
	assert.equal(packageJson.files?.includes("*.mjs"), true);
	assert.equal(fs.existsSync(path.join(projectRoot, "async-retention-discovery-worker.mjs")), true);
	const entrySource = fs.readFileSync(path.join(projectRoot, "index.ts"), "utf-8");
	assert.match(entrySource, /import type \{\} from "\.\/src\/types\/pi-runtime-compat\.d\.ts";/);
	assert.equal(entrySource.includes('export { default } from "./src/extension/index.ts";'), false);
	assert.match(entrySource, /process\.env\.PI_SUBAGENT_CHILD === "1"/);
	assert.match(entrySource, /await import\("\.\/src\/extension\/index\.ts"\)/);
	assert.equal(fs.existsSync(path.join(projectRoot, "src", "api", "delegation.ts")), true);
	// Dynamic imports intentionally exercise public package export resolution.
	const agents = await import("@dev-sergeev/pi-subagents/agents");
	assert.equal(agents.RUNTIME_AGENT_REGISTER_EVENT, "pi-subagents:runtime-agent-register:v1");
	assert.equal(agents.RUNTIME_AGENT_REGISTER_VERSION, 1);
	assert.equal(typeof agents.registerAgentViaEvents, "function");
	const inspectors = await import("@dev-sergeev/pi-subagents/inspectors");
	assert.equal(inspectors.INSPECTOR_REGISTER_EVENT, "pi-subagents:inspector-register:v1");
	assert.deepEqual(Object.keys(inspectors).sort(), ["INSPECTOR_REGISTER_EVENT", "registerInspector"]);
	const backgroundWork = await import("@dev-sergeev/pi-subagents/background-work");
	assert.equal(backgroundWork.BACKGROUND_WORK_PROTOCOL_VERSION, 1);
	assert.equal(backgroundWork.BACKGROUND_WORK_REGISTRY_KEY, "pi-subagents.background-work.v1");
	const externalJobProvider = await import("@dev-sergeev/pi-subagents/external-job-provider");
	assert.equal(externalJobProvider.EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION, 1);
	assert.equal(externalJobProvider.EXTERNAL_JOB_PROVIDER_REGISTRY_KEY, "pi-subagents.external-job-providers.v1");
	assert.equal(typeof externalJobProvider.registerExternalJobProvider, "function");
	const externalRuns = await import("@dev-sergeev/pi-subagents/external-runs");
	assert.equal(externalRuns.EXTERNAL_RUN_REGISTRY_VERSION, 2);
	assert.equal(typeof externalRuns.registerExternalRun, "function");
	assert.equal(typeof externalRuns.updateExternalRun, "function");
	assert.equal(typeof externalRuns.snapshotExternalRuns, "function");
	assert.equal(typeof externalRuns.unregisterExternalRun, "function");
	const capability = await import("@dev-sergeev/pi-subagents/capability-ceiling");
	const workflowResources = await import("@dev-sergeev/pi-subagents/workflow-resources");
	assert.deepEqual(Object.keys(workflowResources), ["registerWorkflowResource"]);
	assert.equal(typeof workflowResources.registerWorkflowResource, "function");
	assert.equal(capability.SUBAGENT_CAPABILITY_CEILING_VERSION, 1);
	assert.equal(capability.SUBAGENT_CAPABILITY_CEILING_REGISTRY_KEY, "pi-subagents.capability-ceiling.v1");
	const delegation = await import("@dev-sergeev/pi-subagents/delegation");
	assert.equal(delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, "prompt-template:subagent:request");
	const preflight = await import("@dev-sergeev/pi-subagents/preflight");
	assert.equal(preflight.SUBAGENT_LAUNCH_CONTRACT_VERSION, 3);
	assert.equal(typeof preflight.resolveSubagentLaunchContract, "function");
	const controlChannel = await import("@dev-sergeev/pi-subagents/control-channel");
	assert.equal(typeof controlChannel.requestAsyncStop, "function");
	const intercomBridge = await import("@dev-sergeev/pi-subagents/intercom-bridge");
	assert.equal(typeof intercomBridge.resolveIntercomSessionTarget, "function");
	const childToolPlan = await import("@dev-sergeev/pi-subagents/child-tool-plan");
	assert.equal(typeof childToolPlan.resolvePiLaunchToolPlan, "function");
	assert.deepEqual(Object.keys(childToolPlan).sort(), ["resolvePiLaunchToolPlan"]);
	const sharedTypes = await import("@dev-sergeev/pi-subagents/shared-types");
	assert.equal(typeof sharedTypes.wrapForkTask, "function");
	assert.equal(typeof sharedTypes.DEFAULT_FORK_PREAMBLE, "string");
	assert.equal("TEMP_ROOT_DIR" in sharedTypes, false);
	const projectPanes = await import("@dev-sergeev/pi-subagents/project-panes");
	assert.equal(projectPanes.PROJECT_PANES_API_VERSION, 1);
	assert.equal(typeof projectPanes.openProjectPane, "function");
	assert.equal(typeof projectPanes.getProjectPaneStatus, "function");
	assert.equal(typeof projectPanes.closeProjectPane, "function");
});

test("direct @earendil-works runtime imports are declared for CI installs", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
	const declared = new Set([
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.devDependencies ?? {}),
		...Object.keys(packageJson.peerDependencies ?? {}),
	]);
	const imported = new Set<string>();

	for (const file of [...collectSourceFiles(path.join(projectRoot, "src")), ...collectSourceFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		for (const match of source.matchAll(sourceImportPattern)) {
			const specifier = match[1] ?? match[2]!;
			imported.add(specifier.split("/").slice(0, 2).join("/"));
		}
	}

	const missing = [...imported].filter((specifier) => !declared.has(specifier)).sort();
	assert.deepEqual(missing, []);
});

test("direct dependency declarations are exact version pins", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	for (const section of ["dependencies", "devDependencies"] as const) {
		for (const [name, version] of Object.entries<string>(packageJson[section] ?? {})) {
			assert.match(version, exactVersionPattern, `${section}.${name} should use an exact version`);
		}
	}
});


test("old pi package scope is not used by source or tests", () => {
	for (const file of [...collectSourceFiles(path.join(projectRoot, "src")), ...collectSourceFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(oldPiScopePattern.test(source), false, file);
	}
});

test("Pi package resolution stays export-map safe", () => {
	for (const file of [...collectSourceFiles(path.join(projectRoot, "src")), ...collectSourceFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(piPackageJsonSubpathPattern.test(source), false, `${file} should not resolve unexported package.json subpaths`);
		assert.equal(cjsPiPackageResolutionPattern.test(source), false, `${file} should not use CommonJS resolution for ESM-only Pi packages`);
	}
});
