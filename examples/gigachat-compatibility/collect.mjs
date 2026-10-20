import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { closeSession, openRuntime, openSdkRuntime, packageModule, rememberSecret, runtimeOptions, StringValue, writeEvidence } from "./runtime.mjs";

// Declaration-only acceptance, NOT a live smoke. The real installed provider
// performs conversion and serialization. Its supported fetch option intercepts
// the final POST; no chat request is sent and no assistant response is fabricated.
// subagents_enable is invoked directly through its real SDK definition, not by a
// model decision. Herdr registration uses a local bridge, not a remote Herdr host.
const help = `Usage: node examples/gigachat-compatibility/collect.mjs
  --provider /absolute/path/to/installed/pi-gigachat/extension.js
  --model provider/model --out /private/new/evidence-directory
  [--package-root /path/to/source-or-built-package] [--agent-dir ~/.pi/agent]

Use Node 24 with compatible Pi/GigaChat peers and saved /gigachat credentials.
For source packages, retain the repository's TypeScript loader if required.
No paid inference is performed. OAuth refresh may contact the auth endpoint.
The output is provider function evidence, not behavioral/live-smoke evidence.
No credentials, request headers, prompts, or model histories are persisted.
An absent model/auth/API or missing outgoing functions is a hard prerequisite failure.

Diagnostic alternative: --sdk-only --out /private/new/sdk-evidence-directory
Uses actual SDK registrations and an explicitly scripted faux provider.
It does NOT exercise GigaChat conversion and is NOT Pi -> GigaChat acceptance.
`;
const { values } = parseArgs({ options: { ...runtimeOptions, out: { type: "string" }, "sdk-only": { type: "boolean" }, help: { type: "boolean" } } });
if (values.help) { console.log(help); process.exit(0); }
if (!values.out) throw new Error("--out is required. Use --help for prerequisites and boundary details.");
const out = path.resolve(values.out);
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.mkdirSync(out, { mode: 0o700 }); // Refuse reusing an evidence run.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pgc-"));
const cases = [];
const scenarios = [];
const packageTools = new Set(["subagent", "subagents_enable", "bg_wait", "contact_supervisor", "subagent_supervisor", "subagent_command", "watchdog_warn", "watchdog_ask", "watchdog_permission_decision", "watchdog_diff", "structured_output", "bash"]);
let host;
let activeScenario;
let sdkRequestCount = 0;
let boundaryCount = 0;
let captureFailure;
const hash = (value) => createHash("sha256").update(value).digest("hex");

