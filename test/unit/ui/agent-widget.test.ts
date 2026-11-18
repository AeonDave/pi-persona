import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { type AgentNode, flattenTree, projectAgentTreeSummary, type RenderOptions } from "../../../src/ui/agent-tree.ts";
import { compactWidget, type WidgetTheme } from "../../../src/ui/compact-widget.ts";
import { foldedRows, projectResourceGroups, RESOURCE_GROUP_IDS, resourceSummary } from "../../../src/ui/resource-groups.ts";
import { rowText } from "../../../src/ui/styled-row.ts";

/** The above-editor agent widget as the extension publishes it: resourceSummary → compactWidget. */

const NOW = 1_000_000;
const OPTS: RenderOptions = { now: NOW, stallMs: 90_000, waitingForSupervisor: new Set<string>() };
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (row: string): string => row.replace(SGR, "");

/** The audit fixture: a 3-leg delegate (one running, one done, one stalled), a root worker, and one
 *  monitor, timer and script. Eleven projected rows for an eight-row budget. */
function auditFixture(): AgentNode[] {
	return [
		{ id: "batch", label: "delegate · 3 legs", parentId: undefined, status: "running", kind: "delegate", detail: "1/3 settled", startedAt: NOW - 95_000, lastAdvanceAt: NOW - 1_000 },
		{ id: "auth", label: "auth-review", parentId: "batch", status: "running", kind: "subagent", thinking: "high", detail: "reading src/auth/session.ts · 12.4k tok", startedAt: NOW - 95_000, lastAdvanceAt: NOW - 2_000 },
		{ id: "tokens", label: "token-tests", parentId: "batch", status: "done", kind: "subagent", thinking: "high", detail: "8.1k tok · ~$0.04", startedAt: NOW - 60_000 },
		{ id: "perf", label: "perf-scan", parentId: "batch", status: "running", kind: "subagent", thinking: "high", detail: "bash: npm run bench · 5.2k tok", startedAt: NOW - 130_000, lastAdvanceAt: NOW - 100_000 },
		{ id: "probe", label: "perf-probe", parentId: undefined, status: "running", kind: "subagent", detail: "bash: hyperfine … · 3.0k tok", startedAt: NOW - 40_000, lastAdvanceAt: NOW - 1_000 },
		{ id: "monitor:1", label: "watch build", parentId: undefined, status: "running", kind: "monitor", detail: undefined, startedAt: NOW - 30_000, dueAt: NOW + 3_600_000 },
		{ id: "timer:1", label: "check deploy", parentId: undefined, status: "running", kind: "timer", detail: undefined, startedAt: NOW - 30_000, dueAt: NOW + 510_000 },
		{ id: "script:1", label: "lint", parentId: undefined, status: "running", kind: "script", detail: undefined, startedAt: NOW - 20_000 },
	];
}

/** Twenty progressing legs and one stalled leg last in tree order: the budget alone cannot show it. */
function wideFanout(): AgentNode[] {
	return [
		{ id: "wide", label: "delegate · 21 legs", parentId: undefined, status: "running", kind: "delegate", detail: undefined, startedAt: NOW - 50_000, lastAdvanceAt: NOW - 1_000 },
		...Array.from({ length: 20 }, (_, i): AgentNode => ({ id: `leg:${i}`, label: `leg-${i}`, parentId: "wide", status: "running", kind: "subagent", detail: "working", startedAt: NOW - 50_000, lastAdvanceAt: NOW - 1_000 })),
		{ id: "quiet", label: "QUIET-LEG", parentId: "wide", status: "running", kind: "subagent", detail: "bash: long build", startedAt: NOW - 300_000, lastAdvanceAt: NOW - 200_000 },
	];
}

/** Records every painted span; returns the text unchanged so rows stay measurable. */
function recordingTheme(): { theme: WidgetTheme; calls: Array<[string, string]> } {
	const calls: Array<[string, string]> = [];
	return { calls, theme: { fg: (token, text) => { calls.push([token, text]); return text; } } };
}

