import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { inspectorFrame } from "../../../src/ui/inspector-frame.ts";

test("inspector frame bounds every size and leaves the caller its content budget", () => {
	for (let width = 1; width <= 160; width++) for (let height = 1; height <= 50; height++) {
		const layout = inspectorFrame.layout(width, height);
		const rows = inspectorFrame.render(Array.from({ length: height + 3 }, () => "wide 界 ".repeat(width)), layout, (s) => s);
		assert.ok(rows.length <= height);
		assert.ok(rows.every((row) => visibleWidth(row) <= width), `${width}x${height}`);
		assert.equal(layout.framed, width >= 5 && height >= 3);
		assert.equal(layout.contentRows, height - (layout.framed ? 2 : 0));
	}
});

test("frame draws bounded square chrome and retains the visible cursor marker", () => {
	const layout = inspectorFrame.layout(12, 4);
	assert.deepEqual(inspectorFrame.render([`a${CURSOR_MARKER}b`], layout, (s) => s), ["┌──────────┐", `│  a${CURSOR_MARKER}b      │`, "└──────────┘"]);
	assert.deepEqual(inspectorFrame.layout(4, 2), { width: 4, height: 2, contentWidth: 4, contentRows: 2, gutter: 0, framed: false });
	assert.equal(inspectorFrame.viewportRows(40), 36);
	assert.equal(inspectorFrame.viewportRows(1), 1);
	assert.equal(inspectorFrame.viewportRows(2), 1);
});
