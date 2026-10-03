# Strategies — the orchestration layer

See [`docs/README.md`](./README.md) for the canonical doc map.

How a roster of sub-agents is coordinated. A **strategy** is a small TypeScript file composing the
**Strategy SDK**; a **persona** decides whether and how one runs. This document is the contributor's
deep dive: the SDK contract, every built-in's mechanism and params, the bias-guard invariants you
must not break, the param schema, and how personas select options. For the user-facing catalog and
copy-paste recipes see [`REFERENCE.md`](./REFERENCE.md); for the system design see
[ARCHITECTURE.md](ARCHITECTURE.md).

## The Strategy SDK

A strategy is `{ name, params?, run(input, sdk) }` (`src/orchestration/sdk.ts`). `run` receives the
task/roster/params and a constrained `sdk`; it returns one `AgentResult`. The engine is injected, so
a strategy is backend-agnostic and unit-testable against a stub engine.

| Primitive | Contract |
|---|---|
| `sdk.agent(spec)` | Run ONE sub-agent → `AgentResult`. `spec`: `{ agent, task, model?, tools?, skills?, role?, outputContract?, isolation?, mcp?, timeoutMs?, peers? }`. |
| `sdk.parallel(thunks, {concurrency?})` | Run many at once, capped at `limits.maxConcurrency`. The basis of every fan-out (`parallel(items.map(…))`). |
| `sdk.reduce.aggregate(results)` | Concatenate N results into one (fan-out's merge). |
| `sdk.reduce.vote(candidates, opts)` | Tally the candidates' OWN votes → a `ReducerResult` (`voting.ts`). |
| `sdk.reduce.judge(candidates, order?)` | Anonymise + reorder N candidates into a ballot for an impartial judge; `pick(label)` maps the verdict back. |
| `sdk.roster.team(name)` | The members of a named team (bare names or inline `{ agent, role, model, skills }` specs). |
| `sdk.signal` · `sdk.limits` · `sdk.log` | Cooperative abort · admission/runtime limits · a progress line. |
| series & loops | Plain `await` / `for` — a strategy is TypeScript, so `pipeline` and `critic-loop` are just native control flow. |

Run limits (`RUN_LIMITS`) are enforced inside `makeSDK` regardless of how a strategy calls `agent()`:
`maxChildren`, `maxConcurrency`, `budgetTokens`, `timeoutMs` (idle window). Model recovery attempts
consume child slots and usage too; they are not free legs hidden outside these limits. Nesting depth is not a
numeric knob on this list — it is structurally 1: a spawned child's whole pi-persona extension
disables itself under `PI_PERSONA_DISABLE=1`, so it has no `delegate`/`council`/`orchestrate`/`flow`
tool to call however a strategy or persona tries to nest it (the in-process engine additionally
excludes those tools from the child session directly, as a second line of defense). On top of the
idle window, every agent can also carry an **opt-in hard wall-clock cap** (`PI_PERSONA_AGENT_MAX_MS`,
OFF by default = unlimited) — a lifetime ceiling that, when armed, settles a busy-but-non-converging
worker the idle window never catches. Without that cap, an actively streaming child may continue
indefinitely; the idle watchdog catches silence. Safety comes from these runtime limits plus the
structural depth-1 guarantee, not from sandboxing the strategy (see the I2 invariant in
[ARCHITECTURE.md](ARCHITECTURE.md)).

Optional main-model recovery leaves admission room for queued logical legs and parallel thunks.
`agent(spec, { reserveChildren })` additionally reserves slots for a mandatory later phase;
`judge`, `compete`, and `synthesize` protect their final arbiter/merge this way. `map` reserves the
worker/verifier waves at splitting and the remaining verifier wave during workers; `pipeline`,
`critic-loop`, and `council-rounds` reserve their remaining required steps/rounds. Recovery must not
turn a usable partial panel into a run-fatal child-budget overflow.

Every `agent()` call in one SDK instance shares a concurrency semaphore, including direct
`Promise.all` calls and overlapping `parallel()` batches. A requested batch concurrency may lower
the ceiling, never raise it. Cancellation removes queued legs before they reach an engine.
`budgetTokens` is an admission guard based on completed legs' input/output usage: queued work
rechecks it when a slot opens, but already-running legs may exceed it. It is not a hard streaming
token or billing cap.

## Roster-role ensembles

A team member is a bare agent name OR an inline `{ agent, role, model, skills }` map that specialises
ONE agent (`roster.ts` · `rosterSpec` normalises both). So `review` is one `reviewer` agent run under
three lens roles (SECURITY · PERFORMANCE · TESTS), not three files. Every strategy must run members
through `rosterSpec` to honour the specialisation — **`critic-loop` is the one to watch**: it resolves
`generator`/`critic` to full specs so a role-carrying roster works, while still accepting a bare-name
`params.generator`/`critic` override.

The `council` tool also accepts temporary `members`, with the same member shape. These override the
named roster for that invocation only: no team or persona file is created or changed. An empty or
invalid list is an error, not a request to silently fall back to MAGI. External actors such as
`params.judge`, `params.synthesizer`, `params.generator`, `params.critic`, and `map`'s `params.verify`
accept a bare agent name
or an inline member specification, so the arbiter can have its own role and model too.

Same-agent members are disambiguated in the live `f9` tree by a role hint (`reviewer · SECURITY`) via
`rosterNodeKeys`/`roleHint` (`roster.ts`) + the SDK's per-run key (`sdk.ts`). If you touch either, keep
the seeding loop and the SDK key derivation in lockstep, and inject any per-run protocol via the TASK
text, never `role` (or the derived tree key drifts from the seeded one).

## The built-in strategies

| Strategy | Mechanism | Params (default) | Comm/engine features |
|---|---|---|---|
| `fanout` | Every roster agent on the same task in parallel, then `aggregate`. | — | roster-role |
| `pipeline` | Roster in SEQUENCE, each builds on the prior output; answer = last step. | — | roster-role |
| `map` | A splitter breaks the task into a runtime list; a worker runs once per item in parallel, then `aggregate`. | `maxItems` (default AND ceiling: maxChildren − 1, the splitter takes a slot; a larger value is clamped and the drop is noted in the output), `peers` (false), `ownership` ("off" — "off"/"declare"/"enforce": ignore, record, or gate on the splitter's per-item `writeSet`; always exposed as `structured.items`, a per-item status ledger), `verify` ("" — agent that re-checks each COMPLETED item read-only; one extra child per completed item, empty = off) | roster-role, opt-in peers |
| `critic-loop` | Generator proposes, critic attacks; `reject`/`revise` triggers another draft, and only explicit `approve` succeeds. Exhaustion fails closed with the last reviewed draft + unresolved critique (never an unreviewed tail revision). | `generator` (roster[0]), `critic` (roster[1]), `rounds` (positive integer, 3) | roster-role, `outputContract` |
| `magi` | Parallel INDEPENDENT votes from distinct-persona cores → majority/unanimity, tally + minority report; one anonymised reflection round by default. | `aggregate` ("majority"), `reflect` (true) | vote reducer |
| `council-rounds` | Multi-round `magi`, best-of-X: the whole roster re-deliberates carrying the debate forward until a supermajority, else best-by-confidence on the last round. | `rounds` (3), `bestOf` (majority), `aggregate` ("majority") | vote reducer |
| `debate` | 2+ members work the same task in parallel and exchange positions LIVE via `contact_peer`, then a majority vote settles it. | `bestOf` (majority), `aggregate` ("majority") | **peers always**, vote reducer |
| `judge` | A panel answers in parallel; one impartial arbiter picks on an anonymised, shuffled ballot. Only a successful arbiter result can select a winner; partial structured output from a failed/aborted arbiter fails closed. | `judge` (required), `contract` (none) | judge reducer |
| `synthesize` | Parallel gatherers → one synthesiser merges the labeled findings into a single coherent answer (the "reduce" `fanout` lacks). | `synthesizer` (roster[0]), `peers` (false) | roster-role, opt-in peers |
| `pair` | A driver executes while a navigator inspects the same ground live (risk checklist up front, corrections per milestone, final review attached). | — | **peers always** (both legs) |
| `compete` | N competitors implement the same task in ISOLATED git worktrees; a successful blind judge picks; the winner is returned as a unified diff for the SUPERVISOR to apply. If judging fails, every valid diff is returned unjudged and the strategy fails closed. | `judge` (required), `ballotDiffChars` (6000) | **`isolation: worktree`**, judge reducer |

`fanout`, `pipeline`, `pair` read no params and omit the schema.

`map`'s `verify` is the one mechanism here with a measured multi-agent gain in the literature: a
single read-only review pass per completed unit of work, not swarm autonomy for its own sake. It
runs one extra child per COMPLETED item (a failed item has nothing to re-check), through the same
`sdk.parallel` wave as the workers, so `maxChildren`/`maxConcurrency`/`budgetTokens` still bound it
— sizing `maxItems` with headroom for roughly double the child count is the caller's job when
`verify` is set. It pays for a batch where a wrong answer is expensive and hard to eyeball after
the fact (security-sensitive edits, long-tail correctness); it costs more than it is worth for a
low-risk sweep a supervisor can spot-check itself. A verifier's stance is read via the SAME
`outputContract: "default"` machinery `critic-loop` uses for its critic (`structured.stance`):
`"approve"` passes, anything else — an explicit reject/revise, a missing stance, or a verifier leg
that itself failed to run — flips that item's `structured.items` ledger entry to `status: "failed"`
(`failureKind: "verification"` for an actual negative verdict; the verifier's own `failureKind` when
its leg couldn't run at all).

Every strategy that runs more than one round or step (`council-rounds`, `debate`, `magi`,
`critic-loop`, `pipeline`) stops at its own round/step boundary when the run is cancelled: an aborted
run must not keep convening rosters nobody will read. A cancelled result comes back `ok: false` with
`failureKind: "abort"` (and a `cancelled`/`status: "cancelled"` marker), so a journal or supervisor
records it as CANCELLED rather than as a deliberation that completed without a ruling, and the work
already paid for (the last good draft / the upstream step's output) rides along in `output`.

**A strategy must check BOTH forms of the abort, and the leg form is the load-bearing one.** The run's
`AbortSignal` reaches a strategy along two paths, and both are live: the ENGINE (`buildEngine(signal)`,
so a leg already running settles) and the SDK (`extension.ts` passes `signal:` to `runPersonaStrategy`
for both the `council` and the `flow` tool → `SDKDeps.signal` → `sdk.signal`). So `sdk.signal?.aborted`
is a real early-out, not a dead branch — check it before convening another roster.

It is not sufficient on its own, for two reasons. A strategy can be run with no signal at all (any
caller that omits `signal:` still gets an engine-level abort through its legs), and `sdk.signal` is
only READ at your boundaries — a stop that lands mid-round is invisible to it until the boundary after
next, while it is already visible in the legs that just came back. Legs settle, they do not throw:
check them too (`every`/`some` on `failureKind === "abort"` at the boundary you just crossed).

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
- **A broken MODEL recovers only on the main model.** All strategies use the same SDK rule:
  `failureKind: "provider"` or `"unknown-model"` permits ONE recovery attempt on the supervisor's
  current model. This is explicitly authorized even when the initial member model was pinned or
  saved earlier. It never borrows a peer's model or searches arbitrary providers, and skips recovery
  when the main model is absent, already failed on that leg, or cannot fit the remaining child/token
  budget. Other failures (`abort`, `timeout`, `contract`, agent/infrastructure errors) are terminal;
  a stopped child never restarts. Strategy/flow engine construction disables the ordinary provider
  reroute decorator so this is the first and only model switch. Every attempt contributes its usage
  and child count; recovery is reported through `modelRecovery` and a visible warning. MAGI discloses
  recovered cores in its ruling and keeps the recovered model during reflection rather than sending
  a core back to its broken assignment. Recovery is a degraded-mode safeguard, not a preference:
  sharing the main model can reduce reasoner diversity.
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
{ type: "string" | "number" | "boolean" | "agent"; default?; rosterIndex?; inheritRoster?; doc }`.
Agent-valued defaults name real agents; `rosterIndex` identifies an omitted selector's roster default,
and `inheritRoster` preserves a named selector's roster specialization where that strategy uses it.
Picker preflight reads these declarations instead of guessing participants from prose. `knownParams(name)`
(`strategy.ts`) exposes them. Two consumers:

- The **`council` tool** warns (via `ui.notify`, never hard-fails — I2 lenient) when a call passes a
  key the active strategy doesn't declare, e.g. `ignoring unknown param "reflct" for magi (known:
  reflect, aggregate)`. A correct call is behaviourally unchanged.
- **`/doctor`** lists each strategy's params live, so the schema is discoverable and this canonical
  table can't drift from the code.

The schema is for discovery and typo-catching, not enforcement: a strategy still reads its own
`input.params` with inline guards, and unknown keys are ignored, not rejected.

## How personas choose options

Options reach a strategy's `input.params` from four surfaces, all overridable by the supervisor
per-call:

1. **Author default (static)** — a persona's `council: { strategy, roster, params }` (tool-driven) or
   mandatory `orchestration: { mode, strategy, roster, params }` both carry a `params` map
   (`persona.ts` → `orchestrate.ts`). E.g. `council: { strategy: magi, params: { reflect: false } }`.
2. **Borrowed persona profile (dynamic)** — `council({ persona: "magi", question: … })` resolves that
   installed persona's already-expanded `council:` block. The caller remains active and retains its
   prompt, model, tools, and capability gates; only strategy/roster/params are borrowed. An unknown
   persona or one without a usable council is a hard error, never a silent MAGI fallback.
3. **Supervisor override (dynamic)** — the `council` tool accepts a per-call `strategy`, named
   `roster`, temporary `members`, and `params`. Params merge over the selected (or active) profile when the strategy stays the same.
   Switching strategy starts from that strategy's own defaults; only explicitly supplied per-call
   params carry across the switch. For example, `{ aggregate: "unanimity" }` overrides the active
   strategy for one invocation, while `council({ strategy: "debate", … })` does not inherit unrelated
   profile params. Explicit unknown keys still produce a warning (leniently ignored), never a hard
   failure.
4. **Preset (reusable bundle)** — `council: { preset: <name> }` expands `presets/<name>.preset.json`
   into `{ strategy, roster, params }`; authored fields win, params merge (`expandCouncilPreset`).
   Strategy/roster names are trimmed, and only those three preset fields are copied. Inline `members`
   belong in the persona's validated council declaration or the tool call, not in preset JSON.

The mandatory `orchestration:` path fires pre-turn on the raw user text, so it takes no dynamic
per-call params (author params are threaded intact) — that is the difference between the two modes:
`council:` is convened on demand and fully overridable; `orchestration:` runs the shape automatically.
Its runtime status survives the hand-off into the supervisor turn: only `ok:true` is presented as a
ruling. A failed, cancelled, or unresolved run is visibly labelled as such, keeps its fenced evidence,
and must be repaired/re-verified rather than being laundered into a completion claim.

## Adding a strategy

1. `src/orchestration/strategies/<name>.ts` — export a `Strategy` composing `agent`/`parallel`/
   `reduce.*`. Declare `params` if it reads any. Inject any per-member protocol via the TASK text.
2. Register it in `strategy.ts` `BUILTINS`.
3. Add a unit test on a stub engine (assert the spec it builds, not a live model).
4. If it needs a new comm/engine capability rather than composing existing primitives, that is a core
   change — read [ARCHITECTURE.md](ARCHITECTURE.md) first (the SDK is the seam; keep it clean).
