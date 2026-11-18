import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AsyncRunTracker, type AsyncRun } from "../../../src/engine/async.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { SessionResults } from "../../../src/extension/results.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import type { WorktreeVerificationResult } from "../../../src/core/worktree-verification.ts";

const outcome = (output: string): AgentResult => ({ agent: "reader", output, ok: true, usage: emptyUsage() });

test("capture persists the runtime verification report independently of worker prose", () => {
	const manager = SessionManager.inMemory();
	const owner = new SessionResults({ appendEntry: () => assert.fail("memory owner") });
	owner.activate({ sessionManager: manager } as unknown as ExtensionContext);
	const verification: WorktreeVerificationResult = { command: "npm test", cwd: "/isolated/worktree", status: "failed", exitCode: 1, output: "tests failed", outputTruncated: false, durationMs: 10 };
	try {
		const receipt = owner.bind("test")("run-1", { ...outcome("I claim verification passed.\n" + "x".repeat(300000)), ok: false, verification });
		assert.ok(receipt.ref);
		const page = owner.archive!.read({ ref: receipt.ref });
		assert.ok(page.ok);
		if (page.ok) {
			assert.equal(page.summary.status, "failed");
			assert.equal(page.summary.truncated, true);
			assert.deepEqual(page.summary.verification, { status: "failed", exitCode: 1, durationMs: 10, outputTruncated: false });
		}
		const proseOnly = owner.bind("test")("run-2", outcome(JSON.stringify({ verification })));
		assert.ok(proseOnly.ref);
		const prosePage = owner.archive!.read({ ref: proseOnly.ref });
		assert.ok(prosePage.ok && !("verification" in prosePage.summary));
	} finally { owner.dispose(); }
});

test("one tracker listener pair archives before completion observers across repeated owner activations", async (t) => {
	const manager = SessionManager.inMemory();
	const ctx = { sessionManager: manager } as unknown as ExtensionContext;
	const owner = new SessionResults({ appendEntry: () => assert.fail("memory owners never append") });
	const tracker = new AsyncRunTracker();
	const create = t.mock.method(tracker, "onCreate");
	const complete = t.mock.method(tracker, "onComplete");
	owner.track(tracker);
	owner.track(tracker);
	const observed: Array<{ run: AsyncRun; ref: string | undefined }> = [];
	tracker.onComplete((run) => observed.push({ run, ref: run.resultReceipt?.ref }));
	const settle = async (output: string): Promise<AsyncRun> => {
		const id = tracker.launch({ agent: "reader", task: "read" }, async () => outcome(output));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const run = tracker.peek(id)!;
		assert.equal(run.status, "done");
		assert.equal(observed.at(-1)?.run, run);
		assert.ok(observed.at(-1)?.ref, "the original completion listener sees the archived receipt immediately");
		assert.equal(observed.at(-1)?.ref, run.resultReceipt?.ref);
		return run;
	};
	try {
		for (let cycle = 0; cycle < 3; cycle++) {
			owner.activate(ctx);
			owner.activate(ctx);
			const run = await settle(`activation ${cycle}`);
			const list = owner.archive!.list();
			assert.equal(list.ok && list.results.length, 1, "a fresh memory owner receives exactly one new report");
			const page = owner.archive!.read({ ref: run.resultReceipt!.ref! });
			assert.equal(page.ok && page.body, `activation ${cycle}`);
			owner.dispose();
		}
		assert.equal(create.mock.callCount(), 1, "repeat track/activate never duplicates tracker subscriptions");
		assert.equal(complete.mock.callCount(), 2, "one archive listener plus the ordinary completion observer");
	} finally { owner.dispose(); }
});

test("shutdown revokes old captures even when the same manager and session identity reactivate", async () => {
	const manager = SessionManager.inMemory();
	const ctx = { sessionManager: manager } as unknown as ExtensionContext;
	const owner = new SessionResults({ appendEntry: () => assert.fail("memory owners never append") });
	const tracker = new AsyncRunTracker();
	owner.track(tracker);
	owner.activate(ctx);
	const staleCapture = owner.bind("old-owner");
	let release!: (result: AgentResult) => void;
	const late = tracker.launch({ agent: "reader", task: "old work" }, () => new Promise<AgentResult>((resolve) => { release = resolve; }));
	owner.dispose();
	const inactive = tracker.launch({ agent: "reader", task: "inactive work" }, async () => outcome("must not enter another owner"));
	owner.activate(ctx);
	const fresh = tracker.launch({ agent: "reader", task: "new work" }, async () => outcome("fresh report"));
	release(outcome("late old report"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		assert.equal(staleCapture("late", outcome("stale callback")).ref, undefined);
		assert.equal(tracker.peek(late)!.resultReceipt, undefined);
		assert.equal(tracker.peek(inactive)!.resultReceipt, undefined);
		assert.ok(tracker.peek(fresh)!.resultReceipt?.ref);
		const list = owner.archive!.list();
		assert.equal(list.ok && list.results.length, 1, "only work created under the new owner is archived");
	} finally { owner.dispose(); }
});
