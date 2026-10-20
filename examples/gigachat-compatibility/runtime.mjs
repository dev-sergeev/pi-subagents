import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const StringValue = Compile(Type.String());

const secrets = new Set();
export function rememberSecret(value) {
	if (StringValue.Check(value) && value.length >= 8) secrets.add(value);
}

// Reject rather than redact evidence: successful files retain the complete safe value.
export function writeEvidence(file, value) {
	const text = StringValue.Check(value) ? value : `${JSON.stringify(value, null, 2)}\n`;
	if ([...secrets].some((secret) => text.includes(secret)) || /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{12,}/i.test(text)) {
		throw new Error("Refusing to persist evidence containing authentication material.");
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
}

export function packageModule(root, relative) {
	for (const extension of [".ts", ".js"]) {
		const file = path.join(root, `${relative}${extension}`);
		if (fs.existsSync(file)) return pathToFileURL(file).href;
	}
	throw new Error(`Prerequisite missing: package module ${relative} (.ts or .js).`);
}

export async function closeSession(session) {
	if (!session) return;
	try {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}

// Boot the installed provider through a real Pi loader/session. No credential files
// are copied, no provider converter is reimplemented, and no model is invented.
export async function openRuntime(values) {
	if (!values.provider || !values.model) throw new Error("Prerequisite missing: --provider /absolute/path/to/installed/extension.js and --model provider/model are required.");
	const packageRoot = path.resolve(values["package-root"] ?? path.join(import.meta.dirname, "../.."));
	const providerEntry = path.resolve(values.provider);
	const agentDir = path.resolve(values["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
	let provider;
	try {
		provider = await import(pathToFileURL(providerEntry).href);
	} catch {
		throw new Error("Prerequisite missing: installed Pi SDK and GigaChat provider must import with mutually compatible peer APIs (provider import failed).");
	}
	if (!provider.default || !sdk.ModelRuntime || !sdk.createAgentSession) throw new Error("Prerequisite missing: provider extension factory and compatible Pi SDK session APIs.");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let session;
	let stage = "Pi ModelRuntime initialization";
	try {
		const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
		const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const cwd = packageRoot;
		const loader = new sdk.DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [provider.default],
		});
		stage = "installed provider extension registration";
		await loader.reload();
		if (loader.getExtensions().errors.length) throw new Error("Provider extension registration failed.");
		stage = "real SDK provider session creation";
		({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime, sessionManager: sdk.SessionManager.inMemory(cwd), noTools: "builtin" }));
		const errors = [];
		stage = "installed provider session_start registration";
		await session.bindExtensions({ mode: "print", onError: () => errors.push(true) });
		if (errors.length) throw new Error("Provider extension startup failed.");
		stage = `saved model resolution (${runtime.getRegisteredProviderIds().length} registered providers)`;
		const slash = values.model.indexOf("/");
		if (slash < 1) throw new Error("Expected provider/model.");
		const providerId = values.model.slice(0, slash);
		const model = runtime.getModel(providerId, values.model.slice(slash + 1));
		if (!model) throw new Error("Requested saved provider model is unavailable.");
		stage = "real provider access-token resolution";
		const resolution = await runtime.getAuth(model);
		if (!resolution?.auth.apiKey) throw new Error("Provider could not resolve a real access token.");
		const auth = resolution.auth;
		rememberSecret(auth.apiKey);
		const bound = runtime.streamSimple.bind(runtime);
		return {
			sdk, runtime, model, packageRoot, providerEntry, agentDir, auth,
			setFetch(fetch) {
				runtime.streamSimple = (requestModel, context, options) => bound(requestModel, context, { ...options, fetch, maxRetries: 0, env: { ...options?.env, GIGACHAT_STREAM: "false", GIGACHAT_MAX_RETRIES: "0" } });
			},
			async dispose() {
				try { await closeSession(session); }
				finally {
					if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				}
			},
		};
	} catch {
		try { await closeSession(session); }
		finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		throw new Error(`Prerequisite missing at ${stage}: compatible Pi/provider APIs, a saved --model from /gigachat, and valid credentials in --agent-dir are required. No inference or validator success is claimed.`);
	}
}

// Separate diagnostic boundary. The faux provider is explicit and cannot be
// mistaken for real Pi -> GigaChat evidence in either manifest or validator run.
export async function openSdkRuntime(values, root) {
	const packageRoot = path.resolve(values["package-root"] ?? path.join(import.meta.dirname, "../.."));
	const faux = ai.fauxProvider({ provider: "sdk-declarations-only", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	const runtime = await sdk.ModelRuntime.create({ authPath: path.join(root, "empty-auth.json"), modelsPath: null, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	return {
		sdkOnly: true, sdk, runtime, model: faux.getModel("local"), packageRoot,
		setSdkCapture(capture) {
			faux.setResponses(Array.from({ length: 32 }, () => (context) => {
				capture((context.tools ?? []).map(({ name, description, parameters }) => ({ name, description, parameters })));
				return ai.fauxAssistantMessage("SDK-only declaration capture. This scripted response is not GigaChat inference.");
			}));
		},
		async dispose() {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		},
	};
}

export const runtimeOptions = {
	provider: { type: "string" }, model: { type: "string" },
	"package-root": { type: "string" }, "agent-dir": { type: "string" },
};