try {
	host = values["sdk-only"] ? await openSdkRuntime(values, root) : await openRuntime(values);
	const { sdk, runtime, model, packageRoot } = host;
	const originalStreamSimple = runtime.streamSimple.bind(runtime);
	function recordFunctions(functions) {
		for (const fn of functions) {
			if (!packageTools.has(fn.name)) continue;
			const id = `${String(cases.length + 1).padStart(3, "0")}-${activeScenario}-${fn.name}`;
			const file = `functions/${id}.json`;
			writeEvidence(path.join(out, file), fn);
			cases.push({ id, scenario: activeScenario, name: fn.name, file, sha256: hash(JSON.stringify(fn)) });
		}
	}
	if (host.sdkOnly) host.setSdkCapture(recordFunctions);
	else host.setFetch(async (input, init) => {
		boundaryCount++;
		const url = new URL(StringValue.Check(input) || input instanceof URL ? input : input.url);
		if (!url.pathname.endsWith("/chat/completions") || init?.method !== "POST") throw new Error("Declaration collector refuses non-chat requests at the capture boundary.");
		const headers = new Headers(init.headers);
		rememberSecret(headers.get("authorization")?.replace(/^Bearer\s+/i, ""));
		try {
			const body = JSON.parse(init.body);
			if (!Array.isArray(body.functions) || body.functions.length === 0) throw new Error("Installed provider produced no outgoing functions. Its Pi transcript/tool API is incompatible; install mutually compatible peers, not a collector schema transform.");
			recordFunctions(body.functions);
		} catch (error) { captureFailure = error; }
		// Deliberate terminal error, never a mock successful completion.
		throw new Error("Declaration-only request intercepted before network inference; no model request was sent.");
	});
	const capturingStreamSimple = runtime.streamSimple.bind(runtime);
	runtime.streamSimple = (requestModel, context, options) => {
		sdkRequestCount++;
		return capturingStreamSimple(requestModel, context, options);
	};
	// Kept only for restoration; no direct provider/converter invocation is used.
	const restoreStream = () => { runtime.streamSimple = originalStreamSimple; };
	const load = (relative) => import(packageModule(packageRoot, relative));
	const register = (await load("index")).default;
	const { createChildHooks } = await load("src/runs/shared/child-hooks");
	const { createChildCommandRuntime } = await load("src/runs/shared/child-commands");
	const { createMainWatchdogReview } = await load("src/watchdog/review");
	const { createWatchdogPermissionArbiter } = await load("src/watchdog/permission-arbiter");
	const { DEFAULT_WATCHDOG_CONFIG } = await load("src/watchdog/settings");
	const { resolveChildWatchdogConfig } = await load("src/watchdog/child-status");
	const { captureWatchdogDiffBaseline } = await load("src/watchdog/diff-tool");

	async function capture(name, expected, work) {
		activeScenario = name;
		captureFailure = undefined;
		const before = cases.length;
		const beforeRequests = sdkRequestCount;
		const beforeBoundaries = boundaryCount;
		try { await work(); } catch { /* Pi/provider may propagate the intentional capture error. */ }
		if (captureFailure) throw captureFailure;
		const received = new Set(cases.slice(before).map((entry) => entry.name));
		const missing = expected.filter((tool) => !received.has(tool));
		if (missing.length) throw new Error(`Prerequisite/capture failure in ${name}: missing ${missing.join(", ")}; SDK requests=${sdkRequestCount - beforeRequests}, provider HTTP boundaries=${boundaryCount - beforeBoundaries}. No successful inference is claimed.`);
		scenarios.push({ name, expected, received: [...received], sdkRequests: sdkRequestCount - beforeRequests, providerHttpBoundaries: boundaryCount - beforeBoundaries });
	}

	async function withSession(name, config, factories, work) {
		const cwd = path.join(root, name, "project");
		const agentDir = path.join(root, name, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify(config));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const loader = new sdk.DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: Array.isArray(factories) ? factories : factories(cwd, agentDir),
		});
		let session;
		try {
			await loader.reload();
			if (loader.getExtensions().errors.length) throw new Error("Package extension registration failed.");
			({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime, model, noTools: "builtin", sessionManager: sdk.SessionManager.inMemory(cwd) }));
			const errors = [];
			await session.bindExtensions({ mode: "print", onError: () => errors.push(true) });
			if (errors.length) throw new Error("Package extension startup failed.");
			await work(session);
		} finally { await closeSession(session); }
	}

	await withSession("activation", { toolActivation: "dynamic" }, [register], async (session) => {
		await capture("cold-loader", ["subagents_enable"], () => session.prompt("Declare the available delegation tools."));
		const tool = session.getToolDefinition("subagents_enable");
		if (!tool) throw new Error("subagents_enable was not registered by the package.");
		await tool.execute("compatibility-activation", {}, undefined, undefined, session.extensionRunner.createContext());
		await capture("ordinary", ["subagent", "bg_wait", "subagent_supervisor"], () => session.prompt("Declare activated delegation tools."));
	});
	await withSession("structured-workflows", { toolActivation: "eager", disabledFeatures: ["workflow-scripts"] }, [register], (session) => capture("structured-workflows", ["subagent", "bg_wait", "subagent_supervisor"], () => session.prompt("Declare structured workflow delegation tools.")));

	const baseChild = { fanoutChild: false, depth: 1, waitTool: { enabled: true }, fast: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false };
	for (const structured of [false, true]) {
		const name = structured ? "fanout-structured-workflows" : "fanout";
		const config = { toolActivation: "eager" };
		if (structured) config.disabledFeatures = ["workflow-scripts"];
		await withSession(name, config, (cwd) => createChildHooks({ ...baseChild, cwd, fanoutChild: true, runId: name, agent: "compatibility-child", childIndex: 0, orchestratorSessionId: "compatibility-parent", supervisorChannelDir: path.join(root, name, "supervisor") }), (session) => capture(name, ["subagent", "bg_wait", "subagent_supervisor", "contact_supervisor"], () => session.prompt("Declare fanout child tools.")));
	}

	let commands;
	try {
		await withSession("native-child", {}, (cwd) => {
			commands = createChildCommandRuntime(path.join(root, "commands"));
			return [...createChildHooks({ ...baseChild, cwd, runId: "compatibility-native", agent: "compatibility-child", childIndex: 0, orchestratorSessionId: "compatibility-parent", supervisorChannelDir: path.join(root, "native-supervisor") }), { name: "pi-subagents:commands", factory(pi) { pi.registerTool(commands.wrap(sdk.createBashTool(cwd))); pi.registerTool(commands.tool()); } }];
		}, (session) => capture("native-child", ["contact_supervisor", "bg_wait", "subagent_command", "bash"], () => session.prompt("Declare native child command and supervisor tools.")));
	} finally { await commands?.shutdown(); }

	for (const description of [false, true]) for (const report of [false, true]) {
		const name = `structured-output-${description ? "described" : "undescribed"}-${report ? "report" : "no-report"}`;
		const schema = { type: "object" };
		if (description) schema.description = "The compatibility fixture's verified result.";
		schema.properties = { ok: { type: "boolean" } };
		schema.required = ["ok"];
		schema.additionalProperties = false;
		const structuredOutput = { schema, capture() { throw new Error("Declaration collection must not execute structured_output."); } };
		if (report) structuredOutput.acceptanceReport = "required";
		await withSession(name, {}, (cwd) => createChildHooks({ ...baseChild, cwd, structuredOutput }), (session) => capture(name, ["structured_output"], () => session.prompt("Declare the structured result tool.")));
	}

	const herdr = await load("src/extension/herdr-pi-bridge");
	const protocol = await load("src/runs/shared/herdr-pi-protocol");
	const oldRun = process.env[protocol.HERDR_PI_RUN_ENV];
	const oldRuntime = process.env[protocol.HERDR_PI_RUNTIME_DIR_ENV];
	try {
		process.env[protocol.HERDR_PI_RUN_ENV] = "compatibility-herdr";
		process.env[protocol.HERDR_PI_RUNTIME_DIR_ENV] = fs.mkdtempSync(path.join(root, "herdr-"));
		await withSession("herdr", {}, [herdr.default], (session) => capture("herdr", ["contact_supervisor"], () => session.prompt("Declare the Herdr supervisor tool.")));
	} finally {
		if (oldRun === undefined) delete process.env[protocol.HERDR_PI_RUN_ENV]; else process.env[protocol.HERDR_PI_RUN_ENV] = oldRun;
		if (oldRuntime === undefined) delete process.env[protocol.HERDR_PI_RUNTIME_DIR_ENV]; else process.env[protocol.HERDR_PI_RUNTIME_DIR_ENV] = oldRuntime;
	}

	await withSession("watchdog", {}, [], async (session) => {
		const ctx = session.extensionRunner.createContext();
		const streamFn = (selectedModel, context, options) => runtime.streamSimple(selectedModel, context, options);
		const baseline = captureWatchdogDiffBaseline(packageRoot);
		if (!baseline) throw new Error("Prerequisite missing: --package-root must have a real Git HEAD baseline to collect the production watchdog_diff review variant.");
		const config = { ...structuredClone(DEFAULT_WATCHDOG_CONFIG), enabled: true };
		const review = createMainWatchdogReview(ctx, { diffBaseline: async () => baseline, streamFn });
		await capture("watchdog-review", ["watchdog_warn", "watchdog_ask", "watchdog_diff"], () => review({ delta: "Declaration-only compatibility collection.", epoch: 1, hasScope: false, reviewId: 1, config, allowClarification: true, emitWarning: () => { throw new Error("Declaration collection must not execute watchdog_warn."); } }));
		config.children.enabled = true;
		const childConfig = resolveChildWatchdogConfig({ config, agent: "compatibility-child" });
		const permission = createWatchdogPermissionArbiter({ streamFn });
		await capture("watchdog-permission", ["watchdog_permission_decision"], () => permission({ ctx, toolName: "write", args: { path: "compatibility.txt" }, rawWatchdogConfig: JSON.stringify(childConfig) }));
	});
	restoreStream();
	const evidence = {
		format: 1, complete: true, evidenceKind: host.sdkOnly ? "sdk-only-not-gigachat-acceptance" : "pi-gigachat-http-functions",
		capturedAt: new Date().toISOString(),
		boundary: host.sdkOnly ? "Real Pi SDK registrations -> scripted faux provider; NO GigaChat provider conversion or inference" : "Real Pi SDK -> installed GigaChat provider -> serialized HTTP POST functions; fetch intercepted before inference",
		inferenceExecuted: false, activation: "Actual registered subagents_enable.execute invoked directly with SDK context",
		herdr: "Local real bridge registration only; no remote Herdr execution",
		model: `${model.provider}/${model.id}`,
		packageVersion: JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version,
		scenarios, cases,
	};
	if (!host.sdkOnly) evidence.providerEntrySha256 = hash(fs.readFileSync(host.providerEntry));
	writeEvidence(path.join(out, "manifest.json"), evidence);
	console.log(`Captured ${cases.length} ${host.sdkOnly ? "SDK-only declarations (NOT GigaChat acceptance)" : "real provider functions"} across ${scenarios.length} scenarios. No inference was executed. Validate with validate.mjs.`);
} catch (error) {
	const message = error instanceof Error ? error.message : "Declaration collection failed.";
	writeEvidence(path.join(out, "failure.json"), { complete: false, evidenceKind: values["sdk-only"] ? "sdk-only-not-gigachat-acceptance" : "pi-gigachat-http-functions", message, completedScenarios: scenarios, capturedCases: cases, sdkRequests: sdkRequestCount, providerHttpBoundaries: boundaryCount, inferenceExecuted: false });
	console.error(message);
	process.exitCode = 1;
} finally {
	try { await host?.dispose(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
