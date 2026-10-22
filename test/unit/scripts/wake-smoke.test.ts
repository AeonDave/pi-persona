import assert from "node:assert/strict";
import test from "node:test";

import { coerceWakeSmokeDelegateTasks } from "../../../scripts/lib/wake-smoke.ts";

test("wake-smoke recognizes a runtime delegate call with JSON-string tasks", () => {
	const markers = ["WAKE_SMOKE_A_3c1f", "WAKE_SMOKE_B_9d42", "WAKE_SMOKE_C_e07b"];
	const raw = {
		tasks: JSON.stringify(markers.map((marker) => ({ agent: "scout", task: `Reply with ${marker}` }))),
	};

	const result = coerceWakeSmokeDelegateTasks(raw);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.tasks.length, 3);
	assert.deepEqual(result.tasks.map((task) => task.agent), ["scout", "scout", "scout"]);
	assert.deepEqual(result.tasks.map((task) => task.task), markers.map((marker) => `Reply with ${marker}`));
});

test("wake-smoke fails closed on malformed delegate arguments", () => {
	const result = coerceWakeSmokeDelegateTasks({ tasks: "[{broken" });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.error, /tasks/);
});
