import assert from "node:assert/strict";
import { test } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import {
	PersonaSettingsPanel,
	filterSettingsRows,
	formatSettingValue,
	visibleSettingsWindow,
	type SettingsPanelAction,
	type SettingsPanelRow,
} from "../../../src/ui/persona-settings.ts";

const rows: SettingsPanelRow[] = [
	{
		id: "engine",
		group: "Runtime",
		label: "Agent engine",
		description: "Choose which engine runs delegated work.",
		kind: "choice",
		choices: ["inproc", "child"],
		activeValue: "inproc",
		savedValue: undefined,
		hasSavedValue: false,
		source: "default",
		locked: false,
		applyWhen: "New delegated runs",
	},
	{
		id: "extraDirs",
		group: "Discovery",
		label: "Additional agent directories",
		description: "Search these extra directories for agents.",
		kind: "string-list",
		activeValue: ["D:\\agent sets\\primary"],
		savedValue: ["D:\\agent sets\\primary"],
		hasSavedValue: true,
		source: "saved",
		locked: false,
		applyWhen: "After /reload",
	},
];

function theme(): Theme {
	return {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

function keybindings(): KeybindingsManager {
	return {
		getKeys: (binding: string) => {
			const keys: Record<string, string[]> = { "tui.select.up": ["up"], "tui.select.down": ["down"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["escape"] };
			return keys[binding] ?? [];
		},
		matches: (data: string, binding: string) => {
			if (binding === "tui.select.up") return data === "UP";
			if (binding === "tui.select.down") return data === "DOWN";
			if (binding === "tui.select.confirm") return data === "ENTER";
			if (binding === "tui.select.cancel") return data === "ESC";
			return false;
		},
	} as unknown as KeybindingsManager;
}

function fakeTui(rows = 24): TUI {
	return {
		terminal: { rows },
		requestRender: () => {},
	} as unknown as TUI;
}

test("filterSettingsRows matches labels, groups, ids and descriptions without reordering", () => {
	assert.deepEqual(filterSettingsRows(rows, ""), rows);
	assert.deepEqual(filterSettingsRows(rows, "  "), rows);
	assert.deepEqual(filterSettingsRows(rows, "RUNTIME"), [rows[0]]);
	assert.deepEqual(filterSettingsRows(rows, "discovery"), [rows[1]]);
	assert.deepEqual(filterSettingsRows(rows, "delegated work"), [rows[0]]);
	assert.deepEqual(filterSettingsRows(rows, "no match"), []);
});

test("visibleSettingsWindow keeps the selected row visible and clamps both ends", () => {
	assert.equal(visibleSettingsWindow(3, 5, 4, 0), 0);
	assert.equal(visibleSettingsWindow(8, 5, 20, 0), 4);
	assert.equal(visibleSettingsWindow(2, 5, 20, 6), 2);
	assert.equal(visibleSettingsWindow(19, 5, 20, 0), 15);
	assert.equal(visibleSettingsWindow(-1, 5, 20, 0), 0);
});

test("formatSettingValue sanitizes terminal controls and preserves Windows path punctuation", () => {
	assert.equal(formatSettingValue(true), "On");
	assert.equal(formatSettingValue(false), "Off");
	assert.equal(formatSettingValue(["D:\\agent sets\\primary", "C:\\agents;archive"]), "D:\\agent sets\\primary, C:\\agents;archive");
	assert.equal(formatSettingValue("\u001b[31munsafe\u001b[0m\u0007"), "unsafe");
	assert.equal(formatSettingValue(undefined), "(unset)");
});

test("the full-page panel filters, navigates, edits, resets and cancels without losing selection state", () => {
	const actions: SettingsPanelAction[] = [];
	const panel = new PersonaSettingsPanel(fakeTui(), theme(), keybindings(), {
		file: "D:\\very long\\persona config.json",
		lastPersona: "reviewer",
		rows,
	}, (action) => actions.push(action));

	panel.handleInput("/");
	for (const char of "agent engine") panel.handleInput(char);
	panel.handleInput("ENTER");
	panel.handleInput("ENTER");
	assert.deepEqual(actions, [{ type: "edit", id: "engine" }]);

	panel.handleInput("r");
	assert.deepEqual(actions.at(-1), { type: "reset", id: "engine" });

	panel.handleInput("ESC");
	panel.handleInput("ESC");
	assert.deepEqual(actions.at(-1), { type: "close" });
});

test("the panel fits narrow and wide terminals and strips ANSI/control injection from visible values", () => {
	const hostileRows: SettingsPanelRow[] = [
		{
			...rows[1]!,
			label: "資料\u001b[31m agent settings with an unusually long label",
			description: "\u001b]0;spoof title\u0007" + "D:\\agents\\" + "界".repeat(100),
			activeValue: ["C:\\very long\\" + "界".repeat(100)],
		},
	];
	const panel = new PersonaSettingsPanel(fakeTui(16), theme(), keybindings(), {
		file: "D:\\配置\\" + "long-path\\".repeat(20),
		lastPersona: "\u001b[2Jreviewer",
		rows: hostileRows,
	}, () => {});

	for (const width of [40, 60, 80, 120]) {
		const rendered = panel.render(width);
		assert.ok(rendered.length <= 16, `rendered ${rendered.length} rows at width ${width}`);
		for (const line of rendered) assert.ok(visibleWidth(line) <= width, `line overflowed at ${width}: ${line}`);
		const plain = rendered.join("\n");
		assert.doesNotMatch(plain, /\u001b\]0;|\u001b\[31m|\u001b\[2J/);
		assert.match(plain, /D:/, "drive colon and backslashes remain ordinary path text");
		assert.match(plain, /Active now:/);
		assert.match(plain, /Saved override:/);
		assert.match(plain, /Applies:/);
	}
});

test("the panel keeps host theme colors while clamping styled rows", () => {
	const themed = new PersonaSettingsPanel(fakeTui(), {
		fg: (_role: string, text: string) => `\u001b[38;5;201m${text}\u001b[0m`,
		bold: (text: string) => text,
	} as unknown as Theme, keybindings(), {
		file: "D:\\persona.json",
		lastPersona: null,
		rows,
	}, () => {});
	const rendered = themed.render(80);
	assert.match(rendered.join("\n"), /\u001b\[38;5;201m/);
	for (const line of rendered) assert.ok(visibleWidth(line) <= 80);
});

test("the split detail column starts at one stable terminal column", () => {
	const panel = new PersonaSettingsPanel(fakeTui(), theme(), keybindings(), {
		file: "D:\\persona.json",
		lastPersona: null,
		rows,
	}, () => {});
	const rendered = panel.render(100);
	const detailLines = rendered.filter((line) => line.includes("Group:") || line.includes("Active now:"));
	assert.equal(detailLines.length, 2);
	for (const line of detailLines) {
		const detailStart = line.indexOf(line.includes("Group:") ? "Group:" : "Active now:");
		assert.equal(visibleWidth(line.slice(0, detailStart)), 43, `detail column drifted: ${line}`);
	}
});

test("settings hints reflect the injected navigation and confirmation bindings", () => {
	const bindings = keybindings();
	const keys: Record<string, string[]> = { "tui.select.up": ["f1"], "tui.select.down": ["f2"], "tui.select.confirm": ["f3"], "tui.select.cancel": ["f4"] };
	bindings.getKeys = (binding) => keys[binding] as ReturnType<KeybindingsManager["getKeys"]>;
	const panel = new PersonaSettingsPanel(fakeTui(), theme(), bindings, { file: "settings.json", lastPersona: null, rows }, () => {});
	const output = panel.render(100).join("\n");
	assert.match(output, /f1\/f2 move/);
	assert.match(output, /f3 edit/);
	assert.match(output, /f4 close/);
	assert.doesNotMatch(output, /enter edit|esc close/);
	panel.handleInput("/");
	assert.match(panel.render(100).join("\n"), /backspace, f3/);
});

test("model access and close hints stay discoverable on a narrow terminal", () => {
	const panel = new PersonaSettingsPanel(fakeTui(), theme(), keybindings(), {
		file: "D:\\persona.json", lastPersona: null, rows,
	}, () => {});
	const rendered = panel.render(40).join("\n");
	assert.match(rendered, /m models/);
	assert.match(rendered, /esc close/);
});
