import assert from "node:assert/strict";
import { test } from "node:test";

import {
	boundCompletionSurface,
	buildCompletionReport,
	buildPeekDigest,
	buildWaitTimeoutNote,
	getFullRunOutput,
	MAX_ASYNC_STATUS_ROWS,
	MAX_COMPLETION_REPORT_CHARS,
	MAX_COMPLETION_RUN_CHARS,
	renderCompletion,
	type AsyncRun,
} from "../../../src/engine/async.ts";
import { fenceUntrusted } from "../../../src/core/fence.ts";

test("automatic completion payload is a summary-sized surface with explicit drill-down", () => {
	assert.ok(MAX_COMPLETION_RUN_CHARS <= 4_000);
	assert.ok(MAX_COMPLETION_REPORT_CHARS <= 12_000);
});

test("wait timeout directs the supervisor back to useful work instead of a polling loop", () => {
	const note = buildWaitTimeoutNote(["run-1", "run-2"], 180_000);
	assert.match(note, /still running after 180000ms/);
	assert.match(note, /completion will notify/i);
	assert.match(note, /do not immediately wait again/i);
	assert.doesNotMatch(note, /or wait again/i);
});

test("async status and timeout views bound very large active run sets", () => {
	const runs = Array.from({ length: 1_000 }, (_, index) => run({ id: `run-${index}` }));
	const digest = buildPeekDigest(runs);
	const wait = buildWaitTimeoutNote(runs.map((entry) => entry.id), 60_000);
	assert.equal(digest.split("\n").filter((line) => /^\[run-/.test(line)).length, MAX_ASYNC_STATUS_ROWS);
	assert.match(digest, /936 additional async runs omitted/);
	assert.match(wait, /\+936 more/);
	assert.ok(digest.length < 12_000);
	assert.ok(wait.length < 4_000);
});

function run(overrides: Partial<AsyncRun>): AsyncRun {
	return {
		id: "run-test",
		agent: "operator",
		task: "test task",
		status: "done",
		progress: { output: "", turns: 1, tokens: 10 },
		...overrides,
	};
}

test("completion report bounds a large DONE result and advertises on-demand retrieval", () => {
	const item = run({ id: "run-large", result: { ok: true, output: "x".repeat(100_000) } as NonNullable<AsyncRun["result"]> });
	const report = buildCompletionReport([item], (text) => text);

	assert.ok(report.length <= MAX_COMPLETION_REPORT_CHARS);
	assert.match(report, /run-large/);
	assert.match(report, /intercom \{ action:"result", to:"run-large" \}/);
});

test("completion report keeps FAILED and STOPPED status/error while bounding partial output", () => {
	const failed = run({
		id: "run-failed",
		status: "failed",
		error: "provider exploded",
		progress: { output: "f".repeat(100_000), turns: 2, tokens: 20 },
	});
	const stopped = run({
		id: "run-stopped",
		status: "stopped",
		error: "stopped by supervisor",
		progress: { output: "s".repeat(100_000), turns: 2, tokens: 20 },
	});
	const report = buildCompletionReport([failed, stopped], (text) => text);

	assert.ok(report.length <= MAX_COMPLETION_REPORT_CHARS);
	assert.match(report, /run-failed/);
	assert.match(report, /provider exploded/);
	assert.match(report, /run-stopped/);
	assert.match(report, /stopped by supervisor/);
	assert.match(report, /intercom \{ action:"result", to:"run-failed" \}/);
	assert.match(report, /intercom \{ action:"result", to:"run-stopped" \}/);
});

test("the final completion cap never cuts through a fenced untrusted line", () => {
	const runs = Array.from({ length: 31 }, (_, index) =>
		run({
			id: `run-${index}`,
			agent: "a".repeat(68),
			result: { ok: true, output: (`PAYLOAD-${index}-`).repeat(180) } as NonNullable<AsyncRun["result"]>,
		}),
	);
	const report = buildCompletionReport(runs, fenceUntrusted);
	assert.ok(report.length <= MAX_COMPLETION_REPORT_CHARS);
	for (const line of report.split("\n").filter((candidate) => candidate.includes("PAYLOAD-"))) {
		assert.match(line, /^> /, `untrusted payload escaped its quote prefix: ${line.slice(0, 80)}`);
	}
});

test("renderCompletion keeps its appended persistence note inside the same hard cap", () => {
	const runs = Array.from({ length: 43 }, (_, index) =>
		run({ id: `run-${index}`, result: { ok: true, output: (`BLOCKED-${index}-`).repeat(180) } as NonNullable<AsyncRun["result"]> }),
	);
	const rendered = renderCompletion(runs, fenceUntrusted, () => `PERSISTENCE-NOTE-${"n".repeat(600)}`);
	assert.ok(rendered.length <= MAX_COMPLETION_REPORT_CHARS, `completion surface exceeded the cap: ${rendered.length}`);
	assert.match(rendered, /PERSISTENCE-NOTE/);
});

test("a hostile custom omission marker cannot break the completion hard cap", () => {
	const rendered = boundCompletionSurface("a\n".repeat(20_000), "x".repeat(100_000));
	assert.ok(rendered.length <= MAX_COMPLETION_REPORT_CHARS, `custom marker exceeded the cap: ${rendered.length}`);
});

test("full run output prefers the result, then progress, then error", () => {
	assert.equal(getFullRunOutput(run({ result: { ok: true, output: "complete" } as NonNullable<AsyncRun["result"]> })), "complete");
	assert.equal(getFullRunOutput(run({ progress: { output: "partial", turns: 1, tokens: 1 } })), "partial");
	assert.equal(getFullRunOutput(run({ progress: { output: "", turns: 1, tokens: 1 }, error: "failed" })), "failed");
});

test("peek digest never exposes a hostile failure reason", () => {
	const digest = buildPeekDigest([
		run({ status: "failed", error: `bad\u001b[2J\n${"e".repeat(100_000)}` }),
	]);
	assert.ok(digest.length < 500, `peek digest was not bounded: ${digest.length}`);
	assert.doesNotMatch(digest, /bad|\u001b|e{100}/);
	assert.match(digest, /failure details available via intercom result/);
});
