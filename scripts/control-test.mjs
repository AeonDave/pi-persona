/**
 * Live control-ops harness — drives the in-process engine with REAL model calls to prove
 * the supervisor controls a running sub-agent: STEER (inject mid-run), STOP (abort mid-run),
 * and RESUME (a flow skips journaled phases). Free model. Run foreground.
 */
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSession } from "@earendil-works/pi-coding-agent";

import { makeInProcessEngine } from "../src/engine/inproc.ts";
import { flowHash, parseFlow } from "../src/orchestration/flow.ts";
import { journalWriter, parseJournal } from "../src/orchestration/flow-journal.ts";
import { runFlow } from "../src/orchestration/flow-run.ts";

const MODEL = process.env.LIVE_MODEL || "openrouter/openrouter/owl-alpha";
const { session: probe } = await createAgentSession({});
const op = { name: "operator", model: MODEL, systemPrompt: "Follow instructions EXACTLY. Work ONE file per turn — never batch.", systemPromptMode: "replace", source: "h", tools: ["read"] };
const engine = makeInProcessEngine({
	resolveAgent: (n) => (n === "operator" ? op : undefined),
	modelRegistry: probe.modelRegistry,
	cwd: process.cwd(),
	agentDir: join(homedir(), ".pi", "agent"),
	defaultModel: MODEL,
});
const READ8 = "Read these files ONE PER TURN (never batch) and summarise each in one line: package.json, README.md, AGENTS.md, tsconfig.json, src/extension.ts, src/engine/inproc.ts, src/orchestration/sdk.ts, src/persona/persona.ts.";

// ── 1. STEER ────────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(70)}\n### STEER — inject a redirect into a running sub-agent\n${"=".repeat(70)}`);
let steered = false;
const sR = await engine.run(
	{ agent: "operator", task: READ8 },
	(p) => { if (p.activity) process.stdout.write(`  · ${p.activity}\n`); },
	undefined,
	(steer) => setTimeout(() => { console.log("  >>> STEER: 'stop, reply only STEERED-OK'"); steer("STOP. Ignore the remaining files. Reply with ONLY: STEERED-OK"); steered = true; }, 4000),
);
console.log(`  injected:${steered} · TOOK EFFECT: ${sR.output.includes("STEERED-OK") ? "YES ✅" : "NO ❌"}  (out: ${sR.output.replace(/\s+/g, " ").slice(0, 50)})`);

// ── 2. STOP / terminate ─────────────────────────────────────────────────────
console.log(`\n${"=".repeat(70)}\n### STOP — abort a running sub-agent mid-run\n${"=".repeat(70)}`);
const ac = new AbortController();
setTimeout(() => { console.log("  >>> ABORT"); ac.abort(); }, 5000);
const stR = await engine.run({ agent: "operator", task: READ8 }, (p) => { if (p.activity) process.stdout.write(`  · ${p.activity}\n`); }, ac.signal);
console.log(`  ok:${stR.ok} (expect false) · error:'${stR.error}' · STOPPED: ${!stR.ok && /abort/i.test(stR.error ?? "") ? "YES ✅" : "NO ❌"}`);

// ── 3. RESUME — a flow skips journaled phases ───────────────────────────────
console.log(`\n${"=".repeat(70)}\n### RESUME — re-run a flow; the done phase is skipped\n${"=".repeat(70)}`);
const flow = parseFlow(JSON.stringify({ name: "r", phases: [{ id: "a", strategy: "solo" }, { id: "b", strategy: "solo", needs: ["a"] }] }));
if (!flow.ok) throw new Error(flow.error);
const hash = flowHash(flow.flow);
const jp = join(tmpdir(), `resume.${hash.slice(0, 8)}.jsonl`);
try { fs.rmSync(jp, { force: true }); } catch { /* fresh */ }
const ran1 = [];
await runFlow(flow.flow, "run the harness", {
	hash,
	journal: journalWriter(jp),
	runPhase: ({ phase, task }) => { ran1.push(phase.id); return engine.run({ agent: "operator", task: `${task}\n\nReply with EXACTLY: done-${phase.id}` }); },
});
console.log(`  fresh run executed phases: [${ran1.join(", ")}]`);
// Simulate an interruption AFTER phase a: a partial journal with only 'a' done.
const partial = `${JSON.stringify({ phase: "a", hash, ok: true, output: "done-a" })}\n`;
const resume = parseJournal(partial, hash);
const ran2 = [];
await runFlow(flow.flow, "run the harness", {
	hash,
	resume,
	runPhase: ({ phase, task }) => { ran2.push(phase.id); return engine.run({ agent: "operator", task }); },
});
console.log(`  resumed run executed phases: [${ran2.join(", ")}]  ·  RESUME (a skipped, b ran): ${ran2.length === 1 && ran2[0] === "b" ? "YES ✅" : "NO ❌"}`);

probe.dispose();
process.exit(0);
