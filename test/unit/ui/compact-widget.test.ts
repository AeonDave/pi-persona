import { test } from "node:test";
import assert from "node:assert/strict";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

import { compactWidget } from "../../../src/ui/compact-widget.ts";
import { type AgentNode, renderAgentTreeSummary } from "../../../src/ui/agent-tree.ts";
import { boundDisplayRows } from "../../../src/ui/presentation.ts";

function assertPhysicalBudget(rows: readonly string[], width: number, budget: number): void {
	assert.ok(rows.length <= budget, `${rows.length} rendered rows exceed ${budget} input rows`);
	for (const row of rows) {
		assert.doesNotMatch(row, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
		assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} columns exceed width ${width}`);
	}
	if (width > 0 && rows.length > 0) {
		assert.ok(new Text(rows.join("\n"), 0, 0).render(width).length <= budget,
			"even native Text must not turn the clipped output into extra physical rows");
	}
}

test("eight budgeted agent rows occupy at most eight physical rows at 80 columns", () => {
	const nodes: AgentNode[] = Array.from({ length: 20 }, (_, i) => ({
		id: `worker-${i}`, parentId: undefined, status: i === 19 ? "failed" : "running",
		label: `worker-${i}-${"long-valid-label-".repeat(8)}`,
		detail: "processing long valid diagnostic details ".repeat(6),
	}));
	const logical = renderAgentTreeSummary(nodes, 8);
	assert.equal(logical.length, 8);
	assert.ok(new Text(logical.join("\n"), 0, 0).render(80).length > 8, "fixture reproduces native wrapping");
	const rendered = compactWidget(logical)().render(80);
	assert.equal(rendered.length, logical.length);
	assertPhysicalBudget(rendered, 80, 8);
	assert.match(rendered.at(-1) ?? "", /more.*F9/);
});

test("Exocom's seven-row pool budget survives long valid names, models and workspace labels", () => {
	const header = `📡 compact-supervisor · reviewer · provider/model-with-long-name · ctx 45% · workspace ${"long-workspace-".repeat(8)} [Ab0T]`;
	const peers = Array.from({ length: 16 }, (_, i) =>
		`📡 peer-${i}-${"valid-name-".repeat(4)} (reviewer) · provider/long-model-name · ctx 50% · recv 12 · sent 20 · external ${"workspace-".repeat(8)} [Ab0T]`);
	const logical = boundDisplayRows(header, peers, 7, "exocom_list for the full pool");
	const rendered = compactWidget(logical)().render(80);
	assert.equal(rendered.length, 7);
	assertPhysicalBudget(rendered, 80, 7);
	assert.match(rendered.at(-1) ?? "", /exocom_list/);
});

test("clips only the right edge, preserving tree indentation and semantic markers", () => {
	const rows = ["  │  ├─ ✗ failed worker with long details", "     └─ ◉ monitor with long details", "  ⏰ timer fires in 20s"];
	const component = compactWidget(rows)();
	const rendered = component.render(20);
	assert.match(rendered[0] ?? "", /^  │  ├─ ✗ /);
	assert.match(rendered[1] ?? "", /^     └─ ◉ /);
	assert.match(rendered[2] ?? "", /^  ⏰ /);
	assertPhysicalBudget(rendered, 20, rows.length);
	assert.deepEqual(component.render(200), rows, "wide rendering preserves all raw detail");
});

test("removes terminal controls and folds embedded line breaks without trimming indentation", () => {
	const component = compactWidget([
		"  ├─ ✓ safe\u001b[2J\u001b[31m red\u001b[0m\r\nnext\u0000\u0007\u0085\u2028tail\u2029end",
		"  └─ ◉ monitor\toutput\ncontinues\rhere\u001b]0;spoof-title\u0007",
	])();
	const rendered = component.render(200);
	assert.deepEqual(rendered, ["  ├─ ✓ safe red next tail end", "  └─ ◉ monitor output continues here"]);
	assertPhysicalBudget(rendered, 200, 2);
});

test("width zero, one and wide graphemes obey the physical budget across resizes", () => {
	const rows = ["  └─ ⏳ 漢字 👩‍💻 e\u0301 " + "界".repeat(50), "✓", "漢", "", "a 👨‍👩‍👧‍👦 z"];
	const component = compactWidget(rows)();
	for (const width of [80, 0, 1, 2, 3, 8, 17, 200, 1, 80]) {
		const rendered = component.render(width);
		assertPhysicalBudget(rendered, width, rows.length);
		if (width > 0) assert.equal(rendered.length, rows.length);
	}
	assert.deepEqual(component.render(1).slice(1, 3), ["✓", "…"]);
	assert.deepEqual(component.render(200), rows);
	component.invalidate();
	assert.deepEqual(component.render(200), rows, "invalidation must not discard raw source rows");
});

test("empty input produces no rows and publication captures a stable raw-text snapshot", () => {
	assert.deepEqual(compactWidget([])().render(80), []);
	const rows = ["  └─ ✓ original"];
	const factory = compactWidget(rows);
	rows[0] = "mutated after publication";
	assert.deepEqual(factory().render(80), ["  └─ ✓ original"]);
});