/** The host passes a live proxy over its current theme instance; mirror that for stock themes. */
const HOST_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
function hostTheme(name: "dark" | "light"): WidgetTheme {
	initTheme(name, false);
	const instance = (globalThis as Record<symbol, Theme | undefined>)[HOST_THEME_KEY];
	assert.ok(instance, "initTheme publishes the host's global theme instance");
	return instance;
}
const liveHostTheme = new Proxy({} as WidgetTheme, {
	get: (_target, prop) => (globalThis as Record<symbol, Record<PropertyKey, unknown>>)[HOST_THEME_KEY]![prop],
});

function paint(nodes: AgentNode[], collapsed: ReadonlySet<string>, width: number, theme?: WidgetTheme, maxRows = 8) {
	const summary = resourceSummary(nodes, collapsed, maxRows, OPTS);
	const component = compactWidget(summary.styled, summary.targets)(undefined, theme);
	return { summary, component, rows: component.render(width) };
}

test("the audit fixture keeps all three legs and folds the restating group headers into the digest", () => {
	const { summary, rows } = paint(auditFixture(), new Set(), 200);
	assert.deepEqual(rows, [
		" ▾ ⏳ delegate · 3 legs  1/3 settled · 1m 35s",
		" ├─ ⏳ auth-review · high  reading src/auth/session.ts · 12.4k tok · 1m 35s",
		" ├─ ✓ token-tests · high  8.1k tok · ~$0.04",
		" └─ ⏳ perf-scan · high  bash: npm run bench · 5.2k tok · ⚠ stalled 1m 40s",
		" ⏳ perf-probe  bash: hyperfine … · 3.0k tok · 40s",
		" ◉ 1 monitor · ⏰ 1 timer · ⚙ 1 script · next due in 8m 30s",
		" … +6 more · F9 or /agents for the full live tree",
	]);
	assert.ok(summary.lines.length <= 8);
	assert.doesNotMatch(summary.lines.join("\n"), /◆ (Monitors|Timers|Scripts)/, "no header restates the digest");
	assert.deepEqual(summary.targets, ["batch", undefined, undefined, undefined, undefined, undefined, undefined]);
});

test("styled spans paint exactly the published plain lines", () => {
	const variants: Array<[AgentNode[], Set<string>]> = [
		[auditFixture(), new Set()],
		[auditFixture(), new Set(["batch"])],
		[auditFixture(), new Set(Object.values(RESOURCE_GROUP_IDS))],
		[wideFanout(), new Set()],
		[wideFanout(), new Set(["wide"])],
	];
	for (const [nodes, collapsed] of variants) {
		const summary = resourceSummary(nodes, collapsed, 8, OPTS);
		assert.equal(summary.styled.length, summary.lines.length);
		assert.equal(summary.targets.length, summary.lines.length);
		summary.styled.forEach((row, i) => assert.equal(rowText(row), summary.lines[i]));
	}
});

test("semantic tokens: names keep text, detail and clocks are muted, connectors dim, states use their tokens", () => {
	const nodes = auditFixture();
	nodes.push({ id: "bad", label: "bad-leg", parentId: undefined, status: "failed", kind: "subagent", detail: "provider" });
	const { theme, calls } = recordingTheme();
	paint(nodes, new Set(), 200, theme, 12);
	const has = (token: string, text: string): boolean => calls.some(([t, s]) => t === token && s === text);
	for (const [token, text] of [
		["dim", "├─ "], ["dim", "└─ "], ["dim", "  "], ["dim", " · "],
		["text", " auth-review"], ["text", " token-tests"], ["text", " perf-scan"], ["text", " perf-probe"], ["text", " bad-leg"],
		["muted", " · high"], ["muted", "reading src/auth/session.ts · 12.4k tok"], ["muted", "8.1k tok · ~$0.04"], ["muted", "1m 35s"],
		["muted", "fires in 8m 30s"],
		["success", "✓"], ["error", "✗"], ["warning", "⚠ stalled 1m 40s"], ["accent", "◉"],
	] as const) assert.ok(has(token, text), `${token} paints ${JSON.stringify(text)}`);
	for (const name of ["auth-review", "token-tests", "perf-scan", "perf-probe", "bad-leg"]) {
		assert.ok(!calls.some(([t, s]) => t !== "text" && s.includes(name)), `${name} is never dimmed or recoloured`);
	}
	const digest = recordingTheme();
	paint(auditFixture(), new Set(), 200, digest.theme);
	assert.ok(digest.calls.some(([t, s]) => t === "muted" && s === "next due in 8m 30s"));
	assert.ok(digest.calls.some(([t, s]) => t === "dim" && s.startsWith("… +6 more")), "the overflow hint recedes");
});

