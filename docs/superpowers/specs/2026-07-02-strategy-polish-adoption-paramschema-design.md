# Strategy polish + adoption + param schema — design

**Date:** 2026-07-02 · **Status:** approved-scope, design under review · **Origin:** the two
closing audits (dead-code = clean; strategy/options = a short list of real gaps + adoption gaps).
Three user-approved buckets in ONE wave: real defects, persona/agent adoption, a param schema —
plus README examples and a general README refresh.

## Guiding principle (answers "optional vs forced")

Everything wired into a persona is a **default, not a mandate**. The `council` tool merges the
supervisor's per-call `params` OVER the persona's (`extension.ts:1513`) and accepts a per-call
`strategy` override (`extension.ts:1510`). A `council:` block is tool-driven (the supervisor
convenes it), never the mandatory input-hook. So: set tasteful defaults; the supervisor/loader
always overrides per-call. The only non-optional p2p is `debate`/`pair` — there the live exchange
IS the strategy, not a toggle.

## Part A — Real defects

### A1. `voting.ts` — degrade `invalid_outputs` to best-prose (the live-observed hole)
When every member fails to emit a vote (frequent on small models), `voteReduce` returns
`invalid_outputs` with no winner, BEFORE the fallback (`voting.ts:65`), so `keepBestFallback`
can't save it and magi/council-rounds/debate return `ok:false` with an empty ruling.
**Fix (contained, in `voting.ts`):** when `valid.length === 0` AND `keepBestFallback` AND there
exist `ok` candidates with non-empty `output`, pick the highest-`confidence` such candidate as
`winner` (status stays `invalid_outputs`, `usedFallback:true`, dissent = the other ok-prose
candidates). No `ok` prose at all ⇒ unchanged empty return. The three vote strategies already
render `decision.winner`, so they now surface the strongest single prose answer with a
"no valid vote — fell back to best response" note instead of nothing.

### A2. `critic-loop.ts` — honour roster-role specialisation
It is the ONLY strategy that flattens members to `.agent` (`critic-loop.ts:20-21`), dropping
`role`/`model`/`skills`. **Fix:** resolve `generator`/`critic` to full `RosterSpec`s
(`rosterSpec(roster[0])` / `[1]`), keep the `params.generator`/`params.critic` **name** overrides
(they select which roster member, or a bare agent name), and pass the full spec to `sdk.agent`.
Bundled `repair`=bare names ⇒ no behavior change; a role-carrying roster now works.

### A3. Extract a shared `attributeInbound()` (security-drift dedup)
`engine/inproc.ts:365` and `bridge.ts:140` compute the sender-attribution + fence envelope
`` `[message from ${from}]\n${fenceUntrusted(text)}` `` VERBATIM — the anti-spoofing format.
**Fix:** one helper in `core/fence.ts` (pure): `attributeInbound(from: string, text: string, opts?: { supervisor?: boolean })` returning the exact string, used by both engines. `from` is the
already-resolved label ("your supervisor" / "peer reviewer#2 (SECURITY)"); the helper only owns
the envelope + fence so a future edit can't drift one copy.

### A4. `unanimity` for council-rounds and debate
Both hardcode `aggregate: "majority"` and ignore `params.aggregate`, though the reducer supports
unanimity. **Fix:** read `params.aggregate` (`"unanimity"` else `"majority"`, default majority) in
both, mirroring magi (`magi.ts:29`). Keep `threshold`/`bestOf` behavior.

### A5. Minors
- `critic-loop.ts` header: document its `generator`/`critic`/`rounds` params (the only strategy
  whose header omits them).
- `council-rounds.ts` + `debate.ts` render: surface the excluded-invalid count when
  `decision.invalid.length > 0` (magi already does — `magi.ts:67-69`).
- `judge.ts` + `fanout.ts` headers: state the no-peers-by-design rationale (independence /
  uncorrelated errors) — compete/magi already document it; make it explicit everywhere it holds.

## Part B — Param schema (validation + discovery)

Params are a bare `Record<string,unknown>` read blindly; a typo (`reflct:false`) is silently
ignored. Add a **declarative, additive** schema — no behavior change to a correct call.

- `sdk.ts`: `export interface StrategyParam { type: "string" | "number" | "boolean"; default?: string | number | boolean; doc: string }` and an optional `params?: Record<string, StrategyParam>`
  on `Strategy`.
