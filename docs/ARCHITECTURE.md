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
  ref-counted in `inproc.ts`). Never claim isolation from `fs`/`net`/`process`. The param schema and
  other convenience checks stay **lenient** (warn, never hard-fail) for the same reason.
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
  (`fenceUntrusted` / `attributeInbound`), `models`, `types`.
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
AgentResult`) and enforce `RUN_LIMITS.timeoutMs` as an **idle window** (no events for that long ⇒
abort; the inproc watchdog is disabled for coaching children that legitimately block on a supervisor
reply).

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

**Guidance.** Treat MCP as a **supervisor capability**, not a sub-agent one. Do the MCP-dependent work
in the supervisor and hand sub-agents the resulting **artifacts** (files, findings, targets) to reason
over — the offensive/parallel legs corroborate and analyse; they don't drive the tools. When a
sub-agent genuinely needs to run MCP tools itself (its own independent session, no shared state), route
it through the child engine (`PI_PERSONA_ENGINE=child`, or an agent that runs there).

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

## Supervision & the waiting model

- **sync** — the supervisor actively blocks on the delegate/strategy call (results still stream); no
  idle/peek/steer.
- **async** — the supervisor returns control and goes **idle, spending no tokens**, until woken by an
  **event** (a child's `contact_supervisor`: a `decision`/`interview` blocks for a reply, `progress` is
  one-way) or an **opt-in periodic peek** (`PI_PERSONA_PEEK_MS`, off by default, carrying a compact
  ProgressView digest — never full transcripts). Async failures are ALWAYS reported (never suppressed);
  the runtime `DelegationLedger` vetoes a blind retry loop (an identical agent+model+task delegation
  that failed twice is stopped before it spawns). Coaching is gated by `coaching: on` AND `canUseBus`.

## Discovery & seeding

- **Precedence (all file kinds):** `builtin < user (~/.pi/agent/…) < project (<root>/.pi/…)`; project
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
- Inter-session intercom (the broker endpoint is per-session by design), blocking peer asks, and hard
  param validation are all out of scope by design — see the reasons in [STRATEGIES.md](STRATEGIES.md)
  and the comm-plane section above.
