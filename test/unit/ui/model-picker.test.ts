import { test } from "node:test";
import assert from "node:assert/strict";

import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, Input, KeybindingsManager, TUI_KEYBINDINGS, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager as HostKeybindingsManager } from "@earendil-works/pi-coding-agent";

import { filterModels, ModelPicker, type ModelPickerConfig, type ModelPickerMetadata, orderModelRefs, visibleWindow } from "../../../src/ui/model-picker.ts";

test("filterModels: case-insensitive substring, order preserved, empty query returns all", () => {
	const opts = ["anthropic/claude-sonnet-4-6", "openrouter/owl-alpha", "openrouter/qwen-3"];
	assert.deepEqual(filterModels(opts, ""), opts);
	assert.deepEqual(filterModels(opts, "  "), opts, "whitespace-only query returns all");
	assert.deepEqual(filterModels(opts, "OWL"), ["openrouter/owl-alpha"]);
	assert.deepEqual(filterModels(opts, "openrouter"), ["openrouter/owl-alpha", "openrouter/qwen-3"]);
	assert.deepEqual(filterModels(opts, "zzz"), []);
});

test("visibleWindow: keeps the selected row inside the viewport with minimal scroll", () => {
	const size = 5;
	const total = 20;
	// Short lists never scroll.
	assert.equal(visibleWindow(3, size, 4, 0), 0);
	// Selecting within the current window keeps the scroll.
	assert.equal(visibleWindow(2, size, total, 0), 0);
	// Selecting below the window pushes scroll down so the row is the last visible.
	assert.equal(visibleWindow(7, size, total, 0), 3, "7 - 5 + 1 = 3");
	// Selecting above the window pulls scroll up to the row.
	assert.equal(visibleWindow(2, size, total, 6), 2);
	// Never scrolls past the end.
	assert.equal(visibleWindow(19, size, total, 0), 15, "max scroll = total - size");
	// Never negative.
	assert.equal(visibleWindow(0, size, total, 0), 0);
});

test("orderModelRefs: session provider first (then alphabetical), originals untouched", () => {
	const refs = ["openrouter/owl-alpha", "anthropic/sonnet", "bedrock/nova", "anthropic/haiku"];
	const ordered = orderModelRefs(refs, "anthropic");
	assert.deepEqual(ordered, ["anthropic/haiku", "anthropic/sonnet", "bedrock/nova", "openrouter/owl-alpha"]);
	// pure: input array not mutated
	assert.equal(refs[0], "openrouter/owl-alpha");
	// no session provider → plain alphabetical
	assert.deepEqual(orderModelRefs(["b/x", "a/y"], undefined), ["a/y", "b/x"]);
});

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function picker(options: string[], config: ModelPickerConfig = {}, title = "Pick a model", skin = theme) {
	const results: (string | undefined)[] = [];
	let renders = 0;
	const component = new ModelPicker(
		{ requestRender: () => { renders++; } } as TUI,
		skin, title, options, "p", (ref) => results.push(ref), config,
	);
	return {
		component, results,
		text: (width = 104) => component.render(width).map(stripVTControlCharacters).join("\n"),
		renders: () => renders,
	};
}

function paste(component: ModelPicker, text: string): void {
	component.handleInput(`\x1b[200~${text}\x1b[201~`);
}

function rows(text: string): string[] {
	return text.split("\n").filter((line) => /[▸★✓]/u.test(line) && !line.includes("session provider"));
}

test("config accepts readonly host snapshots without changing catalog policy", () => {
	const hostModels: readonly Model<Api>[] = [];
	const metadata: readonly ModelPickerMetadata[] = hostModels;
	const config: ModelPickerConfig = { models: metadata };
	assert.deepEqual(config.models, []);
});

test("empty search preserves caller order; eligible current ref starts selected and is marked separately", () => {
	const p = picker(["p/zulu", "other/alpha", "p/beta"], { currentRef: "other/alpha" });
	const output = p.text();
	assert.ok(output.indexOf("p/zulu") < output.indexOf("other/alpha"));
	assert.ok(output.indexOf("other/alpha") < output.indexOf("p/beta"));
	assert.match(output, /▸.*✓.*other\/alpha/u);
	assert.match(output, /✓ current/u);
	assert.doesNotMatch(output, /assigned|saved|pinned/u);
	assert.match(output, /★.*p\/zulu/u);
	assert.doesNotMatch(rows(output).find((line) => line.includes("other/alpha"))!, /★/u);
	p.component.handleInput("\r");
	assert.deepEqual(p.results, ["other/alpha"]);
});

