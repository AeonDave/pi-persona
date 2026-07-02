# Strategy Wave (peers opt-in, pair, compete) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the new comm-plane machinery through the strategy catalog — opt-in peer cross-talk for `map`/`synthesize`, a live `pair` (driver/navigator) strategy, a worktree `compete` (best-of-N + blind judge) strategy, and the no-peers-by-design documentation — per the approved spec `docs/superpowers/specs/2026-07-02-strategy-wave-peers-pair-compete-design.md`.

**Architecture:** Strategy-file-only wave: ZERO engine/SDK changes. `map`/`synthesize` read `input.params.peers` and set `peers: true` + a task-text protocol on their parallel members only. `pair` runs two peers-enabled members with asymmetric protocols. `compete` sets `isolation: "worktree"` per competitor, extracts each one's tail ```diff fence, and judges on an anonymised shuffled ballot via the shared `prepareJudge` (the private `shuffleOrder` in `strategies/judge.ts` moves to `orchestration/judge.ts` so compete and judge share one copy).

**Tech Stack:** TypeScript (erasable-syntax-only, tsc strict), node:test + tsx.

## Global Constraints

- Spec is binding: `docs/superpowers/specs/2026-07-02-strategy-wave-peers-pair-compete-design.md`.
- tsconfig is strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `noUnusedLocals` + `noUnusedParameters`. Never assign a possibly-`undefined` value to an optional property — use conditional spread (`...(x ? { k: x } : {})`) or a guarded assignment.
- Erasable-syntax-only TS. Indentation is TABS in all `src/` and `test/` files.
- Protocols are injected into the TASK text, never appended to `role` (peer-comm deviation 7: `roleHint`-derived UI keys must match `rosterNodeKeys` seeding).
- Commands: typecheck `npm run typecheck` · one test file `node --import tsx --test <path>` · full suite `npm test`. Suite must end 0 fail, exactly 1 intentional skip. Known load-sensitive flake: `test/integration/child-engine.test.ts` idle-timeout test — if it fails in a full run, re-run that file in isolation to confirm; do not chase it.
- Commit with explicit pathspecs (`git add <files> && git commit -m "…" -- <files>`), never bare `git commit`.
- Every commit message ends with the trailer line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `params.peers` opt-in for `map` and `synthesize`

**Files:**
- Modify: `src/orchestration/strategies/map.ts`
- Modify: `src/orchestration/strategies/synthesize.ts`
- Test: `test/unit/orchestration/strategies.test.ts` (append; reuse its `LIMITS`/`usage()` helpers and existing imports of `map`/`synthesize`)

**Interfaces:**
- Consumes: `AgentRunSpec.peers?: boolean` (already shipped), `input.params` (already flows from persona `council.params` + per-call merge).
- Produces: `map` params become `{ maxItems?, peers? }`; `synthesize` params become `{ synthesizer?, peers? }`. Default (absent/false) behavior byte-identical to today.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/orchestration/strategies.test.ts`:

```ts
test("map with params.peers gives WORKERS peer messaging + cross-talk protocol (splitter stays solo)", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			if (spec.agent === "splitter") return { agent: "splitter", output: '["a","b"]', usage: usage(), ok: true };
			return { agent: spec.agent, output: "done", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["splitter", "worker"] }, limits: LIMITS });
	const r = await map.run({ task: "T", roster: "m", params: { peers: true } }, sdk);
	assert.equal(r.ok, true);
	const split = specs.find((s) => s.agent === "splitter");
	const workers = specs.filter((s) => s.agent === "worker");
	assert.equal(split?.peers, undefined, "the splitter runs alone — no peers");
	assert.equal(workers.length, 2);
	for (const w of workers) {
		assert.equal(w.peers, true);
		assert.match(w.task, /contact_peer/, "cross-talk protocol lives in the task text");
	}
});

