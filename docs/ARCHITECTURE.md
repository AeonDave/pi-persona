# Architecture

See [`docs/README.md`](./README.md) for the canonical doc set index.

The design contract for pi-persona — the model, the binding invariants, the module map, and the
runtime seams. This is the **canonical design reference**: on any conflict, this document and the
invariants below win. For the user guide see the [README](../README.md); for the orchestration layer
in depth see [STRATEGIES.md](STRATEGIES.md); for the contributor quick-reference (commands,
conventions, gotchas) see [AGENTS.md](../AGENTS.md).

pi-persona is a single Pi coding-agent extension (`@earendil-works/pi-*`, loaded via tsx/jiti — no
build step) that turns one agent into a **supervisor** of switchable **personas** and file-based
**orchestration strategies**. It fuses three concerns — delegation/engine, coordination/bus,
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
strategy/team without a core change. The gates use effective agent/tool capabilities, conservatively
treat shell-capable, MCP-enabled, or unknown tools as potential writers, and enforce the requested fan-out
concurrency in both synchronous and background execution. A serialized verifier is accepted only
after every material writer in that batch; otherwise the call fails before a child starts. The rule
also holds ACROSS calls: a verifier launched while a material-writer background run is still live is
rejected with the run id to wait on, so a later call cannot slip past the in-batch ordering.

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
  capped at 1: a child's whole pi-persona extension activation short-circuits under
  `PI_PERSONA_DISABLE=1` (the **fork-bomb guard**), so it registers NO tools at all —
  `delegate`/`council`/`orchestrate`/`flow` included. On the child engine this is a one-shot env var
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
  from disk with no re-spend.
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
  peer-vs-sub-agent split, and the relevance bound on an exchange), `nudge` (the two
  runtime-reinforcement state machines, `DelegationNudge` + `PersistenceNudge`), `display-label`
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
  lifecycle metadata only, never an agent-message router or control surface.
- **`src/persona/`** — identity: `persona.ts` (parse + `expandCouncilPreset` + `composeSystemPrompt`),
  `controller.ts`, `gating.ts`, `orchestrate.ts`, `config-store.ts`, `state.ts` (last-selected persona),
  `spine.ts` (the shared behavioral layer's SOURCE resolution — docs/SPINE.md; composition sits in
  `persona.ts` for supervisor turns and in the engines for delegated legs).
