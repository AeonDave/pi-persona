import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { TerminalResultArchive } from "../../../src/results/archive.ts";
import type { TerminalResultInput } from "../../../src/results/types.ts";
import { registerIntercomTool } from "../../../src/tools/intercom-tool.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";

initTheme("dark");

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };

function card(tool: any, result: any, expanded: boolean, context?: any): string {
	return tool.renderResult(JSON.parse(JSON.stringify(result)), { expanded }, theme, context)
		.render(120)
		.map((row: string) => stripVTControlCharacters(row).trimEnd())
		.join("\n");
}

function assertBounded(rendered: string) {
	const rows = rendered.split("\n");
	assert.ok(rows.length <= 6, `collapsed card stays within ~6 rows, got ${rows.length}:\n${rendered}`);
	for (const row of rows) {
		assert.ok(visibleWidth(row) <= 100, `collapsed rows stay within 100 columns, got ${visibleWidth(row)}: ${row}`);
	}
}

/** A real archive over a fake session file; `persistent: false` leaves memory-only receipts. */
function archiveHarness(persistent = true) {
	let seq = 0;
	const archive = new TerminalResultArchive({
		entries: () => [],
		persistent,
		clock: () => 1234,
		makeRef: () => `result:00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`,
		append: () => {},
	});
	const save = (originKey: string, body: string, extra: Partial<TerminalResultInput> = {}) => {
		const outcome = archive.save({ originKey, agent: "worker", status: "done", body, provenance: "result-output", ...extra });
		assert.equal(outcome.ok, true, JSON.stringify(outcome));
		return outcome;
	};
	return { archive, save };
}

function toolWith(archive: TerminalResultArchive): { tool: any } {
	let tool: any;
	registerIntercomTool(
		{ registerTool: (definition: unknown) => { tool = definition; }, on: () => () => {} } as unknown as ExtensionAPI,
		{
			tracker: { peek: () => undefined, list: () => [], running: () => [] },
			completionNotifier: { peekPending: () => [], discard: () => {} },
			intercomNotifier: { discard: () => {} },
			controller: { activePersona: undefined },
			bus: {},
			SUPERVISOR: "supervisor",
			STALL_FLAG_MS: 90_000,
			missingRunMessage: (id: string) => `missing ${id}`,
			stopAgent: () => false,
			steerAgent: () => false,
			steerRegistry: new Map(),
			stopRequested: new Set(),
			scanForSurrender: () => undefined,
			childUsage: { accountMany: () => emptyUsage() },
			publishPersonaCost: () => {},
			archive: () => archive,
		} as any,
	);
	return { tool };
}

const bigBody = `${"x".repeat(300_000)}MUST-NOT-LEAK-COLLAPSED`;
const pageBody = Array.from({ length: 300 }, (_, i) => `line ${i}: ${"payload-".repeat(4)}`).join("\n");
const wideBody = ("y".repeat(50) + "\n").repeat(400);

test("results collapsed: compact purpose line with the retained count, then a bounded listing", async () => {
	const h = archiveHarness();
	for (let i = 0; i < 25; i++) h.save(`activation/r-${i}`, `report ${i}`);
	const { tool } = toolWith(h.archive);
	const result = await tool.execute("l", { action: "results", limit: 50 }, undefined, undefined, {});
	assert.equal(result.isError, false);
	const before = JSON.stringify(result);
	const collapsed = card(tool, result, false, { args: { action: "results" }, isError: false });
	assert.match(collapsed, /^results · 25 retained/, `purpose line names the count:\n${collapsed}`);
	assert.match(collapsed, /result:.*000000000001 · worker · done/, "the bounded listing preview starts with the first entry");
	assert.match(collapsed, /expand/i, "hidden entries advertise expansion");
	assert.doesNotMatch(collapsed, /report 24|000000000019/, "entries beyond the preview stay hidden, not dumped");
	assertBounded(collapsed);
	assert.equal(JSON.stringify(result), before, "rendering never mutates the persisted result");
	const expanded = card(tool, result, true, { args: { action: "results" }, isError: false });
	assert.match(expanded, /Saved terminal reports \(not live workers\):/, "expansion keeps the complete listing");
	assert.match(expanded, /000000000019 · worker · done · session-entry/, "expansion shows the last entry");
	assert.doesNotMatch(expanded, /expand/i);
	assertBounded.length; // (expanded intentionally unbounded in rows; width guard below)
	for (const row of expanded.split("\n")) assert.ok(visibleWidth(row) <= 100, `expanded rows stay within 100 columns: ${row}`);
});

