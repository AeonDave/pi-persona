import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JobQueue } from "../src/queue.js";

test("runs a submitted job to completion", async () => {
	const queue = new JobQueue();
	queue.submit("a", async () => 42);
	await delay(5);
	assert.equal(queue.status("a"), "done");
});

test("cancels a pending job before it starts", async () => {
	const queue = new JobQueue({ concurrency: 1 });
	queue.submit("slow", (signal) => delay(20, undefined, { signal }));
	queue.submit("queued", async () => 1);
	assert.equal(queue.cancel("queued"), true);
	assert.equal(queue.status("queued"), "cancelled");
});

test("cancels a running job", async () => {
	const queue = new JobQueue();
	queue.submit("live", (signal) => delay(30, "finished", { signal }));
	await delay(5);
	assert.equal(queue.cancel("live"), true);
	await delay(40);
	assert.equal(queue.status("live"), "cancelled");
});
