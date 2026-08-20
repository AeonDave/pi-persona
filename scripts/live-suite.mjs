/**
 * Live test suite — drives every built-in strategy with REAL model calls via scripts/drive.ts,
 * logs tool calls + results + usage. Sequential; each test is capped. Install the bundled
 * definitions first (`/persona seed`) and override LIVE_MODEL when testing another provider.
 */
import { spawnSync } from "node:child_process";

const M = process.env.LIVE_MODEL || "openai-codex/gpt-5.6-luna";
const TIMEOUT = 220_000;

const tests = [
	["01 · OPPORTUNISTIC parallel delegate", "dev",
		"In parallelo, con UNA sola call `delegate` (tasks:[...]), delega due `scout`: il primo riassume in 3 righe cosa fa src/engine/ di questo progetto, il secondo src/orchestration/. Scope disgiunto. Poi sintetizza tu in 3 righe."],
	["02 · MAGI vote", "magi",
		"Use the council tool to decide: i file di flow di pi-persona meglio in YAML o JSON? Motiva e dai il verdetto."],
	["03 · SYNTHESIZE (multi-lens audit)", "audit",
		"Use your default council to review src/ui/agent-tree.ts and report only evidence-backed top risks."],
	["04 · CRITIC-LOOP", "verify",
		"Use your default council to propose a tiny LRU cache design and accept it only after explicit verification."],
	["05 · PAIR", "dev",
		"Call council exactly once with strategy pair and roster repair. Evaluate a minimal bounded-queue design and return the driver result plus navigator review."],
	["06 · PIPELINE", "dev",
		"Call council exactly once with strategy pipeline and roster magi. Decide monorepo vs multi-repo for this project and return the chained result."],
	["07 · COUNCIL-ROUNDS", "dev",
		"Call council exactly once with strategy council-rounds, roster magi and params {rounds:2}. Decide whether flow files should stay JSON."],
	["08 · DEBATE", "dev",
		"Call council exactly once with strategy debate and roster magi. Debate result types vs exceptions for a library API."],
	["09 · JUDGE (panel → impartial arbiter)", "judge",
		"Use the council tool: what's the best way to handle errors in a JSON parser — exceptions, result types, or a callback? Judge the options."],
	["10 · MAP (split → per-item → aggregate)", "swarm",
		"Use the council tool: give a one-line description of each .ts file directly under src/core/ of this project."],
	["11 · FANOUT", "dev",
		"Call council exactly once with strategy fanout and roster review. Review src/core/fence.ts; synthesize the independent reports yourself."],
	["12 · COMPETE (isolated worktrees)", "dev",
		"Call council exactly once with strategy compete, roster build and params {judge:'verifier'}. Propose the smallest useful documentation-only diff for README.md; do not apply it."],
	["13 · ASYNC delegate", "dev",
		"Delega in ASYNC (delegate async:true) un `scout` che elenca i file .ts sotto src/ con una riga ciascuno. Intanto, senza aspettarlo, dimmi tu quanti file .ts ci sono in src/."],
	["14 · EDGE unknown agent (clean error)", "dev",
		"Delega all'agente di nome 'fantasma' il task 'fai qualcosa'. Riporta cosa succede."],
	["15 · EDGE limits clamp (50 tasks → capped)", "dev",
		"Con UNA call `delegate`, lancia 50 task identici all'agente `scout` (ogni task: 'conta da 1 a 3'). Voglio vedere quanti ne partono davvero."],
];

console.log(`LIVE SUITE — model=${M} — ${tests.length} tests\n`);
const t0 = Date.now();
for (const [label, persona, prompt] of tests) {
	console.log(`\n${"=".repeat(78)}\n### ${label}\n${"=".repeat(78)}`);
	const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/drive.ts", "--persona", persona, "--model", M, prompt], {
		stdio: "inherit",
		timeout: TIMEOUT,
	});
	if (r.error) console.log(`  [runner] ${r.error.code === "ETIMEDOUT" ? "TIMED OUT" : r.error.message}`);
}
console.log(`\n${"=".repeat(78)}\nLIVE SUITE done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
