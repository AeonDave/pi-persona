# Strategy wave on the new comm plane: `peers` opt-in, `pair`, `compete` — design

**Date:** 2026-07-02 · **Status:** approved · **Scope:** strategy-file-only wave on machinery
shipped by the sibling-peer-comm feature (`contact_peer` + delivery bridge) and the existing
worktree isolation. **Zero engine/SDK changes** — that is the point: proof the seams hold.

## 1. Problem

The audit of the strategy catalog against the just-shipped p2p comm plane found:

1. Only `debate` uses `AgentRunSpec.peers`. Two strategies would genuinely benefit from
   opt-in cross-talk (`map`: cross-item discoveries; `synthesize`: early contradiction
   surfacing) and none offers it.
2. Two machine-supported patterns have NO strategy exposing them: live driver/navigator
   pairing (peers) and best-of-N implementation tournaments (`isolation: "worktree"` — set by
   NO strategy today — plus the `prepareJudge` bias guards).
3. Three strategies must NEVER get p2p — `magi`, `judge`, `fanout` — because independence IS
   their bias guard (uncorrelated errors; anonymisation cannot survive members who talked).
   This rationale is nowhere documented and will eventually be "fixed" by someone.

## 2. Decisions (user-approved)

| # | Decision | Rationale |
|---|----------|-----------|
| W1 | `map` and `synthesize` gain **`params.peers?: boolean`** (default OFF — behavior unchanged). ON ⇒ workers/gatherers run with `peers: true` + a light cooperative cross-talk protocol in the TASK text. | The params channel already flows end-to-end (persona `council.params`, per-call merge in the council tool). Task-text injection, not role (peer-comm deviation 7: keeps UI tree keys stable). |
| W2 | New **`pair`** strategy: roster `[driver, navigator]`, both `peers: true`, in parallel. Driver executes and sends milestones; navigator does an INDEPENDENT inspection (real work that keeps it alive while milestones arrive), sends an early risk checklist, answers milestones with corrections, ends with a final review. Result = driver's work + navigator's review section; `ok` mirrors the driver. | The critic-loop's live counterpart without sequential round costs. Timing is best-effort BY DESIGN (identical to debate): a finalized peer is "gone", the other proceeds solo. |
| W3 | New **`compete`** strategy: N competitors run the same task with `isolation: "worktree"`; each ends its answer with its `git diff` in a ```diff fence (worktrees are DISCARDED — the diff IS the deliverable). A judge picks on an anonymised, shuffled ballot (shared `prepareJudge` guards); the strategy returns the winning diff IN FULL + rationale. **The supervisor applies it** — the strategy never touches the tree (council pattern: the executor applies the ruling). No p2p between competitors: independence is the point. | Exploits `isolation` + judge machinery that exist but are never combined. `withWorktree` discards edits by design (`worktree.ts`), hence the diff contract. |
| W4 | Document **no-peers by design** for `magi`/`judge`/`fanout` in AGENTS.md (one line, with the bias-guard reason). | Protection against future "fixes". |

## 3. Components

### 3.1 `map` + `synthesize` (`params.peers`)

- `const peers = input.params.peers === true;` — anything else is OFF.
- `map`: the WORKERS get `...(peers ? { peers: true } : {})` and, when ON, the task gains a
  `--- swarm cross-talk ---` section: share load-bearing cross-item discoveries once via
  `contact_peer` (`list` then `send`), incorporate incoming `[message from peer …]` notes,
  no chatter. The SPLITTER never gets peers (it runs alone, before the workers exist).
- `synthesize`: the GATHERERS get the same treatment (`--- gatherer cross-talk ---`,
  contradiction/corroboration flavored). The SYNTHESIZER never gets peers (it runs after).

### 3.2 `pair` (`orchestration/strategies/pair.ts`, registered in `BUILTINS`)

- Roster ≥ 2 required (first = driver, second = navigator; throws otherwise).
- ONE `sdk.parallel` with two runs, both `peers: true`, protocols in the task text:
  - Driver: announce plan to the navigator first; milestone note per significant step; final
    "done" note; incorporate corrections when genuinely right — the driver owns the call;
    proceed solo if the navigator is gone.
  - Navigator: do NOT execute the task; inspect the ground independently; send an early risk
    checklist; answer each milestone with ONE short correction/confirmation; send the final
    review, then OUTPUT that same review (verdict + residual risks).
- Result: `agent: "pair"`, output = driver output (+ `--- navigator review (<agent>) ---`
  section when the navigator produced one), `ok` = driver's ok (the work is the deliverable;
  a failed navigator degrades to a solo run, recorded in `structured.navigatorOk`).

### 3.3 `compete` (`orchestration/strategies/compete.ts`, registered in `BUILTINS`)

- Roster ≥ 2 competitors + `params.judge` required (mirrors the `judge` strategy's contract);
  `params.ballotDiffChars?: number` (default 6000) caps each candidate's diff **in the ballot
  only** — the winner's diff is returned in full.
- Competitor spec: `isolation: "worktree"`, task + `--- competition protocol ---`: implement,
  verify, then `git add -N .` (new files must show) and END the answer with an approach
  summary + the COMPLETE unified diff in a ```diff fenced block; an empty diff = failure.
