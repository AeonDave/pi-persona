/**
 * Native offline regression: a REAL Pi1 session, the REAL pi-persona extension factory and the
 * REAL builtin `codemode` extension (QuickJS), driven by a local faux provider. No cloud calls,
 * no credentials, no operator profile: every auth/model/cache/workspace/temp path is a throwaway
 * directory created (and removed) here.
 *
 * The behaviour under test is the nesting contract of the delegation nudge. A codemode script's
 * `tools.read()` runs the FULL tool pipeline (permission gate, telemetry, `tool_result` hooks) but
 * Pi records the nested result on the CALLING call — only the script's printed output reaches the
 * model. So a nested read of a >`singleHeavyChars` file must NOT trip the "fat one-shot dump"
 * nudge, must NOT mint a `pi-persona-nudge` card, and must NOT consume a step of the by-hand
 * streak; the OUTER codemode result is what the model reads and it alone drives the nudge.
 *
 * Everything asserted here is host-produced: the nested marker is the `parentToolCallId` the real
 * agent loop sets, the nudge/card assertions come from the real hook plus the real `appendEntry`,
 * and the content assertions come from the context of the real next provider request. Positive
 * controls (a 5-step sweep, and a direct >`singleHeavyChars` read of the very same file) prove the
 * nudge path is armed in this session, so a silent nested result can never be mistaken for a
 * disarmed harness or a persona that never activated.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
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

/** The nudge's own marker, as rendered by the production renderer (`core/nudge.ts`). */
const CHECKPOINT = "delegation checkpoint";
/** A string that exists ONLY inside the heavy file the script reads. */
const HEAVY = "HEAVYPAYLOAD";

interface CapturedResult {
	toolName: string;
	toolCallId: string;
	parentToolCallId?: string | undefined;
	chars: number;
	isError: boolean;
	/** `pi-persona-nudge` cards already appended when this result's hooks finished. */
	nudgesBefore: number;
	/** 1-based index among MODEL-VISIBLE results; -1 for a nested one. */
	modelVisibleIndex: number;
}

interface Contentish {
	role: string;
	content: unknown;
}

function textOf(message: Contentish): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((block) => {
			const text = (block as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		}).join("");
	}
	return "";
}

/** Text of the newest tool result in a provider request — what the model actually received. */
function lastToolResultText(messages: readonly Contentish[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message && message.role === "toolResult") return textOf(message);
	}
	return "";
}

function rpcUIContext(notifications: string[]): ExtensionUIContext {
	// Pi derives ExtensionContext.hasUI from bindExtensions({ mode: "rpc" }); these methods only
	// satisfy the host surface. `notify` is load-bearing: it is how a real `/persona` switch
	// reports back, which is how the test proves a persona is actually active.
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message) => { notifications.push(message); },
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
	setResponses: ReturnType<typeof fauxProvider>["setResponses"];
	dispose: () => Promise<void>;
	notifications: string[];
	results: CapturedResult[];
	nudges: string[];
}

/**
 * A real session carrying the real pi-persona extension and the real builtin codemode extension,
 * loaded through the PUBLIC `DefaultResourceLoader` — no hand-built ResourceLoader stub, no fake
 * hooks, no production test seam. The observer is an ordinary extension factory registered
 * alongside them; it only records what the host hands it.
 */
