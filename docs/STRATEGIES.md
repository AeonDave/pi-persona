# Strategies — the orchestration layer

How a roster of sub-agents is coordinated. A **strategy** is a small TypeScript file composing the
**Strategy SDK**; a **persona** decides whether and how one runs. This document is the contributor's
deep dive: the SDK contract, every built-in's mechanism and params, the bias-guard invariants you
must not break, the param schema, and how personas select options. For the user-facing catalog and
copy-paste recipes see the [README](../README.md); for the system design see
[ARCHITECTURE.md](ARCHITECTURE.md).

## The Strategy SDK

A strategy is `{ name, params?, run(input, sdk) }` (`src/orchestration/sdk.ts`). `run` receives the
task/roster/params and a constrained `sdk`; it returns one `AgentResult`. The engine is injected, so
a strategy is backend-agnostic and unit-testable against a stub engine.

| Primitive | Contract |
|---|---|
| `sdk.agent(spec)` | Run ONE sub-agent → `AgentResult`. `spec`: `{ agent, task, model?, tools?, skills?, role?, outputContract?, isolation?, peers? }`. |
| `sdk.parallel(thunks, {concurrency?})` | Run many at once, capped at `limits.maxConcurrency`. The basis of every fan-out (`parallel(items.map(…))`). |
| `sdk.reduce.aggregate(results)` | Concatenate N results into one (fan-out's merge). |
| `sdk.reduce.vote(candidates, opts)` | Tally the candidates' OWN votes → a `ReducerResult` (`voting.ts`). |
| `sdk.reduce.judge(candidates, order?)` | Anonymise + reorder N candidates into a ballot for an impartial judge; `pick(label)` maps the verdict back. |
| `sdk.roster.team(name)` | The members of a named team (bare names or inline `{ agent, role, model, skills }` specs). |
| `sdk.signal` · `sdk.limits` · `sdk.log` | Cooperative abort · the hard ceilings · a progress line. |
| series & loops | Plain `await` / `for` — a strategy is TypeScript, so `pipeline` and `critic-loop` are just native control flow. |

Run limits (`RUN_LIMITS`) are enforced inside `makeSDK` regardless of how a strategy calls `agent()`:
`maxChildren`, `maxConcurrency`, `budgetTokens`, `timeoutMs` (idle window), `maxDepth`. On top of the
idle window, every agent can also carry an **opt-in hard wall-clock cap** (`PI_PERSONA_AGENT_MAX_MS`,
OFF by default = unlimited) — a lifetime ceiling that, when armed, settles a busy-but-non-converging
worker the idle window never catches; left off, a healthy child runs to completion and the idle window
+ token budget bound a wedged item. Safety comes from these runtime limits, not from
sandboxing the strategy (see the I2 invariant in [ARCHITECTURE.md](ARCHITECTURE.md)).

## Roster-role ensembles

A team member is a bare agent name OR an inline `{ agent, role, model, skills }` map that specialises
ONE agent (`roster.ts` · `rosterSpec` normalises both). So `review` is one `reviewer` agent run under
three lens roles (SECURITY · PERFORMANCE · TESTS), not three files. Every strategy must run members
through `rosterSpec` to honour the specialisation — **`critic-loop` is the one to watch**: it resolves
`generator`/`critic` to full specs so a role-carrying roster works, while still accepting a bare-name
`params.generator`/`critic` override.

Same-agent members are disambiguated in the live `f9` tree by a role hint (`reviewer · SECURITY`) via
`rosterNodeKeys`/`roleHint` (`roster.ts`) + the SDK's per-run key (`sdk.ts`). If you touch either, keep
the seeding loop and the SDK key derivation in lockstep, and inject any per-run protocol via the TASK
text, never `role` (or the derived tree key drifts from the seeded one).

## The built-in strategies

| Strategy | Mechanism | Params (default) | Comm/engine features |
|---|---|---|---|
| `fanout` | Every roster agent on the same task in parallel, then `aggregate`. | — | roster-role |
| `pipeline` | Roster in SEQUENCE, each builds on the prior output; answer = last step. | — | roster-role |
| `map` | A splitter breaks the task into a runtime list; a worker runs once per item in parallel, then `aggregate`. | `maxItems` (maxChildren), `peers` (false) | roster-role, opt-in peers |
| `critic-loop` | Generator proposes, critic attacks; revise while the critic's stance is `reject`, up to `rounds`. | `generator` (roster[0]), `critic` (roster[1]), `rounds` (3) | roster-role, `outputContract` |
| `magi` | Parallel INDEPENDENT votes from distinct-persona cores → majority/unanimity, tally + minority report; one anonymised reflection round by default. | `aggregate` ("majority"), `reflect` (true) | vote reducer |
| `council-rounds` | Multi-round `magi`, best-of-X: the whole roster re-deliberates carrying the debate forward until a supermajority, else best-by-confidence on the last round. | `rounds` (3), `bestOf` (majority), `aggregate` ("majority") | vote reducer |
| `debate` | 2+ members work the same task in parallel and exchange positions LIVE via `contact_peer`, then a majority vote settles it. | `bestOf` (majority), `aggregate` ("majority") | **peers always**, vote reducer |
| `judge` | A panel answers in parallel; one impartial arbiter picks on an anonymised, shuffled ballot. | `judge` (required), `contract` (none) | judge reducer |
| `synthesize` | Parallel gatherers → one synthesiser merges the labeled findings into a single coherent answer (the "reduce" `fanout` lacks). | `synthesizer` (roster[0]), `peers` (false) | roster-role, opt-in peers |
| `pair` | A driver executes while a navigator inspects the same ground live (risk checklist up front, corrections per milestone, final review attached). | — | **peers always** (both legs) |
| `compete` | N competitors implement the same task in ISOLATED git worktrees; a blind judge picks; the winner is returned as a unified diff for the SUPERVISOR to apply. | `judge` (required), `ballotDiffChars` (6000) | **`isolation: worktree`**, judge reducer |

`fanout`, `pipeline`, `pair` read no params and omit the schema.

## Bias-guard invariants (do NOT "fix" these)

The reducers and independence rules are the quality guarantees. Breaking them silently degrades every
council. They are enforced structurally, not by convention.

- **No peers on `magi` / `judge` / `fanout` (and `compete` / `council-rounds`) — BY DESIGN.**
  Independence is the bias guard: uncorrelated errors for a vote, and an anonymised ballot that cannot
  survive members who talked. These strategies never set `peers: true` and never read `params.peers`,
  so no persona or param can force cross-talk on them. Only `debate`/`pair` (where the live exchange IS
  the topology) and the opt-in `map`/`synthesize` use peers.
- **Anonymise + reorder before a judge.** `reduce.judge` (`orchestration/judge.ts`) strips author
  identity and shuffles order (`shuffleOrder`, shared by `judge` and `compete`) so neither identity nor
  position sways the pick.
- **Preserve dissent.** `reduce.vote` always returns the minority report alongside the winner — a
  ruling never hides who disagreed.
- **Quarantine invalid outputs, then degrade — never strand.** A candidate that emits no parseable
  vote is quarantined from the tally (`voting.ts`). When EVERY member fails to vote (common on small
  models) and `keepBestFallback` is set, the reducer surfaces the highest-confidence PROSE answer
  among the candidates that actually answered — ok ones AND contract-only failures (an engine marks
  a member that answered in prose instead of the vote JSON as `failureKind: "contract"`; hard
  failures stay excluded) — so `magi`/`council-rounds`/`debate` degrade to the strongest single
  response rather than returning `ok: false`. The "N invalid excluded" footer counts only
  genuinely-dropped candidates, not the surfaced prose.
- **The contract instructs as well as validates.** An engine that receives `outputContract` appends
  the format block (`contractInstructions`, derived from the same pinned def it validates against)
  to the member's task — a bare generic agent votes as reliably as one whose `.md` spells the JSON
  out by hand.

## The vote reducer status model

`reduce.vote` returns one of `winner` | `tie` | `no_consensus` | `invalid_outputs`, plus `winner?`,
`dissent?`, `invalid?`, `tally`, `usedFallback`. `aggregate: "majority"` (plurality, with an optional
`threshold`/best-of-X) or `"unanimity"` (one vote key or fall back). `keepBestFallback` promotes the
highest-confidence candidate as `winner` on a tie / no-consensus / all-invalid rather than returning
nothing. Vote keys are normalised (`json-first`, `JSON_First`, `json first` → `json-first`) and a
`result` field counts as a vote when `vote` is absent.

## Param schema (declaration · validation · discovery)

Each strategy declares its params as `params?: Record<string, StrategyParam>` where `StrategyParam =
{ type: "string" | "number" | "boolean"; default?; doc }`. `knownParams(name)` (`strategy.ts`) exposes
them. Two consumers:

- The **`council` tool** warns (via `ui.notify`, never hard-fails — I2 lenient) when a call passes a
  key the active strategy doesn't declare, e.g. `ignoring unknown param "reflct" for magi (known:
  reflect, aggregate)`. A correct call is behaviourally unchanged.
- **`/doctor`** lists each strategy's params live, so the schema is discoverable and the README table
  can't drift from the code.

The schema is for discovery and typo-catching, not enforcement: a strategy still reads its own
`input.params` with inline guards, and unknown keys are ignored, not rejected.

## How personas choose options

Options reach a strategy's `input.params` from three surfaces, all overridable by the supervisor
per-call:

1. **Author default (static)** — a persona's `council: { strategy, roster, params }` (tool-driven) or
   mandatory `orchestration: { mode, strategy, roster, params }` both carry a `params` map
   (`persona.ts` → `orchestrate.ts`). E.g. `council: { strategy: magi, params: { reflect: false } }`.
2. **Borrowed persona profile (dynamic)** — `council({ persona: "magi", question: … })` resolves that
   installed persona's already-expanded `council:` block. The caller remains active and retains its
   prompt, model, tools, and capability gates; only strategy/roster/params are borrowed. An unknown
   persona or one without a usable council is a hard error, never a silent MAGI fallback.
3. **Supervisor override (dynamic)** — the `council` tool accepts a per-call `strategy`, `roster`, and
   `params`; the params **merge OVER** the selected (or active) persona's (`extension.ts`), so the LLM can pick
   `{ aggregate: "unanimity" }` for one invocation, or switch strategy entirely
   (`council({ strategy: "debate", … })`), without editing the persona.
4. **Preset (reusable bundle)** — `council: { preset: <name> }` expands `presets/<name>.preset.json`
   into `{ strategy, roster, params }`; authored fields win, params merge (`expandCouncilPreset`).

The mandatory `orchestration:` path fires pre-turn on the raw user text, so it takes no dynamic
per-call params (author params are threaded intact) — that is the difference between the two modes:
`council:` is convened on demand and fully overridable; `orchestration:` runs the shape automatically.

## Adding a strategy

1. `src/orchestration/strategies/<name>.ts` — export a `Strategy` composing `agent`/`parallel`/
   `reduce.*`. Declare `params` if it reads any. Inject any per-member protocol via the TASK text.
2. Register it in `strategy.ts` `BUILTINS`.
3. Add a unit test on a stub engine (assert the spec it builds, not a live model).
4. If it needs a new comm/engine capability rather than composing existing primitives, that is a core
   change — read [ARCHITECTURE.md](ARCHITECTURE.md) first (the SDK is the seam; keep it clean).
