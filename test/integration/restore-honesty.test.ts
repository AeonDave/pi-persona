/**
 * Native offline regression: a REAL Pi session and the REAL pi-persona extension factory, driven by
 * local faux providers (no cloud calls, no credentials, no operator profile: every path is a
 * throwaway directory created and removed here).
 *
 * Behaviour under test: `/reload` tears the extension instance down, and with it every background
 * run, armed timer and monitor, which live only in memory. The restored supervisor used to keep
 * waiting for wakes that could never come, and run ids restarted at run-1 and collided with the ids
 * already in its history. The shutdown hook now records what was lost (and the id counter) in a
 * session entry; the next session_start tells the supervisor once, passively, and continues the ids.
 *
 * Everything asserted is host-produced: the entries come from the real SessionManager, the notice
 * from the context of the real next provider request, the ids from the real tool result. This also
 * proves `appendEntry` persists at session_shutdown, which the design depends on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { RUNS_ENTRY_CUSTOM_TYPE, type RunsEntry } from "../../src/core/session-runs.ts";

interface Contentish {
	role: string;
	content: unknown;
}

function textOf(message: Contentish): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((block) => (typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("");
	return "";
}

function rpcUIContext(): ExtensionUIContext {
	// Pi derives ExtensionContext.hasUI from bindExtensions({ mode: "rpc" }): an interactive session,
	// where `delegate` always runs in the background.
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

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	/** Provider requests the supervisor model received, newest last (their full message lists). */
	requests: Contentish[][];
	/** Texts of the supervisor's own tool results, in order. */
	toolResults: string[];
	runsEntries: () => RunsEntry[];
	script: (...steps: Array<"delegate" | "timer" | "monitor" | "idle">) => void;
	dispose: () => Promise<void>;
}

async function harness(root: string): Promise<Harness> {
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(cwd, ".pi", "agents", "restore-probe.md"), "---\nname: restore-probe\nlabel: Restore Probe\npersona: true\n---\nRestore probe supervisor.\n");
	await writeFile(join(cwd, ".pi", "agents", "scout.md"), "---\nname: scout\nmodel: persona-restore-child/slow\n---\nA scout that never finishes within the test.\n");

	const toolResults: string[] = [];
	const observer: ExtensionFactory = (pi) => {
		pi.on("tool_result", (event: ToolResultEvent) => {
			toolResults.push(event.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
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
	const main = fauxProvider({ provider: "persona-restore-main", models: [{ id: "offline" }] });
	const child = fauxProvider({ provider: "persona-restore-child", models: [{ id: "slow" }] });
	runtime.registerNativeProvider(main.provider);
	runtime.registerNativeProvider(child.provider);
	await runtime.setRuntimeApiKey("persona-restore-main", "synthetic-key-never-transmitted");
	await runtime.setRuntimeApiKey("persona-restore-child", "synthetic-key-never-transmitted");
	const model = runtime.getModel("persona-restore-main", "offline");
	assert.ok(model, "the local faux model is registered on the runtime");

	// Every scout leg blocks until the test is over, so its run is still in flight at /reload.
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	child.setResponses(Array.from({ length: 4 }, () => async () => { await gate; return fauxAssistantMessage("late"); }));

	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime: runtime,
		resourceLoader: loader,
		sessionManager,
		settingsManager: settings,
		tools: ["delegate", "timer", "monitor", "bash", "intercom"],
	});
	await session.bindExtensions({ uiContext: rpcUIContext(), mode: "rpc" });

	const requests: Contentish[][] = [];
	let tasks = 0;
	const step = {
		delegate: () => fauxAssistantMessage(fauxToolCall("delegate", { agent: "scout", task: `scan area ${++tasks}` }, { id: `d-${tasks}` }), { stopReason: "toolUse" }),
		timer: () => fauxAssistantMessage(fauxToolCall("timer", { action: "arm", message: "check in", delaySeconds: 3600 }, { id: `t-${tasks}` }), { stopReason: "toolUse" }),
		monitor: () => fauxAssistantMessage(fauxToolCall("monitor", { action: "arm", command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], label: "restore probe", mode: "exit", timeoutSeconds: 120 }, { id: "m-1" }), { stopReason: "toolUse" }),
		idle: () => fauxAssistantMessage("Understood; ending my turn."),
	};
	const script: Harness["script"] = (...steps) => {
		main.setResponses(steps.map((name) => (context) => {
			requests.push([...context.messages] as unknown as Contentish[]);
			return step[name]();
		}));
	};

	await session.prompt("/persona restore-probe");
	let disposal: Promise<void> | undefined;
	return {
		session,
		sessionManager,
		requests,
		toolResults,
		script,
		runsEntries: () => sessionManager.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === RUNS_ENTRY_CUSTOM_TYPE)
			.map((entry) => (entry as unknown as { data: RunsEntry }).data),
		dispose: () => disposal ??= (async () => {
			try {
				await session.abort();
				// SDK dispose disconnects listeners; it does not emit the host lifecycle. Join the
				// extension's terminal writes before removing the temporary profile.
				await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				release();
				session.dispose();
			}
		})(),
	};
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-persona-restore-"));
	const previousAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = join(root, "agent");
	let h: Harness | undefined;
	try {
		h = await harness(root);
		await run(h);
	} finally {
		await h?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
}