test("the theme is read at render time: a theme change repaints the same component", () => {
	let palette = "first";
	const mutable: WidgetTheme = { fg: (token, text) => `<${palette}:${token}>${text}` };
	const { component } = paint(auditFixture(), new Set(), 100, mutable);
	const before = component.render(100);
	palette = "second";
	component.invalidate();
	const after = component.render(100);
	assert.match(before.join("\n"), /<first:muted>/);
	assert.match(after.join("\n"), /<second:muted>/);
	assert.doesNotMatch(after.join("\n"), /<first:/, "no colour was captured at publication");

	hostTheme("dark");
	const stock = paint(auditFixture(), new Set(), 100, liveHostTheme).component;
	const dark = stock.render(100);
	hostTheme("light");
	stock.invalidate();
	const light = stock.render(100);
	assert.notDeepEqual(dark, light, "switching the stock theme repaints without republishing");
	assert.deepEqual(dark.map(strip), light.map(strip), "only colours change");
	assert.deepEqual(dark.map(strip), paint(auditFixture(), new Set(), 100).rows, "themed text equals the unthemed widget");
	initTheme("dark", false);
});

test("rows are inset one column and nothing is appended toward the editor; an empty widget draws nothing", () => {
	const { rows, summary } = paint(auditFixture(), new Set(), 100);
	assert.equal(rows.length, summary.lines.length, "the gap toward the editor is the editor's and the theme's, not the widget's");
	assert.ok(rows.every((row, i) => row === ` ${summary.lines[i]}`), "content starts at column 1, like the host's Text(line, 1, 0)");
	assert.ok(rows.every((row) => row.trim() !== ""), "no blank spacing row");
	assert.deepEqual(compactWidget([])(undefined, liveHostTheme).render(100), [], "no rows: nothing drawn");
});

test("a stalled leg below the fold keeps its flag in its own digest", () => {
	for (const collapsed of [new Set<string>(), new Set(["wide"])]) {
		const summary = resourceSummary(wideFanout(), collapsed, 8, OPTS);
		assert.ok(summary.lines.length <= 8);
		const text = summary.lines.join("\n");
		assert.match(text, collapsed.size ? /1 stalled/ : /⚠ 1 stalled: QUIET-LEG/);
		if (!collapsed.size) {
			const shown = summary.lines.filter((line) => /leg-\d+/.test(line) && !/active workers/.test(line)).length;
			assert.match(text, new RegExp(`⏳ ${20 - shown} active workers`), "the stalled leg is not counted as merely active");
		}
		for (const width of [100, 60, 40]) {
			const drawn = compactWidget(summary.styled, summary.targets)().render(width).join("\n");
			assert.match(drawn, /1 stalled/, `the stall flag survives at width ${width}`);
		}
	}
	for (const maxRows of [1, 2, 3]) {
		assert.match(resourceSummary(wideFanout(), new Set(), maxRows, OPTS).lines.join("\n"), /⚠ 1 stalled/, `${maxRows} rows still flag the stall`);
	}
});

