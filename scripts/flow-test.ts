/**
 * Live flow harness — drives `runFlow` directly (no TUI) with the real in-process engine
 * and a free model, to prove the DAG runs in dependency order, threads each phase's output
 * into its dependents, and journals. `/flow` itself is a slash command (interactive); this
 * exercises the same runner headlessly.
 *
 *   node --import tsx scripts/flow-test.ts
 */
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSession } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../src/agents/agent.ts";
import { makeInProcessEngine } from "../src/engine/inproc.ts";
import { flowHash, parseFlow } from "../src/orchestration/flow.ts";
import { journalWriter } from "../src/orchestration/flow-journal.ts";
import { runFlow } from "../src/orchestration/flow-run.ts";

const MODEL = "openrouter/openrouter/owl-alpha";
const MARKER = "MARKER-ZQ42";

const { session: probe } = await createAgentSession({});
const operator: AgentConfig = {
	name: "operator",
	model: MODEL,
	systemPrompt: "Follow instructions exactly. Reply with only what is asked, nothing else.",
	systemPromptMode: "replace",
	source: "harness",
	tools: [],
};
const engine = makeInProcessEngine({
	resolveAgent: (n) => (n === "operator" ? operator : undefined),
	modelRegistry: probe.modelRegistry,
	cwd: process.cwd(),
	agentDir: join(homedir(), ".pi", "agent"),
	defaultModel: MODEL,
});

const parsed = parseFlow(
	JSON.stringify({
		name: "harness",
		phases: [
			{ id: "alpha", strategy: "solo" },
			{ id: "echo", strategy: "solo", needs: ["alpha"] },
		],
	}),
);
if (!parsed.ok) {
	console.error(parsed.error);
	process.exit(1);
}

const hash = flowHash(parsed.flow);
const journalPath = join(tmpdir(), `flowtest.${hash.slice(0, 8)}.jsonl`);
try {
	fs.rmSync(journalPath, { force: true });
} catch {
	/* fresh */
}

const perPhase: Record<string, string> = {
	alpha: `Reply with exactly: ${MARKER}`,
	echo: "Read the upstream result above. Reply with exactly: I-SAW <the marker token you see>",
};

console.log(`▶ flow harness — model=${MODEL}\n`);
const outcome = await runFlow(parsed.flow, "run the harness", {
	hash,
	journal: journalWriter(journalPath),
	onPhase: (id, status) => console.log(`  phase ${id}: ${status}`),
	runPhase: ({ phase, task }) => engine.run({ agent: "operator", task: `${task}\n\nInstruction: ${perPhase[phase.id]}` }),
});

console.log(`\nalpha → ${outcome.results.alpha?.output}`);
console.log(`echo  → ${outcome.results.echo?.output}`);
const threaded = (outcome.results.echo?.output ?? "").includes(MARKER);
const journaled = fs.existsSync(journalPath) && fs.readFileSync(journalPath, "utf8").includes('"echo"');
console.log(`\nDAG ok: ${outcome.ok} · output threaded alpha→echo: ${threaded ? "YES ✅" : "NO ❌"} · journaled: ${journaled ? "YES ✅" : "NO ❌"}`);
probe.dispose();
process.exit(threaded && journaled ? 0 : 1);
