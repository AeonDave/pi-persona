# Architecture

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
| **Agent** | a unit of work that gets spawned (prompt + model + tools); does not orchestrate | `agents/*.md` |
| **Strategy** | an execution shape (vote, loop, fan-out) authored as code on the SDK | `src/orchestration/strategies/*.ts` |
| **Flow** | a declarative DAG that composes strategies into phases with `needs` edges + gates | `flows/*.flow.json` |
| **Team** | a named roster of agents a strategy runs over | `teams.yaml` |
| **Contract** | the structured shape a sub-agent returns, so votes/judges tally | `contracts/*.contract.json` |

A persona binds to an orchestration mode → which selects a built-in shape or a strategy/flow → which
runs over a roster of agents → lowering to engine primitives + deterministic JS reducers. A persona
file *is* an agent file with `persona: true` plus the orchestration grammar; one frontmatter engine
parses both.

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
  default-allow). Prompt text is advisory only. Restricting `tools` keeps `delegate` unless explicitly
  denied; `canUseBus` is OFF only when the persona explicitly denies `intercom`.
- **I5 — Flows are the top tier.** A declarative DAG (statically verified: acyclicity, references
  resolve, join reducers valid) above strategies. The flow engine stays thin — parse, verify,
  schedule, persist, resume — and a flow node may call any strategy. Journaled: finished nodes replay
  from disk with no re-spend.
