import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { isComposingCall, PENDING_CALL_FRAME_MS, PENDING_CALL_FRAMES, PENDING_CALL_QUIET_MS, renderPendingCall } from "../../../src/ui/pending-call.ts";

const theme = { fg: (name: string, text: string) => `<${name}>${text}</${name}>`, bold: (text: string) => `**${text}**` };
const plain = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

test("composing is exactly: no final result, arguments incomplete, execution not started", () => {
	assert.equal(isComposingCall({ isPartial: true, argsComplete: false, executionStarted: false }), true, "streaming arguments");
	assert.equal(isComposingCall({ isPartial: true, argsComplete: true, executionStarted: false }), false, "arguments complete");
	assert.equal(isComposingCall({ isPartial: true, argsComplete: false, executionStarted: true }), false, "execution started without streaming");
	assert.equal(isComposingCall({ isPartial: false, argsComplete: false, executionStarted: false }), false, "restored history: Pi leaves argsComplete false but the result is final");
	assert.equal(isComposingCall(undefined), false, "no render context (export, tests) renders the full card");
	assert.equal(isComposingCall({}), false, "an incomplete context is never composing");
});

test("the pending line is the tool title, Pi's spinner frame and a muted preparing marker", () => {
	const line = renderPendingCall("delegate", theme, { isPartial: true, argsComplete: false, executionStarted: false })!.render(120).join("\n").trimEnd();
	assert.equal(line, `<toolTitle>**delegate**</toolTitle> <accent>${PENDING_CALL_FRAMES[0]}</accent> <muted>preparing…</muted>`);
	assert.equal(renderPendingCall("delegate", plain, { isPartial: false, argsComplete: false, executionStarted: false }), undefined);
});

test("the spinner animates through context.invalidate and stops on the first complete render", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	try {
		const state = {};
		let invalidations = 0;
		const composing = { args: {}, isPartial: true, argsComplete: false, executionStarted: false, state, invalidate: () => { invalidations++; } };
		const frame = () => renderPendingCall("council", plain, composing)!.render(120).join("").trimEnd();
		assert.equal(frame(), `council ${PENDING_CALL_FRAMES[0]} preparing…`);
		mock.timers.tick(PENDING_CALL_FRAME_MS);
		assert.equal(invalidations, 1, "one tick repaints the row");
		assert.equal(frame(), `council ${PENDING_CALL_FRAMES[1]} preparing…`, "the next render shows the next frame");
		frame();
		mock.timers.tick(PENDING_CALL_FRAME_MS);
		assert.equal(invalidations, 2, "re-rendering never starts a second ticker for the same row");
		assert.equal(renderPendingCall("council", plain, { ...composing, argsComplete: true }), undefined);
		mock.timers.tick(PENDING_CALL_FRAME_MS * 5);
		assert.equal(invalidations, 2, "the complete render cleared the ticker");
	} finally {
		mock.timers.reset();
	}
});

test("(a) a live composing call keeps spinning while its arguments change, then shows the full card", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	try {
		const state = {};
		let invalidations = 0;
		const row = (args: unknown, argsComplete = false) => renderPendingCall("delegate", plain, { args, isPartial: true, argsComplete, executionStarted: false, state, invalidate: () => { invalidations++; } });
		let task = "";
		for (let elapsed = 0; elapsed < PENDING_CALL_QUIET_MS * 3; elapsed += 200) {
			task += "x";
			assert.ok(row({ agent: "scout", task }), `still preparing after ${elapsed} ms of streaming`);
			mock.timers.tick(200);
		}
		const before = invalidations;
		assert.ok(before > 0, "the spinner animated");
		assert.equal(row({ agent: "scout", task }, true), undefined, "complete arguments render the full card");
		mock.timers.tick(PENDING_CALL_FRAME_MS * 10);
		assert.equal(invalidations, before, "no repaint after completion");
	} finally {
		mock.timers.reset();
	}
});

test("(b) a restored row without a result settles on its full card within the quiet period", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	try {
		const state = {};
		let invalidations = 0;
		const args = { action: "wait", work_key: "review" };
		// Exactly what Pi's restore loop hands a row saved without its result.
		const context = { args, isPartial: true, argsComplete: false, executionStarted: false, state, invalidate: () => { invalidations++; } };
		assert.ok(renderPendingCall("exocom wait", plain, context), "indistinguishable from composing at first");
		mock.timers.tick(PENDING_CALL_QUIET_MS + PENDING_CALL_FRAME_MS);
		const settled = invalidations;
		assert.equal(renderPendingCall("exocom wait", plain, context), undefined, "after the quiet period it renders its normal card");
		mock.timers.tick(PENDING_CALL_FRAME_MS * 50);
		assert.equal(invalidations, settled, "the timer stopped: no further invalidations");
		assert.equal(renderPendingCall("exocom wait", plain, { ...context, args: { ...args } }), undefined, "a re-render with equal arguments stays settled");
	} finally {
		mock.timers.reset();
	}
});

test("(c) a discarded row stops requesting renders after the quiet period", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	try {
		let invalidations = 0;
		// Rendered once, then dropped from the transcript: nothing ever renders it again.
		renderPendingCall("flow", plain, { args: { name: "build" }, isPartial: true, argsComplete: false, executionStarted: false, state: {}, invalidate: () => { invalidations++; } });
		mock.timers.tick(PENDING_CALL_QUIET_MS + PENDING_CALL_FRAME_MS);
		const settled = invalidations;
		assert.ok(settled <= Math.ceil(PENDING_CALL_QUIET_MS / PENDING_CALL_FRAME_MS) + 1, "bounded by the quiet period");
		mock.timers.tick(PENDING_CALL_QUIET_MS * 10);
		assert.equal(invalidations, settled, "no invalidations after the quiet period");
	} finally {
		mock.timers.reset();
	}
});
