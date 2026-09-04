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
  `RUN_LIMITS` (`maxChildren`, `maxConcurrency`, `budgetTokens`, `timeoutMs` idle window, `maxDepth`)
  are enforced by the SDK on every `agent()` call and by the engine per child; depth is structural —
  children run with `PI_PERSONA_DISABLE=1` so they cannot spawn at all (the **fork-bomb guard**,
  ref-counted in `inproc.ts`), and with `PI_PERSONA_LEG=1` — a **dedicated** worker-leg marker,
  distinct from the user-settable `PI_PERSONA_DISABLE` kill switch, that a companion extension (e.g.
  pi-persona-mind) reads to tell a real delegated leg from a disabled supervisor. Never claim isolation
  from `fs`/`net`/`process`. The param schema and other convenience checks stay **lenient** (warn,
  never hard-fail) for the same reason.
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
  (`fenceUntrusted` / `attributeInbound`), `models`, `brief` (`buildDelegationBrief` — the per-turn
  delegation brief: live roster + standing hand-off default, rendered to the system-prompt tail; and
  `buildExocomBrief` — the per-turn peer brief: live exocom peers as bounded identifiers, the
  peer-vs-sub-agent split, and the relevance bound on an exchange),
  `nudge` (the two runtime-reinforcement state machines, `DelegationNudge` + `PersistenceNudge`),
  `display-label` (`sanitizeDisplayLabel` — an untrusted name reduced to bounded identifier metadata
  before it is interpolated outside a fence),
  `timer` (`TimerScheduler` — the pure alarm engine behind the supervisor `timer` tool; on fire it
  wakes the session through the same idle-gated delivery as async completions),
  `time` (`formatDuration` / `peerSentLabel` / `sessionElapsedLabel` / `buildSessionAnchor` — the
  elapsed-time readings and the prompt-cache rule that sets each one's granularity), `types`.
- **`src/engine/`** — "run an agent → `AgentResult`", backend-agnostic: `child.ts`, `inproc.ts`
  (default), `adapter.ts` (child-engine adapter), `fallback.ts` (provider fallback), `async.ts` (async
  tracker / peek), `worktree.ts` (git-worktree isolation), `stream.ts` (event → state),
  `handles.ts` (one bus-handle sequence shared by BOTH engines), `signals.ts` (`combineSignals`).
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
  `envelope.ts`/`inbound.ts` (wire format + the pure guardrailed
  delivery chain: hop cap, dedup, budgets, truncation, fence/attribute), `limits.ts` (constants),
  `guards.ts` (`SenderBudget`/`SeenMessages`), `ledger.ts` (scope JSONL work ledger),
  `wait.ts`/`gate.ts` (non-blocking join + inbound constrained-turn allowlist),
  `install.ts` (the feature's composition adapter: session-scoped plane + ledger + wait/tool/hook
  wiring; not an ExtensionFactory and not constrained to the transport layer's dependencies).
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
AgentResult`) and enforce three independent deadlines: `RUN_LIMITS.timeoutMs` as an **idle window** (no
events for that long ⇒ abort; the inproc idle watchdog is disabled for coaching children that
legitimately block on a supervisor reply), `PI_PERSONA_AGENT_MAX_MS` as an **opt-in hard wall-clock
cap** — a lifetime ceiling armed once and never reset that, when set, settles a busy-but-non-converging
child (a loop that keeps emitting) the idle window never catches (OFF by default, 0 = unlimited, so a
healthy, progressing child is never killed mid-work; the idle window + token budget remain the always-on
backstops) — and `PI_PERSONA_AGENT_STARTUP_MS` as a **startup deadline** (default 300000, `0` disables):
a child that makes ZERO progress — no completed turn, no tokens, no streamed output — within the window
is killed as a stalled start. It fast-fails the "never started" case the generous idle window is too
slow for — notably a headless `mcp: true` leg whose `pi-mcp-adapter` hangs on interactive OAuth; the
first real progress cancels it, so a slow-but-streaming turn is never touched. All three classify as
`failureKind: "timeout"` (never a provider reroute).

- **InProcessEngine** (default) — a `createAgentSession` per sub-agent: cheaper, shares the host's
  auth/model registry, and **steerable** (inject a live user message into a running sub-agent).
- **ChildProcessEngine** (`PI_PERSONA_ENGINE=child`, the correctness baseline) — spawns `pi --mode
  json -p`, delivering the task over **stdin** (never argv — a flow-phase task would blow Windows'
  ~32 KiB command-line cap). The path worktree isolation always uses the child engine.

Tool grants have three distinct states on both engines: absent inherits Pi's session defaults,
a non-empty array is an allowlist, and an explicit empty array means no tools (`--no-tools`
on the child backend). Denylists are then applied independently through `excludeTools` /
`--exclude-tools`; no mapper may collapse the empty grant into the absent/default state.

`isolation: worktree` is fail-closed. It requires a clean Git checkout so the detached `HEAD` view
cannot silently omit staged/unstaged/untracked supervisor work. A non-repository, dirty checkout,
worktree creation failure, successful leg without a real unified-diff artifact, or artifact over the
bounded return limit fails the leg; the base engine is never invoked against the user's real tree as
an isolation fallback. The generated diff is returned to the supervisor before the temporary tree is
removed.

Transient retries inside one agent session belong to the host **Pi runtime** and its `retry.*`
settings. pi-persona neither parses retry notation from prompts nor schedules its own backoff. Both
backends read those settings from the same resolved global agent directory: the in-process backend
passes it to `createAgentSession`, and spawned child Pi processes receive it as
`PI_CODING_AGENT_DIR`. Exact attempt counts and delays therefore follow the installed Pi version and
configuration, not a persona contract.

`buildEngine` wraps the chosen backend with **provider fallback** (`engine/fallback.ts`): a run whose
model's PROVIDER fails at call time (auth/outage/5xx/model-not-supported) can retry the same model id
only when the selection was unpinned/default, and only through the data-driven provider policy for
that model family. A provider-qualified `spec.model` is an explicit provider and billing pin, so it is
strict by default; callers must deliberately opt it into cross-provider recovery. Only
`failureKind === "provider"` reroutes; abort/timeout/contract/unknown/agent are terminal — engines
classify the cause on the `AgentResult`. This prevents an explicitly selected OpenAI or native Claude
leg from silently moving to an unrelated paid provider.

### MCP (and other `session_start`-scoped extensions) in sub-agents

**A sub-agent does NOT share the supervisor's MCP session, and an in-process sub-agent gets NO MCP at
all.** MCP servers in Pi are provided by a separate extension (`pi-mcp-adapter`), which opens its
connections inside a `session_start` hook. Two consequences of the seam:

- The **in-process engine** builds a fresh `createAgentSession` and only ever calls `session.prompt()`
  — it never fires the session's `session_start` lifecycle (that requires `AgentSession.bindExtensions`).
  So `pi-mcp-adapter` registers its `mcp*`/direct tools at load (they *appear* in the sub-agent) but
  never initializes the connection: calls come back **"MCP not initialized"**. The tools are present
  but dead.
- The **child engine** spawns a real `pi -p`, whose normal startup DOES fire `session_start`, so
  `pi-mcp-adapter` initializes — but as that child's **own** connection (its own `npx`/stdio servers,
  its own HTTP clients). It is a *separate* MCP session, not the supervisor's: it does not see the
  supervisor's MCP workspace/interactive-shell state.

Firing `session_start` for every in-process sub-agent is deliberately NOT done: each would spin up the
full MCP fleet (every stdio server spawned, every HTTP server reconnected) N times per fan-out, and the
adapter's OAuth/UI/consent machinery assumes an interactive session. There is no cheap way to *share*
one live MCP connection across sessions through the current seam.

**The `mcp: true` opt-in — a delegable MCP leg.** Because the child engine DOES fire `session_start`
(it spawns a real `pi -p`), a sub-agent that needs live MCP tools is routed there: mark the agent
`mcp: true` in its frontmatter, or pass `mcp: true` on a `delegate` task/leg (`AgentRunSpec.mcp`). The
engine wrapper then runs that one leg through `childEngineAt(root)` — the exact mechanism a
`isolation: worktree` leg already uses for MCP, minus the git worktree. The child loads `pi-mcp-adapter`
(it is in the user's `packages`; children never pass `noExtensions`) and connects to the SAME MCP
servers from `~/.pi/agent/mcp.json`. Cost is one `pi` spawn per leg — for an **HTTP** MCP server it is
just a client reconnect to an already-running endpoint, not an N× stdio fleet spawn.

**Shared state via a server-keyed backend.** The child gets its OWN MCP *session*, not the supervisor's
handle — but many servers key their state (workspaces, interactive shells, artifacts) by a **session id
passed as a tool argument**, and an HTTP server keeps that state in its own process. So a child that
reconnects to the same HTTP endpoint AND is handed the supervisor's session id operates on the SAME
server-side state. Put the session id in the task packet; the leg then drives the shared workspace
directly. (A pure stdio server whose state lives in-process is genuinely separate — there `mcp: true`
gives the leg its own clean session, not a shared one.)

**Guidance.** Default: treat MCP as a **supervisor capability** — do the MCP-dependent work up top and
hand sub-agents the resulting **artifacts** (files, findings, targets) to reason over. When a leg must
DRIVE MCP itself (breadth enumeration you want off the supervisor's context, an independent tool run),
delegate it with `mcp: true` and pass the session id — the leg reaches the tools and, on an HTTP
backend, the shared workspace. Do not over-restrict such an agent's `tools` allowlist, or the `mcp*`
tools get filtered out of its active set.

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
  reply), `reply`, `onMessage`. `contact_supervisor` (child→supervisor, gated by a persona's
  `coaching: on`) and `contact_peer` (sibling→sibling) are the child-side tools bound onto it.
- **Sibling peer comm** — a strategy opts a run in via `AgentRunSpec.peers` (gated by `canUseBus`).
  The child gets `contact_peer` (`list`/`send`, ONE-WAY so peers can never deadlock; per-engine-instance
  scoping; a send budget). The engine's **delivery bridge** steers incoming bus messages into the child
  session, fenced with the sender attributed OUTSIDE the fence (`attributeInbound`, shared by both
  engines so the anti-spoofing format can't drift) — the same bridge delivers the supervisor's
  `intercom send`. `debate`/`pair` always use peers; `map`/`synthesize` opt in via `params.peers`;
  `magi`/`judge`/`fanout`/`compete`/`council-rounds` stay peer-less by design (independence is a bias
  guard — see [STRATEGIES.md](STRATEGIES.md#bias-guard-invariants-do-not-fix-these)).
- **Cross-process broker** (on by default; `PI_PERSONA_BROKER=off` to restore pre-broker spawn;
  `bus/broker/`) — gives child-process runs, every `isolation: worktree` leg, and every `mcp: true`
  leg the SAME comm plane and **steer** the in-process ones have. It is a session-scoped (POSIX
  socket / Windows named pipe under the session id), supervisor-hosted **relay into the local
  `InProcessBus`**: a connected child is indistinguishable from an in-process one, so the supervisor
  side (intercom, idle notifier, f9, peek) is unchanged BY CONSTRUCTION. Off ⇒ the host never starts
  and the child spawns byte-identical to pre-broker pi-persona.

### Presentation is a projection, not another comm plane

The semantic payload and its human presentation have different lifetimes. A result remains complete
for the supervisor and for explicit retrieval; the default TUI projection is deliberately small:

- async completions are coalesced and bounded fairly across legs; `intercom { action: "result", to:
  "<run-id>" }` retrieves one retained result in full and consumes a still-pending duplicate
  notification;
- collapsed delegate/intercom/council/flow cards show state, identity, a short sanitized preview, and
  Pi's configured expand-key hint. Each surfaces failure at the top of its own card in the shape it
  has: the delegate card **sorts** failed legs ahead of successful ones (`extension.ts`), a failed
  council/flow card leads with the cause in its title, and an `intercom wait` card leads with the
  `N settled — X done, Y failed` tally (the per-leg causes sit in the body, below the preview cut —
  `buildCompletionReport` emits DONE blocks before the failure block, and `wait` reports
  `details.ok: true` because the *wait* succeeded, so the card gets no `failed` prefix);
- follow-up cards (`pi-persona`, exocom) retain their complete semantic content but render a bounded
  preview until expanded; terminal escape/control sequences are removed from the visible projection;
- the sticky agent and exocom widgets have fixed row budgets. F9/`/agents` and paginated
  `exocom_list({ offset, limit })` are the explicit detail surfaces, so a wide fan-out cannot
  permanently push the editor off screen or dump an entire peer registry into model context;
- `/flow` and `/orchestrate` append durable, TUI-only expandable result entries. They do not dump a
  large notification and do not add a second copy to the model context;
- the F9 overlay's *directed* keys (`x` stop, `s` steer) act only on the agent the ▸ marker still
  shows. Runs settle and are pruned under the cursor while a keystroke is in flight, so when the
  aimed-at agent is the one that vanished, the selection re-anchors visibly and that keypress is
  spent re-aiming (`src/ui/agent-overlay.ts`) — aborting an agent the user never chose is not
  undoable. ↑↓, ⏎ and the scroll keys never refuse: they cost nothing to repeat.

This is a UI invariant only: truncating a collapsed card must never be confused with truncating the
underlying result or changing a strategy's contract.

## exocom — the external plane

A separate plane (`src/exocom/`) from everything above, with a different shape entirely: every plane
in "the comm plane in practice" is **internal** to one supervisor's own run — hierarchical, keyed by
that supervisor's session id, talking to children *it* spawned. **exocom is flat and external**:
independent, top-level pi instances sharing one explicit Exocom scope — normally the same workspace,
or a Pi in another workspace that joined by code — discover each other and message peer-to-peer. There
is no parent/child relationship. (The names encode the split: intercom = internal comm; exocom =
external comm.)

Exocom still supplies fenced one-way postcards and presence; chat `message` never mutates shared
work state. On top of that, a workspace work ledger (`ledger.ts`, tools in `tools/exocom-work.ts`)
records claims/asks/answers/progress/releases. `exocom_ask` canonicalizes the public `exocom_list` target
through `plane.resolvePeer` (raw session ids on the ledger, never the display name). A pending ask
to this session constrains the turn (`gate.ts`: answer/decline plus read-only tools) and both the
prompt renders a bounded `pendingAskPrompt` — one complete, fenced next question plus an omitted
count; the tool gate repeats only its `ask_id`, not the peer text. Registry display name is keyed by
`from_session`, never envelope `from_name`. `exocom_wait` is non-blocking and wakes on a separate
idle notifier from postcard `exocom_received` delivery. Clean shutdown attempts to release this
session's claims and outbound asks; if that best-effort write cannot complete, the vanished registry
owner is pruned on the next ledger transaction (live registry sessions are the lease). This gate is
cooperative coordination for participating local Pi processes, not filesystem authorization or
isolation from another same-user process. It is not a delegate/council replacement and not a task/run
workflow runtime.

- **Opt-in, OFF by default.** `PI_PERSONA_EXOCOM=1` (env) or bare `--exocom` joins the current
  workspace. `--exocom=Ab0T` joins the existing workspace scope identified by that exact,
  case-sensitive four-character Base62 alias from any other cwd. Pi's extension flag API cannot
  express a boolean flag with an optional string value, so the extension keeps the registered flag
  boolean for backward compatibility and recovers only the exact equals form from raw argv. Unknown,
  malformed, or conflicting codes fail closed without falling back to the caller's workspace. The
  selection is frozen for the session. Participation is additionally gated by the active persona's
  `canUseBus` and ability to call at least
  one obligation closer (`exocom_answer` or `exocom_decline`), re-evaluated on every persona switch
  (`reconcileExocom`). A bus-restricted or answerless persona leaves the registry rather than
  advertising a participant that can be permanently wedged by an inbound ask; switching back to an
  admissible persona rejoins. Individual targeted tool denies still win. OFF ⇒ no bind, no registry
  entry, no tools registered.
- **Discovery — a scope-selected file registry, not an elected hub.** Bare Exocom preserves the
  existing workspace-hash paths byte-for-byte. A persistent alias map under the effective agent
  directory resolves each four-character code to that full 24-hex workspace identity. Allocation is
  atomic, collision-aware, bounded, and never assigns a reserved code to another workspace; the short
  code is presentation/routing convenience, not the storage identity. Each instance binds its own
  socket (POSIX) / named pipe (Windows), self-registers one JSON entry under
  `<agentDir>/pi-persona/exocom/<workspace-hash>/agents/<session-key>.json` (`sessionKey` — a hash of
  the session id, so the name is path-safe; a read drops any entry whose filename is not the hash of
  its own `session_id`), and heartbeats it; discovery is
  just reading that directory. Dead-pid and stale-heartbeat entries are pruned on read — no host
  election, no failover, genuinely peer-to-peer.
- **Workspace identity remains the Pi's actual cwd.** The chosen scope controls registry, endpoint,
  ledger, and artifact paths. It never overwrites the member's home workspace identity. Every new
  registry entry publishes an all-or-none safe tuple (`workspace_id`, four-character
  `workspace_code`, bounded `workspace_label`); peer lists, the standing brief, widget, and `/exocom`
  label a peer as same-workspace or external without putting its absolute `cwd` in model output.
  External peers are full Pi instances that can inspect the files in their own workspace; paths are
  not implicitly shared.
- **Interaction model — postcards plus a durable, non-blocking join.** `exocom_send` returns a
  `msg_id` immediately; a chat reply is just another `exocom_send` with `in_reply_to` set, delivered
  back as a correlated follow-up. `target: "*"` broadcasts postcards to every live peer
  (best-effort; one unreachable peer doesn't fail the rest). Work coordination is separate:
  `exocom_ask` commits an obligation to the ledger, `answer`/`decline` settles it, and `exocom_wait`
  arms a bounded idle wake rather than blocking the tool call. The signed semantic frame is a wake
  signal; the shared ledger remains the source of truth if delivery is deferred.
- **Cross-workspace writes are advisory-only in v1.** Repository-relative claim paths have meaning
  only in the workspace that owns the selected scope. A member whose home workspace differs from the
  scope therefore does not receive `exocom_claim`, and the tool and signed-frame receiver both reject
  a foreign claim. It may still send postcards, inspect its own files, ask, answer/decline, wait,
  journal progress, and release its outbound asks. General multi-repository write coordination would
  require a versioned resource namespace; path strings from unrelated repositories are never compared
  as if they named the same files.
- **Reply routing is session-stable.** `exocom_list` keeps human display names (`name`/`name#2`),
  while sends and inbound reply hints use `name@<96-bit session hash>`. The name prefix is
  presentation only; routing uses the session hash, so a retained qualified target remains valid
  after that peer renames. Multiple matches for the same suffix fail closed as ambiguous rather than
  guessing; the telemetry projection mirrors this rule so a successful retained-target send does not
  lose its `message.sent` edge. The authenticated registry entry
  (endpoint and signing key) is cached with the bounded inbound context, so a stale/pruned sender
  cannot be retargeted to a same-name twin and its live socket can still receive the reply. The hint
  is CONDITIONAL, not an invitation: it carries the target and the correlation id under "reply only
  if it changes what someone does, otherwise send nothing". A delivery is a fresh prompt on the
  receiver, and a bare `Reply:` would make answering the default and silence the exception — which
  is how a settled point keeps running on agreement and thanks.
- **Identity is session-stable, persona is presence metadata.** Each instance joins with no chosen
  call-sign (a blank registry placeholder). If the active persona permits `exocom_name`, then on its
  first unconstrained task turn the existing model is instructed to make that tool its first action
  and invent a short handle from the task — no catalog and no extra naming model call. A pending
  ledger ask owns the turn, so settlement precedes naming and the bootstrap returns on the next free
  turn. A targeted deny suppresses the prompt as well as the tool. `exocom_name` replaces that display label only — the registry entry
  stays keyed by the session, so a rename cannot take over another peer's slot or its inbound
  replies. Persona, model, and context usage are refreshed on heartbeat; changing persona never
  changes the registry key or grants authority over another peer.
- **Fenced and attributed from the REGISTRY, never the envelope — the security core.** An inbound
  message is head-truncated, then delivered under a header the RECEIVER writes (`[label] —
  message|reply`) above a body quoted by `fencePeer` — the peer flavor of the same `core/fence.ts`
  primitives the planes above use (`fenceUntrusted`/`attributeInbound`), same anti-injection
  discipline, worded for an equal-status collaborator instead of a leg you commissioned. Attribution
  sits OUTSIDE the fence, so a payload can't spoof its sender by closing the block, and `label` comes
  from the registry entry keyed by the connecting session, never the envelope's self-reported
  `from_name`, so a peer cannot spoof its identity. A message over the inline budget spills to a
  scope-selected artifact file (a small preview stays inline) rather than landing whole in the
  receiver's context. The spill is an exact, validated descriptor (`preview`, `path`, `size`) rendered
  as readable fenced metadata; arbitrary JSON is ordinary peer text, and an inline-only truncation
  never claims that an artifact exists. A descriptor is verified at the RECEIVER's transport boundary
  before anything reaches its model: the path must be the selected scope's own `artifacts/<msg_id>.txt`,
  the file must be a regular unlinked file whose size equals the declared one, and that size must sit
  between the inline cap and `ARTIFACT_MAX_BYTES`. The receiver then reads through one held,
  identity-checked descriptor, rechecks that the source did not change, and writes an unpredictable
  receiver-owned snapshot with exclusive creation; only that snapshot path is advertised to the
  model. Anything else is NACKed rather than exposed as readable. Received snapshots join sender
  spills under the same TTL/file-cap cleanup. The per-sender byte window charges only what crossed
  the wire, not a spill's declared size, so a legitimate large spill is delivered instead of being
  refused as "budget".
  Transport guardrails — enforced at the boundary, and not the whole discipline: a hop cap, a
  per-sender rate+byte budget, and a (sender, msg_id)
  dedup set so an at-least-once resend can't double-trigger a turn. Reply-hop history is keyed by
  that same sender identity, so two peers reusing a `msg_id` cannot reset each other's loop depth.
  The fencing and registry attribution above are part of the same set, and an exchange's LENGTH is
  bounded prompt-side instead: the per-turn peer brief (`core/brief.ts`) carries a relevance bound —
  send only what changes what someone does, stop once a round no longer moves the work the turn is
  for — plus the peer/sub-agent split (a peer for judgement you cannot specify, a sub-agent for work
  you can; the sub-agent half is rendered only where this persona can actually reach one).
  Deliberately not a round count: rounds are often how a hard point gets settled, and a counter
  cannot see whether one still serves the work. `hops` is not the reason — it bounds a THREADED
  reply chain only (it is derived from the inbound context when `in_reply_to` is set and is `0`
  otherwise), so two peers alternating untreaded sends are not depth-bounded by the transport.
  Registry cleanup is ownership-aware (`session_id` + endpoint + signing key) and atomically claims
  an entry before deletion, so a failed/replaced session cannot erase the live replacement's slot;
  socket-file cleanup is likewise conditional on that plane having completed the bind itself.
- **Tools are lazy and fail closed.** `exocom_list({ offset?, limit? })` exposes bounded, paginated
  presence (with exact totals and `nextOffset`),
  `exocom_send({ target, message, in_reply_to? })` sends one-way messages — a target that LOOKS like
  a session-qualified token is resolved only as one and never falls back to a display name (names are
  self-chosen, so the fallback was an interception route), and a peer whose call-sign happens to take
  that shape is reachable through the qualified address the refusal names — and
  `exocom_name({ name })` rebrands this instance's display call-sign (the registry key stays the
  session id, so a rename moves no state, invalidates no retained qualified target, and grants
  nothing). The ledger tools are
  `exocom_claim`, `exocom_ask`, `exocom_answer`, `exocom_decline`, `exocom_wait`,
  `exocom_progress`, and `exocom_release`; they are capability-gated with the postcard tools. Pi has
  no dynamic
  unregister API, so definitions registered by a prior join may remain in the registry; the live
  accessor, capability gate, and active-tool set all deny them whenever the plane is stopped. Plane
  admission requires at least one of `exocom_answer`/`exocom_decline`, because every published peer
  may receive a durable ask and must retain a runtime path to settle it.
- **Inbound delivery is bounded without loss.** Each external message is injected under the same
  byte cap whether it is plain text or an artifact descriptor. Bursts remain FIFO-queued; each
  rate-limited wake drains as many whole messages as fit the bounded batch surface, leaving the rest
  queued in order. Collapsed cards show only a short preview, while expanding the card reveals the
  delivered batch. A presentation cap never discards the rest of the queue.

exocom never touches the delegate/council/broker path. A single instance can be **both** a supervisor
(delegating its own spawned children via intercom/broker) **and** an exocom peer (collaborating with
independent sibling instances) at once — the planes are independent and independently gated.
The process that initiates a collaboration is merely the coordinator de facto: the plane remains
flat, and no peer gains stop/steer authority over another. Those controls exist only on the
hierarchical intercom plane.
The join code is not authentication. Exocom remains cooperative same-user, same-host coordination
between processes that use the same effective Pi agent directory; it is not a remote/network plane,
and a local process able to modify that directory is inside the existing trust boundary.

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
  (`PI_PERSONA_CHECKIN_MS`, ~5 min, `0` disables) that delivers the compact ProgressView digest — never
  full transcripts — so the supervisor can catch a leg going off-track early. Both let an idle
  supervisor steer/stop a wedged or drifting child even when NO completion has fired; the enforcing
  backstop is the engines' hard wall-clock cap (above). The full digest is also on demand via `/peek`.
  Async failures are ALWAYS reported (never suppressed);
  the runtime `DelegationLedger` vetoes a blind retry loop (an identical agent+model+task delegation
  that failed twice is stopped before it spawns). Coaching is gated by `coaching: on` AND `canUseBus`.

**Runtime reinforcement of the hand-off default** comes as a standing part and a reactive part, because a
persona directive lives at the TOP of the prompt and its pull decays as recent tool output balloons:

- The **delegation brief** (`core/brief.ts`) is the STANDING half: a compact block — live roster (installed
  agents + teams + flows) and the hand-off default — appended to the system-prompt TAIL every turn, where
  recency wins the tug-of-war a top-of-prompt line loses. It is regenerated from the live registry (so it
  can't desync) and filtered to the active persona's `delegate` allowlist (a persona that denies `delegate`
  gets none). It never dictates how MANY sub-agents or which shape — that is each persona's own method.
- The **nudges** (`core/nudge.ts`, on by default) are
  the REACTIVE half, landing in RECENT context on the very event that warrants them:
  - **DelegationNudge** — a `tool_result` hook watches the *supervisor's own* tool stream and, when a
    delegating persona grinds heavy work by hand (output burn since the last `delegate`/`council` crosses a
    threshold), appends a one-line "hand it off" reminder to that command's result. Sub-agents run in their
    own sessions, so the hook only ever sees the supervisor's tools; a successful hand-off resets the
    streak, while a failed one keeps the streak and returns an actionable re-dispatch hint.
  - **PersistenceNudge** — the counterweight to premature surrender: when a delegated leg's report carries an
    explicit `[BLOCKED]`/`FLAG: UNKNOWN` marker, it appends a "don't bank it yet" reminder. All three
    delivery paths carry it — the sync `delegate`/`council` result, the background completion report, and
    the `intercom wait` join (the latter two through `engine/async.ts`'s `renderCompletion`) — but they do
    not scan the same text, so the coverage is not identical:
    - the sync path (`PersistenceNudge.observe`) scans the WHOLE `delegate`/`council` tool result, and
      `aggregateResults` folds every leg's body into it, failed legs included — so a leg that fails
      carrying `[BLOCKED]` still gets the note;
    - `renderCompletion` scans only `status === "done"` runs (`r.result?.output`), by design: a FAILED run
      is already surfaced as a failure by `buildCompletionReport`. So a background/`wait` leg that FAILED
      while emitting `[BLOCKED]` gets the failure block and its salvaged partial output, but NOT the
      persistence note. Same marker, same leg, different counterweight depending on how it was collected.
  - **The off switch covers every path.** `config.nudge` (`PI_PERSONA_NUDGE=off`) gates the
    `tool_result` hook — silencing the DelegationNudge entirely and the PersistenceNudge on a sync
    `delegate`/`council` result — and both `renderCompletion` call sites (the background completion
    notifier and `intercom wait`) take their `scan` through the same gate, so "off" means off wherever
    a settled leg is collected, not only on the synchronous path.

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
- The completion/mutation guard keeps child-claimed success ≠ runtime-verified; the depth guard blocks
  fan-out **visibly** at the cap (not hidden).
- Sub-agent output is UNTRUSTED — fenced (`fenceUntrusted`) before it reaches the supervisor as a
  follow-up or tool result (prompt-injection defense).
- The broker host is `unref`'d (never keeps Pi alive) with a permanent error sink; never unlink a live
  socket; teardown is idempotent.

## Reference: the core seams

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
