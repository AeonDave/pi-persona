import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerDelegateTool, type DelegateToolDeps } from "../../../src/tools/delegate-tool.ts";
import { coerceDelegateParams, specOf, validateDelegationBrief } from "../../../src/tools/delegate.ts";
import { tempDir } from "../../setup/temp-dir.ts";

function registeredDelegate(): ToolDefinition {
	let captured: ToolDefinition | undefined;
	registerDelegateTool({ registerTool: (tool: ToolDefinition) => { captured = tool; } } as ExtensionAPI, {
		RUN_LIMITS: { maxChildren: 64, maxConcurrency: 4, timeoutMs: 180_000 },
		config: { ledgerV2: false }, tracker: { onComplete: () => {} },
	} as unknown as DelegateToolDeps);
	assert.ok(captured);
	return captured;
}

const brief = {
	objective: "Find the cause", scopeRoe: "This repository only", position: "Current checkout",
	constraints: ["No edits"], requiredArtifacts: ["file:line evidence"], stopConditions: ["Cause or missing evidence"],
};

function validated(tool: ToolDefinition, raw: unknown) {
	assert.ok(tool.prepareArguments, "the host must decode nested JSON before canonical schema validation");
	const args = validateToolArguments(tool, { type: "toolCall", id: "probe", name: "delegate", arguments: tool.prepareArguments(raw) as ToolCall["arguments"] });
	const result = coerceDelegateParams(args);
	assert.ok(result.ok, result.ok ? undefined : result.error);
	return result.params;
}

test("delegate publishes canonical nested objects and lists instead of JSON-string alternatives", () => {
	const schema = registeredDelegate().parameters as unknown as { properties: Record<string, { type?: string; items?: { type?: string; properties?: Record<string, { type?: string }> } }> };
	assert.equal(schema.properties.brief?.type, "object");
	assert.equal(schema.properties.tasks?.type, "array");
	assert.equal(schema.properties.tasks?.items?.type, "object");
	for (const field of ["skills", "tools", "writeSet"]) {
		assert.equal(schema.properties[field]?.type, "array");
		assert.equal(schema.properties.tasks?.items?.properties?.[field]?.type, "array");
	}
});

test("single and batch workers advertise the effective idle window and how to size a quiet tool call", () => {
	const { properties } = registeredDelegate().parameters as unknown as {
		properties: { timeoutMs: { description: string }; tasks: { items: { properties: { timeoutMs: { description: string } } } } };
	};
	for (const field of [properties.timeoutMs, properties.tasks.items.properties.timeoutMs]) {
		assert.match(field.description, /180000 ms/);
		assert.match(field.description, /silence|silent/i);
	}
});

test("a batch reports a misplaced positive idle override before launching with the default", () => {
	const worker = { agent: "operator", task: "Wait for completion" };
	for (const tasks of [[worker], JSON.stringify([worker])]) {
		const result = coerceDelegateParams({ tasks, timeoutMs: 400_000 });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /tasks\[\]\.timeoutMs/);
	}
	const { tasks } = validated(registeredDelegate(), { tasks: [{ ...worker, timeoutMs: 400_000 }, worker] });
	assert.equal(specOf(tasks![0]!).timeoutMs, 400_000);
	assert.equal(specOf(tasks![1]!).timeoutMs, undefined);
});

test("verification survives native and encoded single/batch calls and is copied into the run spec", () => {
	const tool = registeredDelegate();
	const verification = { command: "npm test", timeoutMs: 60_000 };
	const task = { agent: "operator", task: "Fix the regression", isolation: "worktree" as const, verification };
	for (const raw of [task, { ...task, verification: JSON.stringify(verification) }]) {
		const params = validated(tool, raw);
		assert.deepEqual(params.verification, verification);
		const spec = specOf({ ...params, agent: task.agent, task: task.task });
		assert.deepEqual(spec.verification, verification);
		assert.notEqual(spec.verification, params.verification);
	}
	for (const tasks of [[task], JSON.stringify([task]), [{ ...task, verification: JSON.stringify(verification) }]]) {
		assert.deepEqual(validated(tool, { tasks }).tasks?.[0]?.verification, verification);
	}
});

test("malformed verification cannot be silently ignored before worker admission", () => {
	const tool = registeredDelegate();
	for (const [verification, cause] of [
		[{ command: "" }, /command must be non-empty/],
		[{ command: "npm test", cwd: "elsewhere" }, /accepts only command and timeoutMs/],
		[{ command: "npm test", timeoutMs: 0 }, /timeoutMs must be an integer/],
		[{ command: "npm test", timeoutMs: 1.5 }, /timeoutMs must be an integer/],
	] as const) {
		for (const [raw, field] of [
			[{ agent: "operator", task: "Fix", verification }, "verification"],
			[{ tasks: [{ agent: "operator", task: "Fix", verification }] }, "tasks\\[0\\]\\.verification"],
		] as const) {
			// A clean, field-naming rejection — not any crash that happens to throw.
			assert.throws(() => validated(tool, raw), { name: "Error", message: new RegExp(`^delegate: ${field}: verification ${cause.source}`) });
			assert.equal(coerceDelegateParams(raw).ok, false);
		}
	}
});

