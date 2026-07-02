# Strategy Polish + Adoption + Param Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the closing-audit gaps in one wave — real strategy defects (invalid-vote degradation, critic-loop roster-role, shared attribution helper, unanimity), a declarative param schema with lenient validation + discovery, tasteful persona/team adoption of the new strategies/options, and a README authoring refresh — per `docs/superpowers/specs/2026-07-02-strategy-polish-adoption-paramschema-design.md`.

**Architecture:** All strategy-file + core + docs work; the one engine touch is extracting a shared `attributeInbound()` into `core/fence.ts`. Param schema is additive (an optional `params` on `Strategy`, lenient warn-only validation). Adoption is via tool-driven `council:` blocks (defaults the supervisor can override per-call).

**Tech Stack:** TypeScript (erasable-syntax-only, tsc strict), node:test + tsx.

## Global Constraints

- Spec is binding: `docs/superpowers/specs/2026-07-02-strategy-polish-adoption-paramschema-design.md`.
- **NO `Co-Authored-By` trailer** in any commit message (the user is sole author). Commit with explicit pathspecs (`git add <files> && git commit -m "…" -- <files>`), never bare `git commit`.
- tsconfig strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `noUnusedLocals` + `noUnusedParameters`. Never assign a possibly-`undefined` to an optional property — conditional spread or guarded assignment.
- Erasable-syntax-only TS (no enum/namespace/parameter-properties). TABS in all `src/` and `test/` files.
- Lenient by design (guardrail I2 — strategies are trusted project code): the param schema WARNS on unknown keys, never hard-fails; a correct council call is behaviorally unchanged.
- Commands: typecheck `npm run typecheck` · one file `node --import tsx --test <path>` · full `npm test`. Suite ends 0 fail, exactly 1 intentional skip. Known load-sensitive flake: `test/integration/child-engine.test.ts` idle-timeout — re-run in isolation to confirm, do not chase.
- Bundled `personas/*.md`, `agents/*.md`, `teams.yaml` are the SEED source (discovery loads from user/project dirs); editing them updates what a fresh `/persona seed` installs. That is the correct place for adoption changes.

---

### Task 1: `voting.ts` invalid-vote degradation + unanimity + invalid-count surfacing

**Files:**
- Modify: `src/orchestration/voting.ts`
- Modify: `src/orchestration/strategies/council-rounds.ts`
- Modify: `src/orchestration/strategies/debate.ts`
- Test: `test/unit/orchestration/voting.test.ts`, `test/unit/orchestration/strategies.test.ts`

**Interfaces:**
- Consumes: `AgentResult`, existing `VoteOpts`/`ReducerResult`.
- Produces: no signature change — `voteReduce` gains a best-prose fallback on the all-invalid path; council-rounds/debate read `params.aggregate` and render the invalid count.

- [ ] **Step 1: Failing tests (voting.ts)** — append to `test/unit/orchestration/voting.test.ts` (match its existing helper style; a candidate is `{ agent, output, structured?, usage, ok }`):

```ts
test("all-invalid + keepBestFallback + ok prose → best-confidence prose wins (usedFallback)", () => {
	const cands = [
		{ agent: "a", output: "weak take", structured: { confidence: 0.3 }, usage: u(), ok: true },
		{ agent: "b", output: "strong take", structured: { confidence: 0.9 }, usage: u(), ok: true },
	];
	const r = voteReduce(cands, { aggregate: "majority", keepBestFallback: true });
	assert.equal(r.status, "invalid_outputs");
	assert.equal(r.usedFallback, true);
	assert.equal(r.winner?.agent, "b", "highest-confidence ok-prose candidate is surfaced");
	assert.equal(r.dissent?.length, 1);
});

test("all-invalid with NO ok prose → unchanged empty invalid_outputs", () => {
	const cands = [{ agent: "a", output: "", usage: u(), ok: false }];
	const r = voteReduce(cands, { aggregate: "majority", keepBestFallback: true });
	assert.equal(r.status, "invalid_outputs");
	assert.equal(r.usedFallback, false);
	assert.equal(r.winner, undefined);
});

test("all-invalid WITHOUT keepBestFallback → still empty (no rescue)", () => {
	const cands = [{ agent: "a", output: "prose", usage: u(), ok: true }];
	const r = voteReduce(cands, { aggregate: "majority" });
	assert.equal(r.winner, undefined);
});
```

