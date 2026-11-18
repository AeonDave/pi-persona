import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../../src/agents/agent.ts";
import type { ContractDef } from "../../src/core/contract.ts";
import { makeEngine } from "../../src/engine/adapter.ts";
import { makeInProcessEngine, type InProcSession } from "../../src/engine/inproc.ts";

const model = { provider: "stub", id: "m" };
const registry = { find: () => model, getAll: () => [model] } as unknown as ModelRegistry;
const agent: AgentConfig = { name: "reviewer", model: "stub/m", systemPrompt: "Review files.", source: "test" };
const schema = (): ContractDef => ({ name: "nested", fields: {
	result: { type: "string", required: true },
	findings: { type: "array", required: true, items: { type: "object", fields: {
		file: { type: "string", required: true }, line: { type: "integer", required: true, min: 1 },
		severity: { type: "enum", required: true, values: ["high"] }, evidence: { type: "string", required: true },
	} } },
} });

for (const backend of ["inproc", "child"] as const) {
	function harness(def: ContractDef, line = 12) {
		let launches = 0;
		const output = { result: "reviewed", findings: [{ file: "a.ts", line, severity: "high", evidence: "reproduced" }] };
		const dependencies = { resolveAgent: () => agent, contracts: () => def };
		const engine = backend === "inproc" ? makeInProcessEngine({
			...dependencies, modelRegistry: registry, cwd: ".",
			createSession: async () => {
				launches++;
				let listener: ((event: unknown) => void) | undefined;
				const session: InProcSession = {
					subscribe: (fn) => { listener = fn; return () => { listener = undefined; }; },
					prompt: async (text) => { listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ ...output, receivedPrompt: text }) }], stopReason: "end" } }); },
					agent: { abort: () => {}, waitForIdle: async () => {}, steer: () => {} }, dispose: () => {},
				};
				return session;
			},
		}) : makeEngine({
			...dependencies,
			childOptions: { resolveInvocation: () => {
				launches++;
				const source = `let prompt = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { prompt += chunk; }); process.stdin.on("end", () => { process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify({...${JSON.stringify(output)},receivedPrompt:prompt})}],stopReason:"end"}}) + "\\n"); });`;
				return { command: process.execPath, args: ["-e", source] };
			} },
		});
		return { engine, launches: () => launches, output };
	}

	test(`${backend} derives nested instructions and validates the pinned recursive schema`, async () => {
		const original = schema();
		const h = harness(original);
		const result = await h.engine.run({ agent: "reviewer", task: "review", outputContract: "nested" });
		assert.equal(result.ok, true, result.error);
		assert.deepEqual(result.structured?.findings, h.output.findings);
		assert.match(String(result.structured?.receivedPrompt), /findings\[\]\.line \(integer, required, >= 1\)/);
		original.fields.findings!.items!.fields!.line!.min = 100;
		const next = await h.engine.run({ agent: "reviewer", task: "review again", outputContract: "nested" });
		assert.equal(next.ok, true, next.error);
		assert.match(String(next.structured?.receivedPrompt), /findings\[\]\.line \(integer, required, >= 1\)/);
	});

	test(`${backend} rejects invalid nested output as a contract failure`, async () => {
		const h = harness(schema(), 1.5);
		const result = await h.engine.run({ agent: "reviewer", task: "review", outputContract: "nested" });
		assert.equal(result.ok, false);
		assert.equal(result.failureKind, "contract");
		assert.match(result.error ?? "", /findings\[0\]\.line must be an integer/);
	});

	test(`${backend} rejects a malformed programmatic contract before launching`, async () => {
		const original = schema();
		original.fields.findings!.items!.fields!.line!.min = Infinity;
		const h = harness(original);
		const result = await h.engine.run({ agent: "reviewer", task: "review", outputContract: "nested" });
		assert.equal(result.ok, false);
		assert.equal(result.failureKind, "contract");
		assert.match(result.error ?? "", /finite/);
		assert.equal(h.launches(), 0);
	});
}
