import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { nativeToolNames, withNativeToolDefaults } from "../../src/extension/native-tools.ts";
import { makeCodeOutlineTool } from "../../src/tools/code-outline.ts";
import { makeInProcessEngine } from "../../src/engine/inproc.ts";
import piPersona from "../../src/extension.ts";

test("Pi SDK exposes native search and code-outline tools and runs them offline against the session cwd", { timeout: 20_000 }, async () => {
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	const root = await mkdtemp(join(tmpdir(), "pi-persona-native-tools-"));
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	await writeFile(join(cwd, "needle.txt"), "native-search-marker\n");
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
		modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	const faux = fauxProvider({ provider: "native-tools-offline", models: [{ id: "local" }] });
	runtime.registerNativeProvider(faux.provider);
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd, agentDir: root, settingsManager: settings,
		noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [(pi) => pi.registerTool(makeCodeOutlineTool())] });
	await loader.reload();
	const nativeNames = nativeToolNames([
		{ name: "grep", sourceInfo: { source: "builtin" } }, { name: "find", sourceInfo: { source: "builtin" } },
		{ name: "ls", sourceInfo: { source: "builtin" } }, { name: "powershell", sourceInfo: { source: "builtin" } },
	], process.platform);
	const tools = withNativeToolDefaults(undefined, nativeNames);
	const { session } = await createAgentSession({ cwd, agentDir: root, model: faux.models[0]!, modelRuntime: runtime,
		settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
		...(tools !== undefined ? { tools } : {}),
	});
	try {
		const names = session.agent.state.tools.map((tool) => tool.name);
		assert.ok(names.includes("grep"));
		assert.ok(names.includes("find"));
		assert.ok(names.includes("ls"));
		assert.equal(names.includes("powershell"), process.platform === "win32");
		assert.ok(names.includes("code_outline"), "the real SDK registers the local outline tool");
		const execute = async (name: string, params: Record<string, unknown>) => {
			const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
			assert.ok(tool, `${name} is callable`);
			return await tool.execute(`${name}-offline-proof`, params as never, new AbortController().signal);
		};
		const grep = await execute("grep", { pattern: "native-search-marker", path: "." });
		assert.match(grep.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /needle\.txt/);
		const find = await execute("find", { pattern: "*.txt", path: "." });
		assert.match(find.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /needle\.txt/);
		const ls = await execute("ls", { path: "." });
		assert.match(ls.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /needle\.txt/);
		await writeFile(join(cwd, "fixture.tsx"), "// function fake() {}\nclass Box { hiddenMethod() {} }\n");
		const tsx = await execute("code_outline", { path: "fixture.tsx" });
		assert.deepEqual((tsx.details as { symbols: Array<{ name: string }> }).symbols.map((symbol) => symbol.name), ["Box", "hiddenMethod"]);
		assert.match(tsx.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /language="TypeScript JSX" grammar="tsx"/);
		await writeFile(join(cwd, "fixture.py"), "# def fake():\ndef load():\n    class Worker:\n        def run(self):\n            pass\n");
		const python = await execute("code_outline", { path: "fixture.py" });
		assert.deepEqual((python.details as { symbols: Array<{ name: string; startLine: number; endLine: number }> }).symbols.map((symbol) => [symbol.name, symbol.startLine, symbol.endLine]), [["load", 2, 5], ["Worker", 3, 5], ["run", 4, 5]]);
		assert.match(python.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /language="Python" grammar="python"/);
		await writeFile(join(cwd, "fixture.cs"), "namespace N {\n class C { void M() {} }\n}\n");
		const csharp = await execute("code_outline", { path: "fixture.cs" });
		assert.deepEqual((csharp.details as { symbols: Array<{ name: string }> }).symbols.map((symbol) => symbol.name), ["N", "C", "M"]);
		assert.match(csharp.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /language="C#" grammar="c-sharp"/);
		if (process.platform === "win32") {
			const powershell = await execute("powershell", { command: 'Write-Output "PERSONA_NATIVE_PS_OK"' });
			assert.match(powershell.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /PERSONA_NATIVE_PS_OK/);
		}
		const restricted = await createAgentSession({ cwd, agentDir: root, model: faux.models[0]!, modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: [],
		});
		try {
			assert.deepEqual(restricted.session.agent.state.tools.map((tool) => tool.name), [], "explicit empty allowlist stays empty");
		} finally {
			await restricted.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			restricted.session.dispose();
		}
		const excludedTools = withNativeToolDefaults(undefined, nativeNames);
		const excluded = await createAgentSession({ cwd, agentDir: root, model: faux.models[0]!, modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), excludeTools: ["gr*"],
			...(excludedTools !== undefined ? { tools: excludedTools } : {}),
		});
		try {
			assert.ok(!excluded.session.agent.state.tools.some((tool) => tool.name === "grep"), "Pi's exclusion matcher remains authoritative");
			assert.ok(excluded.session.agent.state.tools.some((tool) => tool.name === "find"));
		} finally {
			await excluded.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			excluded.session.dispose();
		}
		assert.equal(faux.state.callCount, 0, "no provider requests");
	} finally {
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await rm(root, { recursive: true, force: true });
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
	}
});

