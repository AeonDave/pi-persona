/**
 * Live test suite — drives every strategy / mode / persona with REAL model calls (free
 * openrouter model) via scripts/drive.ts, logs the tool calls + results + usage. Sequential;
 * each test capped. Run in background; read the aggregated log when it finishes.
 */
import { spawnSync } from "node:child_process";

const M = process.env.LIVE_MODEL || "openrouter/openrouter/owl-alpha";
const TIMEOUT = 220_000;

const tests = [
	["01 · OPPORTUNISTIC parallel delegate (coder)", "coder",
		"In parallelo, con UNA sola call `delegate` (tasks:[...]), delega due `scout`: il primo riassume in 3 righe cosa fa src/engine/ di questo progetto, il secondo src/orchestration/. Scope disgiunto. Poi sintetizza tu in 3 righe."],
	["02 · MANDATORY magi vote (council)", "magi",
		"Use the council tool to decide: i file di flow di pi-persona meglio in YAML o JSON? Motiva e dai il verdetto."],
	["03 · review fanout (3 dimensions)", "review",
		"Use the council tool to review src/ui/agent-tree.ts and report the top risks."],
	["04 · antagonist critic-loop", "antagonist",
		"Use the council tool: propose a tiny LRU cache design, then harden it against the critic."],
	["05 · debate PIPELINE (chain)", "debate",
		"Use the council tool to debate: monorepo or multi-repo for a small TS extension? Chain the three cores and give the synthesis."],
	["06 · magiv2 COUNCIL-ROUNDS (multi-round, new strategy via file only)", "magiv2",
		"Use the council tool to decide: monorepo or multi-repo for this project?"],
	["07 · JUDGE (panel → impartial arbiter)", "judge",
		"Use the council tool: what's the best way to handle errors in a JSON parser — exceptions, result types, or a callback? Judge the options."],
	["08 · MAP (split → per-item → aggregate)", "map",
		"Use the council tool: give a one-line description of each .ts file directly under src/core/ of this project."],
	["09 · ASYNC delegate (coder)", "coder",
		"Delega in ASYNC (delegate async:true) un `scout` che elenca i file .ts sotto src/ con una riga ciascuno. Intanto, senza aspettarlo, dimmi tu quanti file .ts ci sono in src/."],
	["10 · EDGE unknown agent (clean error)", "coder",
		"Delega all'agente di nome 'fantasma' il task 'fai qualcosa'. Riporta cosa succede."],
	["11 · EDGE limits clamp (50 tasks → capped)", "coder",
		"Con UNA call `delegate`, lancia 50 task identici all'agente `scout` (ogni task: 'conta da 1 a 3'). Voglio vedere quanti ne partono davvero."],
];

console.log(`LIVE SUITE — model=${M} — ${tests.length} tests\n`);
const t0 = Date.now();
for (const [label, persona, prompt] of tests) {
	console.log(`\n${"=".repeat(78)}\n### ${label}\n${"=".repeat(78)}`);
	const r = spawnSync("node", ["--import", "tsx", "scripts/drive.ts", "--persona", persona, "--model", M, prompt], {
		stdio: "inherit",
		timeout: TIMEOUT,
	});
	if (r.error) console.log(`  [runner] ${r.error.code === "ETIMEDOUT" ? "TIMED OUT" : r.error.message}`);
}
console.log(`\n${"=".repeat(78)}\nLIVE SUITE done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