async function harness(options: { persona: string; tools: string[]; cwd: string; agentDir: string }): Promise<Harness> {
	const notifications: string[] = [];
	const results: CapturedResult[] = [];
	const nudges: string[] = [];
	let modelVisible = 0;

	const observer: ExtensionFactory = (pi) => {
		pi.on("tool_result", (event: ToolResultEvent) => {
			const text = event.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			const nested = typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0;
			results.push({
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				parentToolCallId: event.parentToolCallId,
				chars: text.length,
				isError: event.isError,
				nudgesBefore: nudges.length,
				modelVisibleIndex: nested ? -1 : ++modelVisible,
			});
		});
	};

	const settings = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false },
		codemode: { mode: "on" },
	});
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: settings,
		extensionFactories: [piPersona, createCodemodeExtension(), observer],
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();

	const runtime = await ModelRuntime.create({
		authPath: join(options.agentDir, "synthetic-auth.json"),
		modelsPath: null,
		modelsStorePath: join(options.agentDir, "synthetic-models-store.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "persona-codemode-test", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("persona-codemode-test", "synthetic-key-never-transmitted");
	const model = runtime.getModel("persona-codemode-test", "offline");
	assert.ok(model, "the local faux model is registered on the runtime");

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		model,
		modelRuntime: runtime,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(options.cwd),
		settingsManager: settings,
		tools: options.tools,
	});
	session.subscribe((event) => {
		const entry = event.type === "entry_appended" ? event.entry : undefined;
		if (entry && entry.type === "custom" && entry.customType === "pi-persona-nudge") {
			const data = entry.data as { content?: unknown } | undefined;
			nudges.push(typeof data?.content === "string" ? data.content : "");
		}
	});
	await session.bindExtensions({ uiContext: rpcUIContext(notifications), mode: "rpc" });
	await session.prompt(`/persona ${options.persona}`);

	return {
		session,
		setResponses: faux.setResponses,
		notifications,
		results,
		nudges,
		dispose: async () => {
			await session.abort();
			session.dispose();
		},
	};
}