const NOTICE = /Session restored\. Background work from before the restore did not survive/;
const requestsMentioningNotice = (h: Harness) => h.requests.filter((messages) => messages.some((m) => NOTICE.test(textOf(m))));

test("/reload tells the restored supervisor which run, timer and monitor did not survive, once and passively, and run ids carry on", { timeout: 90_000 }, async () => {
	await withHarness(async (h) => {
		h.script("delegate", "timer", "monitor", "idle");
		await h.session.prompt("start a scout, arm a check-in and a watch");
		assert.deepEqual(h.runsEntries(), [], "nothing is recorded before a shutdown");

		await h.session.reload();

		const [lostEntry, ack, ...rest] = h.runsEntries();
		assert.deepEqual(rest, []);
		assert.deepEqual(lostEntry?.lost, { runs: ["run-1"], timers: 1, monitors: 1 }, "shutdown persisted exactly what was in flight");
		assert.equal(lostEntry?.issued, 1);
		assert.deepEqual(ack?.lost, { runs: [], timers: 0, monitors: 0 }, "the restore acknowledged the loss so it can never replay");
		assert.equal(ack?.issued, 1, "…while the id counter still continues");
		assert.equal(ack?.sessionId, lostEntry?.sessionId);

		// Passive: telling the supervisor must not start a model turn by itself.
		assert.equal(requestsMentioningNotice(h).length, 0, "no request has carried the notice yet");

		h.script("delegate", "idle", "idle");
		await h.session.prompt("what is still running?");
		const carrying = requestsMentioningNotice(h);
		assert.ok(carrying.length >= 1, "the next turn carries the restore notice");
		const notice = carrying[0]?.map(textOf).find((text) => NOTICE.test(text)) ?? "";
		assert.match(notice, /: run run-1 \(stopped or never reported\); 1 timer; 1 monitor\. Runtime workers and live run handles are not restored\. Retained terminal reports/);
		assert.match(notice, /Runtime workers and live run handles are not restored/);
		assert.match(notice, /Retained terminal reports may still be available via intercom/);
		assert.match(notice, /read saved data without restarting work/);
		assert.match(notice, /relaunch unfinished work or re-arm wake sources only when still needed\./);
		const launches = h.toolResults.filter((text) => text.startsWith("Launched async run ")).map((text) => /run-\d+/.exec(text)?.[0]);
		assert.deepEqual(launches, ["run-1", "run-2"], "the post-restore run is run-2, not a recycled run-1");

		await h.dispose();
		const last = h.runsEntries().at(-1);
		assert.equal(last?.issued, 2, "the lineage keeps counting across the restore");
		assert.deepEqual(last?.lost, { runs: ["run-2"], timers: 0, monitors: 0 }, "a later shutdown records only what is lost then, not the old run");
	});
});

test("a second /reload does not replay an acknowledged loss", { timeout: 90_000 }, async () => {
	await withHarness(async (h) => {
		h.script("timer", "idle");
		await h.session.prompt("arm a check-in");
		await h.session.reload();
		await h.session.reload();
		h.script("idle");
		await h.session.prompt("status?");
		const notices = h.requests.flatMap((messages) => messages.filter((m) => NOTICE.test(textOf(m))));
		assert.equal(new Set(notices.map(textOf)).size, 1, "one distinct notice only");
		const entries = h.runsEntries();
		assert.equal(entries.filter((e) => e.lost.timers > 0).length, 1, "only the first shutdown had anything to lose");
	});
});

test("a quiet session restores silently: nothing was lost, so nothing is announced or recorded", { timeout: 90_000 }, async () => {
	await withHarness(async (h) => {
		h.script("idle");
		await h.session.prompt("hello");
		await h.session.reload();
		h.script("idle");
		await h.session.prompt("still there?");
		assert.equal(requestsMentioningNotice(h).length, 0);
		assert.deepEqual(h.runsEntries(), [], "no run was ever issued, so nothing needs to carry over");
	});
});