test("stall and folded-alert flags survive right-edge clipping; detail is shortened first", () => {
	for (const width of [60, 40]) {
		const open = paint(auditFixture(), new Set(), width).rows;
		const stalled = open.find((row) => row.includes("perf-scan"))!;
		assert.ok(stalled.endsWith("⚠ stalled 1m 40s"), `width ${width}: ${stalled}`);
		assert.match(stalled, /…/, "the detail shows it was shortened");
		const folded = paint(auditFixture(), new Set(["batch"]), width).rows[0]!;
		assert.match(folded, /^ ▸ ⏳ delegate · 3 legs  1 stalled/, `width ${width}: ${folded}`);
	}
	const failed = auditFixture();
	failed.push({ id: "bad", label: "bad", parentId: "batch", status: "failed", kind: "subagent", detail: "provider error with a very long explanation" });
	for (const width of [60, 40]) {
		const folded = paint(failed, new Set(["batch"]), width).rows[0]!;
		assert.match(folded, /1 failed · 1 stalled/, `width ${width}: ${folded}`);
	}
});

test("click targets stay aligned with the drawn rows after header folding", () => {
	const variants: Array<Set<string>> = [new Set(), new Set(["batch"]), new Set([RESOURCE_GROUP_IDS.monitor]), new Set(Object.values(RESOURCE_GROUP_IDS))];
	const labels: Record<string, RegExp> = {
		batch: /[▾▸] ⏳ delegate · 3 legs/,
		[RESOURCE_GROUP_IDS.monitor]: /[▾▸] ◆ Monitors {2}1 active/,
		[RESOURCE_GROUP_IDS.timer]: /[▾▸] ◆ Timers {2}1 active/,
		[RESOURCE_GROUP_IDS.script]: /[▾▸] ◆ Scripts {2}1 active/,
	};
	const childOf: Record<string, string> = {
		[RESOURCE_GROUP_IDS.monitor]: "watch build", [RESOURCE_GROUP_IDS.timer]: "check deploy", [RESOURCE_GROUP_IDS.script]: "lint",
	};
	for (const collapsed of variants) {
		const summary = resourceSummary(auditFixture(), collapsed, 8, OPTS);
		const clicks: string[] = [];
		const component = compactWidget(summary.styled, summary.targets, (id) => clicks.push(id))();
		const rows = component.render(100);
		for (let y = 0; y < rows.length; y++) {
			const before = clicks.length;
			const handled = component.handleMouse?.({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: y, width: 100, height: rows.length, shift: false, alt: false, ctrl: false });
			const target = summary.targets[y];
			if (target) {
				assert.deepEqual(handled, { handled: true });
				assert.equal(clicks.at(-1), target);
				assert.match(rows[y]!, labels[target]!, `row ${y} draws the control it toggles`);
			} else {
				assert.equal(handled, undefined, `row ${y} (${JSON.stringify(rows[y])}) is not a control`);
				assert.equal(clicks.length, before);
			}
		}
		for (const id of collapsed) assert.ok(summary.targets.includes(id), `${id} stays reachable while collapsed`);
		for (const id of Object.values(RESOURCE_GROUP_IDS)) {
			if (collapsed.has(id)) continue;
			const headerShown = summary.targets.includes(id);
			const childShown = summary.lines.some((line) => line.includes(childOf[id]!));
			assert.equal(headerShown, childShown, `expanded ${id} shows only above a drawn child, else folds into the digest`);
		}
		assert.ok(summary.lines.length <= 8);
		assert.match(summary.lines.join("\n"), /⏳ perf-probe {2}/, `${[...collapsed].join(",") || "open"}: a reserved header takes the row a folded one freed, not a worker's`);
	}
});

test("every row fits the render width by pi-tui's visibleWidth at 100, 60 and 40 columns", () => {
	const themes: Array<[string, WidgetTheme | undefined]> = [["plain", undefined], ["dark", hostTheme("dark")], ["light", hostTheme("light")]];
	const fixtures: Array<[AgentNode[], Set<string>]> = [
		[auditFixture(), new Set()],
		[auditFixture(), new Set(["batch"])],
		[auditFixture(), new Set(Object.values(RESOURCE_GROUP_IDS))],
		[wideFanout(), new Set()],
		[wideFanout(), new Set(["wide"])],
	];
	for (const [name, theme] of themes) {
		for (const [nodes, collapsed] of fixtures) {
			for (const width of [100, 60, 40]) {
				const { rows, summary } = paint(nodes, collapsed, width, theme);
				assert.equal(rows.length, summary.lines.length);
				for (const row of rows) assert.ok(visibleWidth(row) <= width, `${name} @${width}: ${visibleWidth(row)} columns: ${strip(row)}`);
			}
		}
	}
	initTheme("dark", false);
});