test("production in-process engine uses the real Pi SDK outline grant with local faux responses only", { timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-persona-outline-inproc-"));
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	await writeFile(join(cwd, "fixture.tsx"), "// function fake() {}\nclass Box { hiddenMethod() {} }\n");
	await writeFile(join(cwd, "fixture.py"), "def load():\n    class Worker:\n        def run(self):\n            pass\n");
	const provider = "outline-inproc-offline";
	const faux = fauxProvider({ provider, models: [{ id: "local" }] });
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
		modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey(provider, "test-key-not-transmitted");
	let transcript = "";
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("code_outline", { path: "fixture.tsx" }, { id: "outline-tsx" })),
		fauxAssistantMessage(fauxToolCall("code_outline", { path: "fixture.py" }, { id: "outline-python" })),
		(context) => { transcript = JSON.stringify(context.messages); return fauxAssistantMessage("outline complete"); },
	]);
	const engine = makeInProcessEngine({ cwd, agentDir: root, modelRegistry: new ModelRegistry(runtime),
		resolveAgent: (name) => ({ name, model: `${provider}/local`, tools: ["code_outline"], systemPrompt: "Use the granted outline tool.", source: "<integration>" }),
	});
	try {
		const result = await engine.run({ agent: "scout", task: "Outline fixture.tsx and fixture.py." });
		assert.equal(result.ok, true, result.error);
		assert.match(transcript, /hiddenMethod/);
		assert.match(transcript, /Worker/);
		assert.match(transcript, /"grammar":"tsx"/);
		assert.match(transcript, /"grammar":"python"/);
		assert.equal(faux.state.callCount, 3, "only the local faux provider was called; no external model or network requests");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("disabled Persona stays inert unless the captured dedicated leg marker is set", { timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-persona-native-leg-"));
	const faux = fauxProvider({ provider: "native-tools-leg", models: [{ id: "local" }] });
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
		modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	const savedDisable = process.env.PI_PERSONA_DISABLE;
	const savedLeg = process.env.PI_PERSONA_LEG;
	const savedOutline = process.env.PI_PERSONA_CODE_OUTLINE;
	try {
		for (const state of [
			{ disabled: false, leg: false, outline: false },
			{ disabled: false, leg: false, outline: false, noBuiltin: true },
			{ disabled: true, leg: false, outline: false },
			{ disabled: true, leg: true, outline: false },
			{ disabled: true, leg: true, outline: true },
		]) {
			if (state.disabled) process.env.PI_PERSONA_DISABLE = "1";
			else delete process.env.PI_PERSONA_DISABLE;
			if (state.leg) process.env.PI_PERSONA_LEG = "1";
			else delete process.env.PI_PERSONA_LEG;
			if (state.outline) process.env.PI_PERSONA_CODE_OUTLINE = "1";
			else delete process.env.PI_PERSONA_CODE_OUTLINE;
			const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
				noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [(pi) => piPersona(pi)],
			});
			await loader.reload();
			const { session } = await createAgentSession({ cwd: root, agentDir: root, model: faux.models[0]!, modelRuntime: runtime,
				settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root),
				...(state.noBuiltin ? { noTools: "builtin" as const } : {}),
			});
			try {
				await session.bindExtensions({ mode: "rpc" });
				const names = session.agent.state.tools.map((tool) => tool.name);
				assert.equal(names.includes("grep"), (!state.disabled || state.leg) && !state.noBuiltin,
					state.leg ? "delegated leaf has grep" : state.disabled ? "user-disabled supervisor has no new tools" : "normal supervisor has grep");
				if (state.disabled && !state.outline) {
					assert.ok(!names.includes("delegate") && !names.includes("council") && !names.includes("flow"));
					assert.equal(names.includes("code_outline"), false, "disabled supervisors and ungranted leaf legs get no outline tool");
				} else if (state.disabled && state.outline) {
					assert.equal(names.includes("code_outline"), true, "a no-broker child receives only the adapter's explicit marker grant");
					const sourcePath = join(root, "broker-off.py");
					await writeFile(sourcePath, "def child_symbol():\n    pass\n");
					const outline = session.agent.state.tools.find((tool) => tool.name === "code_outline")!;
					const result = await outline.execute("offline-child-outline", { path: sourcePath }, new AbortController().signal);
					assert.deepEqual((result.details as { symbols: Array<{ name: string }> }).symbols.map((symbol) => symbol.name), ["child_symbol"]);
				} else if (!state.leg) {
					const outline = session.agent.state.tools.find((tool) => tool.name === "code_outline");
					assert.ok(outline, "enabled root supervisor receives the tool through the real extension");
					const sourcePath = join(root, "root.py");
					await writeFile(sourcePath, "def root_symbol():\n    pass\n");
					const result = await outline.execute("root-outline", { path: sourcePath }, new AbortController().signal);
					assert.deepEqual((result.details as { symbols: Array<{ name: string; kind: string; startLine: number; endLine: number }> }).symbols, [{ name: "root_symbol", kind: "function", startLine: 1, endLine: 2 }]);
				}
			} finally {
				await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		}
	} finally {
		if (savedDisable === undefined) delete process.env.PI_PERSONA_DISABLE;
		else process.env.PI_PERSONA_DISABLE = savedDisable;
		if (savedLeg === undefined) delete process.env.PI_PERSONA_LEG;
		else process.env.PI_PERSONA_LEG = savedLeg;
		if (savedOutline === undefined) delete process.env.PI_PERSONA_CODE_OUTLINE;
		else process.env.PI_PERSONA_CODE_OUTLINE = savedOutline;
		await rm(root, { recursive: true, force: true });
	}
});