- Each of the 11 strategies declares its `params` map (the audit already enumerated them). A
  strategy with no params omits the field.
- `orchestration/strategy.ts`: `export function knownParams(name): Record<string, StrategyParam> | undefined` for consumers.
- The `council` tool (`extension.ts`): before running, if the active strategy has a schema,
  **warn (never hard-fail)** on unknown keys via `ctx.ui.notify(..., "warn")` + a `log` line —
  e.g. `council: ignoring unknown param "reflct" for magi (known: reflect, aggregate)`. A correct
  call is untouched (lenient by design; strategies are trusted project code — I2).
- `/doctor`: a `strategies:` section listing each strategy + its params (name · type · default ·
  doc), so params are discoverable.

## Part C — Adoption (all opt-in-per-call by construction)

| Persona | Change | Why · optionality |
|---|---|---|
| `audit` | `council.params` gains `peers: true` (keeps `synthesize`, roster `review`). | The 3 lens-reviewers surface cross-cutting findings live. Supervisor can pass `{peers:false}` for one call. Clear win. |
| `dev` | NEW `council: { strategy: pair, roster: repair }`. | dev IS build+judge = driver/navigator. Tool-driven ⇒ convened only when useful; supervisor can `{strategy: compete}` etc. per-call. |
| `swarm` | Doc only: note `params: { peers: true }` is available. **Left OFF by default** — batch items are usually independent (peers = noise). | The explicit "beneficial-when-off" case the user flagged: default off, opt-in per call. |
| `magi`, `judge`, `verify` | Unchanged. | Their identity is their strategy; debate/compete are offered via README + per-call `strategy` override, not by distorting them. |

`debate` and `compete` get **README examples** (below) + remain fully reachable via the `council`
tool's per-call `strategy` override from ANY council persona — not force-wired into a persona
whose identity they'd distort. `compete` also needs a competitors roster: add a `build:
[operator, operator]` team to `teams.yaml` (two operator instances in isolated worktrees; per-member
`model:` gives cross-model diversity) so the README example runs.

## Part D — README

- **New "Authoring" section with copy-paste examples:**
  1. An agent `.md` (frontmatter: `tools`, `model`, `isolation: worktree`).
  2. A persona with a tool-driven `council:` (strategy + roster + params), showing the per-call
     override (`council({strategy, roster, params})`).
  3. A persona with mandatory `orchestration:` (fires on the turn).
  4. A `teams.yaml` roster incl. the inline `{ agent, role, model, skills }` ensemble form.
  5. Each new strategy with a runnable one-liner: `debate`, `pair`, `compete`, and `map`/`synthesize`
     with `params: { peers: true }`.
- **Strategy table:** add the `params` column (name · default) for every strategy, sourced from the
  Part-B schemas so table and code can't drift.
- **Comm-plane / broker:** a short "opt-in cross-process broker (`PI_PERSONA_BROKER=1`)" note and
  what it unlocks (steer + comm for child/worktree legs), pointing at the design spec.
- General pass: fix any stale wording the audits flagged (already partly done in the strategy wave).

## Testing

- A1: `voting.test.ts` — all-invalid + keepBestFallback + ok-prose ⇒ winner is the best-confidence
  prose, `usedFallback:true`, status `invalid_outputs`; all-invalid + no ok prose ⇒ unchanged.
  `strategies.test.ts` — magi/debate/council-rounds now return `ok:true` with the prose ruling on
  all-invalid.
- A2: `strategies.test.ts` — critic-loop with a role-carrying roster passes role/model/skills to
  `sdk.agent` (spy the spec); bare-name roster unchanged.
- A3: `fence.test.ts` — `attributeInbound` exact-string; inproc/bridge tests keep passing (they
  pin the delivered format).
- A4: `strategies.test.ts` — council-rounds/debate with `params:{aggregate:"unanimity"}` require
  a unanimous vote.
- B: `strategy.test.ts` — `knownParams` returns each strategy's schema; a council call with an
  unknown param warns (spy `ui.notify`) and still runs.
- C: extension/integration — the seeded personas parse with the new council blocks; `build` team
  resolves.

## Out of scope
- Hard param validation / rejecting unknown keys (stays lenient — I2 trusted code).
- Forcing debate/compete into magi/verify (identity distortion).
- Turning the broker on by default (stays opt-in).