/** A grid fixture: a delegate batch (running, failed, done, stalled legs), an optional root worker,
 *  and `timers`/`monitors`/`scripts` root wake rows. */
function gridFixture(timers: number, monitors: number, scripts: number, legs: number, root: boolean): AgentNode[] {
	const nodes: AgentNode[] = [];
	if (legs > 0) {
		nodes.push({ id: "batch", label: "delegate", parentId: undefined, status: "running", kind: "delegate", detail: undefined, startedAt: NOW - 10_000, lastAdvanceAt: NOW - 1_000 });
		for (let i = 0; i < legs; i++) {
			const status = i === 1 ? "failed" : i === 2 ? "done" : "running";
			nodes.push({ id: `leg:${i}`, label: `leg-${i}`, parentId: "batch", status, kind: "subagent", detail: "x", startedAt: NOW - 200_000, lastAdvanceAt: i === 3 ? NOW - 150_000 : NOW - 1_000 });
		}
	}
	if (root) nodes.push({ id: "probe", label: "probe", parentId: undefined, status: "running", kind: "subagent", detail: "y", startedAt: NOW - 5_000, lastAdvanceAt: NOW - 1_000 });
	for (let i = 0; i < timers; i++) nodes.push({ id: `timer:${i}`, label: `t${i}`, parentId: undefined, status: "running", kind: "timer", detail: undefined, startedAt: NOW - 1_000, dueAt: NOW + 60_000 * (i + 1) });
	for (let i = 0; i < monitors; i++) nodes.push({ id: `monitor:${i}`, label: `m${i}`, parentId: undefined, status: "running", kind: "monitor", detail: undefined, startedAt: NOW - 1_000, dueAt: NOW + 600_000 });
	for (let i = 0; i < scripts; i++) nodes.push({ id: `script:${i}`, label: `s${i}`, parentId: undefined, status: "running", kind: "script", detail: undefined, startedAt: NOW - 1_000 });
	return nodes;
}

/** The widget's selection exactly as `resourceSummary` makes it, with the row kinds kept. */
function selection(nodes: AgentNode[], collapsed: ReadonlySet<string>, budget: number) {
	const projected = foldedRows(projectResourceGroups(nodes), collapsed, OPTS).map((row) => row.node);
	const flat = flattenTree(projected);
	const preferred = flat.filter((row) => collapsed.has(row.node.id)).map((row) => row.node.id);
	const summary = projectAgentTreeSummary(projected, budget, OPTS, preferred);
	const drawn = new Set(summary.flatMap((row) => row.kind === "node" && row.nodeId ? [row.nodeId] : []));
	return { projected, flat, summary, drawn };
}

/** Expanded group headers drawn without any drawn child (a collapsed header has no projected child). */
function orphanHeaders(projected: readonly AgentNode[], summary: ReturnType<typeof selection>["summary"], drawn: ReadonlySet<string>): string[] {
	return summary.flatMap((row) => {
		const node = projected.find((candidate) => candidate.id === row.nodeId);
		if (row.kind !== "node" || node?.kind !== "resource-group") return [];
		const children = projected.filter((candidate) => candidate.parentId === node.id);
		return children.length > 0 && !children.some((child) => drawn.has(child.id)) ? [node.id] : [];
	});
}

