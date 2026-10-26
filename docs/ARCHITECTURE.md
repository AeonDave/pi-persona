# Architecture

See [`docs/README.md`](./README.md) for the canonical doc set index.

The design contract for pi-persona — the model, the binding invariants, the module map, and the
runtime seams. This is the **canonical design reference**: on any conflict, this document and the
invariants below win. For the user guide see the [README](../README.md); for the orchestration layer
in depth see [STRATEGIES.md](STRATEGIES.md); for the contributor quick-reference (commands,
conventions, gotchas) see [AGENTS.md](../AGENTS.md).

pi-persona is a single Pi coding-agent extension (`@earendil-works/pi-*`, loaded via tsx/jiti — no
build step) for **supervised multi-agent orchestration**: async workers, live steering, cross-session
collaboration, and switchable personas. It fuses three concerns — delegation/engine, coordination/bus,
persona/identity — into one cohesive, cross-OS, data-driven codebase.

## The model

| Thing | Is | Lives in |
|---|---|---|
| **Persona** | the control surface: a supervisor identity (system-prompt body) + how it orchestrates | `personas/*.md` (`persona: true`) |
| **Agent** | a unit of work that gets spawned (prompt + model + enforced tool allow/deny); does not orchestrate | `agents/*.md` |
| **Strategy** | an execution shape (vote, loop, fan-out) authored as code on the SDK | `src/orchestration/strategies/*.ts` |
| **Flow** | a declarative DAG that composes strategies into phases with `needs` edges + gates | `flows/*.flow.json` |
| **Team** | a named roster of agents a strategy runs over | `teams.yaml` |
| **Contract** | the structured shape a sub-agent returns, so votes/judges tally | `contracts/*.contract.json` |

A persona binds to an orchestration mode → which selects a built-in shape or a strategy/flow → which
runs over a roster of agents → lowering to engine primitives + deterministic JS reducers. A persona
file *is* an agent file with `persona: true` plus the orchestration grammar; one frontmatter engine
parses both.

Persona names are data, never dispatch keys. Optional `delegation:` fields apply generic gates to any
builtin, user, or project persona: `requireBrief`, `outputContract`, `requireDisjointWrites`,
`requireFreshVerification`, and `verificationAgents`. Council behavior remains independently
declarative through `council: { strategy, roster, params }`; a custom persona can compose any installed
strategy/team without a core change. Ownership intent follows the agent, not the caller: an agent definition
can declare the area it alone writes (`writeSet`, e.g. `research` → `.research/`), and a write-capable delegate leg that
names no `writeSet` inherits it before the gates run, so the disjoint-ownership and overlap checks see a
declared owner; a leg's own set wins, and the field stays declarative (nothing enforces paths at runtime).
Legs restricted to read-only tools do not inherit ownership defaults, so parallel readers do not conflict.
The gates use effective agent/tool capabilities, conservatively
treat shell-capable, MCP-enabled, or unknown tools as potential writers, and enforce the requested fan-out
concurrency on the single launch path (interactive background or headless inline). A serialized verifier is accepted only
after every material writer in that batch; otherwise the call fails before a child starts. The rule
also holds ACROSS calls: a verifier launched while a material-writer background run is still live is
rejected, naming the mutating run ids, so a later call cannot slip past the in-batch ordering.

### The effort ladder (make the simple case simple; complexity is opt-in)

- **L0 — prompt-driven.** Just the persona body + the `delegate` tool, no orchestration block. The
  supervisor LLM fans out by its own judgement ("research X, Y, Z" → one sub-agent per item). Absent
  an orchestration block ⇒ pure L0.
- **L1 — declarative shape.** A persona `orchestration: { mode: parallel|pipeline, roster }` (or the
  `council:` tool form) runs a built-in strategy deterministically.
  A caller may borrow another installed persona's declared council with `council({ persona: "name" })`;
  this resolves configuration only and never activates or inherits authority from the target persona.
- **L2 — strategy file.** `src/orchestration/strategies/<name>.ts` on the Strategy SDK drives a
  richer shape (magi vote, critic loop, debate).
- **L3 — flow file.** `flows/<name>.flow.json` composes strategies into a resumable DAG.

You climb only when you want determinism, structure, or reuse. Nothing forces the higher tiers.
The `council` tool is a gateway to all installed strategies, not a universal instruction to vote on
routine work. Choose a strategy when its topology adds value; MAGI and Judge retain their specialized
persona focus. The tool description lists every strategy with its `when`, positional roster and required
params, generated from the registry (`strategyCatalog`), and a call missing a required param is refused
before any run exists. A caller can supply ephemeral `members` with inline roles/models/skills instead of a
named team, without persisting a team or switching personas.

## Binding invariants (I1–I7)

These are the guardrails a contributor must not violate. They are enforced in code, not by convention.

- **I1 — Child-process is the correctness baseline.** `ChildProcessEngine` (`engine/child.ts`, spawns
  `pi --mode json -p`) is the reference backend; `InProcessEngine` (`engine/inproc.ts`,
  `createAgentSession`) is the runtime **default** but a swappable optimization behind the
  `StrategyEngine` seam. Behavior must hold on the child backend first; worktree isolation always uses
  the child engine. Opt to the baseline with `PI_PERSONA_ENGINE=child`.
- **I2 — Strategies are trusted project code, NOT a security sandbox.** Gated by Pi project-trust; the
  SDK is a constrained API *by convention*. Safety comes from **runtime limits, not isolation**:
  `RUN_LIMITS` (`maxChildren`, `maxConcurrency`, `budgetTokens`, `timeoutMs` idle window) are enforced
  by the SDK on every `agent()` call and by the engine per child. Concurrency is shared across all
  calls in one SDK instance; token admission uses completed usage and is rechecked after queueing, so
  active legs can overshoot it. Nesting depth is not one of these numeric knobs — it is structural,
  capped at 1: full pi-persona activation short-circuits under `PI_PERSONA_DISABLE=1` (the
  **fork-bomb guard**), so no supervisor orchestration tools (`delegate`/`council`/`flow`) are
  registered. A broker-enabled child instead loads the minimal bridge, which registers only
  granted communication and scoped result-reader tools. On the child engine this is a one-shot env var
  set on each spawned process; the in-process engine instead shares one Node process across
  concurrently-building sub-sessions, so it ref-counts the guard (`inproc.ts`) to keep it set until the
  LAST one finishes. The in-process engine also excludes `ORCHESTRATION_TOOLS` from the child session
  directly (`engine/inproc.ts`) as a
  second line of defense, in case anything else ever left the extension active. `PI_PERSONA_LEG=1`
  rides alongside `PI_PERSONA_DISABLE` — a **dedicated** worker-leg marker, distinct from the
  user-settable `PI_PERSONA_DISABLE` kill switch, that a companion extension (e.g. pi-persona-mind)
  reads to tell a real delegated leg from a disabled supervisor. Never claim isolation from
  `fs`/`net`/`process`. The param schema and other convenience checks stay **lenient** (warn, never
  hard-fail) for the same reason.
- **I3 — Per-run pinning.** A run pins `contract@hash` at start; hot-reload affects **new runs only**;
  an active run never changes schema/logic mid-flight. `makeEngine`/`makeInProcessEngine` pin the
  contract on first use and reuse the frozen snapshot for the whole run.
- **I4 — Capabilities enforced at call time, never prompt-only.** Every tool call, delegate, and bus
  action passes one `EffectiveCapabilities` (`core/capabilities.ts`: `tools`, `delegateTargets`,
  `canUseBus`), resolved once on persona activation (deny-wins; `allow` present ⇒ allowlist; absent ⇒
  default-allow). Prompt text is advisory only. Declarative delegation gates are checked before spawn:
  required briefs, contract defaults, parallel write ownership/overlap, and stale concurrent verifier
  topology. Restricting `tools` keeps `delegate` unless explicitly denied; `canUseBus` is OFF only when
  the persona explicitly denies `intercom`.
- **I5 — Flows are the top tier.** A declarative DAG (statically verified: acyclicity, references
  resolve, join reducers valid) above strategies. The flow engine stays thin — parse, verify,
  schedule, persist, resume — and a flow node may call any strategy. Journaled: finished nodes replay
  from disk with no re-spend. A resume matches only the same flow, the same task and the same project
  (`flowRunHash` = flow + task + cwd); another task starts from scratch. A `gate: true` phase shows its
  output and its dependents to the operator; a rejection returns `stoppedAtGate` (not a failure, though
  `ok` stays false so mandatory orchestration still fails closed).