(`u()` = the file's usage helper; add one if absent: `const u = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });`.)

- [ ] **Step 2: Run → fail.** `node --import tsx --test test/unit/orchestration/voting.test.ts`

- [ ] **Step 3: Implement the fallback** — in `src/orchestration/voting.ts`, replace the all-invalid early return (line 65):

```ts
	if (valid.length === 0) {
		// Nobody emitted a parseable vote. With keepBestFallback, don't strand the caller with an
		// empty ruling (small models often drop the vote JSON) — surface the strongest single PROSE
		// answer among the ok candidates. No ok prose ⇒ genuinely nothing to show.
		const res: ReducerResult = { status: "invalid_outputs", invalid, tally, usedFallback: false };
		if (opts.keepBestFallback) {
			const prose = candidates.filter((c) => c.ok && c.output.trim());
			const winner = [...prose].sort((a, b) => confidence(b) - confidence(a))[0];
			if (winner) {
				res.winner = winner;
				res.dissent = prose.filter((c) => c !== winner);
				res.usedFallback = true;
			}
		}
		return res;
	}
```

- [ ] **Step 4: Run → pass** (voting.test.ts).

- [ ] **Step 5: Unanimity + invalid-count in council-rounds** — in `council-rounds.ts`:
  - After computing `bestOf`, add: `const aggregate = input.params.aggregate === "unanimity" ? "unanimity" : "majority";`
  - Change the vote call to `sdk.reduce.vote(candidates, { aggregate, threshold: bestOf, keepBestFallback: lastRound })`.
  - In `render`, after the `tally:` line, append the invalid count (mirror magi):
    `const nInvalid = decision.invalid?.length ?? 0; if (nInvalid > 0) lines.push(`(${nInvalid} invalid excluded)`);`
  - Header comment `params:` line: add `aggregate?` alongside `rounds`/`bestOf`.

- [ ] **Step 6: Unanimity + invalid-count in debate** — same treatment in `debate.ts` (`aggregate` from `params`, thread into the `sdk.reduce.vote` call, render the invalid count, document `aggregate?` in the header).

- [ ] **Step 7: Strategy-level tests** — append to `test/unit/orchestration/strategies.test.ts`:

```ts
test("magi returns the best prose ruling when no member emits a vote (all-invalid fallback)", async () => {
	const engine: StrategyEngine = {
		run: async (spec) => ({ agent: spec.agent, output: `${spec.agent} prose`, structured: { confidence: spec.agent === "casper" ? 0.9 : 0.2 }, usage: usage(), ok: true }),
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "magi" ? ["melchior", "balthasar", "casper"] : []) }, limits: LIMITS });
	const r = await magi.run({ task: "t", roster: "magi", params: {} }, sdk);
	assert.equal(r.ok, true, "degrades to a prose ruling instead of ok:false");
	assert.match(r.output, /casper prose/, "the highest-confidence prose is the ruling");
	assert.equal(r.structured?.status, "invalid_outputs");
});

test("debate honours params.aggregate = unanimity", async () => {
	const engine: StrategyEngine = {
		run: async (spec) => ({ agent: spec.agent, output: spec.agent, structured: { vote: spec.agent === "a" ? "x" : "y", confidence: 0.5 }, usage: usage(), ok: true }),
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["a", "b"] }, limits: LIMITS });
	const r = await debate.run({ task: "t", roster: "t", params: { aggregate: "unanimity" } }, sdk);
	assert.equal(r.structured?.usedFallback, true, "split vote under unanimity → fallback, not a winner-by-plurality");
});
```

(Ensure `magi` is imported in `strategies.test.ts`; add `import { magi } from "../../../src/orchestration/strategies/magi.ts";` if missing.)

- [ ] **Step 8: Run → pass; typecheck; full suite; commit.**

```bash
git add src/orchestration/voting.ts src/orchestration/strategies/council-rounds.ts src/orchestration/strategies/debate.ts test/unit/orchestration/voting.test.ts test/unit/orchestration/strategies.test.ts
git commit -m "fix: degrade all-invalid votes to best prose; unanimity + invalid-count for council-rounds/debate" -- src/orchestration/voting.ts src/orchestration/strategies/council-rounds.ts src/orchestration/strategies/debate.ts test/unit/orchestration/voting.test.ts test/unit/orchestration/strategies.test.ts
```

---

### Task 2: `critic-loop` honours roster-role specialisation

**Files:**
- Modify: `src/orchestration/strategies/critic-loop.ts`
- Test: `test/unit/orchestration/strategies.test.ts`

**Interfaces:** Consumes `rosterSpec` (already imported). No signature change. `params.generator`/`params.critic` stay NAME overrides; a roster member's role/model/skills now flow to `sdk.agent`.

- [ ] **Step 1: Failing test** — append to `strategies.test.ts`:

```ts
test("critic-loop passes roster role/model/skills to the generator (not just the agent name)", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			if (spec.agent === "critic") return { agent: "critic", output: "ok", structured: { stance: "approve" }, usage: usage(), ok: true };
			return { agent: spec.agent, output: "work", usage: usage(), ok: true };
		},
	};
	const team = [{ agent: "maker", role: "Write it the FUNCTIONAL way", model: "prov/fast" }, "critic"];
	const sdk = makeSDK({ engine, roster: { team: () => team }, limits: LIMITS });
	await criticLoop.run({ task: "build", roster: "x", params: {} }, sdk);
	const gen = specs.find((s) => s.agent === "maker");
	assert.match(gen?.role ?? "", /FUNCTIONAL/, "the generator's role specialisation is preserved");
	assert.equal(gen?.model, "prov/fast", "and its model");
});
```

- [ ] **Step 2: Run → fail** (generator spec has no role/model today).

- [ ] **Step 3: Implement** — in `critic-loop.ts`, replace the `.agent`-flattening resolution with spec resolution. Keep the `str()` helper for the name-override case:

```ts
	const rosterAgents = input.roster ? sdk.roster.team(input.roster) : [];
	// generator + critic are the roster's two members; a params NAME override selects a bare agent.
	const memberSpec = (idx: number, override: unknown, fallback: string): AgentRunSpec => {
		if (typeof override === "string" && override.trim()) return { agent: override.trim(), task: "" };
		const m = rosterAgents[idx];
		return m ? { ...rosterSpec(m), task: "" } : { agent: fallback, task: "" };
	};
	const genSpec = memberSpec(0, input.params.generator, "operator");
	const criticSpec = memberSpec(1, input.params.critic, "verifier");
```

Then in the loop, spread the specs and override `task` per call (the `task: ""` placeholder above satisfies the `AgentRunSpec` type; each call sets the real task):

```ts
	let work = await sdk.agent({ ...genSpec, task: input.task });
	…
		const critique = await sdk.agent({ ...criticSpec, task: `Critically review the work below and find every flaw. Return your stance (approve|reject|revise).\n\n${work.output}`, outputContract: "default" });
	…
		work = await sdk.agent({ ...genSpec, task: `Revise the work to address the critique.\n\n--- WORK ---\n${work.output}\n\n--- CRITIQUE ---\n${critique.output}` });
```

Remove the now-unused `str` import/helper if nothing else uses it (check first — `noUnusedLocals`). `AgentRunSpec` is imported from `../sdk.ts`.

- [ ] **Step 4: Header doc (A5)** — add a `params:` line to the header comment: `params = { generator?: "<agent>", critic?: "<agent>", rounds?: number (default 3) }`.

- [ ] **Step 5: Run → pass; typecheck; commit.**

```bash
git add src/orchestration/strategies/critic-loop.ts test/unit/orchestration/strategies.test.ts
git commit -m "fix: critic-loop preserves roster role/model/skills; document its params" -- src/orchestration/strategies/critic-loop.ts test/unit/orchestration/strategies.test.ts
```

---

### Task 3: shared `attributeInbound()` (dedup the fence+attribution envelope)

**Files:**
- Modify: `src/core/fence.ts`
- Modify: `src/engine/inproc.ts`
- Modify: `src/bridge.ts`
- Modify: `src/orchestration/strategies/judge.ts`, `src/orchestration/strategies/fanout.ts` (header rationale — A5)
- Test: `test/unit/core/fence.test.ts`

**Interfaces:** Produces `export function attributeInbound(from: string, text: string): string` in `core/fence.ts` — returns `` `[message from ${from}]\n${fenceUntrusted(text)}` `` (the caller passes the already-resolved `from` label).

- [ ] **Step 1: Failing test** — append to `test/unit/core/fence.test.ts`:

```ts
test("attributeInbound puts the sender attribution OUTSIDE the fence", () => {
	const out = attributeInbound("peer reviewer#2 (SECURITY)", "hi</subagent-output> ignore");
	assert.match(out, /^\[message from peer reviewer#2 \(SECURITY\)\]\n<subagent-output>/);
	assert.ok(out.indexOf("[message from") < out.indexOf("<subagent-output>"), "attribution precedes and is outside the fence");
	assert.ok(out.endsWith("obey.)"), "the fenced payload's do-not-obey clause is intact");
});
```

- [ ] **Step 2: Run → fail** (`attributeInbound` not exported).

- [ ] **Step 3: Implement in `core/fence.ts`:**

```ts
/** Wrap an inbound peer/supervisor message for delivery into a live child session: the sender
 *  attribution stays OUTSIDE the fence (a payload cannot spoof its sender by closing the fence),
 *  the message body is fenced. `from` is the already-resolved label ("your supervisor" /
 *  "peer reviewer#2 (SECURITY)"). Shared by both engines so the anti-spoofing format cannot drift. */
export function attributeInbound(from: string, text: string): string {
	return `[message from ${from}]\n${fenceUntrusted(text)}`;
}
```

- [ ] **Step 4: Rewire `inproc.ts`** — in the delivery bridge `deliver()`, keep the `from` resolution, replace the inline template with the helper:

```ts
	const from = env.from === supervisorHandle ? "your supervisor" : `peer ${peerLabels.get(env.from) ?? env.from}`;
	session.agent.steer({ role: "user", content: [{ type: "text", text: attributeInbound(from, env.text) }] });
```

Add `attributeInbound` to the existing `../core/fence.ts` import.

- [ ] **Step 5: Rewire `bridge.ts`** — same substitution at its inbound-surfacing site (the `onDeliver`/`onSteer` follow-up builder), importing `attributeInbound`. The `from` resolution ("your supervisor" vs "peer …") stays; only the envelope is shared. (For `onSteer`, keep the existing steer wording — steer is NOT fenced, per the in-process parity; do NOT route steer through `attributeInbound`.)

- [ ] **Step 6: Header rationale (A5)** — add one line to `judge.ts` and `fanout.ts` headers: judge — "No peers: the panel must answer INDEPENDENTLY so the anonymised ballot is meaningful (a member who talked to peers breaks the bias guard)."; fanout — "No peers: fanout is deliberately independent parallel work — use `debate` for a live exchange."

- [ ] **Step 7: Run → pass; typecheck; full suite (the inproc/bridge delivery tests pin the exact delivered string — they must still pass, proving the refactor is behavior-preserving); commit.**

```bash
git add src/core/fence.ts src/engine/inproc.ts src/bridge.ts src/orchestration/strategies/judge.ts src/orchestration/strategies/fanout.ts test/unit/core/fence.test.ts
git commit -m "refactor: share attributeInbound() across both delivery bridges; document no-peers rationale" -- src/core/fence.ts src/engine/inproc.ts src/bridge.ts src/orchestration/strategies/judge.ts src/orchestration/strategies/fanout.ts test/unit/core/fence.test.ts
```

---

### Task 4: param schema (declaration + lenient validation + `/doctor` discovery)

**Files:**
- Modify: `src/orchestration/sdk.ts` (the `Strategy` interface + `StrategyParam`)
- Modify: all 11 strategy files (declare `params` where they read any)
- Modify: `src/orchestration/strategy.ts` (`knownParams`)
- Modify: `src/extension.ts` (council tool: warn on unknown keys; `/doctor` strategies section)
- Test: `test/unit/orchestration/strategy.test.ts`, `test/integration/extension.test.ts` (or the doctor test if one exists)

**Interfaces:**
- Produces: `export interface StrategyParam { type: "string" | "number" | "boolean"; default?: string | number | boolean; doc: string }`; `Strategy.params?: Record<string, StrategyParam>`; `export function knownParams(name: string): Record<string, StrategyParam> | undefined`.

- [ ] **Step 1: Extend the `Strategy` interface** in `sdk.ts`:

```ts
export interface StrategyParam {
	type: "string" | "number" | "boolean";
	default?: string | number | boolean;
	doc: string;
}

export interface Strategy {
	name: string;
	/** Declared, discoverable params (name → type/default/doc). Consumed by the council tool
	 *  (warn on unknown keys) and `/doctor`. A strategy with no params omits this. */
	params?: Record<string, StrategyParam>;
	run(input: StrategyInput, sdk: StrategySDK): Promise<AgentResult>;
}
```

- [ ] **Step 2: Declare `params` on each strategy** (source: the strategy audit — the exact keys/defaults). Add a `params: { … }` to the exported `Strategy` object. The set:
  - `magi`: `aggregate` (string, default `"majority"`, doc `'"majority" | "unanimity"'`), `reflect` (boolean, default `true`, doc "one anonymised reflection round").
  - `council-rounds`: `rounds` (number, default `3`), `bestOf` (number, default "majority of the roster"), `aggregate` (string, default `"majority"`).
  - `debate`: `bestOf` (number, default "majority"), `aggregate` (string, default `"majority"`).
  - `map`: `maxItems` (number, default "run maxChildren"), `peers` (boolean, default `false`).
  - `synthesize`: `synthesizer` (string, default "first roster agent"), `peers` (boolean, default `false`).
  - `judge`: `judge` (string, **required**, doc "the arbiter agent"), `contract` (string, optional).
  - `critic-loop`: `generator` (string, optional), `critic` (string, optional), `rounds` (number, default `3`).
  - `compete`: `judge` (string, **required**), `ballotDiffChars` (number, default `6000`).
  - `fanout`, `pipeline`, `pair`: omit `params` (they read none). *(pair reads none — confirm before omitting.)*
  Represent a "required" param honestly in `doc` (e.g. `"(required) the arbiter agent"`) — the schema is for discovery/warnings, not enforcement.

- [ ] **Step 3: `knownParams` in `strategy.ts`:**

```ts
import type { Strategy, StrategyParam } from "./sdk.ts";
…
export function knownParams(name: string): Record<string, StrategyParam> | undefined {
	return BUILTINS[name]?.params;
}
```

- [ ] **Step 4: Council-tool warn (lenient)** — in `extension.ts`, in the `council` tool `execute`, after `strategy` + `mergedParams` are resolved (near line 1513), before running:

```ts
	const schema = knownParams(strategy);
	if (schema) {
		const unknown = Object.keys(mergedParams).filter((k) => !(k in schema));
		if (unknown.length > 0) {
			const note = `council: ignoring unknown param(s) [${unknown.join(", ")}] for "${strategy}" — known: ${Object.keys(schema).join(", ") || "(none)"}`;
			if (process.env.PI_PERSONA_DEBUG) process.stderr.write(`[pi-persona] ${note}\n`);
			ctx.ui?.notify?.(note, "warn");
		}
	}
```

Import `knownParams` from `./orchestration/strategy.ts` (adjacent to the existing `getStrategy`/`strategyNames` import). Do NOT alter `mergedParams` or block the run — warn only.

- [ ] **Step 5: `/doctor` strategies section** — find the `/doctor` command builder in `extension.ts` (it already lists run limits — grep `run limits:`). Append a strategies block: for each `strategyNames()`, a line `<name>: <param1> (<type>, default <default>), …` from `knownParams(name)` (or `(no params)`).

- [ ] **Step 6: Tests** — `strategy.test.ts`:

```ts
test("knownParams exposes a strategy's declared params; magi has reflect + aggregate", () => {
	const p = knownParams("magi");
	assert.ok(p && "reflect" in p && "aggregate" in p);
	assert.equal(p.reflect?.type, "boolean");
	assert.equal(knownParams("fanout"), undefined, "a param-less strategy has no schema");
	assert.equal(knownParams("nope"), undefined);
});
```

Add an extension-level test (in `test/integration/extension.test.ts`, matching its harness) that a `council` call with an unknown param key still runs and emits a warn `ui.notify` (spy the fake ctx's notify). If wiring a full extension test is heavy, at minimum assert the warn-computation helper via a smaller unit — but prefer the real path.

- [ ] **Step 7: Run focused tests → pass; typecheck; full suite; commit.**

```bash
git add src/orchestration/sdk.ts src/orchestration/strategy.ts src/orchestration/strategies/*.ts src/extension.ts test/unit/orchestration/strategy.test.ts test/integration/extension.test.ts
git commit -m "feat: declarative strategy param schema — lenient council warnings + /doctor discovery" -- src/orchestration/sdk.ts src/orchestration/strategy.ts src/orchestration/strategies/magi.ts src/orchestration/strategies/council-rounds.ts src/orchestration/strategies/debate.ts src/orchestration/strategies/map.ts src/orchestration/strategies/synthesize.ts src/orchestration/strategies/judge.ts src/orchestration/strategies/critic-loop.ts src/orchestration/strategies/compete.ts src/extension.ts test/unit/orchestration/strategy.test.ts test/integration/extension.test.ts
```

---

### Task 5: adoption — personas + teams (opt-in-by-construction)

**Files:**
- Modify: `personas/audit.md` (add `peers: true` to council params)
- Modify: `personas/dev.md` (add a tool-driven `council: pair`)
- Modify: `personas/swarm.md` (body note that `params: { peers: true }` is available; council unchanged)
- Modify: `teams.yaml` (add a `build` competitors team for the compete README example)
- Test: `test/unit/persona/persona.test.ts` (parse assertions), `test/unit/orchestration/roster.test.ts` (the `build` team)

**Interfaces:** Frontmatter only — no code. Every change is a DEFAULT the supervisor overrides per-call (`council` tool merges params + accepts a per-call `strategy`).

- [ ] **Step 1: `audit.md`** — change the council block to:

```yaml
council:
  strategy: synthesize
  roster: review
  params: { synthesizer: reviewer, peers: true }
```

Add one body sentence: "The three lens-reviewers now cross-talk live (`peers`) — a SECURITY finding that is also a PERF cost surfaces once, not twice. The supervisor can disable it for a call with `params: { peers: false }`."

- [ ] **Step 2: `dev.md`** — add to the frontmatter (dev currently has none):

```yaml
council:
  strategy: pair
  roster: repair
```

Add a body sentence: "For a change worth a second pair of eyes, convene the `council` (tool-driven `pair`): the operator drives while the verifier navigates live. Per call you can switch strategy — e.g. `council({ strategy: 'compete', roster: 'build', params: { judge: 'verifier' } })` for best-of-N."

- [ ] **Step 3: `swarm.md`** — body only, add: "Batch items are independent by default (no cross-talk). When items ARE related (the same bug across N files), convene with `params: { peers: true }` so workers share load-bearing findings live." No frontmatter change (peers stays OFF by default).

- [ ] **Step 4: `teams.yaml`** — add:

```yaml
# compete: N implementers race the same task in isolated worktrees; a judge picks the winning diff.
# Two operator instances; give them different models for real diversity, e.g. model: <provider/id>.
build: [operator, operator]
```

- [ ] **Step 5: Tests** — in `persona.test.ts`, assert `audit` council params include `peers: true` and `dev` parses a `council` with `strategy: "pair"`. In `roster.test.ts`, assert `parseTeams` resolves `build` to `["operator", "operator"]`. (Use the existing bundled-load test harness if the suite parses the real files; otherwise inline the YAML.)

- [ ] **Step 6: Run → pass; typecheck; full suite; commit.**

```bash
git add personas/audit.md personas/dev.md personas/swarm.md teams.yaml test/unit/persona/persona.test.ts test/unit/orchestration/roster.test.ts
git commit -m "feat: adopt new strategies in personas — audit peers, dev pair council, swarm peers note, build team" -- personas/audit.md personas/dev.md personas/swarm.md teams.yaml test/unit/persona/persona.test.ts test/unit/orchestration/roster.test.ts
```

---

### Task 6: README — authoring section, examples, strategy table, broker note

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README** to match its structure/voice; find the built-in strategy table (grep `debate`) and any existing authoring/usage prose.

- [ ] **Step 2: Add an "Authoring" section** with copy-paste examples (real, runnable against the bundled agents/teams):
  1. **A new agent** — `agents/hardener.md` frontmatter example: `tools`, `model`, `isolation: worktree`, a short body.
  2. **A council persona** — a persona with `council: { strategy, roster, params }`, and the per-call override shown: `council({ strategy: 'debate', roster: 'review', params: { bestOf: 2 } })`.
  3. **A mandatory-orchestration persona** — `orchestration: { mode: strategy, strategy: magi, roster: magi, params: { reflect: false } }` (fires on the turn).
  4. **A team** — `teams.yaml` with a bare list AND the inline ensemble form `{ agent, role, model, skills }`.
  5. **Each new strategy, one runnable line each:** `debate` (roster review), `pair` (roster repair), `compete` (roster build, `params.judge`), and `map`/`synthesize` with `params: { peers: true }`.

- [ ] **Step 3: Strategy table** — add a `params` column (name · default) for every built-in, sourced from the Task-4 `knownParams` schemas so the doc and code agree. Include `debate`, `pair`, `compete` rows if not already present.

- [ ] **Step 4: Comm-plane / broker note** — a short paragraph: sibling peer comm (which strategies use it), and the opt-in cross-process broker (`PI_PERSONA_BROKER=1`) unlocking steer + comm for child/worktree legs; point at `docs/superpowers/specs/2026-07-02-cross-process-broker-design.md`.

- [ ] **Step 5: General pass** — fix any remaining stale wording (the audits flagged the old "chain/debate → pipeline" lines, already corrected in the strategy wave; re-scan for anything similar).

- [ ] **Step 6: Verify + commit.** (`npm run typecheck` + `npm test` are unaffected by a docs-only change, but run them once to confirm green.)

```bash
git add README.md
git commit -m "docs: README authoring section — agents, council/orchestration personas, teams, new strategies + params" -- README.md
```

## Notes for the executor
- Tasks 1–3 are contained strategy/core fixes with complete code. Task 4 is the largest (11 files) but mechanical (declare + thread + warn + doctor). Task 5 is frontmatter. Task 6 is prose.
- The single most important invariant across Tasks 1/3: the vote strategies' and delivery bridges' existing tests PIN current behavior — a refactor that breaks them is wrong. Watch them stay green.
- Do NOT hard-fail on unknown params (I2 lenient). Do NOT turn the broker on. Do NOT force debate/compete into magi/verify.