test("`… +N more` counts exactly the tree rows not drawn, and no expanded header is drawn without a child, across enumerated fixtures", () => {
	const ids = ["batch", RESOURCE_GROUP_IDS.timer, RESOURCE_GROUP_IDS.monitor, RESOURCE_GROUP_IDS.script];
	let fixtures = 0;
	let withOverflow = 0;
	for (const timers of [0, 1, 3]) for (const monitors of [0, 1, 3]) for (const scripts of [0, 2]) for (const legs of [0, 4]) for (const root of [false, true]) {
		const nodes = gridFixture(timers, monitors, scripts, legs, root);
		for (let mask = 0; mask < 16; mask++) {
			const collapsed = new Set(ids.filter((_, i) => mask & (1 << i)));
			for (let budget = 2; budget <= 8; budget++) {
				fixtures++;
				const label = `timers=${timers} monitors=${monitors} scripts=${scripts} legs=${legs} root=${root} collapsed=[${[...collapsed].join(",")}] budget=${budget}`;
				const { projected, flat, summary, drawn } = selection(nodes, collapsed, budget);
				assert.ok(summary.length <= budget, label);
				const hidden = flat.length - drawn.size;
				const overflow = summary.find((row) => row.kind === "overflow");
				if (overflow) {
					withOverflow++;
					assert.equal(overflow.text, `… +${hidden} more · F9 or /agents for the full live tree`, label);
					assert.equal(overflow.compact, `+${hidden} more`, label);
				} else {
					assert.ok(hidden === 0 || summary.length === budget, `${label}: a free row with hidden rows shows the overflow hint`);
				}
				assert.deepEqual(orphanHeaders(projected, summary, drawn), [], label);
				const published = resourceSummary(nodes, collapsed, budget, OPTS).lines.join("\n").match(/\+(\d+) more/);
				if (published) assert.equal(Number(published[1]), hidden, `${label}: the published widget carries the same count`);
			}
		}
	}
	assert.equal(fixtures, 8064);
	assert.ok(withOverflow > 1000, `the grid exercises the overflow row (${withOverflow} fixtures)`);
});

test("a reservation that pushes out an expanded group's only visible child folds the header away", () => {
	const nodes = gridFixture(3, 3, 1, 0, false);
	const collapsed = new Set([RESOURCE_GROUP_IDS.script]);
	const { projected, summary, drawn } = selection(nodes, collapsed, 8);
	assert.deepEqual(orphanHeaders(projected, summary, drawn), []);
	const published = resourceSummary(nodes, collapsed, 8, OPTS);
	assert.ok(published.targets.includes(RESOURCE_GROUP_IDS.script), "the collapsed control keeps its reserved row");
	const expandedHeaders = published.lines.filter((line) => /^▾ ◆ /.test(line));
	for (const header of expandedHeaders) {
		const index = published.lines.indexOf(header);
		assert.match(published.lines[index + 1] ?? "", /^[├└]─ /, `${header} is followed by a child row: ${JSON.stringify(published.lines)}`);
	}
	assert.match(published.lines.join("\n"), /◉ \d monitors?/, "the hidden monitors are still counted by the wake digest");
});

test("a kept flag after a clipped name keeps its gap from the ellipsis at 40 and 60 columns", () => {
	const nodes: AgentNode[] = [
		{ id: "quiet", label: "an-extremely-long-worker-label-that-will-not-fit-anywhere", parentId: undefined, status: "running", kind: "subagent", detail: undefined, startedAt: NOW - 300_000, lastAdvanceAt: NOW - 200_000 },
		{ id: "rev", label: "reviewing the authentication module end to end", parentId: undefined, status: "running", kind: "delegate", detail: "1/2 settled", startedAt: NOW - 30_000, lastAdvanceAt: NOW - 1_000 },
		{ id: "bad", label: "bad", parentId: "rev", status: "failed", kind: "subagent", detail: "provider" },
		{ id: "ok", label: "ok", parentId: "rev", status: "running", kind: "subagent", detail: "x", startedAt: NOW - 30_000, lastAdvanceAt: NOW - 1_000 },
	];
	for (const width of [40, 60]) {
		const { rows } = paint(nodes, new Set(["rev"]), width);
		const stalled = rows.find((row) => row.includes("⚠ stalled"))!;
		const folded = rows.find((row) => row.includes("1 failed") && row.includes("▸"))!;
		assert.match(stalled, /… {2}⚠ stalled 3m 20s$/, `width ${width}: ${stalled}`);
		assert.match(folded, /… {2}1 failed/, `width ${width}: ${folded}`);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `width ${width}: ${row}`);
	}
});