test("ineligible current ref and extra metadata never add choices", () => {
	const p = picker(["p/alpha"], {
		currentRef: "ghost/secret",
		models: [{ provider: "ghost", id: "secret", name: "Hidden Exclusive" }],
	});
	assert.doesNotMatch(p.text(), /ghost|Exclusive/u);
	assert.doesNotMatch(rows(p.text()).join("\n"), /✓/u, "legend is not a current choice");
	paste(p.component, "Hidden Exclusive");
	assert.match(p.text(), /no model matches/u);
	p.component.handleInput("\r");
	assert.deepEqual(p.results, [], "no match must not confirm or cancel");
});

test("picker supports fuzzy multi-token name, id and provider search, unlike substring helper", () => {
	const p = picker(["anthropic/claude-sonnet", "openai/gpt-fast", "p/opaque-id"], {
		models: [{ provider: "p", id: "opaque-id", name: "Friendly Vision Model" }],
	});
	paste(p.component, "mdl frndly");
	assert.match(p.text(), /opaque-id/u);
	assert.doesNotMatch(p.text(), /claude-sonnet|gpt-fast/u);
	assert.deepEqual(filterModels(["p/opaque-id"], "mdl frndly"), []);
	p.component.handleInput("\x15"); // native Ctrl+U clears to line start
	paste(p.component, "snnt anth");
	p.component.handleInput("\r");
	assert.deepEqual(p.results, ["anthropic/claude-sonnet"]);
});

test("full qualified ref ranks before fuzzy matches even with a stronger friendly-name score", () => {
	const p = picker(["p/model-extended", "p/model", "p/model-extra"], {
		models: [{ provider: "p", id: "model-extended", name: "p model p model" }],
	});
	paste(p.component, "P/MODEL");
	const output = p.text();
	assert.ok(output.indexOf("p/model ") < output.indexOf("p/model-extended"));
	p.component.handleInput("\r");
	assert.deepEqual(p.results, ["p/model"], "an exact typed ref takes precedence over a surviving fuzzy selection");
});

test("an exact case-sensitive qualified ref wins over a case-folded sibling", () => {
	const p = picker(["p/Model", "p/model"], { currentRef: "p/Model" });
	paste(p.component, "p/model");
	p.component.handleInput("\r");
	assert.deepEqual(p.results, ["p/model"]);
});

test("capability metadata gets spare columns before a long friendly name", () => {
	const p = picker(["provider/reasonably-long-model-id"], {
		models: [{ provider: "provider", id: "reasonably-long-model-id", name: "A very long friendly model name that fills the row", contextWindow: 200_000, reasoning: true, input: ["image"] }],
	});
	const line = rows(p.text(80))[0]!;
	assert.match(line, /provider\/reasonably-long-model-id/);
	assert.match(line, /200k/);
	assert.match(line, /reasoning/);
	assert.match(line, /vision/);
});

test("selection follows canonical ref through ranking changes, widening and narrowing", () => {
	const p = picker(["p/alpha", "p/alpine", "p/beta"]);
	p.component.handleInput("\x1b[B");
	paste(p.component, "alp");
	assert.match(p.text(), /▸.*p\/alpine/u);
	p.component.handleInput("\x15");
	assert.match(p.text(), /▸.*p\/alpine/u);
	paste(p.component, "beta");
	assert.match(p.text(), /▸.*p\/beta/u, "removed selection falls back to first match");
	p.component.handleInput("\x15");
	p.component.handleInput("\r");
	assert.deepEqual(p.results, ["p/beta"]);
});