async function scaffold(root: string): Promise<{ cwd: string; agentDir: string }> {
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	return { cwd, agentDir };
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

test("native codemode: a nested read past singleHeavyChars never nudges, and only the outer printed output drives the nudge", { timeout: 90_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-persona-codemode-native-"));
	const { cwd, agentDir } = await scaffold(root);
	const previousAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	let h: Harness | undefined;
	try {
		await writeFile(
			join(cwd, ".pi", "agents", "native-probe.md"),
			"---\nname: native-probe\nlabel: Native Probe\npersona: true\n---\nNative codemode probe supervisor.\n",
		);
		// ~200 KB: whatever the read tool's truncation keeps is still far past the 40 000-char
		// `singleHeavyChars` dump threshold, so "too fat to ignore" is not in doubt.
		const heavyPath = join(cwd, "heavy.txt");
		await writeFile(heavyPath, Array.from({ length: 500 }, (_unused, i) => `${i} ${HEAVY}-${"x".repeat(400)}`).join("\n"));
		// ~2 KB: substantive (past `minStepChars`) but far below the dump threshold, so it
		// advances the by-hand run exactly one step.
		const stepPath = join(cwd, "step.txt");
		await writeFile(stepPath, "S".repeat(1999));

		h = await harness({ persona: "native-probe", tools: ["read", "bash", "codemode", "delegate"], cwd, agentDir });
		const { session, setResponses, results, nudges, notifications } = h;
		// The nudge hook is inert without an active, delegate-enabled persona: a silent nested
		// result must not be able to pass for a session where the hook never armed.
		assert.ok(
			notifications.includes("persona: Native Probe active"),
			`/persona reported the switch, got: ${JSON.stringify(notifications)}`,
		);
		assert.ok(session.getActiveToolNames().includes("delegate"), "the active persona keeps the delegate tool");

		// The script reads the heavy file and prints only its size plus a short summary — the
		// regression shape: a fat nested read whose bytes never reach the model.
		const script = [
			`const r = await tools.read({ path: ${JSON.stringify(heavyPath)} });`,
			`text("HEAVY-SUMMARY characters=" + r.length + " :: " + "summary ".repeat(40));`,
		].join("\n");

		const delivered: string[] = [];
		const stepRead = (id: string) =>
			fauxAssistantMessage(fauxToolCall("read", { path: stepPath }, { id }), { stopReason: "toolUse" });

		setResponses([
			(context) => {
				delivered.push(lastToolResultText(context.messages));
				return fauxAssistantMessage(fauxToolCall("codemode", { code: script }, { id: "cm-1" }), { stopReason: "toolUse" });
			},
			...(["r1", "r2", "r3", "r4"] as const).map((id) => (context: { messages: readonly Contentish[] }) => {
				delivered.push(lastToolResultText(context.messages));
				return stepRead(id);
			}),
			(context) => {
				delivered.push(lastToolResultText(context.messages));
				return fauxAssistantMessage("done");
			},
		]);
		await session.prompt("Use codemode to summarise the heavy file.");

		// ── the host's own nesting marker, captured from the real tool_result pipeline ──
		const nested = results.filter((r) => r.parentToolCallId !== undefined);
		assert.equal(nested.length, 1, `exactly one nested result (the script's read), got ${JSON.stringify(results.map((r) => [r.toolName, r.parentToolCallId]))}`);
		const nestedRead = nested[0];
		assert.ok(nestedRead);
		assert.equal(nestedRead.toolName, "read");
		assert.equal(nestedRead.modelVisibleIndex, -1, "a nested result is never a model-visible one");
		assert.ok(
			nestedRead.chars > 40_000,
			`the nested read really is past singleHeavyChars (${nestedRead.chars} chars) — it would dump-nudge if it were model-visible`,
		);
		assert.equal(nestedRead.nudgesBefore, 0, "no card existed when the fat nested result landed");

		const outer = results.find((r) => r.toolName === "codemode");
		assert.ok(outer, "the outer codemode call is a real tool_result too");
		assert.equal(outer.parentToolCallId, undefined, "the outer call carries no parent marker");
		assert.equal(outer.nudgesBefore, 0, "the outer result minted no card either — it is only a step");
		assert.ok(outer.chars >= 200, `the outer printed result is a substantive step (${outer.chars} chars)`);
		assert.ok(outer.chars < 40_000, `the outer result stayed lean (${outer.chars} chars)`);

		// ── what the model actually received ──
		assert.equal(delivered.length, 6, `one record per provider request, got ${delivered.length}`);
		const codemodeToModel = delivered[1] ?? "";
		assert.match(codemodeToModel, /HEAVY-SUMMARY/, "the script's printed output is what reached the model");
		assert.doesNotMatch(codemodeToModel, new RegExp(HEAVY), "the heavy payload never reached the model");
		assert.doesNotMatch(codemodeToModel, new RegExp(CHECKPOINT), "the fat nested read did not dump-nudge the outer result");

		// ── the streak is untouched by the nested bytes: the sweep still fires on step 5 ──
		for (let step = 2; step <= 4; step++) {
			assert.doesNotMatch(delivered[step] ?? "", new RegExp(CHECKPOINT), `model-visible result ${step} is still an ordinary step`);
		}
		const sweep = delivered[5] ?? "";
		assert.match(sweep, new RegExp(CHECKPOINT), "the 5th model-visible result trips the sweep — the path is armed");
		assert.match(sweep, /substantive direct tool calls/, "the trigger is the run of model-visible calls, not the nested bytes");
		assert.doesNotMatch(sweep, new RegExp(HEAVY), "no heavy payload leaked into a step result");

		assert.equal(nudges.length, 1, `exactly one card, from the one model-visible trigger: ${JSON.stringify(nudges)}`);
		assert.match(nudges[0] ?? "", /substantive direct tool calls/);
		const fifth = results.find((r) => r.modelVisibleIndex === 5);
		assert.ok(fifth, "five model-visible results were observed");
		assert.equal(fifth.nudgesBefore, 1, "the sweep card existed by the time the 5th model-visible result finished, and no earlier");
		const fourth = results.find((r) => r.modelVisibleIndex === 4);
		assert.ok(fourth);
		assert.equal(fourth.nudgesBefore, 0, "nothing was minted after 4 steps — the nested read consumed no step");
	} finally {
		await h?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("native codemode: the same heavy file read DIRECTLY does nudge — the nested silence is the nesting, not the size", { timeout: 90_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-persona-codemode-dump-"));
	const { cwd, agentDir } = await scaffold(root);
	const previousAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	let h: Harness | undefined;
	try {
		await writeFile(
			join(cwd, ".pi", "agents", "native-probe.md"),
			"---\nname: native-probe\nlabel: Native Probe\npersona: true\n---\nNative codemode probe supervisor.\n",
		);
		const heavyPath = join(cwd, "heavy.txt");
		await writeFile(heavyPath, Array.from({ length: 500 }, (_unused, i) => `${i} ${HEAVY}-${"x".repeat(400)}`).join("\n"));

		h = await harness({ persona: "native-probe", tools: ["read", "bash", "codemode", "delegate"], cwd, agentDir });
		const { session, setResponses, results, nudges, notifications } = h;
		assert.ok(notifications.includes("persona: Native Probe active"), "the temp delegate-enabled persona is active");

		const delivered: string[] = [];
		setResponses([
			(context) => {
				delivered.push(lastToolResultText(context.messages));
				return fauxAssistantMessage(fauxToolCall("read", { path: heavyPath }, { id: "heavy-direct" }), { stopReason: "toolUse" });
			},
			(context) => {
				delivered.push(lastToolResultText(context.messages));
				return fauxAssistantMessage("done");
			},
		]);
		await session.prompt("Read the heavy file.");

		const direct = results.find((r) => r.toolName === "read");
		assert.ok(direct, "the direct read is a model-visible result");
		assert.equal(direct.parentToolCallId, undefined);
		assert.ok(direct.chars > 40_000, `the direct result is past singleHeavyChars (${direct.chars} chars)`);
		const model = delivered[1] ?? "";
		assert.match(model, new RegExp(CHECKPOINT), "a model-visible fat dump nudges");
		assert.match(model, /one direct tool result/, "…through the dump trigger");
		assert.match(model, new RegExp(HEAVY), "…and this is the very payload the nested read swallowed");
		assert.equal(nudges.length, 1, `one card, from that result: ${JSON.stringify(nudges)}`);
	} finally {
		await h?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("native codemode: a persona-denied nested bash call is refused by the runtime gate and never runs", { timeout: 90_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-persona-codemode-deny-"));
	const { cwd, agentDir } = await scaffold(root);
	const previousAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	let h: Harness | undefined;
	try {
		await writeFile(
			join(cwd, ".pi", "agents", "native-observer.md"),
			"---\nname: native-observer\nlabel: Native Observer\npersona: true\ntools:\n  deny: [bash]\n---\nRead-only native probe supervisor.\n",
		);
		const marker = join(cwd, "denied-marker.txt");
		h = await harness({ persona: "native-observer", tools: ["read", "bash", "codemode", "delegate"], cwd, agentDir });
		const { session, setResponses, results, notifications } = h;
		assert.ok(
			notifications.includes("persona: Native Observer active"),
			`/persona reported the switch, got: ${JSON.stringify(notifications)}`,
		);
		// The persona's deny pulled bash out of the declared loadout; put it back so the script
		// CAN reach it. That is the point: a reachable tool is still refused, natively, at call time.
		assert.equal(session.getActiveToolNames().includes("bash"), false, "the persona's deny dropped bash from the loadout");
		session.setActiveToolsByName([...session.getActiveToolNames(), "bash"]);
		assert.ok(session.getCallableToolNames().includes("bash"), "a codemode script can now reach bash");

		const command = `node -e "require('fs').writeFileSync('denied-marker.txt','ran')"`;
		const script = [
			"try {",
			`  const r = await tools.bash({ command: ${JSON.stringify(command)} });`,
			'  text("BASH-RAN " + r.output);',
			"} catch (e) {",
			'  text("BASH-REFUSED " + e.message);',
			"}",
		].join("\n");

		const delivered: string[] = [];
		setResponses([
			(context) => {
				delivered.push(lastToolResultText(context.messages));
				return fauxAssistantMessage(fauxToolCall("codemode", { code: script }, { id: "cm-deny" }), { stopReason: "toolUse" });
			},
			(context) => {
				delivered.push(lastToolResultText(context.messages));
				return fauxAssistantMessage("done");
			},
		]);
		await session.prompt("Use codemode to write the marker file with bash.");

		const outer = delivered[1] ?? "";
		// The gate refuses before the tool runs, so the host produces no nested RESULT at all —
		// the absence is the "never ran" half of the proof, the marker file the filesystem half.
		assert.deepEqual(
			results.filter((r) => r.parentToolCallId !== undefined).map((r) => r.toolName),
			[],
			"a call refused at the gate yields no nested tool result",
		);

		assert.match(outer, /BASH-REFUSED/, `the script saw the refusal, not a result: ${outer.slice(0, 400)}`);
		assert.match(outer, /may not use tool: bash/, "the refusal is the persona's own gate reason");
		assert.equal(await exists(marker), false, "the denied command never ran");
	} finally {
		await h?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
