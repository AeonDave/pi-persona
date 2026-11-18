import { test } from "node:test";
import assert from "node:assert/strict";
import { runChildAgent } from "../../src/engine/child.ts";

const engineUrl = new URL("../../src/engine/child.ts", import.meta.url).href;

for (const phase of ["stream", "tool-end", "settle"]) {
	test(`a throwing ${phase} progress sink cannot prevent child settlement or cleanup`, async () => {
		// Isolate the regression: an escaping EventEmitter callback would otherwise crash the
		// test process itself. The inner engine still launches a real, short-lived Node child.
		const events = [
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read" },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completed" }], model: "stub/m", stopReason: "stop", usage: { input: 5, output: 3, cost: { total: 0.125 }, totalTokens: 8 } } },
		];
		const worker = `process.stdout.write(${JSON.stringify(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)})`;
		const harness = `
import { existsSync } from "node:fs";
import { runChildAgent } from ${JSON.stringify(engineUrl)};
let promptPath;
let plain = 0;
const transitions = [];
let failures = 0;
const result = await runChildAgent({ task: "short worker", systemPrompt: "temporary worker prompt" }, undefined, {
  resolveInvocation: (args) => {
    promptPath = args[args.indexOf("--append-system-prompt") + 1];
    return { command: process.execPath, args: ["-e", ${JSON.stringify(worker)}] };
  },
  onProgress: (snapshot) => {
    if (snapshot.toolEvent) transitions.push(snapshot.toolEvent);
    else plain++;
    if ((${JSON.stringify(phase)} === "tool-end" && snapshot.toolEvent?.phase === "end") ||
        (${JSON.stringify(phase)} === "stream" && !snapshot.toolEvent && plain === 1) ||
        (${JSON.stringify(phase)} === "settle" && !snapshot.toolEvent && plain === 2)) {
      failures++;
      throw new Error("progress sink failed");
    }
  },
});
const observed = { result, transitions, plain, failures, promptRemoved: !existsSync(promptPath) };
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(observed) }], stopReason: "stop" } }));
`;
		const outer = await runChildAgent({ task: "progress containment harness" }, undefined, {
			resolveInvocation: () => ({ command: process.execPath, args: ["--import", "tsx", "--input-type=module", "-e", harness] }),
			hardTimeoutMs: 20_000,
		});
		assert.equal(outer.ok, true, outer.stderr || outer.errorMessage);
		const observed = JSON.parse(outer.output);
		assert.equal(observed.result.ok, true);
		assert.equal(observed.result.quiescent, true);
		assert.equal(observed.result.output, "completed");
		assert.equal(observed.result.model, "stub/m");
		assert.equal(observed.result.aborted, false);
		assert.equal(observed.result.timedOut, false);
		assert.equal(observed.result.usage.input, 5);
		assert.equal(observed.result.usage.output, 3);
		assert.equal(observed.result.usage.cost, 0.125);
		assert.equal(observed.result.usage.turns, 1);
		assert.equal(observed.failures, 1, "the targeted progress callback actually threw");
		assert.equal(observed.plain, 2, "a failed live update must not prevent the final snapshot");
		assert.deepEqual(observed.transitions, [
			{ phase: "start", callId: "call-1", name: "read" },
			{ phase: "end", callId: "call-1", name: "read", failed: true },
		]);
		assert.equal(observed.promptRemoved, true);
	});
}