test("native Input handles chunked paste, cursor edits, delete and grapheme backspace", () => {
	const p = picker(["p/alpha", "p/alpine"]);
	p.component.handleInput("\x1b[200~al");
	p.component.handleInput("pha\x1b[201~");
	const input = p.component.children.find((child): child is Input => child instanceof Input);
	assert.ok(input, "edits must go through the real Pi Input");
	assert.equal(input.getValue(), "alpha");
	p.component.handleInput("\x1b[D");
	p.component.handleInput("\x7f"); // alpa
	p.component.handleInput("h"); // alpha
	assert.match(p.text(), /1\/2/u);
	p.component.handleInput("\x01"); // home
	p.component.handleInput("\x1b[3~"); // delete a
	p.component.handleInput("a");
	p.component.handleInput("\x05"); // end
	p.component.handleInput("👩‍💻");
	p.component.handleInput("\x7f"); // delete whole grapheme
	assert.equal(input.getValue(), "alpha");
	p.component.handleInput("\r");
	assert.deepEqual(p.results, ["p/alpha"]);
	assert.ok(p.renders() > 0);
});

test("paste chunks containing action keys stay in native paste buffering, including split end marker", () => {
	const p = picker(["p/alpha", "p/beta"]);
	p.component.handleInput("\x1b[200~al");
	p.component.handleInput("\r");
	p.component.handleInput("pha\x1b[20");
	p.component.handleInput("1~");
	assert.deepEqual(p.results, [], "a pasted newline must not choose the current model");
	p.component.handleInput("\x1b[B"); // only alpha matches
	p.component.handleInput("\r");
	assert.deepEqual(p.results, ["p/alpha"]);
});

test("focus forwards to actual Input and emits exactly one hardware cursor marker", () => {
	const p = picker(["p/alpha"]);
	assert.ok(p.component.children.some((child) => child instanceof Input));
	p.component.focused = true;
	assert.equal(p.component.focused, true);
	assert.equal((p.component.children.find((child) => child instanceof Input) as Input).focused, true);
	assert.equal(p.component.render(80).join("\n").split(CURSOR_MARKER).length - 1, 1);
	p.component.focused = false;
	assert.equal(p.component.render(80).join("\n").includes(CURSOR_MARKER), false);
});

test("injected keybindings control selection, confirm, cancel and native editor without leaking globally", () => {
	const global = getKeybindings();
	const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.down": ["ctrl+n"],
		"tui.select.confirm": ["ctrl+s"],
		"tui.select.cancel": ["ctrl+q"],
		"tui.editor.deleteToLineStart": ["ctrl+r"],
	}) as HostKeybindingsManager;
	const p = picker(["p/alpha", "p/beta"], { keybindings: bindings });
	paste(p.component, "alpha");
	p.component.handleInput("\x12");
	assert.match(p.text(), /2\/2/u, "injected Ctrl+R clears the native Input");
	p.component.handleInput("\x0e");
	assert.match(p.text(), /▸.*p\/beta/u);
	p.component.handleInput("\x13");
	assert.deepEqual(p.results, ["p/beta"]);
	assert.equal(getKeybindings(), global);
	const cancel = picker(["p/alpha"], { keybindings: bindings });
	cancel.component.handleInput("\x11");
	assert.deepEqual(cancel.results, [undefined]);
	assert.equal(getKeybindings(), global);
});

test("metadata is compact, explicit only, and ref precedes friendly name", () => {
	const p = picker(["p/opaque", "p/unknown", "p/plain"], {
		models: [
			{ provider: "p", id: "opaque", name: "Friendly", contextWindow: 200000, reasoning: true, input: ["text", "image"] },
			{ provider: "p", id: "plain", contextWindow: NaN, reasoning: false, input: ["text"] },
		],
	});
	const output = p.text();
	const rich = rows(output).find((line) => line.includes("p/opaque"))!;
	assert.match(rich, /p\/opaque.*200k ctx.*reasoning.*vision.*Friendly/u);
	for (const ref of ["p/unknown", "p/plain"]) {
		assert.doesNotMatch(rows(output).find((line) => line.includes(ref))!, /ctx|reasoning|vision|NaN/u);
	}
	const narrow = p.text(28);
	assert.match(narrow, /p\/opaque/u, "ref wins width budget over friendly name and badges");
});

