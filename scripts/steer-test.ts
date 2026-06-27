/**
 * Live steer harness — drives the InProcessEngine directly (no TUI) and injects a
 * steering message mid-run via the engine's `onSteerable` handle, to prove steering
 * actually redirects a running sub-agent. Uses a free openrouter model.
 *
 *   node --import tsx scripts/steer-test.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { createAgentSession } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../src/agents/agent.ts";
import { makeInProcessEngine } from "../src/engine/inproc.ts";

const MODEL = "openrouter/openrouter/owl-alpha";
const STEER_AT_MS = 7000;
const MARKER = "STEERED-OK-7Q";

// A populated registry (openrouter etc. registered via extensions) from a throwaway session.
const { session: probe } = await createAgentSession({});
const registry = probe.modelRegistry;

const operator: AgentConfig = {
	name: "operator",
	model: MODEL,
	systemPrompt:
		"You are a focused operator. Work step by step, ONE file per turn. If you receive a new instruction mid-task, OBEY IT IMMEDIATELY and abandon the previous plan.",
	systemPromptMode: "replace",
	source: "harness",
	tools: ["read"],
};

const engine = makeInProcessEngine({
	resolveAgent: (n) => (n === "operator" ? operator : undefined),
	modelRegistry: registry,
	cwd: process.cwd(),
	agentDir: join(homedir(), ".pi", "agent"),
	defaultModel: MODEL,
});

const task =
	"Read each of these files ONE PER TURN and summarise each in one line: package.json, README.md, AGENTS.md, tsconfig.json, src/extension.ts, src/engine/inproc.ts. Do them sequentially, one read per turn.";

let steered = false;
console.log(`▶ steer harness — model=${MODEL}; will steer at ${STEER_AT_MS}ms\n`);
const t0 = Date.now();

const result = await engine.run(
	{ agent: "operator", task },
	(p) => {
		if (p.activity) process.stdout.write(`  · ${p.activity}\n`);
	},
	undefined,
	(steer) => {
		setTimeout(() => {
			console.log(`\n>>> STEERING (${((Date.now() - t0) / 1000).toFixed(1)}s): "stop, reply only ${MARKER}"\n`);
			steer(`STOP. Ignore the remaining files and any earlier plan. Reply with ONLY this exact text and nothing else: ${MARKER}`);
			steered = true;
		}, STEER_AT_MS);
	},
);

console.log(`\n— FINAL OUTPUT (${((Date.now() - t0) / 1000).toFixed(1)}s):\n${result.output}\n`);
const worked = result.output.includes(MARKER);
console.log(`steer injected: ${steered} · ok: ${result.ok} · STEER TOOK EFFECT: ${worked ? "YES ✅" : "NO ❌"}`);
probe.dispose();
process.exit(worked ? 0 : 1);