test("results collapsed: paging flag and truncated-entry count stay visible without expanding", async () => {
	const h = archiveHarness();
	for (let i = 0; i < 25; i++) h.save(`activation/r-${i}`, `report ${i}`);
	h.save("activation/big", bigBody);
	const { tool } = toolWith(h.archive);
	const first = await tool.execute("p1", { action: "results" }, undefined, undefined, {});
	assert.equal(first.details.results.length, 20);
	const collapsed = card(tool, first, false, { args: { action: "results" }, isError: false });
	assert.match(collapsed, /^results · 20 retained · next page: cursor \d+/, `purpose line carries the paging flag:\n${collapsed}`);
	assert.match(collapsed, /expand/i);
	const rest = await tool.execute("p2", { action: "results", cursor: first.details.nextCursor }, undefined, undefined, {});
	assert.equal(rest.details.results.length, 6);
	const tail = card(tool, rest, false, { args: { action: "results" }, isError: false });
	assert.match(tail, /^results · 6 retained · 1 truncated/, `a truncated page entry is counted on the purpose line:\n${tail}`);
	assert.doesNotMatch(tail, /next page: cursor/, "a final page advertises no further cursor");
});

test("result ref collapsed: purpose line carries ref, page position and honesty flags", async () => {
	const h = archiveHarness();
	const saved = h.save("activation/page", pageBody);
	const wide = h.save("activation/wide", wideBody);
	const { tool } = toolWith(h.archive);
	const result = await tool.execute("p", { action: "result", ref: saved.ref, limit: 16_000 }, undefined, undefined, {});
	assert.equal(result.isError, false);
	const before = JSON.stringify(result);
	const collapsed = card(tool, result, false, { args: { action: "result", ref: saved.ref }, isError: false });
	assert.match(collapsed, new RegExp(`^result · ${saved.ref} · page 12789/12789`), `purpose line names ref and page position:\n${collapsed}`);
	assert.match(collapsed, /line 0: payload/, "the fenced page start is previewed");
	assert.match(collapsed, /expand/i, "the hidden page body advertises expansion");
	assert.doesNotMatch(collapsed, /line 299/, "the rest of the page stays hidden, not dumped");
	assertBounded(collapsed);
	assert.equal(JSON.stringify(result), before, "rendering never mutates the persisted result");
	// A true 16k-unit page over a larger stored body: position reads against the stored body.
	const paged = await tool.execute("p2", { action: "result", ref: wide.ref, limit: 16_000 }, undefined, undefined, {});
	assert.equal(paged.details.nextOffset, 16_000);
	const pagedCard = card(tool, paged, false, { args: { action: "result", ref: wide.ref }, isError: false });
	assert.match(pagedCard, new RegExp(`^result · ${wide.ref} · page 16000/20400`), `paged purpose line:\n${pagedCard}`);
	assertBounded(pagedCard);
	assert.match(pagedCard, /expand/i);
});

test("result ref collapsed: truncated and memory-only receipts are flagged on the purpose line", async () => {
	const h = archiveHarness(false);
	const saved = h.save("activation/big", bigBody);
	const { tool } = toolWith(h.archive);
	const result = await tool.execute("p", { action: "result", ref: saved.ref, offset: 254_000, limit: 16_000 }, undefined, undefined, {});
	assert.equal(result.isError, false);
	const collapsed = card(tool, result, false, { args: { action: "result", ref: saved.ref }, isError: false });
	assert.match(collapsed, /page 262144\/262144/, `page position reads against the stored body:\n${collapsed}`);
	assert.match(collapsed, /truncated/, "a truncated archive body is flagged collapsed, not only expanded");
	assert.match(collapsed, /memory-only/, "a non-durable receipt is flagged collapsed");
	assertBounded(collapsed);
	assert.doesNotMatch(collapsed, /MUST-NOT-LEAK-COLLAPSED/);
});