- `extractDiff`: the TAIL ```diff fence of the output; candidates without one are excluded
  (all excluded ⇒ `ok: false`, informative output).
- Ballot: per candidate, the answer minus its diff fence (the summary) + the clipped diff;
  anonymised + shuffled via the shared `prepareJudge`. `shuffleOrder` moves from
  `strategies/judge.ts` (private) to `orchestration/judge.ts` (exported) so compete and judge
  share ONE implementation (no verbatim duplication).
- Winner mapping: `prep.pick(label)` returns the display object by reference ⇒
  `display.indexOf(picked)` indexes the parallel `valid` array carrying the full diff.
- Result: headline (`winner`, valid/entered counts, judge's reasoning) + apply instruction +
  the FULL winning diff in a ```diff fence. `structured: { winner, pick, entered, valid }`.
- **Requires a git repo**: without one the extension's isolation wrapper silently falls back
  to UNISOLATED runs sharing the real tree — documented as a hard caveat (strategy doc
  comment + AGENTS.md/README), not detected at runtime in v1 (the strategy has no fs access).

### 3.4 Docs (W4 + coverage)

- AGENTS.md sibling-peer-comm bullet grows: which strategies use peers (`debate`, `pair`;
  `map`/`synthesize` via `params.peers`) and the no-peers-by-design line for
  `magi`/`judge`/`fanout` (independence = bias guard: uncorrelated errors, anonymisation).
- README: `pair` + `compete` rows in the built-in strategy table (same style); the
  `map`/`synthesize` `peers` param noted where strategies are documented; compete's git-repo
  requirement stated.

## 4. Error handling

- `pair`: navigator failure ⇒ result stays `ok` on the driver's work, no review section,
  `structured.navigatorOk: false`. Driver failure ⇒ `ok: false` (the deliverable failed).
- `compete`: missing/empty tail diff ⇒ candidate excluded; zero valid ⇒ `ok: false`;
  unresolvable judge pick ⇒ `ok: false` with the verdict text (mirrors `judge`).
- Peer sends to finished members ("gone") and send budgets are inherited from the shipped
  peer machinery — nothing new.
- Cross-process note: when the broker (next spec) lands, `peers` on worktree/child-engine legs
  stops degrading — these strategies need NO changes (the flag is the forward-compatible
  surface).

## 5. Testing (stub engine, `strategies.test.ts` conventions)

- `map`/`synthesize`: peers ON ⇒ workers/gatherers get `peers: true` + protocol in task,
  splitter/synthesizer do NOT; peers absent ⇒ specs carry no `peers` (regression pin).
- `pair`: both run with `peers: true` and distinct protocols; result composition (driver
  output + review section); roster < 2 throws; navigator failure keeps `ok` and drops the
  section.
- `compete`: roster/judge validation; competitors get `isolation: "worktree"` + protocol,
  the judge does NOT; happy path (stub judge votes "A", winner accepted via alternation —
  the shuffle is real); no-diff candidate excluded; all-excluded ⇒ `ok: false`; ballot
  clipping (end-of-diff marker absent from the judge's task, present in the winner output).
- `judge` strategy unchanged in behavior after the `shuffleOrder` extraction (existing tests
  are the regression pins).

## 6. Out of scope

- The cross-process broker (separate spec, next).
- Auto-applying the winning compete diff (supervisor's job, by decision W3).
- Navigator transcript-peek (siblings only see explicit sends, by the peer-comm design P1).
- Runtime git-repo detection inside `compete` (strategies have no fs surface; revisit only
  if the caveat bites in practice).