test("sanitizes display fields and paste controls but returns the original canonical ref", () => {
	const ref = "p/a\x1b[31m\n\t\u202e👩‍💻";
	const p = picker([ref], {
		models: [{ provider: "p", id: ref.slice(2), name: "Nice\x1b]0;spoof\x07\nName" }],
	}, "Title\x1b[2J\nInjected");
	const output = p.text();
	assert.equal(output.includes("\u202e"), false);
	assert.equal(output.includes("\t"), false);
	assert.equal(output.includes("spoof"), false);
	assert.equal(output.split("\n").filter((line) => line.includes("Injected")).length, 1);
	p.component.handleInput("\r");
	assert.deepEqual(p.results, [ref]);
	const query = picker(["p/alpha"]);
	paste(query.component, "\x1b]0;spoof\x07alpha");
	assert.equal(query.component.render(80).join("\n").includes("\x1b]0;"), false);
});

test("every render fits terminal columns across first render, narrow widths, resize and wide Unicode", () => {
	const p = picker(["供應商/模型👩‍💻é", `p/${"界".repeat(100)}`], {
		models: [{ provider: "供應商", id: "模型👩‍💻é", name: "友好模型".repeat(50) }],
	}, "選択👩‍💻é".repeat(20));
	p.component.focused = true;
	paste(p.component, "界👩‍💻é".repeat(20));
	for (const width of [28, 104, 17, 80, 8, 7, 4, 3, 2, 1, 0, 40, 104]) {
		const lines = p.component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
			assert.doesNotMatch(line, /[\n\r\t]/u);
		}
	}
	p.component.handleInput("\x15");
	assert.match(p.text(104), /供應商\/模型/u, "widening restores content without another edit");
});

test("native cursor marker follows cursor-left editing and survives resize", () => {
	const p = picker(["p/alpha"]);
	p.component.focused = true;
	paste(p.component, "alpha");
	p.component.handleInput("\x1b[D");
	for (const width of [80, 20, 80]) {
		const line = p.component.render(width).find((row) => row.includes(CURSOR_MARKER))!;
		assert.ok(line.includes(`alph${CURSOR_MARKER}`), JSON.stringify(line));
	}
});

test("first narrow render then widening restores complete ref and bounded metadata", () => {
	const ref = "p/long-reference-with-a-distinct-suffix";
	const p = picker([ref], {
		models: [{ provider: "p", id: ref.slice(2), name: "Friendly".repeat(100), contextWindow: Infinity }],
	});
	assert.equal(p.text(20).includes(ref), false);
	assert.match(p.text(104), /p\/long-reference-with-a-distinct-suffix/u);
	assert.doesNotMatch(p.text(104), /Infinity|ctx/u);
});

test("theme invalidation recomputes styles without losing query, focus or selection", () => {
	let color = 31;
	const skin = {
		fg: (_role: string, text: string) => `\x1b[${color}m${text}\x1b[0m`,
		bold: (text: string) => text,
	} as Theme;
	const p = picker(["p/alpha", "p/alpine"], {}, "Theme test", skin);
	p.component.focused = true;
	p.component.handleInput("\x1b[B");
	paste(p.component, "alp");
	assert.ok(p.component.render(80).join("\n").includes("\x1b[31m"));
	color = 32;
	p.component.invalidate();
	const output = p.component.render(80).join("\n");
	assert.equal(output.includes("\x1b[31m"), false);
	assert.ok(output.includes("\x1b[32m"));
	assert.ok(output.includes(CURSOR_MARKER));
	assert.match(stripVTControlCharacters(output), /▸.*p\/alpine/u);
});

test("viewport follows eligible current ref and arrow navigation stays on screen", () => {
	const options = Array.from({ length: 35 }, (_, i) => `p/model-${i}`);
	const p = picker(options, { currentRef: options[30]! });
	assert.match(p.text(), /▸.*p\/model-30/u);
	assert.match(p.text(), /above/u);
	for (let i = 0; i < 30; i++) p.component.handleInput("\x1b[A");
	assert.match(p.text(), /▸.*p\/model-0\s/u);
	assert.equal(rows(p.text()).length, 12);
});

test("escape and Ctrl+C cancel; empty options stay safe", () => {
	for (const key of ["\x1b", "\x03"]) {
		const p = picker([]);
		p.component.handleInput("\x1b[B");
		p.component.handleInput("\r");
		assert.deepEqual(p.results, []);
		p.component.handleInput(key);
		assert.deepEqual(p.results, [undefined]);
	}
});
