import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { registerWorkflowResource } from "../../src/api/workflow-resources.ts";
import { flattenSubagentToolOptions } from "../../src/extension/subagent-options.ts";
import { resolveDisabledFeatureSurface } from "../../src/shared/disabled-features.ts";
import { makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { available, createSubagentExecutor, installSingleExecutionHooks, makeExecutor, mockPi, tempDir } from "../support/single-execution-fixture.ts";

const disabledConfig = { disabledFeatures: ["workflow-scripts"] };

// Exercise the same model-input lowering and execution boundary used by parent and fanout tools.
describe("GigaChat model execution contract", { skip: !available || !createSubagentExecutor }, () => {
	installSingleExecutionHooks();

	it("selects the owning reply block, a cwd-relative file, and a named resource", async () => {
		const ctx = makeMinimalCtx(tempDir);
		const callId = "source-call";
		const replyContext = {
			...ctx,
			sessionManager: {
				...ctx.sessionManager,
				getBranch: () => [{ type: "message", message: { role: "assistant", content: [
					{ type: "text", text: "```js workflow\nreturn {source: 'reply', marker: args.marker};\n```" },
					{ type: "toolCall", name: "subagent", id: callId, arguments: { workflow: "true" } },
				] } }],
			},
		};
		fs.mkdirSync(path.join(tempDir, "flows"));
		fs.writeFileSync(path.join(tempDir, "flows", "source.js"), "return {source: 'file', marker: args.marker};");
		const registration = registerWorkflowResource({ sessionId: ctx.sessionManager.getSessionId(), definition: {
			name: "test.source", version: 1,
			resolve: (args) => ({ script: `return {source: 'resource', marker: ${JSON.stringify(args.marker)}};` }),
		} });
		try {
			for (const [workflow, source] of [["true", "reply"], ["./flows/source.js", "file"], ["test.source", "resource"]]) {
				const result = await makeExecutor([]).executePublic(callId, flattenSubagentToolOptions({
					workflow, args: { marker: "selected" }, cwd: tempDir, async: false,
					options: { mission: false, chatProgress: "off" },
				}), new AbortController().signal, undefined, replyContext);
				assert.equal(result.isError, undefined, result.content[0]?.text);
				assert.deepEqual(result.details.workflow?.value, { source, marker: "selected" });
			}
		} finally { registration.dispose(); }
	});

	for (const mode of ["single", "workflow", "structured"] as const) {
		for (const output of [undefined, "true", "false", "explicit"] as const) {
			it(`${mode}: ${output ?? "omitted"} output preserves saving and inheritance`, async () => {
				const configured = path.join(tempDir, "configured.md");
				const explicit = path.join(tempDir, "explicit.md");
				const value = output === "explicit" ? explicit : output;
				const config = mode === "structured" ? disabledConfig : {};
				const disabled = resolveDisabledFeatureSurface(config);
				mockPi.onCall({ output: "saved model result" });
				const scriptFile = path.join(tempDir, "output.js");
				if (mode === "workflow") fs.writeFileSync(scriptFile, 'return runs.run("child", {agent:"echo", task:"Return the result", async:false});');
				const execution = mode === "single" ? { agent: "echo", task: "Return the result" }
					: mode === "workflow" ? { workflow: scriptFile }
					: { tasks: [{ agent: "echo", task: "Return the result" }] };
				const input: Parameters<typeof flattenSubagentToolOptions>[0] = {
					...execution, async: false,
					options: { acceptance: false, mission: false, chatProgress: "off" },
				};
				if (value !== undefined) input.output = value;
				const result = await makeExecutor([makeAgent("echo", { output: configured })], config).executePublic("output-call", flattenSubagentToolOptions(input, disabled), new AbortController().signal, undefined, makeMinimalCtx(tempDir));
				assert.equal(result.isError, undefined, result.content[0]?.text);
				const child = result.details.results[0]!;
				if (output === "false") {
					assert.equal(child.savedOutputPath, undefined);
					assert.equal(fs.existsSync(configured), false);
				} else {
					assert.ok(child.savedOutputPath);
					assert.equal(fs.readFileSync(child.savedOutputPath, "utf8"), "saved model result");
					if (output !== "explicit") assert.equal(child.savedOutputPath, configured);
					else if (mode === "single") assert.equal(child.savedOutputPath, explicit);
					else assert.equal(fs.existsSync(explicit), true, "the explicit workflow aggregate is saved too");
				}
			});
		}
	}
});

describe("workflow output sentinel precedence", { skip: !available || !createSubagentExecutor }, () => {
	installSingleExecutionHooks();

	for (const mode of ["parallel", "sequential", "structured"] as const) {
		it(`isolates inherited configured outputs with output true in ${mode} launches`, async () => {
			mockPi.onCall({ matchArgIncludes: "First report", output: "FIRST" });
			mockPi.onCall({ matchArgIncludes: "Second report", output: "SECOND" });
			const config = mode === "structured" ? disabledConfig : {};
			const tasks = [{ agent: "echo", task: "First report" }, { agent: "echo", task: "Second report" }];
			const file = path.join(tempDir, "multi.js");
			if (mode === "parallel") fs.writeFileSync(file, `return runs.all(${JSON.stringify(tasks.map((task, index) => ({ key: `child-${index}`, ...task, async: false })))});`);
			if (mode === "sequential") fs.writeFileSync(file, `await runs.run("first", ${JSON.stringify({ ...tasks[0], async: false })}); return runs.run("second", ${JSON.stringify({ ...tasks[1], async: false })});`);
			const result = await makeExecutor([makeAgent("echo", { output: path.join(tempDir, "configured.md") })], config).executePublic("multi-output", flattenSubagentToolOptions({
				...(mode === "structured" ? { tasks } : { workflow: file }), output: "true", async: false,
				options: { acceptance: false, mission: false, chatProgress: "off" },
			}, resolveDisabledFeatureSurface(config)), new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined, result.content[0]?.text);
			const paths = result.details.results.map((child) => child.savedOutputPath);
			assert.equal(new Set(paths).size, 2);
			assert.deepEqual(paths.map((file) => fs.readFileSync(file!, "utf8")).sort(), ["FIRST", "SECOND"]);
		});
	}

	it("preserves the original report when output true is inherited by a retained resume", async () => {
		const configured = path.join(tempDir, "original.md");
		mockPi.onCall({ matchArgIncludes: "First retained report", output: "ORIGINAL" });
		mockPi.onCall({ matchArgIncludes: "Continue retained report", output: "FOLLOWUP" });
		const file = path.join(tempDir, "resume.js");
		fs.writeFileSync(file, 'const writer = await runs.run("writer", {agent:"echo", task:"First retained report", async:false}); return runs.run("followup", {resume:writer.runId, task:"Continue retained report"});');
		const result = await makeExecutor([makeAgent("echo", { output: configured })]).executePublic("resume-output", flattenSubagentToolOptions({
			workflow: file, output: "true", async: false, options: { acceptance: false, mission: false, chatProgress: "off" },
		}), new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(fs.readFileSync(configured, "utf8"), "ORIGINAL");
		const followup = result.details.results.at(-1)!;
		assert.notEqual(followup.savedOutputPath, configured);
		assert.equal(fs.readFileSync(followup.savedOutputPath!, "utf8"), "FOLLOWUP");
	});

	it("keeps explicit child output overrides under a default-disabled workflow", async () => {
		const configured = path.join(tempDir, "configured.md");
		const explicit = path.join(tempDir, "explicit.md");
		for (const marker of ["DISABLED", "DEFAULT", "EXPLICIT"]) mockPi.onCall({ matchArgIncludes: marker, output: marker });
		const file = path.join(tempDir, "overrides.js");
		fs.writeFileSync(file, `return runs.all([
			{key:"disabled", agent:"echo", task:"DISABLED", async:false},
			{key:"default", agent:"echo", task:"DEFAULT", output:"true", async:false},
			{key:"explicit", agent:"echo", task:"EXPLICIT", output:${JSON.stringify(explicit)}, async:false}
		]);`);
		const result = await makeExecutor([makeAgent("echo", { output: configured })]).executePublic("override-output", flattenSubagentToolOptions({
			workflow: file, output: "false", async: false, options: { acceptance: false, mission: false, chatProgress: "off" },
		}), new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, undefined, result.content[0]?.text);
		const children = result.details.results;
		const disabled = children.find((child) => child.workflowKey === "disabled");
		assert.ok(disabled, "The default-disabled child still executes");
		assert.equal(disabled.exitCode, 0);
		assert.equal(disabled.savedOutputPath, undefined);
		assert.equal(fs.readFileSync(configured, "utf8"), "DEFAULT");
		assert.equal(fs.readFileSync(explicit, "utf8"), "EXPLICIT");
	});
});