- **`src/tools/`** — `delegate.ts`, `intercom.ts`, `exocom.ts` (the `exocom_list`/`exocom_send`
  tools), `exocom-work.ts` (claim/ask/answer/decline/wait/release/progress). **`src/ui/`** — agent tree/overlay, model picker, `presentation.ts` (the shared
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
worktree creation failure, missing diff artifact, or an artifact over the return limit fails the leg —
the base engine is never invoked against the real tree as a fallback. The diff returns to the
supervisor before the temporary tree is removed, and every git call is asynchronous so the extension
host keeps rendering, ticking timers, and serving broker sockets while a large checkout runs.

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

## Time awareness — one rule, three granularities

Pi's base prompt carries no date and no time, so from inside a turn five minutes of work and five
hours look identical. `core/time.ts` renders the three durations that fix that, and the rule that
decides how precise each may be is a **prompt-cache** rule, not a taste one:

- **Tail surfaces are free.** A tool result or a delivered message is written once and never re-sent
  as the cached prefix, so precision costs nothing there. An inbound peer delivery dates itself
  (`[rune] — reply · sent 20m ago`), and every settled leg reports its wall time on every
  tracker-backed path — the done/failed/stopped report, the join, `intercom result`, and each
  settled line of a peek digest.
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
- **ProgressView** — a derived, read-only UI view computed *from* EngineEvents. Never authored, never
  a source of truth. The `f9` agent tree and `peek` digest are ProgressViews.

Steering is always a Bus action; the peek digest is always a read-only ProgressView.

External telemetry is not a fourth communication plane: it is a generic observer/export contract that
future plugins may consume or produce, not an exclusive pi-persona protocol. It observes projected
events and cannot route, reply, steer, or otherwise control agents.

## The comm plane in practice

- **In-process bus** (`bus/inproc.ts`) — a handle-based mailbox: `send` (one-way), `ask` (blocks for a
  reply), `reply`, `onMessage`. `contact_supervisor` (child→supervisor, gated by `coaching: on`) and
  `contact_peer` (sibling→sibling) are the child-side tools bound onto it. Each unread inbox holds at
  most 200 messages; overflow evicts an old one-way note first, and an inbox full of live asks rejects
  new delivery rather than stranding a sender. Ask settlement (reply, timeout, abort, departure, or
  failed delivery) releases its timer/listener and unread entry; a previously retained question stays
  readable with `expectsReply: false`, so old questions never advertise an active reply id.
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
  own host ask. `extension/broker-host.ts`'s `SupervisorBroker` owns the lifecycle: it starts the host
  lazily on the first child-engine build, warns once on a failed bind (children built while it's down
  spawn without a bus endpoint, so they never burn connect backoff against a dead socket), and the next
  build retries; `/doctor` surfaces its state on one line. A dropped client connection flips the
  child-side bridge to `⇄ offline` and fails a fresh ask fast rather than hanging.

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
  Pi's expand-key hint, each surfacing failure at the top in its own shape: the delegate card **sorts**
  failed legs first, a failed council/flow card leads with the cause in its title, and an
  `intercom wait` card leads with the `N settled — X done, Y failed` tally (per-leg causes sit in the
  body, below the preview cut, so `wait`'s own success doesn't get a `failed` prefix);
- follow-up cards (`pi-persona`, exocom) retain their complete semantic content but render a bounded
  preview until expanded; terminal escape/control sequences are removed from the visible projection;
- the sticky agent and exocom widgets have fixed row budgets — F9/`/agents` and paginated
  `exocom_list({ offset, limit })` are the explicit detail surfaces, so a wide fan-out cannot push the
  editor off screen or dump an entire peer registry into model context. Agent-tree deltas share one
  16 ms widget composition per terminal frame; identical lines/status are not republished, hierarchy
  rendering uses one adjacency index, and the F9 overlay rebuilds lazily when Pi paints rather than
  once per streamed token;
- `/flow` and `/orchestrate` append durable, TUI-only expandable result entries rather than dumping a
  large notification or a second copy into the model context;
- the F9 overlay's *directed* keys (`x` stop, `s` steer) act only on the agent the ▸ marker still
  shows; if that agent settles and is pruned mid-keystroke, the selection re-anchors visibly and the
  keypress is spent re-aiming instead of aborting an agent the user never chose. ↑↓, ⏎, and the scroll
  keys never refuse;
- every agent-tree node carries `startedAt`/`lastAdvanceAt`; `LiveClock` (`src/ui/live-clock.ts`)
  repaints the sticky widget and the F9 overlay once a second while any node is running and stops
  itself once nothing is. A running row shows elapsed time until it goes `STALL_FLAG_MS` (90s) quiet,
  then the same `⚠ stalled <duration>` badge the async peek watchdog uses. `x` marks the target
  `stopping…` at once and is offered only when a live stop handle exists; a refusal (no handle,
  already settled) surfaces as a one-line notice instead of silently no-op'ing.

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
state. Separately, a workspace work ledger (`ledger.ts`, tools in `tools/exocom-work.ts`) records
claims/asks/answers/progress/releases. `exocom_ask` canonicalizes its target through
`plane.resolvePeer` (raw session ids on the ledger, never the display name); registry display name is
keyed by `from_session`, never the envelope's self-reported `from_name`. A pending ask constrains the
turn (`gate.ts`: answer/decline plus read-only tools) behind a bounded `pendingAskPrompt`.
`exocom_wait` is non-blocking. Clean shutdown releases this session's claims/asks; if that best-effort
write fails, the vanished owner is pruned on the next ledger transaction (live registry sessions are
the lease), and `expireWaiters` wakes any waiter left behind instead of leaving `exocom_wait` armed
forever. This gate is cooperative coordination for participating local Pi processes — not filesystem
authorization, not isolation from another same-user process, and not a delegate/council or task/run
replacement.

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
- **Postcards plus a durable, non-blocking join.** `exocom_send` returns a `msg_id` immediately; a
  reply is another `exocom_send` with `in_reply_to` set. `target: "*"` broadcasts postcards
  best-effort (one unreachable peer doesn't fail the rest). Work coordination is separate:
  `exocom_ask` commits an obligation to the ledger, `answer`/`decline` settles it, and `exocom_wait`
  arms a bounded idle wake rather than blocking. The signed frame is a wake signal; the ledger remains
  the source of truth if delivery is deferred.
- **Cross-workspace writes are advisory-only in v1.** A repository-relative claim path has meaning
  only in the workspace that owns the selected scope, so a member whose home workspace differs from
  the scope cannot `exocom_claim` (the tool and the signed-frame receiver both reject a foreign
  claim) — it can still send, inspect its own files, ask, answer/decline, wait, and release its own
  asks. Multi-repository write coordination would need a versioned resource namespace; paths from
  unrelated repositories are never compared as if they named the same files.
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
  generic persona/agent names are rejected. `exocom_name` only replaces the display label — the
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
- **Tools are lazy and fail closed.** `exocom_list({ offset?, limit? })` exposes bounded, paginated
  presence; `exocom_send({ target, message, in_reply_to? })` sends one-way (a session-qualified-looking
  target resolves only as one, never falling back to a display name, since names are self-chosen);
  `exocom_name({ name })` rebrands the display call-sign without moving any state. The ledger tools —
  `exocom_claim`, `exocom_ask`, `exocom_answer`, `exocom_decline`, `exocom_wait`, `exocom_progress`,
  `exocom_release` — are capability-gated with the postcard tools; the live accessor, capability gate,
  and active-tool set all deny them once the plane stops, since Pi has no dynamic tool-unregister API.
  Admission requires at least one obligation closer, because every published peer may receive a
  durable ask and must retain a way to settle it.
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

- **sync** — the supervisor actively blocks on the delegate/strategy call (results still stream); no
  idle/peek/steer.
- **async** — the supervisor returns control and goes **idle, spending no tokens**, until woken by an
  **event** (a child's `contact_supervisor`: a `decision`/`interview` blocks for a reply, `progress` is
  one-way) or the **peek watchdog**, which fires while async children run but stays SILENT unless there
  is something to act on — a healthy background run never interrupts. It surfaces on two independent
  signals: a **fast** wakeup (`PI_PERSONA_PEEK_MS`, ~30s, `0` disables) when a child NEWLY crosses the
  `STALL_FLAG_MS` (90s) stall window (a focused *possibly stuck* alert, framed patience-first — ask the
  leg, don't probe its environment) or messages the supervisor; and a **slow routine check-in**
  (`PI_PERSONA_CHECKIN_MS`, ~5 min, `0` disables) delivering the compact ProgressView digest — never
  full transcripts — so the supervisor can catch a leg going off-track early. Both let an idle
  supervisor steer/stop a wedged or drifting child even with NO completion fired; the enforcing
  backstop is the engines' hard wall-clock cap (above). The full digest is also on demand via `/peek`.
  Async failures are ALWAYS reported; the runtime `DelegationLedger` vetoes a blind retry loop (an
  identical agent+model+task delegation that failed twice is stopped before it spawns). Coaching is
  gated by `coaching: on` AND `canUseBus`.

**Runtime reinforcement of the hand-off default** comes as a standing part and a reactive part, because
a persona directive lives at the TOP of the prompt and its pull decays as recent tool output balloons:

- The **delegation brief** (`core/brief.ts`) is the STANDING half: live roster (agents + teams + flows)
  and the hand-off default, appended to the system-prompt TAIL every turn, where recency wins the
  tug-of-war a top-of-prompt line loses. It regenerates from the live registry (so it can't desync) and
  filters to the active persona's `delegate` allowlist. It never dictates how MANY sub-agents or which
  shape — that is each persona's own method.
- The **nudges** (`core/nudge.ts`, on by default) are the REACTIVE half, landing in RECENT context on
  the event that warrants them:
  - **DelegationNudge** — a `tool_result` hook watches the supervisor's own tool stream and, when a
    delegating persona grinds heavy work by hand (output burn since the last `delegate`/`council`
    crosses a threshold), appends a one-line "hand it off" reminder to that command's result. A
    successful hand-off resets the streak; a failed one keeps it and returns a re-dispatch hint.
  - **PersistenceNudge** — the counterweight to premature surrender: a delegated leg's report carrying
    `[BLOCKED]`/`FLAG: UNKNOWN` gets a "don't bank it yet" reminder. All three delivery paths carry it
    (sync `delegate`/`council`, background completion, `intercom wait`), but coverage isn't identical:
    the sync path scans the WHOLE tool result including failed legs, while `renderCompletion` scans
    only `status === "done"` runs by design — a failed background/`wait` leg already gets a failure
    block, so a `[BLOCKED]` marker there doesn't also get the persistence note. Same marker, same leg,
    different counterweight depending on how it was collected.
  - **The off switch covers every path.** `PI_PERSONA_NUDGE=off` silences DelegationNudge entirely and
    PersistenceNudge on every collection path (sync result, background notifier, `intercom wait`).

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