test("map and synthesize without params.peers leave peers unset (default unchanged)", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			if (spec.agent === "splitter") return { agent: "splitter", output: '["a"]', usage: usage(), ok: true };
			return { agent: spec.agent, output: "x", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["splitter", "worker"] }, limits: LIMITS });
	await map.run({ task: "T", roster: "m", params: {} }, sdk);
	const sdk2 = makeSDK({ engine, roster: { team: () => ["g1", "g2"] }, limits: LIMITS });
	await synthesize.run({ task: "T", roster: "g", params: {} }, sdk2);
	assert.ok(
		specs.every((s) => s.peers === undefined && !s.task.includes("cross-talk")),
		"no peers flag, no protocol by default",
	);
});

test("synthesize with params.peers gives GATHERERS cross-talk but never the synthesizer", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			if (spec.agent === "writer") return { agent: "writer", output: "merged", usage: usage(), ok: true };
			return { agent: spec.agent, output: `finding-${spec.agent}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["g1", "g2"] }, limits: LIMITS });
	const r = await synthesize.run({ task: "T", roster: "g", params: { synthesizer: "writer", peers: true } }, sdk);
	assert.equal(r.ok, true);
	const gatherers = specs.filter((s) => s.agent === "g1" || s.agent === "g2");
	const writer = specs.find((s) => s.agent === "writer");
	assert.equal(gatherers.length, 2);
	for (const g of gatherers) {
		assert.equal(g.peers, true);
		assert.match(g.task, /contact_peer/);
	}
	assert.equal(writer?.peers, undefined, "the synthesizer runs after the gatherers — no peers");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/unit/orchestration/strategies.test.ts`
Expected: the 3 new tests FAIL (`peers` is `undefined` on workers / protocol missing); all pre-existing tests still pass.

- [ ] **Step 3: Implement `map.ts`**

Update the header comment's params line to:

```ts
 * roster = [splitter, worker]  (worker defaults to the splitter if only one is given)
 * params = { maxItems?: number, peers?: boolean (workers share load-bearing cross-item
 *            discoveries live via contact_peer — default off) }
```

Add after the imports:

```ts
// Cooperative cross-talk (params.peers): workers share load-bearing cross-item discoveries
// live. Injected into the TASK text (not the role) so UI tree keys stay stable.
const CROSS_TALK = [
	"You have sibling workers on OTHER sub-items of this same batch. If you discover something",
	"load-bearing that likely applies to their items too (a shared gotcha, a convention, a blocker),",
	"share it once via `contact_peer` (action `list`, then `send`) — short and factual. Incorporate",
	"any “[message from peer …]” notes you receive. No chatter: only load-bearing findings.",
].join(" ");
```

In `run`, after the `maxItems` line add:

```ts
		const peers = input.params.peers === true;
```

Change the log line to:

```ts
		sdk.log(`map: ${items.length} items → ${worker.agent}${peers ? " (cross-talk on)" : ""}`);
```

Replace the worker fan-out with:

```ts
		const results = await sdk.parallel(
			items.map((item) => () =>
				sdk.agent({
					...worker,
					task: `${input.task}\n\n— Your single sub-item: ${item}${peers ? `\n\n--- swarm cross-talk ---\n${CROSS_TALK}` : ""}`,
					...(peers ? { peers: true } : {}),
				}),
			),
		);
```

- [ ] **Step 4: Implement `synthesize.ts`**

Update the header comment's params line to:

```ts
 * roster = the gatherers · params = { synthesizer?: "<agent>" (default: the first roster agent),
 *          peers?: boolean (gatherers share contradictions/corroborations live — default off) }
```

Add after the imports:

```ts
// Cooperative cross-talk (params.peers): gatherers surface contradictions early instead of
// leaving them all to the synthesizer. Task-text injection keeps UI tree keys stable.
const CROSS_TALK = [
	"You have sibling gatherers working OTHER angles of this same task. If you find something that",
	"contradicts or strongly corroborates what another angle would see, share it once via",
	"`contact_peer` (action `list`, then `send`) — short and factual. Incorporate any",
	"“[message from peer …]” notes you receive. No chatter: only load-bearing findings.",
].join(" ");
```

In `run`, after the `synthesizer` const add `const peers = input.params.peers === true;`, extend the log line with `${peers ? " (cross-talk on)" : ""}`, and replace the gatherer fan-out with:

```ts
		const results = await sdk.parallel(
			team.map((m) => () =>
				sdk.agent({
					...rosterSpec(m),
					task: peers ? `${input.task}\n\n--- gatherer cross-talk ---\n${CROSS_TALK}` : input.task,
					...(peers ? { peers: true } : {}),
				}),
			),
		);
```

The synthesizer call at the bottom stays untouched.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test test/unit/orchestration/strategies.test.ts` → PASS (all).

- [ ] **Step 6: Typecheck + full suite + commit**

Run: `npm run typecheck` → clean. Run: `npm test` → 0 fail.

```bash
git add src/orchestration/strategies/map.ts src/orchestration/strategies/synthesize.ts test/unit/orchestration/strategies.test.ts
git commit -m "feat: opt-in peer cross-talk for map and synthesize (params.peers)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- src/orchestration/strategies/map.ts src/orchestration/strategies/synthesize.ts test/unit/orchestration/strategies.test.ts
```

---

### Task 2: The `pair` strategy

**Files:**
- Create: `src/orchestration/strategies/pair.ts`
- Modify: `src/orchestration/strategy.ts` (register in `BUILTINS`)
- Test: `test/unit/orchestration/strategies.test.ts` (append; add `import { pair } from "../../../src/orchestration/strategies/pair.ts";`)

**Interfaces:**
- Consumes: `AgentRunSpec.peers`, `rosterSpec`, `sumUsage`, `sdk.parallel`.
- Produces: `export const pair: Strategy` with `name: "pair"`, roster `[driver, navigator]`, no params.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/orchestration/strategies.test.ts`:

```ts
test("pair runs driver and navigator in parallel with peer messaging and distinct protocols", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			const out = spec.agent === "operator" ? "the implemented work" : "verdict: solid; residual risks: none";
			return { agent: spec.agent, output: out, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["operator", "verifier"] }, limits: LIMITS });
	const r = await pair.run({ task: "build it", roster: "repair", params: {} }, sdk);
	assert.equal(specs.length, 2);
	const drv = specs.find((s) => s.agent === "operator");
	const nav = specs.find((s) => s.agent === "verifier");
	assert.equal(drv?.peers, true);
	assert.equal(nav?.peers, true);
	assert.match(drv?.task ?? "", /DRIVER/);
	assert.match(drv?.task ?? "", /milestone/);
	assert.match(nav?.task ?? "", /NAVIGATOR/);
	assert.match(nav?.task ?? "", /risk checklist/);
	assert.equal(r.ok, true);
	assert.match(r.output, /the implemented work/);
	assert.match(r.output, /--- navigator review \(verifier\) ---/);
	assert.match(r.output, /verdict: solid/);
	assert.equal(r.structured?.driverOk, true);
	assert.equal(r.structured?.navigatorOk, true);
});

test("pair requires a roster of at least 2", async () => {
	const engine: StrategyEngine = { run: async (s) => ({ agent: s.agent, output: "", usage: usage(), ok: true }) };
	const sdk = makeSDK({ engine, roster: { team: () => ["solo"] }, limits: LIMITS });
	await assert.rejects(() => pair.run({ task: "t", roster: "x", params: {} }, sdk), /driver, navigator/);
});

test("pair stays ok when the navigator fails — the driver's work is the deliverable", async () => {
	const engine: StrategyEngine = {
		run: async (spec) =>
			spec.agent === "verifier"
				? { agent: spec.agent, output: "", usage: usage(), ok: false, error: "died" }
				: { agent: spec.agent, output: "solo work", usage: usage(), ok: true },
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["operator", "verifier"] }, limits: LIMITS });
	const r = await pair.run({ task: "t", roster: "repair", params: {} }, sdk);
	assert.equal(r.ok, true);
	assert.match(r.output, /solo work/);
	assert.doesNotMatch(r.output, /navigator review/);
	assert.equal(r.structured?.navigatorOk, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/unit/orchestration/strategies.test.ts`
Expected: FAIL (`Cannot find module … strategies/pair.ts`).

- [ ] **Step 3: Implement `src/orchestration/strategies/pair.ts`**

```ts
/**
 * pair — driver/navigator live pairing on the p2p comm plane. The driver executes the
 * task; the navigator does an INDEPENDENT inspection of the same ground (real work that
 * keeps it alive while milestones arrive), sends an early risk checklist, answers each
 * milestone with a short correction, and ends with a final review. All over one-way
 * `contact_peer` sends — the critic-loop's live counterpart, without sequential round
 * costs. Timing is best-effort BY DESIGN (same as debate): a peer that already finalized
 * is "gone" and the other proceeds solo.
 *
 * roster = [driver, navigator] · result = the driver's work + the navigator's review
 */

import { sumUsage } from "../reducers.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";

const DRIVER_PROTOCOL = [
	"You are the DRIVER of a live pair: a navigator is inspecting the same ground right now.",
	"Announce your plan to it first (`contact_peer` action `list`, then `send`), send a short",
	'milestone note after each significant step, and send a final "done: <summary>" before you',
	"finish. Weigh the navigator's “[message from peer …]” corrections and take the genuinely",
	"right ones — you own the work and the final call. If the navigator is gone, proceed solo.",
].join(" ");

const NAVIGATOR_PROTOCOL = [
	"You are the NAVIGATOR of a live pair: a driver is executing this task right now — you do",
	"NOT execute it yourself. First inspect the task's ground independently (the relevant code,",
	"files, constraints) and `contact_peer send` the driver a short risk checklist (pitfalls,",
	"edge cases). Keep inspecting deeper; whenever a driver “[message from peer …]” milestone",
	"arrives, check it and send back ONE short correction or confirmation. Before you finish,",
	"send the driver your final review, then OUTPUT that same review: a verdict plus the risks",
	"that remain.",
].join(" ");

export const pair: Strategy = {
	name: "pair",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length < 2) throw new Error("pair: a roster of [driver, navigator] is required");
		const driver = rosterSpec(team[0]!);
		const navigator = rosterSpec(team[1]!);
		sdk.log(`pair: ${driver.agent} drives, ${navigator.agent} navigates`);

		const results = await sdk.parallel([
			() => sdk.agent({ ...driver, task: `${input.task}\n\n--- pair protocol (driver) ---\n${DRIVER_PROTOCOL}`, peers: true }),
			() => sdk.agent({ ...navigator, task: `${input.task}\n\n--- pair protocol (navigator) ---\n${NAVIGATOR_PROTOCOL}`, peers: true }),
		]);
		const work = results[0];
		const review = results[1];
		if (!work || !review) throw new Error("pair: a member run went missing");

		// The driver's work IS the deliverable; the navigator's review is attached when it
		// produced one, and its failure only degrades the pair to a solo run.
		const lines = [work.output];
		if (review.ok && review.output.trim()) lines.push(`\n--- navigator review (${navigator.agent}) ---\n${review.output.trim()}`);
		return {
			agent: "pair",
			output: lines.join("\n"),
			structured: { driver: driver.agent, navigator: navigator.agent, driverOk: work.ok, navigatorOk: review.ok },
			usage: sumUsage([work, review].map((r) => r.usage)),
			ok: work.ok,
		};
	},
};
```

- [ ] **Step 4: Register in `src/orchestration/strategy.ts`**

Add `import { pair } from "./strategies/pair.ts";` and a `pair,` entry in `BUILTINS` (keep alphabetical-ish placement next to `map`/`pipeline`). If `test/unit/orchestration/strategy.test.ts` asserts the exact registry name list, add `"pair"` there.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test test/unit/orchestration/strategies.test.ts` → PASS.
Run: `node --import tsx --test test/unit/orchestration/strategy.test.ts` → PASS.

- [ ] **Step 6: Typecheck + full suite + commit**

Run: `npm run typecheck` → clean. Run: `npm test` → 0 fail.

```bash
git add src/orchestration/strategies/pair.ts src/orchestration/strategy.ts test/unit/orchestration/strategies.test.ts test/unit/orchestration/strategy.test.ts
git commit -m "feat: pair strategy — live driver/navigator pairing over peer messaging

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- src/orchestration/strategies/pair.ts src/orchestration/strategy.ts test/unit/orchestration/strategies.test.ts test/unit/orchestration/strategy.test.ts
```

(Drop `strategy.test.ts` from both lists if it needed no change.)

---

### Task 3: The `compete` strategy (+ shared `shuffleOrder`)

**Files:**
- Modify: `src/orchestration/judge.ts` (export `shuffleOrder`)
- Modify: `src/orchestration/strategies/judge.ts` (drop its private copy, import the shared one)
- Create: `src/orchestration/strategies/compete.ts`
- Modify: `src/orchestration/strategy.ts` (register in `BUILTINS`)
- Test: `test/unit/orchestration/strategies.test.ts` (append; add `import { compete } from "../../../src/orchestration/strategies/compete.ts";`)

**Interfaces:**
- Consumes: `sdk.reduce.judge` (`prepareJudge` — ballot format `[A]\n<output>`, `pick(label)` returns the display object BY REFERENCE), `AgentRunSpec.isolation`, `rosterSpec`, `sumUsage`.
- Produces: `export const compete: Strategy` (`name: "compete"`, params `{ judge: string, ballotDiffChars?: number }`); `export function shuffleOrder(n: number): number[]` from `src/orchestration/judge.ts`.

- [ ] **Step 1: Move `shuffleOrder` to the shared module**

In `src/orchestration/judge.ts`, append:

```ts
/** A random permutation of [0..n) — so a judge can't be biased by candidate order.
 *  Production ballots pass this to {@link prepareJudge}; tests pass a fixed permutation. */
export function shuffleOrder(n: number): number[] {
	const a = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j] as number, a[i] as number];
	}
	return a;
}
```

In `src/orchestration/strategies/judge.ts`, DELETE the private `shuffleOrder` function (and its doc comment) and add `import { shuffleOrder } from "../judge.ts";` to the imports. No other change.

Run: `node --import tsx --test test/unit/orchestration/strategies.test.ts` → the existing `judge` tests still PASS (they are the regression pins for this move).

- [ ] **Step 2: Write the failing compete tests**

Append to `test/unit/orchestration/strategies.test.ts`:

```ts
test("compete isolates every competitor in a worktree and returns the winning diff in full", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			if (spec.agent === "arbiter") {
				assert.match(spec.task, /\[A\]/, "the ballot is label-anonymised");
				return { agent: "arbiter", output: "A", structured: { vote: "A", output: "A is cleanest" }, usage: usage(), ok: true };
			}
			const diff = `diff --git a/${spec.agent}.txt b/${spec.agent}.txt\n+x\nEND-${spec.agent}`;
			return { agent: spec.agent, output: `my approach\n\n\`\`\`diff\n${diff}\n\`\`\``, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["one", "two"] }, limits: LIMITS });
	const r = await compete.run({ task: "T", roster: "c", params: { judge: "arbiter" } }, sdk);
	assert.equal(r.ok, true);
	const comps = specs.filter((s) => s.agent !== "arbiter");
	assert.equal(comps.length, 2);
	for (const c of comps) {
		assert.equal(c.isolation, "worktree", "every competitor runs isolated");
		assert.match(c.task, /competition protocol/);
	}
	assert.equal(specs.find((s) => s.agent === "arbiter")?.isolation, undefined, "the judge is not isolated");
	assert.match(r.output, /COMPETE winner: (one|two)/, "the shuffle is real — either can sit at A");
	assert.match(r.output, /END-(one|two)/, "the winner's FULL diff is in the result");
	assert.equal(r.structured?.entered, 2);
	assert.equal(r.structured?.valid, 2);
});

