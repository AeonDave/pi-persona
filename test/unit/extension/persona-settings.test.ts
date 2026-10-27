import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { resolveConfig, type PiPersonaConfig } from "../../../src/core/config.ts";
import type { PersonaPreferences, SettingId } from "../../../src/core/settings.ts";
import { registerPersonaSettings, type PersonaSettingsDeps } from "../../../src/extension/persona-settings.ts";
import type { SettingsPanelAction } from "../../../src/ui/persona-settings.ts";

interface RegisteredCommand {
	name: string;
	options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
}

interface HarnessOptions {
	preferences?: PersonaPreferences;
	activeConfig?: PiPersonaConfig;
	env?: Record<string, string | undefined>;
	readError?: Error;
	writeError?: Error;
	isCurrent?: () => boolean;
}

function makeHarness(options: HarnessOptions = {}) {
	let preferences: PersonaPreferences = { ...(options.preferences ?? {}) };
	const writeCalls: Array<{ preferences?: Partial<Record<SettingId, unknown | null>>; lastPersona?: string | null }> = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const models: unknown[] = [];
	const registered: RegisteredCommand[] = [];
	let compactCalls = 0;
	const deps: PersonaSettingsDeps = {
		file: "D:/agent data/persona-settings.json",
		activeConfig: options.activeConfig ?? resolveConfig(options.env ?? {}),
		read: () => {
			if (options.readError) throw options.readError;
			return { preferences, lastPersona: "reviewer" };
		},
		write: (patch) => {
			writeCalls.push(patch);
			if (options.writeError) throw options.writeError;
			const next = { ...(preferences as Record<string, unknown>) };
			for (const [key, value] of Object.entries(patch.preferences ?? {})) {
				if (value === null) delete next[key];
				else next[key] = value;
			}
			preferences = next as PersonaPreferences;
		},
		env: options.env ?? {},
		models: async (ctx) => { models.push(ctx); },
		diagnostics: () => "settings store: ready",
		isCurrent: options.isCurrent ? () => options.isCurrent?.() ?? false : () => true,
	};
	const pi = {
		registerCommand: (name: string, command: RegisteredCommand["options"]) => registered.push({ name, options: command }),
	} as unknown as ExtensionAPI;
	registerPersonaSettings(pi, deps);
	return {
		deps,
		registered,
		writeCalls,
		notices,
		models,
		compactCalls: () => compactCalls,
		setCompactCalls: (value: number) => { compactCalls = value; },
		get preferences() { return preferences; },
	};
}

interface ContextOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	input?: (title: string, placeholder?: string) => Promise<string | undefined>;
	custom?: (factory: (...args: never[]) => unknown, options?: unknown) => Promise<unknown>;
	notices?: Array<{ message: string; type?: string }>;
	compact?: () => void;
	signal?: AbortSignal;
	sessionManager?: { getSessionId: () => string };
}

function makeContext(options: ContextOptions = {}): ExtensionCommandContext {
	const notices = options.notices ?? [];
	return {
		mode: options.mode ?? "rpc",
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, ...(type !== undefined ? { type } : {}) }),
			select: options.select ?? (async () => undefined),
			input: options.input ?? (async () => undefined),
			custom: options.custom ?? (async () => undefined),
		},
		compact: options.compact ?? (() => {}),
		signal: options.signal,
		sessionManager: options.sessionManager ?? { getSessionId: () => "session-a" },
	} as unknown as ExtensionCommandContext;
}

function command(harness: ReturnType<typeof makeHarness>): RegisteredCommand["options"] {
	assert.equal(harness.registered.length, 1);
	return harness.registered[0]!.options;
}