- **I6 — Spawning is opportunistic by default; mandatory only when the persona declares it.** Two
  first-class cases: *opportunistic* (`mode: solo` / no block — the supervisor MAY delegate by its own
  judgement; never forced) and *mandatory* (`mode: strategy|flow|parallel|pipeline` with a roster —
  the engine runs the shape; the LLM can't opt out, only do its part). A persona picks exactly one.
  Mandatory hand-off preserves runtime status: only `ok:true` becomes a ruling; failure/cancellation
  remains visibly unresolved and its fenced output is evidence, never an implicit success.
- **I7 — Adoption is a success criterion.** The opportunistic path must be *engineered to actually
  fire* — under-delegation is the explicit failure to avoid. The `delegate` tool description is
  compelling and model-agnostic; opportunistic persona bodies coach delegation with concrete
  heuristics; success is measured by delegations actually happening, not by the capability existing.

## Design decisions (D1–D7)

- **D1 — One engine interface, two backends.** The `StrategyEngine` seam makes strategies
  backend-agnostic; the concrete backend is an optimization/isolation choice (see I1).
- **D2 — One shared `core`.** A single frontmatter/YAML parser, one permission engine, one discovery,
  one config, one contract module, one set of env constants. `core/*` is **pure** (no Pi imports) and
  unit-tested — removing a whole class of two-parser / naming-mirror drift bugs.
- **D3 — Three authoring surfaces, data-driven.** `agents/*.md`, `strategies/*.ts` (files on a core
  SDK), `flows/*.flow.json` — all lower to engine primitives + JS reducers. Built-in strategies ship
  **as files** and double as reference examples.
- **D4 — Personas are a thin layer over orchestration.** persona = identity + optional default
  strategy/flow/council + generic delegation policy; the persona file is the control surface. Runtime
  code must not branch on a persona name.
- **D5 — Bias mitigations baked into the reducers.** Anonymise authors, shuffle order, keep-best
  fallback, preserved dissent, invalid-output quarantine — deterministic JS, safe by default (see
  [STRATEGIES.md](STRATEGIES.md#bias-guard-invariants-do-not-fix-these)).
- **D6 — Cross-OS by construction.** In-process avoids IPC entirely; only the opt-in cross-process
  bus needs OS-specific transport (Unix socket vs Windows named pipe), confined to the broker — so no
  fragile per-OS code lives in strategies.
- **D7 — Contracts are schema-defined and hot-editable.** The return contract lives in an editable
  `contracts/*.contract.json`; reducers read fields generically. Add/remove fields without
  recompiling. Hardened by I3 (hot-reload for new runs only). The contract both **instructs and
  validates**: when a spec carries `outputContract`, each engine appends `contractInstructions(def)`
  (the format, derived mechanically from the same pinned def it validates against) to the member's
  task — so ANY agent can be convened by a voting strategy, not just those whose `.md` hand-writes
  the JSON format.

## Module layout

The supported host is the latest stable Pi (currently 1.4.0). Runtime code uses its public APIs
directly; obsolete host facades, ignored SDK options and compatibility-only aliases are removed
with their callers. Genuine host failures remain explicit rather than fabricating session identity
or model availability. One-way user-data migrations and retained-history readers are separate data
contracts: they remain only while serving stored user data, not to support an older Pi runtime.

Domain dependencies remain downward-only and acyclic: `core ← all`; `engine`/`bus → core`;
`orchestration → engine + bus + core`; `persona → orchestration + core`; the Exocom transport and
ledger → `core + bus`; `tools`/`ui → lower layers`. `src/exocom/install.ts` is deliberately the
composition adapter for that feature, colocated with Exocom but allowed to wire extension, persona,
engine, telemetry, UI, and tool surfaces; it is not part of the transport/domain layer.
`src/extension/*` contains extracted factory internals (which must not import `extension.ts`), while
`extension.ts` remains the package entry and composition root (`package.json` `pi.extensions` →
`./src/extension.ts`).

- **`src/agents/`** — the agent definition (`agent.ts`: `AgentConfig`/`parseAgent`, the
  `persona: false` sibling of the persona parser; both share one frontmatter engine).
- **`src/core/`** — pure kernel (no Pi imports, unit-tested): `frontmatter`, `permissions` +
  `capabilities`, `contract` (+`parseContract`), `config`, `discovery`, `seed`, `fence`
  (`fenceUntrusted` / `attributeInbound`), `ownership` (`findWriteSetOverlaps` /
  `validateParallelWriteSets` / `writeSetPathError` — parallel write-set overlap, shared by
  `delegate` and `map`'s `ownership` param), `pi-compat` (`MIN_PI_VERSION`, `installedPiVersion`,
  `satisfiesFloor` — the one place the supported host floor is declared; `package.json`
  `peerDependencies`, `/doctor`'s `pi:` line, and the README's stated floor trace back to this
  constant), `models`, `brief` (`buildDelegationBrief` — the per-turn delegation brief: live roster +
  standing hand-off default; and `buildExocomBrief` — the per-turn peer brief: live peers, the
  peer-vs-sub-agent split, and the relevance bound on an exchange), `nudge` (the
  runtime-reinforcement state machines `DelegationNudge` + `PersistenceNudge`, and the call-time wake
  guards `PollGuard` + `longWaitSeconds`), `display-label`
  (`sanitizeDisplayLabel` — an untrusted name reduced to bounded metadata before interpolation
  outside a fence), `timer` (`TimerScheduler` — the pure alarm engine behind the `timer` tool), `time`
  (`formatDuration` / `peerSentLabel` / `sessionElapsedLabel` / `buildSessionAnchor` — the elapsed-time
  readings and the prompt-cache rule that sets each one's granularity), `types`.
- **`src/engine/`** — "run an agent → `AgentResult`", backend-agnostic: `child.ts`, `inproc.ts`
  (default), `adapter.ts` (child-engine adapter), `fallback.ts` (provider fallback),
  `spec-preflight.ts` (the one unknown-agent/unknown-contract preflight shared by both engines),
  `change-report.ts` (`captureStatus`/`diffStatus`/`renderChangeReport` — the files-changed report
  `src/extension/engine.ts` appends to a non-worktree leg's result; pure over the injected `GitExec`
  from `worktree.ts`), `async.ts` (async tracker / peek), `worktree.ts` (git-worktree isolation),
  `stream.ts` (event → state), `handles.ts` (one bus-handle sequence shared by BOTH engines),
  `signals.ts` (`combineSignals`).
- **`src/orchestration/`** — the heart: `sdk.ts` (the Strategy SDK), `strategy.ts` (registry +
  `knownParams`), `strategies/*.ts`, `voting.ts`, `judge.ts` (anonymise-for-judge), `reducers.ts`,
  `roster.ts` (teams + `rosterSpec`), `flow*.ts` (DAG + JSONL journal + gates), `render.ts`.
- **`src/bus/`** — coordination: `inproc.ts` (handle-based mailbox: send/ask/reply/onMessage),
  `contact.ts` (child `contact_supervisor`), `peers.ts` (child `contact_peer`), `broker/` (cross-process
  relay, on by default: `paths`/`framing`/`messages` pure, `host`/`client` over `node:net`).
- **`src/exocom/`** — the external peer plane (the exocom section below): `plane.ts` (lifecycle —
  bind/join/teardown + reconnect), `activation.ts` (the exact optional-value CLI shim), `codes.ts`
  (persistent four-character alias allocation), `scope.ts` (home identity versus selected scope),
  `registry.ts` (scope-selected presence + stale pruning), `paths.ts` (pure path layout),
  `envelope.ts`/`inbound.ts` (wire format + the pure guardrailed delivery chain: hop cap, dedup,
  budgets, truncation, fence/attribute), `limits.ts` (constants), `guards.ts`
  (`SenderBudget`/`SeenMessages`), `ledger.ts` (scope JSONL work ledger), `untrusted.ts`
  (`untrusted()`/`UNTRUSTED_MAX` — the ONE sanitizer every surface rendering a peer-authored ledger
  field runs first, so a hostile peer's escapes or instruction-shaped text never reach output
  unfenced), `status.ts` (`formatLedgerStatus` — the ownership view `exocom_status`/`/exocom`
  render), `write-guard.ts` (`peerClaimFor`/`writeWarningReason`/`WriteWarnings` — the advisory,
  warn-once-then-allow guard on a `write`/`edit` overlapping a peer's open claim, built on
  `core/ownership.ts`'s path-overlap primitives), `wait.ts`/`gate.ts` (non-blocking join + inbound
  constrained-turn allowlist), `install.ts` (the feature's composition adapter: session-scoped plane +
  ledger + wait/tool/hook wiring).
- **`src/telemetry/`** — a generic, versioned observer/export contract for future plugins: projected
  lifecycle metadata only, never an agent-message router or control surface. See
  [`TELEMETRY.md`](./TELEMETRY.md) for privacy, retention, writer leases, and shutdown behavior.
- **`src/persona/`** — identity: `persona.ts` (parse + `expandCouncilPreset` + `composeSystemPrompt`),
  `controller.ts`, `gating.ts`, `orchestrate.ts`, `config-store.ts` (pure model helpers),
  `settings-store.ts` (canonical preferences, per-persona models and last-selected persona),
  `spine.ts` (the shared behavioral layer's SOURCE resolution — docs/SPINE.md; composition sits in
  `persona.ts` for supervisor turns and in the engines for delegated legs).
- **`src/tools/`** — `delegate.ts`, `intercom.ts`, `exocom.ts` (the `exocom_list`/`exocom_send`
  tools), `exocom-work.ts` (claim/ask/answer/decline/wait/release/progress). **`src/ui/`** — agent tree/overlay, model picker, `wake-rows.ts` (the monitor/timer → tree-row projection), `presentation.ts` (the shared
  card-compaction/sanitization helpers behind the projection rules below), `usage.ts`
  (token/usage formatting, `ChildUsageLedger` / `toToolUsage` — sub-agent spend is
  attached as Pi `toolResult.usage` so the footer and pi-theme-1337's frame count it;
  leftover background-leg cost is published on the `persona-cost` status key).
- **`src/loader.ts`** — the discovery loader (`loadDefinitions`/`loadContracts`/`loadPresets`/
  `loadTeams`), the concrete read-side of the discovery precedence table.
- **`src/bridge.ts`** — the child-mode-only wiring, loaded instead of the full extension when
  `PI_PERSONA_BUS` is set (a broker child).
- **`src/extension.ts`** — the single `ExtensionFactory` (default export `piPersona`): still the
  only file `package.json` `pi.extensions` names. Tools/commands stay registered here; Pi lifecycle,
  prompt composition, the pending-ask tool gate, and engine construction were extracted to
  `src/extension/hooks.ts`, `src/extension/engine.ts`, and leaf helpers in `src/extension/shared.ts`.
  Those modules must not import the factory. Broker host state is declared before `installHooks` so
  shutdown cannot TDZ on `brokerHostPromise`.

## The two engines

Both backends sit behind the `StrategyEngine` seam (`run(spec, onProgress?, signal?, onSteerable?) →
AgentResult`) and enforce three independent deadlines, all classified as `failureKind: "timeout"`
(never a provider reroute): `RUN_LIMITS.timeoutMs`, an **idle window** (no events for that long ⇒
abort); `PI_PERSONA_AGENT_MAX_MS`, an **opt-in hard wall-clock cap** — a lifetime ceiling, armed once
and never reset, that settles a busy-but-non-converging child (a loop that keeps emitting) the idle
window never catches (OFF by default = unlimited, so a healthy child has no lifetime ceiling); and
`PI_PERSONA_AGENT_STARTUP_MS`, a **startup deadline** (default 300000, `0` disables) that kills a
child making ZERO progress — no completed turn, no tokens, no streamed output. It fast-fails the
"never started" case the generous idle window is too slow for — notably a headless `mcp: true` leg
whose `pi-mcp-adapter` hangs on interactive OAuth; the first real progress cancels it.

The idle window and startup deadline stay ARMED for every child, coaching or not — a blind exemption
that once disabled both while a child could legitimately block on a supervisor reply let a genuinely
stalled coaching leg run forever. Instead, when either fires, the source of truth is asked directly:
does this child have a live `decision`/`interview` ask outstanding right now? In-process consults the
bus (`hasPendingAskFrom`); the child-process engine consults the broker through the same shape
(`isBlocked`). A live pending ask re-arms the window; no pending ask means the silence is real and the
leg is killed. The hard wall-clock cap is the one ceiling that still applies unconditionally —
including to a coaching child blocked on a reply — so a supervisor that never answers still has a
backstop.

In-process deadlines and caller cancellation are armed **before session construction**; the bus
consult that re-arms idle/startup only matters after construction, since no ask can be pending before
a session exists. Cancellation settles the run and releases its bus handle; a session returned late is
disposed and a late factory rejection is consumed. Pi's resource loader does not expose forcible
cancellation — the recursive-extension guard stays held until that factory settles, so a loader that
never returns needs a Pi restart (and `PI_PERSONA_ENGINE=child` for process-level termination). Run
settlement does not promise that arbitrary in-process code has physically stopped.

- **InProcessEngine** (default) — a `createAgentSession` per sub-agent: cheaper, shares the host's
  auth/model registry, and **steerable** (inject a live user message into a running sub-agent).
- **ChildProcessEngine** (`PI_PERSONA_ENGINE=child`, the correctness baseline) — spawns `pi --mode
  json -p`, delivering the task over **stdin** (never argv — a flow-phase task would blow Windows'
  ~32 KiB command-line cap). Worktree isolation always uses this engine.

Tool grants have three distinct states on both engines: absent inherits Pi's session defaults, a
non-empty array is an allowlist, and an explicit empty array means no tools (`--no-tools` on the
child backend); denylists apply independently via `excludeTools`/`--exclude-tools`.

A spec naming an agent or output contract that isn't installed fails before anything spawns, on both
backends alike (`engine/spec-preflight.ts`): the message names what IS installed, capped at 12 names.
The `delegate` tool runs its own earlier check with a different cap — `unknownAgentError`/
`unknownContractError` (`src/tools/delegate.ts`) reject a typo before either engine is reached, listing
up to 16 names. Same idea, two layers, two caps — see docs/REFERENCE.md's example.

`isolation: worktree` is fail-closed. It requires a clean Git checkout so the detached `HEAD` view
cannot silently omit staged/unstaged/untracked supervisor work; a non-repository, dirty checkout,
worktree creation failure, or a successful leg with neither a captured diff nor a returned unified
patch fails the leg — the base engine is never invoked against the real tree as a fallback. The
created worktree starts from the committed `HEAD` only: local ignored files are not copied into it,
and untracked ignored outputs are not exported. The original checkout's ignored files remain
untouched; tasks that need local-only inputs must recreate or provide them explicitly. The
worktree's initial commit is pinned before the worker starts. Export compares the final file state
against that immutable commit, so worker commits, later unstaged changes and new files are included
together. The diff is captured before the temporary tree is removed, then returned to the supervisor;
commit history is not applied to the main checkout. If Git cannot capture the diff but the worker
returned a unified patch, that patch is retained with a warning that it was worker-provided and not
verified against the worktree state. Every git call is asynchronous so the extension host keeps
rendering, ticking timers, and serving broker sockets while a large checkout runs.

Transient retries inside one agent session belong to the host **Pi runtime**'s `retry.*` settings, not
a persona contract — pi-persona neither parses retry notation nor schedules its own backoff. Both
backends read the same resolved global agent directory (`PI_CODING_AGENT_DIR` for spawned children).

`buildEngine` wraps the chosen backend with **provider fallback** (`engine/fallback.ts`): a run whose
model's provider fails at call time (auth/outage/5xx/model-not-supported) can retry the same model id
only when the selection was unpinned/default, through the data-driven provider policy for that model
family. A provider-qualified `spec.model` is an explicit pin and stays strict by default. Only
`failureKind === "provider"` reroutes; abort/timeout/contract/unknown/agent are terminal — this
prevents an explicitly selected OpenAI or native Claude leg from silently moving to an unrelated paid
provider. (`"verification"` is a further terminal value that never appears on an `AgentResult` — see
`map`'s `verify` param in [`docs/STRATEGIES.md`](./STRATEGIES.md).)

Strategy/council/flow runs use a different, explicitly authorized recovery policy: the selected model
is tried first without arbitrary provider reroutes, then `makeSDK` may retry a `provider` or
`unknown-model` failure ONCE on the supervisor's current model. This main-only exception also applies
to saved and inline-pinned assignments; ordinary delegate provider pins remain strict. Missing main
models, repeated same-model attempts, stop/timeout/contract/agent/infrastructure failures, and exhausted
child/token budgets do not recover. Both attempts are accounted, and a warning plus result metadata
identify the switch. A per-role model assignment can supplement the legacy per-agent assignment;
preflight model selection includes external arbiters and other declared agent-valued parameters.
Live tree and telemetry labels resolve auxiliary actors and every repeated roster occurrence from
the SDK's exact, immutable attempt identity (`agent`, full `role`, explicit `model` and `thinking`),
alongside its unique node key. Short role hints and `#N` suffixes are presentation only: colliding
hints never discard a known model or borrow another occurrence's inline pins. Model assignments
and agent defaults are copied after setup when the engine is constructed, so a queued leg's display
cannot change with later persona/settings edits. Seeds use each actual roster member; lifecycle
updates use the actual attempt, including custom strategy calls and auxiliary actors in any order.
A recovery keeps the node key, changes its requested model, and clears the preceding attempt's Pi
effort observation. Terminal `modelUsed` and validated effort observations override intent only when
reported; an absent observation retains the current attempt's intent. Initial effort remains the
explicit spec request, never inferred provider cognition. Clearing an unknown model emits an empty
`model` string in a telemetry update, preserving the existing string patch contract without leaving
a stale previous model in consumers.

**Model assignment repair is configuration, not execution recovery.** `/persona models [profile]`
is an explicit user edit in the Pi adapter: it reuses `resolveCouncilInvocation`,
`collectModelParticipants` and the canonical locked settings writer, without adding another roster,
model store or provider-routing policy. The active caller owns saved assignments even when borrowing
another council profile. Automatic discovery stays never-nag; explicit editing may replace saved or
agent defaults, but not inline pins. Host catalog refresh has a 20-second cooperative deadline;
reported cancellation/errors or a caller/session change leave assignments untouched. Selection uses
the refreshed host availability snapshot rather than treating all catalog entries as authenticated.
Cancelled rows preserve their old choices; accepted choices merge without clearing other personas.
Running engines retain their captured assignments. Missing credentials are classified at the engine
adapter boundary; only the SDK decides whether a main-model recovery is admissible. This separation
avoids a global reset or automatic repinning that could silently change billing and panel diversity.

The extension owns the derived candidate cache, keyed by session and base provider/model. Ordinary
turns reuse it; explicit catalog refresh invalidates the initiating key even after partial provider
failure. The settings UI supplies the refresh deadline and reporting, while the extension's refresh
adapter captures the key before awaiting the host. Briefs and nudges share the same callable-`models`
gate. Automatic model setup for tools, commands and mandated orchestration shares the checkpoint
dialog queue; each run registers its stop handle before entering that queue. Aborting setup discards
its unsaved choices and removes only prompt markers created by that attempt, so it can be retried.

**Unified settings.** `/persona-settings` is independent of Pi's `/settings`: full-page TUI, native
RPC dialogs, and a read-only `show` report. `core/settings.ts` is the public preference registry and
validator; the UI and environment precedence consume it rather than maintaining duplicate field lists.
All persistent Persona preferences live in `<agentDir>/persona/settings.json`, version 1: sparse
`preferences`, `personas` model maps and `lastPersona`. `settings-store.ts` owns bounded validated reads,
cross-process locked field patches and atomic replacement. Null removes an exact override; unknown
top-level and per-persona fields survive unrelated edits. Malformed/unsupported files are never
overwritten: activation warns and falls back, while editing fails closed. Fresh read-only inspection
does not materialize defaults.

`selectionRevision` is a non-negative counter updated only by explicit `lastPersona` patches,
including re-selection of the same name. Model/preference saves never advance it. Companion scope
readers must use this semantic marker, not the settings file's mtime, as evidence of a selection gesture.

Legacy `config.json` and `state.json` are imported only if the canonical file is absent, then archived
as exact independent `.migrated` copies after commit. Archive conflicts preserve the original and warn;
an existing canonical file is never reimported. `PI_PERSONA_STATE_FILE` only selects a legacy import
source. No active legacy writer remains. Explicit public environment values retain startup precedence;
internal child/bus guards are not preferences. Definitions, credentials and native Pi settings remain
with their existing owners.

Scalar preferences are activation-scoped: saving marks differences pending until a Pi restart or
Pi's native `/reload`, not `/new`; the panel never reloads automatically. `/persona reload` only refreshes resources.
The Models section selects the assignment owner independently of the viewed council/orchestration
profile, supports exact-key resets and keeps inline pins immutable. It patches the same file and updates
the resolver cache for future runs, never changing an already-running worker. Native compaction is untouched.

Mind/Flow settings use optional synchronous discovery on Pi's public event bus
(`pi-persona:settings:collect:v1`). The owning companion reports its current startup values; the same
central registry validates owner/type and renders only supported fields. Persona alone writes their
preferences in the canonical file; companions independently read their known fields, retaining
standalone operation with no hard runtime dependency on Persona. No collection call performs I/O,
starts services or wakes a model. Flow's desired port and idle grace apply to the next shared-service
startup, never to a daemon other sessions are already using. Skill Optimizer is outside this contract.

### MCP (and other `session_start`-scoped extensions) in sub-agents

**A sub-agent does NOT share the supervisor's MCP session, and an in-process sub-agent gets NO MCP at
all.** MCP servers are provided by a separate extension (`pi-mcp-adapter`), which opens its
connections inside a `session_start` hook:

- The **in-process engine** builds a fresh `createAgentSession` and only calls `session.prompt()` — it
  never fires `session_start` (that requires `AgentSession.bindExtensions`). `pi-mcp-adapter` registers
  its `mcp*`/direct tools at load (they *appear*) but never initializes: calls come back **"MCP not
  initialized"** — the tools are present but dead.
- The **child engine** spawns a real `pi -p`, whose normal startup DOES fire `session_start`, so
  `pi-mcp-adapter` initializes as that child's **own** connection (its own stdio/HTTP clients) — a
  *separate* MCP session that does not see the supervisor's MCP workspace/interactive-shell state.

Firing `session_start` for every in-process sub-agent is deliberately NOT done: it would spin up the
full MCP fleet N times per fan-out, and the adapter's OAuth/UI/consent machinery assumes an interactive
session. There is no cheap way to *share* one live MCP connection across sessions here.

**The `mcp: true` opt-in — a delegable MCP leg.** Because the child engine fires `session_start`, a
sub-agent that needs live MCP tools is routed there: mark the agent `mcp: true` in its frontmatter, or
pass it on a `delegate` task (`AgentRunSpec.mcp`). The engine runs that leg through `childEngineAt(root)`
— the same mechanism `isolation: worktree` uses for MCP, minus the git worktree — connecting to the
SAME servers from `~/.pi/agent/mcp.json`. Cost is one `pi` spawn per leg; for an **HTTP** server it is
just a client reconnect, not an N× stdio fleet spawn.

**Shared state via a server-keyed backend.** The child gets its own MCP session, not the supervisor's
handle — but a server that keys state (workspaces, shells, artifacts) by a **session id passed as a
tool argument** lets a child that reconnects to the same HTTP endpoint AND is handed that session id
operate on the SAME server-side state. Put the session id in the task packet. (A stdio server whose
state lives in-process is genuinely separate — `mcp: true` there gives the leg its own clean session.)

**Guidance.** Default: treat MCP as a **supervisor capability** — do MCP-dependent work up top and
hand sub-agents the resulting **artifacts** to reason over. When a leg must DRIVE MCP itself, delegate
with `mcp: true` and pass the session id. Do not over-restrict such an agent's `tools` allowlist, or
the `mcp*` tools get filtered out.

## The spine — one shared behavioral layer

An optional layer of behavioral baseline (scope discipline, verification, how to treat another
agent's text) that a persona would otherwise restate in its own words. [SPINE.md](SPINE.md) covers
the content and the A/B that gates its default; the architectural shape is:

- **Where it sits.** Between Pi's base prompt and the persona body — the stable, cacheable *prefix*,
  the opposite end of the prompt from the per-turn delegation brief. `composeSystemPrompt(base,
  persona, spine)` (`persona/persona.ts`) is the one supervisor-side composition: a persona-less turn
  still gets base + layer, and a `replace` persona (which drops Pi's base) keeps the layer as its only
  scaffolding.
- **Two texts, two selectors.** The supervisor reads `spine.md`, a delegated leg reads
  `spine.worker.md` — a leg runs headless, so "confirm irreversible actions with the user" would make
  it stall or hand the question back as its deliverable. `PI_PERSONA_SPINE` / `PI_PERSONA_SPINE_LEGS`
  (the legs' selector follows the supervisor's unless set) each take off / on / an explicit path; `on`
  resolves the user dir before the bundled `prompts/`, a path never falls back to another file.
- **Source resolution is pure, composition is per-role.** `persona/spine.ts` answers only *which file,
  if any* — over an injected reader, so the whole precedence table is unit-testable without a disk.
  The legs' text is prepended by each engine (`engine/inproc.ts`, and `--append-system-prompt` on the
  child adapter), so a leg keeps Pi's full base prompt either way.
- **Off by default, opt-out at both ends.** Unset ⇒ every composition above is byte-identical to a
  pre-spine pi-persona. Frontmatter `spine: false` opts a persona or an agent out, and a persona's
  opt-out carries to the legs it spawns. A file that is unreadable, empty, or over `MAX_SPINE_BYTES`
  (64 KiB, refused on its `stat` so the bytes never enter the process) degrades to a warning and no
  layer — a prompt file is never a hard failure.

## Runtime metadata is not a new user request

The supervisor system prompt carries one fixed runtime-context rule, after persona/spine composition
and before the time anchor and live rosters. It applies with no persona, append/replace personas and
`spine: false`: it is protocol guidance, not an activation of the optional behavioral spine. Identity,
skill-prefetch, clock and routine status metadata do not require repeated acknowledgements. Initial
setup and actionable questions still require attention; explicit user questions about metadata are
answered normally. Skill availability alone is not evidence that instructions were loaded or used.

The rule contains no interpolated handle or changing counters, creates no conversation message and
does not redact assistant history. The pre-name identity bootstrap remains actionable and disappears
once naming succeeds. An old session may contain repetitive prose; updating the extension does not
rewrite it. Reload extension code with Pi's `/reload` (when delegated work has settled), not merely
`/persona reload`, which only reloads persona data.

## Time awareness — one rule, three granularities

Pi's base prompt carries no date and no time, so from inside a turn five minutes of work and five
hours look identical. `core/time.ts` renders the three durations that fix that, and the rule that
decides how precise each may be is a **prompt-cache** rule, not a taste one:

- **Tail surfaces are free.** A tool result or a delivered message is written once and never re-sent
  as the cached prefix, so precision costs nothing there. An inbound peer delivery dates itself
  (`[rune] — reply · sent 20m ago`), and every settled leg reports its wall time on every
  tracker-backed path — the done/failed/stopped report, `intercom result`, and each
  settled line of a peek digest; a running line ends its turns/tokens parenthesis with
  `· running for <duration>` (not shown while queued).
- **The system prompt is not.** It is re-composed and re-sent every turn and IS the cached prefix,
  so a minute-granular value there rewrites it every minute and throws away the provider's cache of
  everything before it. The **session anchor** therefore reads on a deliberately coarse ladder —
  one bucket for the first quarter hour, then quarter hours, then whole hours, then days — which
  steps 27 times in a full day where a minute-granular label would step 1440. `pi-persona-mind`
  makes the same trade one scale coarser for the same reason.

The anchor answers *"how long have I been on this problem"* rather than *"what turn is this"*
because it reads pi's `SessionHeader.timestamp` — the first entry of the append-only session file.
That is what makes it survive **compaction** (the system prompt is re-sent, never summarized) and
**restart** (`/resume` re-reads the original start, not the resume time). Branching mints a new
session file, so the reading restarts there — correctly: the line claims the life of *this* session.

Both readings state an elapsed time as fact, so both refuse the inputs that would make that a lie.
A timestamp is accepted only when it names exactly one moment — `Date.parse` reads a zone-less
date-time as the *receiver's* local time, so two peers would print two different ages for the same
frame — and only when it is plausible: a peer age outside a 30-day window, or a session start in
the future or older than a year, is corruption rather than a long wait, and degrades to an honest
label or to no anchor at all. A peer's timestamp stays a peer's claim; bounding the window narrows
what it can assert, it does not authenticate it.

## The three communication planes

Three planes with **disjoint vocabularies** — a concept name lives in exactly one, so "progress" is
never simultaneously a telemetry event, a routed message, and a UI source of truth.

- **EngineEvent** — runtime lifecycle/telemetry (`started · token · tool_call · completed · failed ·
  usage`). Feeds derived UI; never routed as an agent message.
- **Bus Msg** — semantic agent↔agent communication (`progress · decision · interview`, and sibling
  peer sends). `src/bus`. `progress_update` is a Bus message only, not an EngineEvent.
- **ProgressView** — a derived, read-only UI view computed from observed runtime lifecycles:
  EngineEvents, wake-source lifecycles, or the bounded local companion lifecycle below. Never a
  source of truth. The `f9` agent tree and `peek` digest are ProgressViews.

Steering is a supervisor-to-child control action, distinct from semantic Bus messages; requesting
steering does not establish that a blocking headless delegate call has been interrupted. The peek digest is
always a read-only ProgressView.

External telemetry is not a fourth communication plane: it is a generic observer/export contract that
future plugins may consume or produce, not an exclusive pi-persona protocol. It observes projected
events and cannot route, reply, steer, or otherwise control agents.

### Loaded companions and local activity

The local EventBus request `pi-persona:companion:v1` accepts `{ version: 1, respond }` and calls
`respond` synchronously with `{ version: 1, provider: "pi-persona", role, capabilities }`.
`role` is `supervisor`, `leg`, or `disabled`; `capabilities.memory` is `1` for a loaded supervisor or
delegated leg and `false` for a disabled supervisor. `capabilities.activity` is `1` only for an enabled
supervisor. Persona registers this responder before its bridge and disable guards. Pi owns the
subscription lifetime and revokes it on disposal/reload. Companions query the loaded extension;
settings files, package installation, and environment flags cannot establish its presence. This is
a cooperative local extension contract, not authentication or an OS permission boundary. The
contract is available from Persona 1.17.5, paired with Mind 0.8.4 or later; qualify both together.

Memory ownership is queried through `pi-persona:memory-owner:v1` with
`{ version: 1, sessionId, respond }`. Its synchronous response is
`{ version: 1, provider: "pi-persona", sessionId, ready, persona }`, where `persona` is the actual
live selection or `null` for Persona off. The native manager/id/file must still match, and `ready`
remains false until Persona's session startup finishes. `pi-persona:memory-owner-changed:v1`
broadcasts that same descriptor on readiness, selection and shutdown. A companion loaded first
must not wait inside its startup hook for a later extension's hook; it can activate on the readiness
broadcast or its next fresh query. Canonical settings retain startup preferences, not live ownership:
`persist: false` selections still change this descriptor. Unavailable ownership never authorizes a
fallback to another persona's saved selection.

Each engine freezes the parent's memory persona when it is built. In-process children receive a
private ResourceLoader factory and their own native manager/EventBus responder; child processes
receive the versioned `PI_PERSONA_MEMORY_PERSONA` record only in that spawn's environment. Inherited
values are scrubbed before spawning. Neither route mutates a shared process-wide persona value.
Delegated legs expose this frozen owner while retaining their lean memory-only role, including an
explicit `null` owner when the parent had Persona off.

`pi-persona:activity:v1` contributes operator-only local-work rows through a closed record:
`{ version: 1, producerId: "pi-persona-mind", activityId, sessionId, phase, state, target }`.
`phase` is `inspect|stage|apply`, `state` is `running|staged|done|failed`, and `target` is
`project|persona|shared`; `staged` is valid only for `stage`. No memory text, paths, models, token
counts, or free-form output are accepted. Ingress matches the active native session and checks its
manager's current id/file. The producer also captures its native owner and scope across awaits.
The resulting `Mind` row uses `kind: "activity"`: it has no agent count, steer/stop handle, wake,
stall badge, or `agent.*` telemetry. The F9 drill-in explains the local phase. Up to eight rows are
retained, with completed/staged rows evicted before live work; teardown and explicit persona
selection revoke old rows without cancelling workers. A staged row states that a proposal was
prepared and requires explicit apply; it does not claim that the plan remains valid indefinitely or
that model review is running.
Receipts remain in Mind's session-native cards; local activity events are not replayed on restart.

Mind may request one real async maintenance worker through `pi-persona:mind-worker:v1` with
the closed record `{ version: 1, sessionId, persona, task, respond }` (task at most 48,000 characters).
Persona checks the current native session and ready memory owner, actual persona, delegation and
memory permissions, the persona's raw delegate target rules for `mind`, and idle/no-pending-message
state. A strict target allowlist must include `mind`; explicit memory/delegate/target denies win.
No installed agent is required. Accepted
responses are synchronous `{ ok: true, runId, model, thinking, completion, cancel }`; rejection is
`{ ok: false, reason }`. `completion` resolves with `{ ok, output, error?, resultRef?, model?, thinking? }`.
Output remains untrusted data for Mind's bounded proposal parser, never executable code.

This is an ordinary tracked `Mind` sub-agent in the tree and F9, sharing the launch pool, usage,
progress, stop/steer controls and terminal-result archive. Its private definition has an explicit empty
tool allowlist and no worker spine. Provider/model and thinking are pinned to the accepting session;
provider fallback is disabled. The worker has a 180-second cancellation ceiling; owner readiness or
selection changes cancel it. Mind can also cancel through its accepted handle. Settlement returns
to the requesting companion and retains operator failure reporting, but never wakes a supervisor
model turn. Native session teardown cancels it through the ordinary stop registry. Local inspect,
stage and apply operations continue to use activity rows; model work uses the real agent view.

## The comm plane in practice

- **In-process bus** (`bus/inproc.ts`) — a handle-based mailbox: `send` (one-way), `ask` (blocks for a
  reply), `reply`, `onMessage`. `contact_supervisor` (child→supervisor, gated by `canUseBus` and,
  for in-process children, `coaching: on`) and
  `contact_peer` (sibling→sibling) are the child-side tools bound onto it. Each unread inbox holds at
  most 200 messages; overflow evicts an old one-way note first, and an inbox full of live asks rejects
  new delivery rather than stranding a sender. Ask settlement (reply, timeout, abort, departure, or
  failed delivery) releases its timer/listener and unread entry; a previously retained question stays
  readable with `expectsReply: false`, so old questions never advertise an active reply id.
  Supervisor `intercom send` requires the exact bus handle from `list`, independently of runtime
  run IDs and displayed names. Its diagnostics distinguish an absent recipient from rejected inbox
  admission; a full inbox does not unregister its recipient or settle an existing question.
  Tool outcomes distinguish `answered` from unavailable, timed-out, cancelled and failed requests;
  delivery evidence is never approval. Headless questions remain nonblocking and unresolved, allowing
  only independent already-authorized work or a blocked/partial handoff. Pre-aborted calls perform no
  bus action, and replies racing cancellation are not reported as answers.
- **Sibling peer comm** — a strategy opts a run in via `AgentRunSpec.peers` (gated by `canUseBus`). The
  child gets `contact_peer` (`list`/`send`, ONE-WAY so peers can never deadlock; per-engine-instance
  scoping; a 20-send budget and an 8,000-character body limit, enforced before consuming a send). The
  engine's **delivery bridge** steers incoming bus messages into the child session, fenced with the
  sender attributed OUTSIDE the fence (`attributeInbound`, shared by both engines so the anti-spoofing
  format can't drift) — the same bridge delivers the supervisor's `intercom send`. `debate`/`pair`
  always use peers; `map`/`synthesize` opt in via `params.peers`; `magi`/`judge`/`fanout`/`compete`/
  `council-rounds` stay peer-less by design (independence is a bias guard — see
  [STRATEGIES.md](STRATEGIES.md#bias-guard-invariants-do-not-fix-these)).
- **Cross-process broker** (on by default; `PI_PERSONA_BROKER=off` restores pre-broker spawn;
  `bus/broker/`) — gives child-process runs, every `isolation: worktree` leg, and every `mcp: true` leg
  the same comm plane and **steer** the in-process ones have. It is a session-scoped (POSIX socket /
  Windows named pipe under the session id), supervisor-hosted relay into the local `InProcessBus`: a
  connected child is indistinguishable from an in-process one, so the supervisor side (intercom, idle
  notifier, f9, peek) is unchanged by construction. Off ⇒ the host never starts and the child spawns
  byte-identical to pre-broker pi-persona. Ask failures echo the originating `msgId` so the client
  rejects the right request immediately, and a client cancellation propagates only to that connection's
  own host ask. A one-way send gets a UUID-correlated host receipt; `delivered: true` means admitted
  to the bus, not read or acted on by the peer. Each child is limited to 64 pending receipts with a
  maximum 10-second wait. Abort, disconnect, a full or missing inbox, or a lost receipt reports
  `delivered: false`. It never waits for a recipient answer or approval and does not replay.
  `extension/broker-host.ts`'s `SupervisorBroker` owns the lifecycle: it starts
  the host lazily on the first child-engine build and warns once on a failed bind. Children built while
  it's down spawn without a bus endpoint, so they never burn connect backoff against a dead socket;
  the next build retries; `/doctor` surfaces its state on one line. A dropped client connection flips the
  child-side bridge to `⇄ offline` and fails a fresh ask fast rather than hanging.
  A connected child exposes `contact_supervisor` when `canUseBus` is allowed; `contact_peer` also
  requires the run's peer opt-in. Granted custom tool names join a nonempty plain allowlist so Pi's
  host filter does not hide them. Explicit `tools: []` and exclusions remain restrictive. A denied
  semantic bus does not remove supervisor runtime steering or an independently scoped result reader.

### Presentation is a projection, not another comm plane

The semantic payload and its human presentation have different lifetimes. A result remains complete
for the supervisor and for explicit retrieval; the default TUI projection is deliberately small:

- async completions are coalesced and bounded fairly across legs; `intercom { action: "result", to:
  "<run-id>" }` retrieves one retained result in full and consumes a still-pending duplicate
  notification;
- drained bus messages have a separate session-local retention window: at most 256 messages and
  256,000 body characters across the bus, FIFO eviction. `intercom { action: "message", messageId:
  "<message-id>" }` retrieves a retained message; it never interprets a message id as a run id.
  Oversized or evicted messages return an unavailable diagnostic — retention is not durable evidence
  storage;
- collapsed delegate/intercom/council/flow cards show state, identity, a short sanitized preview, and
  Pi's expand-key hint, each surfacing failure at the top in its own shape: the delegate card
  names each failed leg on its own line, and a failed council/flow card leads with the cause in its title;
- async launch cards and targeted Intercom call headers use the worker's canonical alias/model,
  matching the tree rather than promoting its routing ID to display identity. Launch/control receipts
  persist identity snapshots for history rendering; aliases never become routing keys. Colliding
  aliases carry a secondary ID, and legacy receipts without a recoverable name retain their ID fallback.
  Accepted steering receipts retain the exact sent message: collapsed cards preview it, expansion
  shows all sanitized text and the diagnostic ID. A queued receipt does not prove the worker acted;
- async failures append a `pi-persona-run-failure` entry in TUI mode, with alias, agent/model,
  elapsed time and a concise cause. The entry stores the original diagnostic for expanded history
  rendering; it is operator-only and adds no model context or wake. Other modes, or an append
  failure, retain a bounded notification. The semantic completion follows its existing single-wake path;
- follow-up cards (`pi-persona`, exocom) retain their complete semantic content but render a bounded
  preview until expanded; terminal escape/control sequences are removed from the visible projection;
- custom follow-ups and operator-only entries share `ui/session-cards.ts`: glyph-free generated
  headings, explicit textual state, one width-aware layout and semantic theme backgrounds. Neutral
  information/unknown state uses `customMessageBg`, verified completion `toolSuccessBg`, attention
  (nudge/stall/stopped) `toolPendingBg`, and verified failure `toolErrorBg`. Only runtime-owned status
  evidence selects chrome, never peer/child prose. Colors are resolved from the active theme at render
  time (including pi-theme-1337); normal tools keep Pi's own shell rather than gaining a duplicate box.
  Expanded prose reports use the native Markdown projection in `ui/report-body.ts` (including visible
  trust blockquotes); receipts, live output, monitor/timer notices and raw diagnostics stay literal.
  Source payloads and fences remain intact. The native Markdown component is retained per report and
  invalidated for theme/layout changes, without a global transcript cache. Rendering never rewrites
  stored or model-facing payloads, nor creates a wake;
- literal control receipts and fallback errors share `ui/literal-tool-result.ts`: bounded collapsed
  text, an expansion hint only when detail is hidden, and full sanitized expansion. Tool errors use
  the host's `ToolRenderContext.isError`, not a presumed result field; semantic negative peer answers
  remain successful retrievals. Retained `exocom_wait` answers are prose reports and render Markdown
  when expanded. Native tool shells remain host-owned;
- the sticky agent and exocom widgets have fixed physical-row budgets: the shared width-aware
  `ui/compact-widget.ts` clips each already-budgeted row instead of letting native Text wrap it.
  F9/`/agents` and paginated
  `exocom_list({ offset, limit })` are the explicit detail surfaces, so a wide fan-out cannot push the
  editor off screen or dump an entire peer registry into model context. Agent-tree deltas share one
  16 ms widget composition per terminal frame; identical lines/status are not republished, hierarchy
  rendering uses one adjacency index, and the F9 overlay rebuilds lazily when Pi paints rather than
  once per streamed token;
- `/flow` and `/orchestrate` append a durable, TUI-only expandable result card rather than a large
  notification; the supervisor gets the same text (fenced, 12k-bounded) once, as a passive next-turn message;
- an interactive `tasks` fan-out of two or more legs gets one container row, `delegate · N legs`
  (`k/N settled`), that never counts as an in-flight agent and leaves with its last leg. Settled leg
  rows retain a bounded terminal preview until then (4,096 body characters plus a retrieval hint);
  control handles close immediately. `ui/async-settlement.ts` only projects existing results: it
  cannot create a missing row, prolong a worker, alter archived text or add a completion wake;
- every group is inspectable in F9, independently of control permissions. `ui/agent-group.ts`
  derives a bounded, scrollable overview of worker descendants without counting phase/run
  containers, timers or local activities as workers. Queued work is distinct from running work.
  Selection and drill-in/back navigation preserve worker IDs; a lost target consumes the next
  directed key instead of applying it to a different worker. The overview controls its selected leg;
  root-wide cancellation remains on the root in the tree;
- overflowing sticky summaries preserve failure, pending-ask, wake/activity and active-worker
  digests before the generic overflow line, in that priority order when space is insufficient.
  Hidden active workers exclude queued/waiting/settled rows and containers; the representative follows
  tree order rather than changing with each progress event;
- `X` is not a directed key: it acts on the whole stoppable set of leaf rows after a confirmation that
  states how many agents it covers, and a changed set is re-confirmed. The set is every agent leaf (wake
  rows excepted) plus any run root with a stop handle (council/flow/mandated runs), and `x` on such a
  root stops the whole run.
  `intercom stop` / `stop { to: "all" }` also cover tracker runs, `council` and `flow` included;
- the F9 overlay's *directed* keys (`x` stop, `s` steer) act only on the agent the ▸ marker still
  shows; if that agent settles and is pruned mid-keystroke, the selection re-anchors visibly and the
  keypress is spent re-aiming instead of aborting an agent the user never chose. ↑↓, ⏎, and the scroll
  keys never refuse;
- every agent-tree node carries `startedAt`/`lastAdvanceAt`; `LiveClock` (`src/ui/live-clock.ts`)
  repaints the sticky widget and the F9 overlay once a second while any node is running and stops
  itself once nothing is. Running/completed usage shares `formatUsage`: `↑` input and `↓` output,
  using copied existing cumulative usage snapshots, never context occupancy. `AgentNode.usage`
  keeps that snapshot independently of the compact activity text; F9 shows both, without summing
  parent totals with child totals. A new strategy attempt clears the preceding attempt's usage and
  report preview. A progress source
  providing only an aggregate shows a neutral compact count without `tok` or a fabricated direction. A running row shows elapsed time until it goes `STALL_FLAG_MS` (90s) quiet,
  then the same `⚠ stalled <duration>` badge the async peek watchdog uses. `x` marks the target
  `stopping…` at once and is offered only when a live stop handle exists; a refusal (no handle,
  already settled) surfaces as a one-line notice instead of silently no-op'ing;
- armed timers and active monitors are **wake rows** in the same tree (`src/ui/wake-rows.ts`, ids
  `monitor:<id>` / `timer:<id>`): rows, not agents. The countdown replaces the stall clock: a timer
  shows `fires in <d>` only, a monitor keeps its elapsed time (`<elapsed> · deadline in <d>`), so
  neither carries the `⚠ stalled` badge or `waiting for supervisor`. `x` cancels
  one through the same stop registry as an agent (the `monitor cancel` / `timer cancel` effect); `s` steer
  is never offered. They are excluded from the `X` stop-all count, confirmation and bulk stop, from the
  `N agents` in-flight status, and from telemetry (`agent.*` events are agents only). They settle and
  leave like an async row: the final ✓/✗/■ goes to the tree change stream (telemetry excluded), not to
  the screen, because the update and the removal are synchronous and the widget frame is coalesced. They
  live only in the arming session, never restored. Raw monitor stdout/stderr has a separate passive
  observer: raw chunks feed bounded sanitized tails immediately, but full row/preview projection is
  coalesced per dirty monitor into the existing 16 ms widget frame, before its tree snapshot. Terminal
  events and cancellation publish the pending final tail synchronously; teardown clears pending state.
  This updates the widget and F9 without semantic events, model wakes, event-budget consumption or
  stall-clock credit. The same observer feeds a bounded session-native log
  archive (`src/monitor/archive.ts`): one plain custom entry per terminal/cancelled run, no sidecars or
  per-chunk writes. `monitor result` retrieves retained captures across reload/resume from the whole
  session tree, including sibling conversation branches: this archive is session-wide, deliberately
  not a projection of the active branch. Branch navigation changes neither visibility nor the shared
  lifetime budget. Restored logs never restore processes. Activation-unique monitor ids avoid historical result collisions. A finite
  lifetime serialized-byte/count budget includes all previous entries of the archive type, even
  unreadable versions. Session-file deletion owns log deletion; ordinary shutdown saves diagnostics,
  not deletes them. Operator-only expandable log entries do not create model context or extra wakes.

**Terminal result archive** (`src/results/`, `src/extension/results.ts`) applies the same
ownership model to settled agent work: every terminal delegate/council/flow outcome (and each final
SDK leg result, after any model recovery) is projected — once, idempotently by immutable origin —
into a versioned session entry with an opaque `result:<UUID>` reference, independent from runtime
run ids. Budgets: 128 entries, 8 MiB cumulative serialized payload per owning session file, 512 KiB
per record; bodies cap at 262,144 UTF-16 units with honest truncation metadata. Unknown, malformed
and duplicate history still consumes quota; unaccountable history disables new persistence instead
of resetting it. A fork/copy is a new owning file charged only for the entries it actually carries.
`storage: "session-entry"` means the host accepted the entry — never an fsync guarantee; memory-only
retention is labelled as such. Retrieval is read-only: `intercom results` lists, `intercom result
{ ref, offset, limit }` pages (8,000 default / 16,000 max units, surrogate-safe), with no respawn,
rebilling, collection or extra wake; reading a page never returns the whole run hidden in metadata.
A saved result is not a live worker: the restore notice says runtime handles are gone while retained
reports remain readable. Archive listeners belong to the extension factory/tracker lifetime and are
installed exactly once. `session_shutdown` revokes that session's archive owner and clears its
captures. A later activation creates a fresh owner and capture context before the ordinary completion
listener observes terminal results for that activation; a late callback bound to the old owner cannot
append into the new session.

Flow reference handoff needs durable session-entry storage when a phase's result feeds a dependent
phase. In a no-session run, a source phase can finish with a memory-only receipt, but the dependent's
reader preflight rejects it before that dependent is spawned. Use a persisted session for reference
handoff across phases, or use inline handoff when no durable reader is available.

This is a UI invariant only: truncating a collapsed card must never be confused with truncating the
underlying result or changing a strategy's contract.

## exocom — the external plane

`src/exocom/` is a separate plane from everything above: every plane in "the comm plane in practice"
is **internal** to one supervisor's own run — hierarchical, keyed by that session id, talking to
children *it* spawned. **exocom is flat and external**: independent, top-level Pi instances sharing
one explicit scope — normally the same workspace, or a Pi that joined by code — discover each other
and message peer-to-peer, with no parent/child relationship. (intercom = internal comm; exocom =
external comm.)

Exocom supplies fenced one-way postcards and presence; chat `message` never mutates shared work
state. `src/exocom/ledger.ts` stores claims, questions, answers and progress; `src/exocom/collaboration.ts`
adds voluntary tasks, optional offers and explicit evidence excerpts. Tool adapters live in
`src/tools/exocom.ts`, `src/tools/exocom-collaboration.ts`, and `src/tools/exocom-profile.ts`.
`exocom_ask` resolves its target through the live registry to a raw session id, never a display name.
Attribution is resolved by `from_session`, never the envelope's self-reported `from_name`.

A pending ask gates the participant to `exocom_answer`/`exocom_decline`, `exocom_name` identity
metadata, `exocom_status`, explicit collaboration reads (`exocom_task` list/get, `exocom_publish`
read, `exocom_profile` get), and read-only filesystem tools. Profile `set`/`clear` and all other
mutations remain unavailable until the ask is settled. Naming does not settle an ask. The bounded
`pendingAskPrompt` explains the outstanding obligation. `exocom_wait` is non-blocking. Clean shutdown
releases this session's claims/asks; if that best-effort write fails, the vanished owner is pruned on
the next ledger transaction (live registry sessions are the lease), and `expireWaiters` wakes any
waiter left behind instead of leaving `exocom_wait` armed forever. This gate is cooperative
coordination for participating local Pi processes — not filesystem authorization, not isolation from
another same-user process, and not a delegate/council or task/run replacement.

- **Opt-in, OFF by default.** `PI_PERSONA_EXOCOM=1` or bare `--exocom` joins the current workspace;
  `--exocom=Ab0T` joins an existing scope by its exact, case-sensitive four-character Base62 alias
  from another cwd (Pi's flag API can't express an optional-value boolean, so the extension recovers
  the equals form from raw argv). Unknown/malformed/conflicting codes fail closed rather than falling
  back to the caller's workspace; selection is frozen for the session. Participation also requires
  the active persona's `canUseBus` plus at least one obligation closer
  (`exocom_answer`/`exocom_decline`), re-evaluated on every persona switch — a persona that loses
  either leaves the registry rather than advertising a peer that could be permanently wedged by an
  inbound ask, and rejoins once an admissible persona is active. OFF ⇒ no bind, no registry entry, no
  tools registered.
- **Discovery — a scope-selected file registry, not an elected hub.** A persistent alias map under
  the agent directory resolves each four-character code to its full 24-hex workspace identity
  (allocation is atomic, collision-aware, bounded); the code is a routing convenience, never the
  storage identity. Each instance binds its own socket (POSIX) / named pipe (Windows) and
  self-registers one JSON entry under `<agentDir>/persona/exocom/<workspace-hash>/agents/<session-key>.json`
  (a hash of the session id, so a read drops any entry whose filename doesn't match its own
  `session_id`), heartbeating it; discovery is just reading that directory. Dead-pid and
  stale-heartbeat entries are pruned on read — no host election, no failover. Cleanup is
  ownership-aware (`session_id` + endpoint + signing key) and atomically claims an entry before
  deletion, so a failed/replaced session cannot erase a live replacement's slot.
- **Workspace identity is the Pi's actual cwd.** The chosen scope controls registry, endpoint, ledger,
  and artifact paths but never overwrites the member's home workspace identity. Peer lists, the
  standing brief, and `/exocom` label a peer as same-workspace or external without exposing its
  absolute `cwd`. External peers are full Pi instances that can inspect files in their own workspace;
  paths are never implicitly shared.
- **Postcards, asks and offers have different obligations.** `exocom_send` returns a `msg_id`
  immediately; a reply is another `exocom_send` with `in_reply_to` set. `target: "*"` broadcasts
  postcards best-effort. `exocom_ask` commits a targeted question that must be answered or declined;
  `exocom_wait` arms a bounded idle wake rather than blocking. `exocom_offer` is an optional,
  expiring invitation to consider an open task, targeted to one peer or the pool; it creates no ask,
  no answer obligation and no work authorization. Its default lifetime is one hour, capped at 24 hours.
  Signed immediate-wake frames are signals; the ledger remains authoritative when delivery is deferred.
- **Task generations and atomic pickup.** `exocom_task create` records a voluntary objective and
  declared write set; creation neither launches work nor claims paths. The task's immutable
  `task_id` is its creation frame's `msg_id`; later take/progress/finish, offer and publish actions
  carry both `work_key` and `task_id`, so reusing a key cannot attach a delayed action to a newer
  task. A write-set task's pickup and overlapping write claim commit together under the ledger lock;
  competing overlapping pickups are rejected. Read-only tasks can be taken by a peer in another
  workspace scope. A task whose owning registry lease disappears becomes stale and cannot be taken
  over automatically. `exocom_task list` is paginated; `get` returns the complete bounded task detail,
  including the exact write set. `exocom_publish` attaches an explicitly authored bounded excerpt to
  one task generation; discovery pages titles and message ids, and the full excerpt is read by id.
  These excerpts do not grant access to a peer's terminal-result archive.
- **Cross-workspace writes are advisory-only in v1.** A repository-relative claim path has meaning
  only in the workspace that owns the selected scope, so a member whose home workspace differs from
  the scope cannot `exocom_claim` or create/pick up a write-set task (the tool and signed-frame
  transaction both enforce the scope). It can still read shared tasks/evidence, take read-only tasks,
  send postcards, ask, answer/decline, and release its own asks. Multi-repository write coordination
  would need a versioned resource namespace; paths from unrelated repositories are never compared as
  if they named the same files.
- **Reply routing is session-stable.** `exocom_list` shows human display names (`name`/`name#2`);
  sends and inbound reply hints use `name@<96-bit session hash>`, so a retained qualified target
  stays valid after a rename. Ambiguous suffix matches fail closed rather than guess. The
  authenticated registry entry (endpoint + signing key) is cached with the bounded inbound context,
  so a stale/pruned sender can't be retargeted to a same-name twin. The reply hint is CONDITIONAL —
  reply only if it changes what someone does — so a settled point can keep running on agreement and
  thanks instead of a bare `Reply:` making answering the default.
- **Identity is session-stable, persona is presence metadata.** `extension/identity.ts` owns one
  handle independent of Exocom. `agent_name` names a standalone session; `exocom_name` does the same
  while Exocom is active and refreshes presence immediately. A chosen name persists in a session-bound
  entry, survives resume/reload/persona changes, and is not inherited by a fork with a new session id;
  generic persona/agent names are rejected. Before selection, the `context` hook supplies the
  actionable naming bootstrap to ordinary turns and custom Exocom wakes; after selection it injects
  no identity pseudo-turn. `exocom_name` only replaces the display label — the
  registry key stays the session, so a rename can't take over another peer's slot or its inbound
  replies, and changing persona never changes the key or grants authority over another peer. Delegated
  workers keep the leader's `delegate.name` from launch, including peer/broker display labels.
- **Fenced and attributed from the REGISTRY, never the envelope — the security core.** An inbound
  message is head-truncated and delivered under a header the RECEIVER writes, above a body quoted by
  `fencePeer` (the peer flavor of `core/fence.ts`'s `fenceUntrusted`/`attributeInbound`). Attribution
  sits OUTSIDE the fence so a payload can't spoof its sender by closing the block, and the label comes
  from the registry entry keyed by the connecting session, never the envelope's self-reported
  `from_name`. A message over the inline budget spills to a scope-selected artifact file (a small
  preview stays inline); the spill descriptor (`preview`, `path`, `size`) is verified at the
  RECEIVER's transport boundary before anything reaches its model — the path must be the selected
  scope's own `artifacts/<msg_id>.txt`, a regular unlinked file whose size matches the declared one
  and sits between the inline cap and `ARTIFACT_MAX_BYTES`. The receiver then reads through one held,
  identity-checked descriptor, rechecks the source didn't change, and writes an unpredictable
  receiver-owned snapshot with exclusive creation — only that snapshot path reaches the model.
  Anything else is NACKed rather than exposed. Received snapshots join sender spills under the same
  TTL/file-cap cleanup, and the per-sender byte window charges only what crossed the wire (not a
  spill's declared size), so a legitimate large spill is delivered rather than refused as "budget".
  Transport guardrails enforced at the boundary: a hop cap (bounds only a THREADED reply chain,
  derived from `in_reply_to`; untreaded alternating sends aren't depth-bounded by the transport), a
  per-sender rate+byte budget, and a (sender, msg_id) dedup set so an at-least-once resend can't
  double-trigger a turn. An exchange's LENGTH is instead bounded prompt-side: the per-turn peer brief
  (`core/brief.ts`) carries a relevance bound — send only what changes what someone does — deliberately
  not a round count, since a counter can't see whether a round still serves the work.
- **Fifteen tools are lazy and fail closed.** `EXOCOM_TOOL_NAMES` lists `exocom_list`, `exocom_send`,
  `exocom_name`, `exocom_claim`, `exocom_ask`, `exocom_answer`, `exocom_decline`, `exocom_wait`,
  `exocom_release`, `exocom_progress`, `exocom_status`, `exocom_task`, `exocom_offer`,
  `exocom_publish`, and `exocom_profile`. Each tool rechecks effective persona capabilities at call
  time; the live accessor and active-tool set also deny calls once the plane stops, since Pi has no
  dynamic tool-unregister API. A joined foreign-scope peer has no `exocom_claim`. Admission requires
  `canUseBus` and at least one callable ask closer, because every published peer may receive a durable
  ask and must retain a way to settle it.
- **Collaboration and profile retention are bounded.** The ledger retains at most 64 tasks, 64 offers,
  and 64 evidence excerpts with a 128 KiB aggregate collaboration-state budget. Task descriptions cap
  at 2,048 characters; write sets at 64 paths of 256 characters each; progress/finish notes at 4,096.
  Evidence titles cap at 160 characters and excerpts at 4,096 characters / 8,192 UTF-8 bytes. Finished
  or stale tasks remain for up to one hour; expired offers remain for up to one hour after expiry, and
  evidence for up to one hour after publication. Active tasks remain while their owner lease is live.
  `exocom_profile` contains up to eight self-described capability labels (48 characters each) and
  optional `available`, `busy` or `away` status. Missing status is unknown. Profiles exist only for
  their live Exocom session and never prove skills, permission or availability.
- **Inbound delivery is bounded without loss.** Each message is injected under the same byte cap
  whether plain text or an artifact descriptor. Bursts stay FIFO-queued; each rate-limited wake drains
  as many whole messages as fit, leaving the rest queued. A presentation cap on the collapsed card
  never discards the rest of the queue.

exocom never touches the delegate/council/broker path. One instance can be **both** a supervisor
(delegating its own children) **and** an exocom peer at once — the planes are independent and
independently gated. Whoever initiates a collaboration is merely the coordinator de facto: the plane
stays flat, and no peer gains stop/steer authority over another (that exists only on the hierarchical
intercom plane). The join code is not authentication: exocom is cooperative same-user, same-host
coordination between processes sharing one effective Pi agent directory, not a remote/network plane —
a local process able to modify that directory is already inside the trust boundary.

## Supervision & the waiting model

There is no `sync`/`async` switch on `delegate` and no `intercom wait`; the mode follows the session.

- **Headless (`ctx.hasUI !== true`, e.g. `pi -p`)** — the supervisor blocks on the delegate, council or
  flow call and gets results inline (returned once, unclipped; progress is only a `k/N done` counter), because nothing drains a follow-up after the
  single turn exits. A runtime constraint, not a model-facing choice. The legs are still tracked, but
  the status monitor stays off: the model is parked in the call and nobody reads a card.
- **Interactive (TUI and RPC)** — delegation is ALWAYS background: the call returns run ids at once
  and each result returns as an idle-gated completion follow-up (`intercom result { to: runId }`
  retrieves a settled run; `peek`/`steer`/`stop` stay available, which a blocking call could never
  offer). With only background children left, the supervisor ends its turn and goes idle until a wake;
  it never sleeps, polls, or arms a `timer` to wait for a child or a monitor. The **peek watchdog**
  fires while async children run but stays SILENT unless there is something to act on. A newly
  detected stall (`STALL_FLAG_MS`, 90s) appends a durable, expandable operator-only warning showing
  the observed quiet duration, even while the supervisor is busy. A previously reported leg that
  genuinely advances and is currently below the stall threshold produces one **progress resumed**
  entry. Queuing, waiting, removal, settlement or a watcher reset never invent a recovery. Neither
  transition wakes the model; unread messages to the supervisor keep their wake path.
  Ordinary progress stays in the live rows/F9. The **routine status card** (`PI_PERSONA_CHECKIN_MS`,
  default `0`, off) is opt-in: a positive interval appends a durable operator-only compact ProgressView
  digest, never full transcripts. Episode entries replace a coincident routine card and restart its
  cadence. Explicit saved intervals are preserved. Live supervisor asks
  are derived from the exact engine handle's optional `isWaitingForSupervisor` predicate: tree/F9/peek
  show waiting, and the watchdog suppresses false stalls until the ask settles. Parent clocks advance
  with child engine events (liveness, not proof of useful work); parents are waiting only when every
  live descendant branch is waiting. The peek watchdog's clock is stricter (`madeHeadway` in
  `engine/async.ts`): a run advances only when assistant output, tokens or turns grew or a tool call
  completed, and raw tool-output chunks earn nothing, so a leg whose tool streams forever (`npm run dev`,
  `tail -f`) raises the operator-only stall card. A false advisory on a legitimately noisy long tool is
  accepted; nothing is killed and the model is not woken. A council or flow run is credited per leg. The
  tree/F9 clocks stay event-based.
  The operator (or a manual `/peek`) can steer/stop a silent child. The supervisor's net for one is the
  engine idle window (`RUN_LIMITS.timeoutMs`, 180s; startup deadline 300s), which kills it and returns a
  failed completion follow-up whose text says to raise the leg's `timeoutMs`; the opt-in hard wall-clock cap (`PI_PERSONA_AGENT_MAX_MS`, off by
  default) catches a busy non-converging leg.
  Two call-time guards (under `config.nudge`, `PI_PERSONA_NUDGE=off` disables both) stop the in-turn
  waits that would block those wakes: a repeated `intercom peek`/`result` whose answer has not changed
  (per scope; `steer`/`stop` reset it) is refused, then asks Pi to end the turn (`terminate` is a hint
  Pi honours when the peek is the batch's only call); a leading long `sleep`/`Start-Sleep` (>= 20s) is
  stopped while background children run or are being launched (interactive only; a sleep prepared
  before a same-batch `delegate` is an accepted false negative). A `delegate` fan-out (`tasks`) is
  held and delivered as ONE completion follow-up when its last member settles, with every failed leg
  named and clipped on its own line; single legs and separate calls are unchanged. Held reports are
  dropped at session shutdown or reload, like the running legs, and the `PI_PERSONA_ASYNC_RETAIN`
  default (64, the `tasks` cap) covers one whole call so early finishers stay fetchable. In headless `pi -p` the
  `timer`/`monitor` arm text says the process exits when the turn settles, so such a wake lands only
  if it fires before then.
  **`council` and `flow` are the same kind of run** (`tools/background-run.ts`, `createBackgroundRuns`).
  Interactive, each is ONE tracker run rooted at `async:<runId>`: a receipt now, ONE completion follow-up
  (`intercom result { to: runId }` for the full payload), and the same `peek`/`stop`/`stop all`/f9 reach
  as a delegate leg. Headless, the same run is launched and joined inside the tool call. Esc no longer aborts
  one; stop it by key. Ownership of the limits: a run holds ONE slot of the delegate `maxConcurrency` launch
  pool for its whole life (`queued` until granted; a flow keeps it while parked at a checkpoint); the strategy
  SDK's per-run semaphore gates the legs INSIDE it, so members never compete with delegate legs for pool
  slots; token budgets, the child limit, the delegation ledger and the fork-bomb guard stay in the SDK and
  engine. A flow parked at a checkpoint is blocked on the OPERATOR: the run carries `awaiting`, peek reads
  `waiting for operator at checkpoint <id>`, the stall watchdog skips it and nothing wakes the model; a
  rejected checkpoint settles the run `stopped` and the plan reaches the model as its partial output. A
  persona's `council:` defaults resolve unchanged when the call omits strategy, roster and params. The
  mandated `orchestration:` path stays PRE-turn and inline (its result is the supervisor's first answer),
  as do the `/orchestrate` and `/flow` slash commands; those runs register their own abort under their root
  row, so shutdown ends the whole run. Operator-run results also reach the supervisor's next turn as a
  passive, fenced, 12k-bounded message.
  Progress tokens are labelled **cumulative input/output**, not context occupancy; cache-read/write
  accounting is separate. Do not infer a full context window from that counter. File age or line-count
  changes alone likewise do not establish a stall, a passing test or completed work.
  **Restore honesty:** `session_shutdown` records lost run ids, timers, monitors and the run-id counter
  in a `pi-persona:runs` session entry (`core/session-runs.ts`). The next `session_start` (reload,
  in-session resume, `pi -c`; not fork or `/new`) tells the supervisor once through a passive `nextTurn`
  message, acknowledges it, and continues run ids so they never restart at `run-1` within a session.
  Only ids matching a strict shape and capped counts are ever read back.
  Async failures are ALWAYS reported; the runtime `DelegationLedger` vetoes a blind retry loop (an
  identical agent+model+task delegation that failed twice is stopped before it spawns). Coaching is
  gated by `coaching: on` AND `canUseBus`.

**Runtime reinforcement of the hand-off default** comes as a standing part and a reactive part, because
a persona directive lives at the TOP of the prompt and its pull decays as recent tool output balloons:

- The **delegation brief** (`core/brief.ts`) is the STANDING half: live roster (agents + teams + flows, with descriptions;
  gated flows are tagged in headless sessions) and the hand-off default (the supervisor's role: it holds the
  objective, the plan and the judgement, normally handing bounded independent work to supervised legs;
  quick, trivial or tightly coupled work can stay inline when hand-off overhead would outweigh the benefit; one decision-class →
  method line that a test checks against the strategy registry; model-sizing guidance and a cached provider
  candidate list), appended to the system-prompt TAIL every turn, where recency wins the
  tug-of-war a top-of-prompt line loses. It regenerates from the live registry (so it can't desync) and
  filters to the active persona's `delegate` allowlist. It never dictates how MANY sub-agents; beyond the one class line,
  the shape is each persona's own method.
  The model snapshot is acquired once per session/base-model reference, refreshed on a base-model change
  or explicit `models` call, and reused across turns. Recommendations first stay near the current
  model's provider, textual name root and numbered major generation, then order distinct variants by
  relative cost band and numeric version. They do not fill spare slots with older or unrelated models.
  This affects discovery only; exact assignment and search retain the full eligible catalog.
  Relative cost hints use host prices against an uncapped recent-provider reference, never a
  model-name-to-tier table, and leave missing or zero-price metadata unknown. The LLM chooses task fit.
- The **nudges** (`core/nudge.ts`, on by default) are the REACTIVE half, landing in RECENT context on
  the event that warrants them:
  - **DelegationNudge** — a `tool_result` hook watches the supervisor's own tool stream and, when a
    delegating persona grinds heavy work by hand (output burn since the last `delegate`/`council`/`flow`
    crosses a threshold: 3 substantive calls and ~1k tokens), appends a compact labelled checkpoint
    (`Trigger` / `Scope` / `Action`, with four delegate targets named in the action, those the persona's own prompt mentions first, and a
    `Model candidates` line for the session provider) to
    that command's result for the model and mirrors it into a durable, expandable
    `pi-persona-nudge` custom entry for the operator. The entry is TUI-only (no duplicate model
    context or turn) and guarantees visibility even when a built-in/custom tool renderer suppresses
    result `content`. A successful hand-off resets the streak; a failed one keeps it and returns the
    same visible re-dispatch checkpoint.
  - `flow` is a hand-off beside `delegate`/`council`: a successful flow resets the by-hand streak and a
    failed one gets no re-dispatch checkpoint (its failure text is self-describing).
  - **PersistenceNudge** — the counterweight to premature surrender: a delegated leg's report carrying
    `[BLOCKED]`/`FLAG: UNKNOWN` gets a "don't bank it yet" reminder. Three delivery paths carry it
    (the inline `delegate`/`council`/`flow` result — headless only — background
    completion, and an explicit `intercom result` of a done run), but coverage isn't identical:
    the sync path scans the WHOLE tool result including failed legs, while `renderCompletion` scans
    only `status === "done"` runs by design — a failed background leg already gets a failure
    block, so a `[BLOCKED]` marker there doesn't also get the persistence note. Same marker, same leg,
    different counterweight depending on how it was collected.
    Nested calls through codemode's `ctx.executeTool` leave their programmatic result untouched.
    Pi's explicit `parentToolCallId` supplies the parent identity; call-id string shapes are never
    used to infer nesting. A bounded set of parent call ids carries report provenance through wrappers
    only while their output relays a surrender marker; the outer model-visible result alone gets the
    note/card. Suppressed reports produce neither, and turn/session settlement clears abandoned relay state.
  - **The off switch covers every path.** `PI_PERSONA_NUDGE=off` silences DelegationNudge entirely,
    PersistenceNudge on all three delivery paths (inline result, background completion, `intercom result`),
    and both call-time wake guards (`PollGuard`, the long-sleep block).

## Discovery & seeding

- **Precedence (all file kinds):** `builtin < user (~/.pi/agent/persona/…) < project (<root>/.pi/…)`; project
  wins collisions. Personas and agents **share a folder**, split by the `persona: true` marker (a
  persona and an agent must not share a name). The loader reports a same-name collision and omits
  both ambiguous definitions from the effective registries, so a malformed install fails closed
  instead of silently routing persona selection and delegation to different files.
- **Personas/agents load ONLY from the user and project dirs.** The bundled `personas/`+`agents/` are a
  **seed source, not a live discovery layer** — a fresh install shows NO personas until installed.
  `/persona seed` copies missing defaults, `/persona restore` force-restores originals (`core/seed.ts`);
  first-run auto-install is opt-in (`PI_PERSONA_SEED=on`, guarded by a marker). When a release changes
  a bundled default, activation may call the exact-size/hash migration helper: it upgrades only a known
  pristine prior copy and preserves edited, linked, or unknown files. A migration can declare a bundled
  agent dependency; that missing file is installed first with no-clobber atomic creation, or the parent
  remains on its old bytes. Upgrades, dependency installs, and warnings are exposed in `/doctor`.
  The legacy digest table (`LEGACY_SEEDED_DEFAULTS`) holds the LF-checkout bytes of every shipped
  elite/swarm/MAGI-core version from v1.11.0, plus the v1.17.1 copies of every bundled persona. Release prep must add the
  previous tag's digest for each changed persona/agent; the guard test in `seed.test.ts` prints the
  row (and skips in CI's depth-1 checkout). With zero personas installed, F8 and `/doctor` point to
  `/persona seed`, like `/persona list`.
  Contracts/presets/teams keep a builtin layer (they aren't personas).

## Cross-OS constructs

Never raw `child_process` — reuse Pi's helpers: `getPiInvocation()` (resolve the current `pi` binary),
`killProcessTree` (`taskkill /F /T` on Windows vs POSIX process-group kill), temp/path helpers. Always
attach an `error` listener to every spawned process and socket/server (an unhandled `error` event
crashes the host). Cross-OS is a regression gate: Windows AND POSIX child-spawn + process-tree-kill
must pass. The broker's transport is the only OS-specific code, confined to `bus/broker/`.

## Error-handling & lose-nothing invariants

- Per-run `AbortController`; recoverable failures return `AgentResult.error` + diagnostics, never
  silently lost. A throwing ENGINE call becomes that leg's own `ok: false` result (`legFailure`,
  flagged `infrastructure: true` so failure-punishing consumers can tell it from a model-side
  failure), so one blown leg can't discard the fan-out's completed — already billed — siblings.
  A rejection that reaches `sdk.parallel` is run-fatal by construction (a limit breach, a throwing
  host callback): the batch stops pulling new items and rethrows the FIRST error immediately.
  `runPersonaStrategy` returns `null` only for "nothing to run" (a persona naming no mode) — that
  is not a failure.
- Model/thinking baseline is snapshot-once and restored on omit; tools are restored from the **full**
  registry, never the active subset ("never strip Pi power").
- The completion/mutation guard keeps child-claimed success ≠ runtime-verified; the `maxChildren` cap
  rejects an oversized fan-out **visibly** (an error before spawn), never by silently trimming it.
- Sub-agent output is UNTRUSTED — fenced (`fenceUntrusted`) before it reaches the supervisor as a
  follow-up or tool result (prompt-injection defense).
- The broker host is `unref`'d (never keeps Pi alive) with a permanent error sink; never unlink a live
  socket; teardown is idempotent.

## Reference: the core seams

Session event monitors follow the [time and event wake contract](MONITORS.md). A pure bounded
`MonitorManager` owns command-watch lifetimes; one process adapter reuses `killProcessTree`,
and a bounded session queue delivers fenced events through the existing idle follow-up path.
They are supervisor-owned resources, cancelled on shutdown or execution-permission revocation.
They do not replace engine events, the semantic bus, or Exocom, and are not an OS authorization layer.

The stable contracts other layers build on:

- **Engine:** `AgentRunSpec` → `AgentResult` (`ok`, `output`, `structured?`, `usage`, `error?`,
  `failureKind?`, `modelUsed?`) via `StrategyEngine.run`.
- **Strategy SDK:** `agent` · `parallel` · `reduce.{aggregate,vote,judge}` · `roster.team` · `signal`
  · `limits` · `log` (see [STRATEGIES.md](STRATEGIES.md#the-strategy-sdk)).
- **Strategy:** `{ name, params?, run(input, sdk) }`. **Reducer:** the `ReducerResult` status union
  (`winner | tie | no_consensus | invalid_outputs`, dissent + invalid preserved, `usedFallback`).
- **Persona:** identity + `orchestration` grammar / `council` draft. **Bus:**
  `send`/`ask`/`reply`/`onMessage`/`participants` over logical handles (resolved to a broker name only
  when a message crosses a process).

## Deliberately deferred

- **`context: fork`** — `fresh` is the right child default; fork stays deferred (fail-fast, no silent
  downgrade).
- Blocking peer asks and hard param validation are out of scope by design — see the reasons in
  [STRATEGIES.md](STRATEGIES.md) and the comm-plane section above. Inter-session comm (the broker
  endpoint stays per-session by design) is no longer a gap: **exocom** (above) is the flat, opt-in
  plane for independently-launched instances sharing a selected scope, including explicitly joined
  peers whose actual files live in another workspace.