test("compete excludes a competitor without a tail diff fence; all excluded ⇒ not ok", async () => {
	const engine: StrategyEngine = {
		run: async (spec) => {
			if (spec.agent === "arbiter") return { agent: "arbiter", output: "A", structured: { vote: "A" }, usage: usage(), ok: true };
			if (spec.agent === "forgetful") return { agent: spec.agent, output: "did stuff, no diff", usage: usage(), ok: true };
			return { agent: spec.agent, output: "sum\n\n```diff\ndiff --git a/w.txt b/w.txt\n+w\n```", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["forgetful", "worker"] }, limits: LIMITS });
	const r = await compete.run({ task: "T", roster: "c", params: { judge: "arbiter" } }, sdk);
	assert.equal(r.ok, true);
	assert.equal(r.structured?.winner, "worker", "only the fenced candidate could win");
	assert.equal(r.structured?.valid, 1);

	const noneEngine: StrategyEngine = { run: async (s) => ({ agent: s.agent, output: "no fence", usage: usage(), ok: true }) };
	const sdk2 = makeSDK({ engine: noneEngine, roster: { team: () => ["a", "b"] }, limits: LIMITS });
	const r2 = await compete.run({ task: "T", roster: "c", params: { judge: "arbiter" } }, sdk2);
	assert.equal(r2.ok, false);
	assert.match(r2.output, /no competitor delivered a diff/);
});