- **I6 — Spawning is opportunistic by default; mandatory only when the persona declares it.** Two
  first-class cases: *opportunistic* (`mode: solo` / no block — the supervisor MAY delegate by its own
  judgement; never forced) and *mandatory* (`mode: strategy|flow|parallel|pipeline` with a roster —
  the engine runs the shape; the LLM can't opt out, only do its part). A persona picks exactly one.
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
  strategy/flow + the declarative grammar; the persona file is the control surface.
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

Downward-only, acyclic dependencies: `core ← all`; `engine`/`bus → core`; `orchestration →
engine + bus + core`; `persona → orchestration + core`; `tools`/`ui → lower layers`;
`extension.ts` wires everything to `pi.*`.

- **`src/core/`** — pure kernel (no Pi imports, unit-tested): `frontmatter`, `permissions` +
  `capabilities`, `contract` (+`parseContract`), `config`, `discovery`, `seed`, `fence`
  (`fenceUntrusted` / `attributeInbound`), `models`, `brief` (`buildDelegationBrief` — the per-turn
  delegation brief: live roster + standing hand-off default, rendered to the system-prompt tail),
  `nudge` (the two runtime-reinforcement state machines, `DelegationNudge` + `PersistenceNudge`),
  `timer` (`TimerScheduler` — the pure alarm engine behind the supervisor `timer` tool; on fire it
  wakes the session through the same idle-gated delivery as async completions), `types`.
- **`src/engine/`** — "run an agent → `AgentResult`", backend-agnostic: `child.ts`, `inproc.ts`
  (default), `adapter.ts` (child-engine adapter), `fallback.ts` (provider fallback), `async.ts` (async
  tracker / peek), `worktree.ts` (git-worktree isolation), `stream.ts` (event → state).
- **`src/orchestration/`** — the heart: `sdk.ts` (the Strategy SDK), `strategy.ts` (registry +
  `knownParams`), `strategies/*.ts`, `voting.ts`, `judge.ts` (anonymise-for-judge), `reducers.ts`,
  `roster.ts` (teams + `rosterSpec`), `flow*.ts` (DAG + JSONL journal + gates), `render.ts`.
- **`src/bus/`** — coordination: `inproc.ts` (handle-based mailbox: send/ask/reply/onMessage),
  `contact.ts` (child `contact_supervisor`), `peers.ts` (child `contact_peer`), `broker/` (opt-in
  cross-process relay: `paths`/`framing`/`messages` pure, `host`/`client` over `node:net`).
- **`src/persona/`** — identity: `persona.ts` (parse + `expandCouncilPreset`), `controller.ts`,
  `gating.ts`, `orchestrate.ts`, `config-store.ts`.
- **`src/tools/`** — `delegate.ts`, `intercom.ts`. **`src/ui/`** — agent tree/overlay, model picker.
- **`src/bridge.ts`** — the child-mode-only wiring, loaded instead of the full extension when
  `PI_PERSONA_BUS` is set (a broker child).
- **`src/extension.ts`** — the single `ExtensionFactory`: wires tools/commands/hooks/engines,
  `/doctor`, seeding.

## The two engines

Both backends sit behind the `StrategyEngine` seam (`run(spec, onProgress?, signal?, onSteerable?) →
AgentResult`) and enforce two independent deadlines: `RUN_LIMITS.timeoutMs` as an **idle window** (no
events for that long ⇒ abort; the inproc idle watchdog is disabled for coaching children that
legitimately block on a supervisor reply), and `PI_PERSONA_AGENT_MAX_MS` as an **opt-in hard wall-clock
cap** — a lifetime ceiling armed once and never reset that, when set, settles a busy-but-non-converging
child (a loop that keeps emitting) the idle window never catches. OFF by default (0 = unlimited) so a
healthy, progressing child is never killed mid-work; the idle window + token budget remain the always-on
backstops. Both classify as `failureKind: "timeout"` (never a provider reroute).

- **InProcessEngine** (default) — a `createAgentSession` per sub-agent: cheaper, shares the host's
  auth/model registry, and **steerable** (inject a live user message into a running sub-agent).
- **ChildProcessEngine** (`PI_PERSONA_ENGINE=child`, the correctness baseline) — spawns `pi --mode
  json -p`, delivering the task over **stdin** (never argv — a flow-phase task would blow Windows'
  ~32 KiB command-line cap). The path worktree isolation always uses.

`buildEngine` wraps the chosen backend with **provider fallback** (`engine/fallback.ts`): a run whose
model's PROVIDER fails at call time (auth/outage/5xx/model-not-supported) is retried on the same model
id under another authenticated provider, walking the whole chain (session provider first). Only
`failureKind === "provider"` reroutes; abort/timeout/contract/unknown/agent are terminal — engines
classify the cause on the `AgentResult`.

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
- **Cross-process broker** (opt-in, `PI_PERSONA_BROKER=1`; `bus/broker/`) — gives child-process runs
  and every `isolation: worktree` leg the SAME comm plane and **steer** the in-process ones have. It is
  a session-scoped (POSIX socket / Windows named pipe under the session id), supervisor-hosted **relay
  into the local `InProcessBus`**: a connected child is indistinguishable from an in-process one, so the
  supervisor side (intercom, idle notifier, f9, peek) is unchanged BY CONSTRUCTION. Off by default ⇒
  the host never starts and the child spawns byte-identical to pre-broker pi-persona.

## exocom — the external plane

A separate plane (`src/exocom/`) from everything above, with a different shape entirely: every plane
in "the comm plane in practice" is **internal** to one supervisor's own run — hierarchical, keyed by
that supervisor's session id, talking to children *it* spawned. **exocom is flat and external**:
independent, top-level pi instances sharing a workspace — no parent/child relationship — discover each
other and message peer-to-peer. (The names encode the split: intercom = internal comm; exocom =
external comm.)

- **Opt-in, OFF by default.** `PI_PERSONA_EXOCOM=1` (env) or `--exocom` (a `pi.registerFlag`
  convenience); additionally gated by the active persona's `canUseBus`, re-evaluated on every persona
  switch (`reconcileExocom`) — switching to a bus-restricted persona tears the plane down, switching
  back to one that allows it rejoins. OFF ⇒ no bind, no registry entry, no tools registered.
- **Discovery — a workspace-scoped file registry, not an elected hub.** Each instance binds its own
  socket (POSIX) / named pipe (Windows), self-registers one JSON entry under
  `<agentDir>/pi-persona/exocom/<workspace-hash>/agents/<session-id>.json`, and heartbeats it; discovery is
  just reading that directory. Dead-pid and stale-heartbeat entries are pruned on read — no host
  election, no failover, genuinely peer-to-peer.
- **Interaction model — one-way + async reply, never blocking.** `exocom_send` returns a `msg_id`
  immediately; a reply is just another `exocom_send` with `in_reply_to` set, delivered back as a
  correlated follow-up — no blocking await, no mutual-wait deadlock class. `target: "*"` broadcasts to
  every live peer (best-effort; one unreachable peer doesn't fail the rest).
- **Identity is session-stable, persona is presence metadata.** Each instance gets a collision-aware
  call-sign (`orion`, `vega`, …) derived from its session id and independent of persona. Persona,
  model, and context usage are refreshed on heartbeat; changing persona never changes the registry
  key or grants authority over another peer.
- **Fenced and attributed from the REGISTRY, never the envelope — the security core.** An inbound
  message is head-truncated, then delivered as `attributeInbound(label, fenceUntrusted(text))` — the
  same fence/attribute primitives the broker/peer plane above uses. `label` comes from the registry
  entry keyed by the connecting session, never the envelope's self-reported `from_name`, so a peer
  cannot spoof its identity. A message over the inline budget spills to a workspace-scoped artifact
  file (a small preview stays inline) rather than landing whole in the receiver's context. Guardrails:
  a hop cap, a per-sender rate+byte budget, and a (sender, msg_id) dedup set so an at-least-once resend
  can't double-trigger a turn.
- **Tools are lazy and fail closed.** `exocom_list` exposes presence and
  `exocom_send({ target, message, in_reply_to? })` sends one-way messages. Pi has no dynamic
  unregister API, so definitions registered by a prior join may remain in the registry; the live
  accessor, capability gate, and active-tool set all deny them whenever the plane is stopped.

exocom never touches the delegate/council/broker path. A single instance can be **both** a supervisor
(delegating its own spawned children via intercom/broker) **and** an exocom peer (collaborating with
independent sibling instances) at once — the planes are independent and independently gated.
The process that initiates a collaboration is merely the coordinator de facto: the plane remains
flat, and no peer gains stop/steer authority over another. Those controls exist only on the
hierarchical intercom plane.

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
- The **nudges** (`core/nudge.ts`, `config.nudge`, on by default; `PI_PERSONA_NUDGE=off` silences BOTH) are
  the REACTIVE half, landing in RECENT context on the very event that warrants them:
  - **DelegationNudge** — a `tool_result` hook watches the *supervisor's own* tool stream and, when a
    delegating persona grinds heavy work by hand (output burn since the last `delegate`/`council` crosses a
    threshold), appends a one-line "hand it off" reminder to that command's result. Sub-agents run in their
    own sessions, so the hook only ever sees the supervisor's tools; a hand-off resets the streak.
  - **PersistenceNudge** — the counterweight to premature surrender: when a delegated leg's report carries an
    explicit `[BLOCKED]`/`FLAG: UNKNOWN` marker, it appends a "don't bank it yet" reminder. It rides every
    delivery path — the sync `delegate`/`council` result, the background completion report, and the `intercom
    wait` join (the latter two through `engine/async.ts`'s `renderCompletion`) — so a blocked leg gets the
    counterweight however it is collected.

## Discovery & seeding

- **Precedence (all file kinds):** `builtin < user (~/.pi/agent/persona/…) < project (<root>/.pi/…)`; project
  wins collisions. Personas and agents **share a folder**, split by the `persona: true` marker (a
  persona and an agent must not share a name).
- **Personas/agents load ONLY from the user and project dirs.** The bundled `personas/`+`agents/` are a
  **seed source, not a live discovery layer** — a fresh install shows NO personas until installed.
  `/persona seed` copies missing defaults, `/persona restore` force-restores originals (`core/seed.ts`);
  first-run auto-install is opt-in (`PI_PERSONA_SEED=on`, guarded by a marker). Contracts/presets/teams
  keep a builtin layer (they aren't personas).

## Cross-OS constructs

Never raw `child_process` — reuse Pi's helpers: `getPiInvocation()` (resolve the current `pi` binary),
`killProcessTree` (`taskkill /F /T` on Windows vs POSIX process-group kill), temp/path helpers. Always
attach an `error` listener to every spawned process and socket/server (an unhandled `error` event
crashes the host). Cross-OS is a regression gate: Windows AND POSIX child-spawn + process-tree-kill
must pass. The broker's transport is the only OS-specific code, confined to `bus/broker/`.

## Error-handling & lose-nothing invariants

- Per-run `AbortController`; recoverable failures return `AgentResult.error`/`null` + diagnostics,
  never silently lost. A throwing SDK stage drops that item to `null` (filterable).
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
  plane for independently-launched instances sharing a workspace.
