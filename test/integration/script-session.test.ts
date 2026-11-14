/** Native offline regression: script lifecycle through a real Pi session and pi-persona. */
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionFactory,
	type ExtensionUIContext,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import piPersona from "../../src/extension.ts";
import { SCRIPT_LOG_ENTRY, type MonitorLogRecord } from "../../src/monitor/archive.ts";

interface Contentish {
	role: string;
	content: unknown;
}

function textOf(message: Contentish): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "").join("");
}

function rpcUIContext(): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: {} as ExtensionUIContext["theme"],
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function waitForFile(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const watcher = watch(dirname(path), (_event, filename) => {
			if (filename?.toString() !== basename(path)) return;
			void access(path).then(() => finish(), () => {});
		});
		const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${path}`)), 10_000);
		function finish(error?: Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			watcher.close();
			if (error) reject(error);
			else resolve();
		}
		void access(path).then(() => finish(), () => {});
		watcher.on("error", (error) => finish(error));
	});
}

test("native SDK: script completion wakes once with bounded diagnostics while full output stays in the passive session archive", { timeout: 90_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-persona-script-session-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(cwd, ".pi", "agents", "script-probe.md"), "---\nname: script-probe\nlabel: Script Probe\npersona: true\n---\nScript probe supervisor.\n");

	const previousAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	let session: AgentSession | undefined;
	let disposePromise: Promise<void> | undefined;
	let releaseScript: (() => Promise<void>) | undefined;
	let scriptId: string | undefined;
	try {
		const observer: ExtensionFactory = (pi) => {
			pi.on("tool_result", (event: ToolResultEvent) => {
				if (event.toolName !== "script") return;
				const text = event.content.map((block) => block.type === "text" ? block.text : "").join("");
				scriptId = /Started ([\w-]+)/.exec(text)?.[1];
			});
		};
		const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: settings,
			extensionFactories: [piPersona, observer],
			noContextFiles: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await loader.reload();

		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "synthetic-auth.json"),
			modelsPath: null,
			modelsStorePath: join(agentDir, "synthetic-models-store.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "persona-script-session", models: [{ id: "offline" }] });
		runtime.registerNativeProvider(faux.provider);
		await runtime.setRuntimeApiKey("persona-script-session", "synthetic-key-never-transmitted");
		const model = runtime.getModel("persona-script-session", "offline");
		assert.ok(model, "the local faux model is registered");

		const sessionManager = SessionManager.inMemory(cwd);
		const activeSession = (await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: runtime,
			resourceLoader: loader,
			sessionManager,
			settingsManager: settings,
			tools: ["script", "bash"],
		})).session;
		session = activeSession;
		await activeSession.bindExtensions({ uiContext: rpcUIContext(), mode: "rpc" });
		await activeSession.prompt("/persona script-probe");
		assert.ok(activeSession.getActiveToolNames().includes("script"), "the active persona grants the script tool");

		const readyPath = join(root, "script-ready");
		const releasePath = join(root, "script-release");
		const stdoutPrefix = "SCRIPT_ARCHIVE_ONLY_BEGIN";
		const stdoutTail = "SCRIPT_COMPLETION_STDOUT_TAIL";
		const stderrTail = "SCRIPT_COMPLETION_STDERR_TAIL";
		const source = [
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"const [ready, release] = process.argv.slice(1);",
			"fs.writeFileSync(ready, 'ready');",
			"const finish = () => {",
			"  if (!fs.existsSync(release)) return;",
			"  watcher.close();",
			`  process.stdout.write(${JSON.stringify(stdoutPrefix)} + 'x'.repeat(24000) + '\\n' + ${JSON.stringify(stdoutTail)} + '\\n');`,
			`  process.stderr.write(${JSON.stringify(stderrTail)} + '\\n');`,
			"};",
			"const watcher = fs.watch(path.dirname(release), (_event, filename) => { if (filename?.toString() === path.basename(release)) finish(); });",
			"finish();",
		].join("\n");
		const requests: Contentish[][] = [];
		let resolveCompletionRequest!: (messages: Contentish[]) => void;
		let resolveCompletionEnd!: () => void;
		let completionRequestSeen = false;
		const completionRequest = new Promise<Contentish[]>((resolve) => { resolveCompletionRequest = resolve; });
		const completionTurn = new Promise<void>((resolve) => { resolveCompletionEnd = resolve; });
		activeSession.subscribe((event) => {
			if (event.type === "agent_end" && completionRequestSeen) resolveCompletionEnd();
		});
		faux.setResponses([
			(context) => {
				requests.push([...context.messages] as unknown as Contentish[]);
				return fauxAssistantMessage(fauxToolCall("script", {
					action: "run", command: process.execPath, args: ["-e", source, readyPath, releasePath], label: "native session probe", timeoutSeconds: 30,
				}, { id: "script-run" }), { stopReason: "toolUse" });
			},
			(context) => {
				requests.push([...context.messages] as unknown as Contentish[]);
				return fauxAssistantMessage("I started the script and will continue when it exits.");
			},
			(context) => {
				requests.push([...context.messages] as unknown as Contentish[]);
				completionRequestSeen = true;
				resolveCompletionRequest([...context.messages] as unknown as Contentish[]);
				return fauxAssistantMessage("The script completed successfully.");
			},
		]);
		const ready = waitForFile(readyPath);
		await activeSession.prompt("Run the asynchronous probe.");
		await ready;
		assert.ok(scriptId, "the host ran the script tool and assigned a retained id");

		releaseScript = () => writeFile(releasePath, "release");
		await releaseScript();
		const completionMessages = await completionRequest;
		await completionTurn;
		assert.equal(requests.length, 3, "one initial turn and exactly one automatic completion turn ran");

		const archiveEntries = sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SCRIPT_LOG_ENTRY);
		assert.equal(archiveEntries.length, 1, "the terminal script log was appended once as session-native custom data");
		const record = (archiveEntries[0] as unknown as { data: MonitorLogRecord }).data;
		assert.equal(record.entry.id, scriptId);
		assert.equal(record.outcome, "exit");
		assert.equal(record.stdout.length, 16_384, "the archive retains the bounded full output tail");
		assert.equal(record.truncated, true, "the larger process output is explicitly marked truncated");
		assert.doesNotMatch(record.stdout, new RegExp(stdoutPrefix), "the archive retains a bounded tail, not the discarded prefix");
		assert.match(record.stdout, new RegExp(stdoutTail));
		assert.match(record.stderr, new RegExp(stderrTail));

		const delivered = completionMessages.map(textOf).join("\n");
		assert.match(delivered, /Script events/);
		assert.match(delivered, /process exited with exit code 0/);
		assert.match(delivered, new RegExp(stdoutTail), "the completion carries bounded stdout diagnostics");
		assert.match(delivered, new RegExp(stderrTail), "the completion carries bounded stderr diagnostics");
		assert.doesNotMatch(delivered, new RegExp(stdoutPrefix), "the full captured output is not injected into model context");
		assert.ok(!delivered.includes("x".repeat(16_000)), "the large archived body stays out of the completion context");
		assert.doesNotMatch(delivered, new RegExp(SCRIPT_LOG_ENTRY), "the archive entry type itself is not a model message");
	} finally {
		await releaseScript?.();
		if (session) {
			disposePromise ??= (async () => {
				try {
					await session.abort();
					await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
				} finally { session.dispose(); }
			})();
			await disposePromise;
		}
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