test("compete clips diffs in the ballot but returns the winner untruncated", async () => {
	let judgeTask = "";
	const long = `diff --git a/big.txt b/big.txt\n${"+x\n".repeat(3000)}TAIL-MARKER`;
	const engine: StrategyEngine = {
		run: async (spec) => {
			if (spec.agent === "arbiter") {
				judgeTask = spec.task;
				return { agent: "arbiter", output: "A", structured: { vote: "A" }, usage: usage(), ok: true };
			}
			return { agent: spec.agent, output: `sum\n\n\`\`\`diff\n${long}\n\`\`\``, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["one", "two"] }, limits: LIMITS });
	const r = await compete.run({ task: "T", roster: "c", params: { judge: "arbiter", ballotDiffChars: 500 } }, sdk);
	assert.match(judgeTask, /\[diff clipped for the ballot/);
	assert.doesNotMatch(judgeTask, /TAIL-MARKER/, "the tail never reaches the ballot");
	assert.match(r.output, /TAIL-MARKER/, "the winner's diff is full in the result");
	assert.equal(r.ok, true);
});

test("compete requires 2+ competitors and params.judge", async () => {
	const engine: StrategyEngine = { run: async (s) => ({ agent: s.agent, output: "", usage: usage(), ok: true }) };
	const sdk = makeSDK({ engine, roster: { team: () => ["a", "b"] }, limits: LIMITS });
	await assert.rejects(() => compete.run({ task: "t", roster: "c", params: {} }, sdk), /params\.judge/);
	const sdk1 = makeSDK({ engine, roster: { team: () => ["solo"] }, limits: LIMITS });
	await assert.rejects(() => compete.run({ task: "t", roster: "c", params: { judge: "j" } }, sdk1), /at least 2/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --import tsx --test test/unit/orchestration/strategies.test.ts`
Expected: the 4 new tests FAIL (`Cannot find module … strategies/compete.ts`); everything else passes.

- [ ] **Step 4: Implement `src/orchestration/strategies/compete.ts`**

```ts
/**
 * compete — best-of-N implementations in ISOLATED worktrees, judged blind. Every
 * competitor attacks the same task with `isolation: "worktree"` (the engine routes it
 * through a throwaway detached checkout whose edits are DISCARDED at the end), so each
 * must deliver its work AS A UNIFIED DIFF at the tail of its answer. An impartial judge
 * picks on an anonymised, shuffled ballot (the same bias guards as `judge`); the strategy
 * returns the WINNING DIFF in full — the SUPERVISOR applies it (council pattern: the
 * executor applies the ruling; the strategy never touches the tree). No p2p between
 * competitors: independence is the point.
 *
 * REQUIRES a git repo: without one the isolation wrapper silently degrades to unisolated
 * runs sharing the real tree — do not convene compete there.
 *
 * roster = the competitors · params = { judge: "<agent>" (required),
 *          ballotDiffChars?: number (default 6000 — ballot-only clip; the winner is full) }
 */

import { shuffleOrder } from "../judge.ts";
import { sumUsage } from "../reducers.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";

const DIFF_PROTOCOL = [
	"You are ONE of several competitors implementing this task independently in an ISOLATED git",
	"worktree — your edits are discarded when you finish, so the diff IS your deliverable.",
	"When your implementation is complete and verified: run `git add -N .` (so new files show up),",
	"then `git diff`, and END your answer with a one-paragraph summary of your approach followed",
	"by the COMPLETE unified diff in a ```diff fenced block. An empty diff means you failed.",
].join(" ");

const BALLOT_DIFF_CHARS = 6000;
const TAIL_DIFF_FENCE = /```diff\n([\s\S]*?)```\s*$/;

/** The tail ```diff fence of a competitor's answer (its deliverable), or undefined. */
function extractDiff(output: string): string | undefined {
	const body = output.match(TAIL_DIFF_FENCE)?.[1]?.trim();
	return body ? body : undefined;
}

/** Clip a diff for the ballot only — the winner's diff is always returned in full. */
function clip(diff: string, max: number): string {
	if (diff.length <= max) return diff;
	return `${diff.slice(0, max)}\n…[diff clipped for the ballot — ${diff.length - max} more chars; the full diff survives in the winner]`;
}

export const compete: Strategy = {
	name: "compete",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length < 2) throw new Error("compete: a roster of at least 2 competitors is required");
		const arbiter = typeof input.params.judge === "string" && input.params.judge.trim() ? input.params.judge.trim() : undefined;
		if (!arbiter) throw new Error("compete: params.judge (the arbiter agent) is required");
		const ballotChars =
			typeof input.params.ballotDiffChars === "number" && input.params.ballotDiffChars > 0
				? input.params.ballotDiffChars
				: BALLOT_DIFF_CHARS;
		sdk.log(`compete: ${team.length} competitors in isolated worktrees → judge ${arbiter}`);

		const candidates = await sdk.parallel(
			team.map((m) => () =>
				sdk.agent({
					...rosterSpec(m),
					task: `${input.task}\n\n--- competition protocol ---\n${DIFF_PROTOCOL}`,
					isolation: "worktree",
				}),
			),
		);
		const valid: Array<{ result: AgentResult; diff: string }> = [];
		for (const c of candidates) {
			const diff = c.ok ? extractDiff(c.output) : undefined;
			if (diff) valid.push({ result: c, diff });
		}
		if (valid.length === 0) {
			const reasons = candidates.map((c) => `[${c.agent}] ${c.ok ? "no tail ```diff fence" : (c.error ?? "failed")}`).join("; ");
			return {
				agent: "compete",
				output: `(no competitor delivered a diff: ${reasons})`,
				usage: sumUsage(candidates.map((c) => c.usage)),
				ok: false,
			};
		}

		// Blind ballot: each candidate is its approach summary (the answer minus the diff fence)
		// + a clipped diff — anonymised and shuffled by the shared judge prep (§4.3 bias guards).
		const display = valid.map(({ result, diff }) => ({
			...result,
			output: `${result.output.replace(TAIL_DIFF_FENCE, "").trim()}\n\n${clip(diff, ballotChars)}`,
		}));
		const prep = sdk.reduce.judge(display, shuffleOrder(display.length));
		const verdict = await sdk.agent({
			agent: arbiter,
			task:
				`Judge these competing implementations (each: approach summary + unified diff) and pick the single best — ` +
				`correctness first, then simplicity and fit. Be impartial: the candidates are anonymised.\n\n` +
				`Task: ${input.task}\n\nCandidates:\n${prep.ballot}\n\n` +
				`Return JSON ONLY: {"vote":"<the letter of your pick>","result":"<one-line verdict>","output":"<why it wins>"}`,
			outputContract: "default",
		});
		const label = typeof verdict.structured?.vote === "string" ? verdict.structured.vote : "";
		const picked = prep.pick(label);
		// prep.pick returns the display object by reference, so its index maps back to `valid`.
		const winner = picked ? valid[display.indexOf(picked)] : undefined;
		const usage = sumUsage([...candidates, verdict].map((r) => r.usage));
		if (!winner) {
			return { agent: "compete", output: `compete: the judge could not resolve a pick (verdict: ${verdict.output})`, usage, ok: false };
		}

		const reasoning = (typeof verdict.structured?.output === "string" && verdict.structured.output) || verdict.output;
		const out = [
			`COMPETE winner: ${winner.result.agent} (${valid.length} valid of ${team.length} entered) — chosen by ${arbiter}: ${reasoning}`,
			"",
			"Apply the winning diff from the repo root (save it, then `git apply`):",
			"```diff",
			winner.diff,
			"```",
		].join("\n");
		return {
			agent: "compete",
			output: out,
			structured: { winner: winner.result.agent, pick: label, entered: team.length, valid: valid.length },
			usage,
			ok: true,
		};
	},
};
```

- [ ] **Step 5: Register in `src/orchestration/strategy.ts`**

Add `import { compete } from "./strategies/compete.ts";` and a `compete,` entry in `BUILTINS`. If `strategy.test.ts` asserts the registry name list, add `"compete"`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --import tsx --test test/unit/orchestration/strategies.test.ts` → PASS (all, including the judge regression pins).
Run: `node --import tsx --test test/unit/orchestration/strategy.test.ts` → PASS.
Run: `node --import tsx --test test/unit/orchestration/judge.test.ts` → PASS (prepareJudge untouched).

- [ ] **Step 7: Typecheck + full suite + commit**

Run: `npm run typecheck` → clean. Run: `npm test` → 0 fail.

```bash
git add src/orchestration/judge.ts src/orchestration/strategies/judge.ts src/orchestration/strategies/compete.ts src/orchestration/strategy.ts test/unit/orchestration/strategies.test.ts test/unit/orchestration/strategy.test.ts
git commit -m "feat: compete strategy — best-of-N in isolated worktrees, blind-judged, winner as diff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- src/orchestration/judge.ts src/orchestration/strategies/judge.ts src/orchestration/strategies/compete.ts src/orchestration/strategy.ts test/unit/orchestration/strategies.test.ts test/unit/orchestration/strategy.test.ts
```

---

### Task 4: Documentation + final verification

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

- [ ] **Step 1: AGENTS.md — extend the sibling-peer-comm bullet**

Find the Conventions bullet that starts with `- **Sibling peer comm (in-process)**:` and append these sentences to it (same indentation, keep the existing text):

```markdown
  On the peer plane: `debate` and `pair` always; `map`/`synthesize` opt-in via `params.peers`.
  `magi`/`judge`/`fanout` stay peer-less BY DESIGN — independence is their bias guard
  (uncorrelated errors; an anonymised ballot cannot survive members who talked) — do not "fix"
  this. `compete` runs its competitors with `isolation: worktree` (REQUIRES a git repo; without
  one the wrapper silently degrades to unisolated runs) and returns the winning diff for the
  SUPERVISOR to apply.
```

- [ ] **Step 2: README — strategy table + params**

Run `Grep "debate" README.md -n` to find the built-in strategy table. Add two rows in the same style:
- `pair` — *driver executes while a navigator inspects the same ground live: risk checklist up front, corrections per milestone, final review attached (peer-to-peer)*
- `compete` — *N competitors implement the same task in isolated git worktrees; a blind judge picks; the winner is returned as a unified diff for the supervisor to apply (requires a git repo)*

Where `map` and `synthesize` are documented (table or prose), note the `peers` param: *opt-in live cross-talk between workers/gatherers (`params: { peers: true }`)*. Match the surrounding wording style; keep it brief.

- [ ] **Step 3: Full verification**

Run: `npm run typecheck` → clean.
Run: `npm test` → 0 fail, 1 intentional skip.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: strategy wave — peers opt-in, pair, compete, no-peers-by-design rationale

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- AGENTS.md README.md
```

- [ ] **Step 5 (manual, flagged to the user — not run by the executor): live drive checks**

```bash
npm run drive -- --persona elite --model claude-pro-max-native/claude-haiku-4-5 "council strategy=pair roster=repair: add an input-validation guard to the sample script"
npm run drive -- --persona elite --model claude-pro-max-native/claude-haiku-4-5 "council strategy=compete roster=magi params={\"judge\":\"verifier\"}: implement a tiny slugify helper with tests"
```

Expected: pair shows milestone/correction `contact_peer` traffic and a navigator review section; compete shows worktree-isolated runs and a `COMPETE winner:` ruling carrying a ```diff fence. These spend tokens — left to the human.