test("SDK validation accepts native and JSON-encoded delegates with identical effective arguments", () => {
	const tool = registeredDelegate();
	const task = { agent: "scout", task: "Inspect", brief, tools: ["read", "grep"], mcp: false, timeoutMs: 0 };
	const expected = { tasks: [task], concurrency: 1 };
	for (const raw of [expected, { tasks: JSON.stringify([task]), concurrency: 1 }, { tasks: [JSON.stringify(task)], concurrency: 1 },
		{ tasks: [{ ...task, brief: JSON.stringify(brief), tools: JSON.stringify(task.tools) }], concurrency: 1 }]) {
		assert.deepEqual(validated(tool, raw), expected);
	}
	assert.deepEqual(validated(tool, { agent: "operator", task: "No tools", tools: [], skills: [], writeSet: [], mcp: false, timeoutMs: 0 }),
		{ agent: "operator", task: "No tools", tools: [], skills: [], writeSet: [], mcp: false, timeoutMs: 0 });
	assert.deepEqual(validated(tool, { resume: "run-1", task: "Follow up" }), { resume: "run-1", task: "Follow up" });
});

test("preparation preserves the host's native optional-null and primitive coercion", () => {
	const tool = registeredDelegate();
	assert.deepEqual(validated(tool, { agent: "scout", task: "Inspect", brief: null, tools: null, tasks: null, thinking: null }),
		{ agent: "scout", task: "Inspect" });
	assert.deepEqual(validated(tool, { tasks: [{ agent: "scout", task: "Inspect", mcp: "false", timeoutMs: "100", tools: null }] }),
		{ tasks: [{ agent: "scout", task: "Inspect", mcp: false, timeoutMs: 100 }] });
	assert.deepEqual(validated(tool, { agent: "scout", task: "Inspect", brief: { ...brief, objective: 42 } }).brief?.objective, "42");
});

test("JSON-encoded malformed or non-object requests never become valid defaults", () => {
	const tool = registeredDelegate();
	assert.ok(tool.prepareArguments);
	for (const [raw, cause] of [
		[null, /^delegate: arguments must be an object\./],
		[[], /^delegate: arguments must be an object\./],
		["{}", /^delegate: arguments must be an object\./],
		[{ tasks: "[{" }, /^delegate: tasks looks like JSON but did not parse/],
		[{ tasks: ["not JSON"] }, /^delegate: tasks\[0\] must be an object\./],
		[{ tasks: "[null]" }, /^delegate: tasks\[0\] must be an object\./],
		[{ agent: "scout", task: "Inspect", brief: "{" }, /^delegate: brief looks like JSON but did not parse/],
		[{ tasks: JSON.stringify([{ agent: "scout", task: "Inspect", mcp: "false" }]) }, /^delegate: tasks\[0\]\.mcp must be a boolean\./],
		[{ agent: "scout", task: "Inspect", brief: JSON.stringify({ ...brief, objective: 42 }) }, /^delegate: brief\.objective must be a string\./],
	] as const) {
		// A clean, field-naming rejection — not any crash that happens to throw.
		assert.throws(() => validated(tool, raw), { name: "Error", message: cause }, JSON.stringify(raw));
	}
});

test("decoding neither fills policy-required briefs nor inherits top-level grants into a batch", () => {
	const tool = registeredDelegate();
	const raw = { tasks: [{ agent: "operator", task: "Read only" }, { agent: "operator", task: "Read only" }], tools: ["read"], brief };
	const params = validated(tool, raw);
	assert.deepEqual(params.tasks, raw.tasks);
	assert.match(validateDelegationBrief(params) ?? "", /tasks\[\]\.brief/);
	assert.deepEqual(raw.tasks, [{ agent: "operator", task: "Read only" }, { agent: "operator", task: "Read only" }]);
});

test("real Pi prepares delegate calls both directly and through native codemode", { timeout: 30_000 }, async () => {
	const cwd = tempDir("persona-delegate-schema-sdk-");
	const agentDir = tempDir("persona-delegate-schema-profile-");
	const accepted: unknown[] = [];
	const parents: Array<string | undefined> = [];
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, codemode: { mode: "on" } });
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager: settings, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [
			(pi) => {
				// Keep the real published schema and preparation hook; observe admission without launching a worker.
				pi.registerTool({ ...registeredDelegate(), execute: async (_id, args) => {
					accepted.push(args);
					return { content: [{ type: "text", text: "accepted" }], details: {} };
				} });
				pi.on("tool_call", (event) => { if (event.toolName === "delegate") parents.push(event.parentToolCallId); });
			},
			createCodemodeExtension(),
		],
	});
	await loader.reload();
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "synthetic-auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "synthetic-models.json"),
		refreshOnCreate: false, allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "delegate-schema-test", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("delegate-schema-test", "synthetic-key-never-transmitted");
	const model = runtime.getModel("delegate-schema-test", "offline");
	assert.ok(model);
	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd), settingsManager: settings, tools: ["delegate", "codemode"] }));
		await session.bindExtensions({ mode: "print" });
		const task = { agent: "scout", task: "Inspect", brief, tools: ["read"], mcp: false };
		const raw = { tasks: JSON.stringify([task]) };
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("delegate", raw), { stopReason: "toolUse" }), fauxAssistantMessage("done"),
			fauxAssistantMessage(fauxToolCall("codemode", { code: `text(await tools.delegate(${JSON.stringify(raw)}));` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("Delegate directly.");
		await session.prompt("Delegate through codemode.");
		assert.deepEqual(accepted, [{ tasks: [task] }, { tasks: [task] }]);
		assert.equal(parents.length, 2);
		assert.equal(parents[0], undefined);
		assert.equal(typeof parents[1], "string", "the second call took Pi's nested tool pipeline");
	} finally {
		try { await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
		finally { session?.dispose(); }
	}
});