function fakeTui(): TUI {
	return { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
}

function fakeTheme(): { fg: (_role: string, text: string) => string; bold: (text: string) => string } {
	return { fg: (_role, text) => text, bold: (text) => text };
}

function fakeKeybindings(): KeybindingsManager {
	return {
		matches: (data: string, binding: string) =>
			(binding === "tui.select.up" && data === "UP") ||
			(binding === "tui.select.down" && data === "DOWN") ||
			(binding === "tui.select.confirm" && data === "ENTER") ||
			(binding === "tui.select.cancel" && data === "ESC"),
	} as unknown as KeybindingsManager;
}

test("registers only /persona-settings and show is deterministic, read-only, and does not compact", async () => {
	const harness = makeHarness({ preferences: { engine: "child" } });
	const cmd = command(harness);
	assert.equal(harness.registered[0]!.name, "persona-settings");
	const ctx = makeContext({ mode: "rpc", notices: harness.notices, compact: () => harness.setCompactCalls(harness.compactCalls() + 1) });
	await cmd.handler("show", ctx);
	assert.equal(harness.writeCalls.length, 0);
	assert.equal(harness.models.length, 0);
	assert.equal(harness.compactCalls(), 0);
	const report = harness.notices[0]!.message;
	assert.match(report, /D:\/agent data\/persona-settings\.json/);
	assert.match(report, /Remembered persona: reviewer/);
	assert.match(report, /engine: active=inproc; saved=child; source=saved · pending \/reload; applies=next Pi restart or native extension reload/);
	assert.match(report, /settings store: ready/);
	assert.ok(report.indexOf("extraDirs:") < report.indexOf("engine:"), "registry order is stable in the report");
});

test("blocked idle compaction reports effective Off even with saved or environment opt-in", async () => {
	for (const env of [{}, { PI_PERSONA_IDLE_COMPACTION: "on" }]) {
		const harness = makeHarness({ preferences: { idleCompaction: true }, env });
		await command(harness).handler("show", makeContext({ notices: harness.notices }));
		const line = harness.notices[0]!.message.split("\n").find((value) => value.startsWith("idleCompaction:"));
		assert.match(line ?? "", /active=Off; saved=On/);
		assert.match(line ?? "", /Unavailable: waiting for a qualified upstream Pi/);
		assert.doesNotMatch(line ?? "", /pending \/reload/);
	}
});

test("blocked Context setting rejects an edit without prompting or saving", async () => {
	const harness = makeHarness();
	const choices = ["Idle compaction [idleCompaction] · Off", "Edit", "Close"];
	await command(harness).handler("", makeContext({
		notices: harness.notices,
		select: async () => choices.shift(),
		input: async () => { throw new Error("unavailable preference must not prompt"); },
	}));
	assert.equal(harness.writeCalls.length, 0);
	assert.ok(harness.notices.some(({ message }) => /Cannot edit.*Unavailable:.*upstream Pi/.test(message)));
});

test("clearing a blocked request preserves the effective Off state and does not promise reload activation", async () => {
	const harness = makeHarness({ preferences: { idleCompaction: true } });
	const choices = ["Idle compaction [idleCompaction] · Off", "Reset saved override", "Close"];
	await command(harness).handler("", makeContext({ notices: harness.notices, select: async () => choices.shift() }));
	assert.deepEqual(harness.writeCalls, [{ preferences: { idleCompaction: null } }]);
	const message = harness.notices.find(({ message }) => message.startsWith("Saved override removed"))?.message;
	assert.match(message ?? "", /Unavailable:.*upstream Pi/);
	assert.doesNotMatch(message ?? "", /\/reload/);
});

test("TUI opens the full-page component without overlay options and reuses the Models callback", async () => {
	const harness = makeHarness();
	const commandDef = command(harness);
	let customCalls = 0;
	const ctx = makeContext({
		mode: "tui",
		notices: harness.notices,
		custom: async (factory, options) => {
			assert.equal(options, undefined, "custom UI should use the full page, without overlay mode");
			customCalls++;
			let result: SettingsPanelAction | undefined;
			const component = (factory as unknown as (tui: TUI, theme: unknown, keybindings: KeybindingsManager, done: (value: SettingsPanelAction) => void) => { handleInput(key: string): void })(
				fakeTui(), fakeTheme(), fakeKeybindings(), (value) => { result = value; },
			);
			component.handleInput(customCalls === 1 ? "m" : "ESC");
			return result;
		},
	});
	await commandDef.handler("", ctx);
	assert.equal(customCalls, 2);
	assert.equal(harness.models.length, 1);
	assert.equal(harness.writeCalls.length, 0);
});

test("RPC can browse and edit a choice using the native select primitive", async () => {
	const harness = makeHarness();
	const selections = [
		"Sub-agent engine [engine] · inproc",
		"Edit",
		"child",
		"Close",
	];
	const ctx = makeContext({
		mode: "rpc",
		notices: harness.notices,
		select: async () => selections.shift(),
	});
	await command(harness).handler("", ctx);
	assert.deepEqual(harness.writeCalls, [{ preferences: { engine: "child" } }]);
	assert.equal((harness.preferences as Record<string, unknown>).engine, "child");
	assert.ok(harness.notices.some(({ message }) => /running value remains inproc/.test(message)));
});

test("RPC reset deletes a saved override, and cancelling an edit leaves it intact", async () => {
	const harness = makeHarness({ preferences: { engine: "child" } });
	const selections = [
		"Sub-agent engine [engine] · inproc",
		undefined,
		"Sub-agent engine [engine] · inproc",
		"Reset saved override",
		"Close",
	];
	const ctx = makeContext({ mode: "rpc", notices: harness.notices, select: async () => selections.shift() });
	await command(harness).handler("", ctx);
	assert.deepEqual(harness.writeCalls, [{ preferences: { engine: null } }]);
	assert.equal(Object.hasOwn(harness.preferences, "engine"), false);
});

test("reset reports pending reload when the running value differs from the next default", async () => {
	const harness = makeHarness({
		preferences: { engine: "inproc" },
		activeConfig: { ...resolveConfig({}), engine: "child" },
	});
	const selections = [
		"Sub-agent engine [engine] · child",
		"Reset saved override",
		"Sub-agent engine [engine] · child",
		"Details",
		"Close",
	];
	await command(harness).handler("", makeContext({
		mode: "rpc",
		notices: harness.notices,
		select: async () => selections.shift(),
	}));
	assert.equal(Object.hasOwn(harness.preferences, "engine"), false);
	assert.ok(harness.notices.some(({ message }) => /differs from the running value/.test(message) && /\/reload/.test(message)));
});

test("spine selectors treat off and the active empty value as equivalent", async () => {
	const harness = makeHarness({
		preferences: { spine: "off", spineLegs: "off" },
		activeConfig: { ...resolveConfig({}), spine: "", spineLegs: "" },
	});
	await command(harness).handler("show", makeContext({ mode: "rpc", notices: harness.notices }));
	const report = harness.notices[0]!.message;
	assert.match(report, /spine: active=\(empty\); saved=off; source=saved(?: · pending \/reload)?; applies=next Pi restart or native extension reload/);
	assert.match(report, /spineLegs: active=\(empty\); saved=off; source=saved(?: · pending \/reload)?; applies=next Pi restart or native extension reload/);
	assert.doesNotMatch(report, /spine(?:Legs)?: active=.*pending \/reload/);
});

test("RPC environment pins are locked and reset removes only a saved preference", async () => {
	const harness = makeHarness({ preferences: { engine: "inproc" }, env: { PI_PERSONA_ENGINE: "child" } });
	const selections = [
		"Sub-agent engine [engine] · child",
		"Edit",
		"Sub-agent engine [engine] · child",
		"Reset saved override",
		"Close",
	];
	const ctx = makeContext({ mode: "rpc", notices: harness.notices, select: async () => selections.shift() });
	await command(harness).handler("", ctx);
	assert.deepEqual(harness.writeCalls, [{ preferences: { engine: null } }]);
	assert.ok(harness.notices.some(({ message }) => /Cannot edit this setting while PI_PERSONA_ENGINE is set/.test(message)));
	assert.ok(harness.notices.some(({ message }) => /PI_PERSONA_ENGINE still controls the active value/.test(message)));
});

test("RPC string-list editor preserves drive paths and punctuation from JSON input", async () => {
	const path = "D:\\agents\\with, comma; semicolon";
	const selections = [
		"Extra persona directories [extraDirs] · (empty list)",
		"Edit",
		"Close",
	];
	const harness = makeHarness();
	const ctx = makeContext({
		mode: "rpc",
		notices: harness.notices,
		select: async () => selections.shift(),
		input: async () => JSON.stringify([path]),
	});
	await command(harness).handler("", ctx);
	assert.deepEqual(harness.writeCalls, [{ preferences: { extraDirs: [path] } }]);
});

test("invalid numeric input, a failed store, or a changed session never saves a preference", async () => {
	const invalid = makeHarness();
	const invalidSelections = ["Progress and stall check interval [peekEveryMs] · 30000", "Edit", "Close"];
	await command(invalid).handler("", makeContext({
		mode: "rpc",
		notices: invalid.notices,
		select: async () => invalidSelections.shift(),
		input: async () => "9007199254740992",
	}));
	assert.equal(invalid.writeCalls.length, 0);
	assert.ok(invalid.notices.some(({ message }) => /safe integer/.test(message)));

	const failedStore = makeHarness({ writeError: new Error("disk full") });
	const failedSelections = ["Sub-agent engine [engine] · inproc", "Edit", "child", "Close"];
	await command(failedStore).handler("", makeContext({
		mode: "rpc",
		notices: failedStore.notices,
		select: async () => failedSelections.shift(),
	}));
	assert.deepEqual(failedStore.writeCalls, [{ preferences: { engine: "child" } }]);
	assert.ok(failedStore.notices.some(({ message }) => /Could not confirm save for engine: disk full/.test(message)));

	const changed = makeHarness({ isCurrent: () => false });
	const changedSelections = ["Sub-agent engine [engine] · inproc", "Edit", "child", "Close"];
	await command(changed).handler("", makeContext({
		mode: "rpc",
		notices: changed.notices,
		select: async () => changedSelections.shift(),
	}));
	assert.deepEqual(changed.writeCalls, []);
	assert.ok(changed.notices.some(({ message }) => /session changed/.test(message)));
});

test("an aborted command context cannot save an edit", async () => {
	const harness = makeHarness();
	const selections = ["Sub-agent engine [engine] · inproc", "Edit", "child", "Close"];
	const controller = new AbortController();
	controller.abort();
	await command(harness).handler("", makeContext({
		mode: "rpc",
		notices: harness.notices,
		select: async () => selections.shift(),
		signal: controller.signal,
	}));
	assert.deepEqual(harness.writeCalls, []);
	assert.ok(harness.notices.some(({ message }) => /command was cancelled/.test(message)));
});

test("a session switch during an RPC prompt invalidates the command's captured session", async () => {
	const harness = makeHarness({ isCurrent: () => true });
	let sessionId = "session-a";
	let prompt = 0;
	const ctx = makeContext({
		mode: "rpc",
		notices: harness.notices,
		sessionManager: { getSessionId: () => sessionId },
		select: async () => {
			prompt++;
			if (prompt === 1) return "Sub-agent engine [engine] · inproc";
			if (prompt === 2) return "Edit";
			if (prompt === 3) {
				sessionId = "session-b";
				return "child";
			}
			return "Close";
		},
	});
	await command(harness).handler("", ctx);
	assert.deepEqual(harness.writeCalls, []);
	assert.ok(harness.notices.some(({ message }) => /session changed/.test(message)));
});

test("a TUI action returned after the session changes is discarded before editing", async () => {
	let contextChecks = 0;
	const harness = makeHarness({ isCurrent: () => contextChecks++ === 0 });
	let customCalls = 0;
	await command(harness).handler("", makeContext({
		mode: "tui",
		notices: harness.notices,
		custom: async (factory) => {
			customCalls++;
			let result: SettingsPanelAction | undefined;
			const component = (factory as unknown as (tui: TUI, theme: unknown, keybindings: KeybindingsManager, done: (value: SettingsPanelAction) => void) => { handleInput(key: string): void })(
				fakeTui(), fakeTheme(), fakeKeybindings(), (value) => { result = value; },
			);
			component.handleInput("ENTER");
			return result;
		},
	}));
	assert.equal(customCalls, 1);
	assert.deepEqual(harness.writeCalls, []);
	assert.ok(harness.notices.some(({ message }) => /session changed/.test(message)));
});

test("headless mode reports readonly state without invoking any prompt", async () => {
	const harness = makeHarness();
	const output: string[] = [];
	const oldError = console.error;
	console.error = (message?: unknown) => output.push(String(message ?? ""));
	try {
		await command(harness).handler("", makeContext({ mode: "print", hasUI: false, notices: harness.notices }));
	} finally {
		console.error = oldError;
	}
	assert.equal(harness.writeCalls.length, 0);
	assert.equal(harness.models.length, 0);
	assert.match(output.join("\n"), /read-only in print mode/);
	assert.match(output.join("\n"), /engine: active=inproc/);
});

test("a read failure in the bare headless command is reported to stderr instead of escaping", async () => {
	const harness = makeHarness({ readError: new Error("preferences unreadable") });
	const output: string[] = [];
	const oldError = console.error;
	console.error = (message?: unknown) => output.push(String(message ?? ""));
	try {
		await command(harness).handler("", makeContext({ mode: "print", hasUI: false }));
	} finally {
		console.error = oldError;
	}
	assert.match(output.join("\n"), /Could not read persona settings: preferences unreadable/);
});

test("companion sections appear only when their plugin reports active values", async () => {
	const harness = makeHarness();
	const ctx = makeContext({ notices: harness.notices });
	await command(harness).handler("show", ctx);
	assert.doesNotMatch(harness.notices.at(-1)!.message, /mindCapture:|flowEnabled:/);
	harness.deps.companions = () => ({ mind: { mindCapture: "prompt", mindNudge: false } });
	await command(harness).handler("show", ctx);
	const report = harness.notices.at(-1)!.message;
	assert.match(report, /mindCapture: active=prompt/);
	assert.match(report, /mindNudge: active=Off/);
	assert.doesNotMatch(report, /flowEnabled:/);
});

test("a Mind preference edits through the same canonical patch path as Persona settings", async () => {
	const harness = makeHarness();
	harness.deps.companions = () => ({ mind: { mindCapture: "auto", mindNudge: true } });
	let step = 0;
	await command(harness).handler("", makeContext({
		notices: harness.notices,
		select: async (_title, options) => {
			step++;
			if (step === 1) return options.find((option) => option.includes("[mindCapture]"));
			if (step === 2) return "Edit";
			if (step === 3) return "prompt";
			return "Close";
		},
	}));
	assert.deepEqual(harness.writeCalls, [{ preferences: { mindCapture: "prompt" } }]);
	assert.ok(harness.notices.some(({ message }) => /running value remains auto/.test(message)));
});

test("Flow's desired service port uses the unified numeric editor and leaves service control to Flow", async () => {
	const harness = makeHarness();
	harness.deps.companions = () => ({ flow: { flowEnabled: true, flowPort: 7874, flowIdleMs: 60000 } });
	let step = 0;
	await command(harness).handler("", makeContext({
		notices: harness.notices,
		select: async (_title, options) => {
			step++;
			if (step === 1) return options.find((option) => option.includes("[flowPort]"));
			if (step === 2) return "Edit";
			return "Close";
		},
		input: async () => "0",
	}));
	assert.deepEqual(harness.writeCalls, [{ preferences: { flowPort: 0 } }]);
	assert.ok(harness.notices.some(({ message }) => /existing service is unchanged/.test(message)));
	assert.equal(harness.models.length, 0);
});