test("result ref expanded: the page renders literally through the shared renderer, complete and sanitized", async () => {
	const h = archiveHarness();
	const saved = h.save("activation/page", pageBody);
	const { tool } = toolWith(h.archive);
	const result = await tool.execute("p", { action: "result", ref: saved.ref, limit: 16_000 }, undefined, undefined, {});
	const expanded = card(tool, result, true, { args: { action: "result", ref: saved.ref }, isError: false });
	assert.match(expanded, new RegExp(`${saved.ref} · done · session-entry`), "the archive receipt header is kept");
	assert.match(expanded, /> line 0: payload/, "the untrusted quote fence stays literal, never re-rendered as Markdown blockquote");
	assert.match(expanded, /Page offset 0; 12789 UTF-16 units; end of stored body\./, "the paging diagnostics stay literal");
	assert.match(expanded, /line 299/, "expansion shows the complete page");
	assert.doesNotMatch(expanded, /expand/i);
	assert.doesNotMatch(expanded, /^│/m, "no Markdown blockquote artifacts on a listing/diagnostic page");
	// Bounded-page rule: the payload body is never duplicated into details metadata.
	assert.doesNotMatch(JSON.stringify(result.details), /line 7: payload/);
});

test("archive failure views stay literal, bounded and error-headed", async () => {
	const h = archiveHarness();
	const saved = h.save("activation/one", "small");
	const { tool } = toolWith(h.archive);
	const miss = await tool.execute("m", { action: "result", ref: "result:ffffffff-ffff-4fff-8fff-ffffffffffff" }, undefined, undefined, {});
	assert.equal(miss.isError, true);
	const missCard = card(tool, miss, false, { args: { action: "result" }, isError: true });
	assert.match(missCard, /^failed\n/);
	assert.match(missCard, /unavailable/);
	assertBounded(missCard);
	const rejected = await tool.execute("b", { action: "result", ref: saved.ref, collect: true }, undefined, undefined, {});
	assert.equal(rejected.isError, true);
	const rejectedCard = card(tool, rejected, false, { args: { action: "result" }, isError: true });
	assert.match(rejectedCard, /^failed\n/);
	assert.match(rejectedCard, /to and collect are live-only/);
	assertBounded(rejectedCard);
	const badCursor = await tool.execute("c", { action: "results", cursor: 999_999 }, undefined, undefined, {});
	assert.equal(badCursor.isError, true);
	const badCursorCard = card(tool, badCursor, false, { args: { action: "results" }, isError: true });
	assert.match(badCursorCard, /^failed\n/);
	assert.match(badCursorCard, /Invalid result list cursor or limit/);
	assertBounded(badCursorCard);
});

test("a live collect acknowledgment keeps its report rendering and never regresses to archive chrome", async () => {
	let tool: any;
	const tracker: any = {
		peek: (id: string) => ({
			id, agent: "worker", status: "done", task: "t", progress: { output: "", turns: 1, tokens: 1 },
			collected: true, result: { usage: emptyUsage(), ok: true, output: "final report body" }, output: "final report body",
		}),
		list: () => [], running: () => [], markCollected: () => {},
	};
	registerIntercomTool(
		{ registerTool: (definition: unknown) => { tool = definition; }, on: () => () => {} } as unknown as ExtensionAPI,
		{
			tracker,
			completionNotifier: { peekPending: () => [], discard: () => {} },
			intercomNotifier: { discard: () => {} },
			controller: { activePersona: undefined },
			bus: {},
			SUPERVISOR: "supervisor",
			STALL_FLAG_MS: 90_000,
			missingRunMessage: (id: string) => `missing ${id}`,
			stopAgent: () => false,
			steerAgent: () => false,
			steerRegistry: new Map(),
			stopRequested: new Set(),
			scanForSurrender: () => undefined,
			childUsage: { accountMany: () => emptyUsage() },
			publishPersonaCost: () => {},
		} as any,
	);
	const result = await tool.execute("c", { action: "result", to: "run-1", collect: true }, undefined, undefined, {});
	assert.equal(result.isError, false);
	const collapsed = card(tool, result, false, { args: { action: "result", to: "run-1" }, isError: false });
	assert.match(collapsed, /^run-1 \(worker\) · done/, "the live receipt keeps its run purpose line");
	assert.match(collapsed, /final report body/, "the report body is previewed");
	assertBounded(collapsed);
	assert.doesNotMatch(JSON.stringify(result.details), /final report body/, "no report body hidden in details");
});
