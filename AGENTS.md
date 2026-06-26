# AGENTS.md — pi-persona

**Read first (binding):**
`docs/superpowers/specs/2026-06-25-pi-persona-implementation-guardrails.md`, then the
architecture spec beside it. The guardrails **win on any conflict**.

## What this is

A single Pi extension unifying the delegation/execution engine + the coordination bus +
switchable supervisor personas, with **file-based orchestration strategies**. Clean
rewrite on Pi-native primitives (`@earendil-works/pi-*`) — no third-party fork.

## Hard invariants (do not violate)

- **I1** `ChildProcessEngine` is the correctness baseline; `InProcessEngine` is a deferred
  optimization behind the `Engine` seam. Behavior tests pass on child-process first.
- **I2** Strategy files are **trusted project code** (project-trust gated), NOT a sandbox;
  safety = runtime limits (budget/depth/concurrency/timeout/abort).
- **I3** Each run pins `contract@hash` + `strategy@version` + `reducer@version`;
  hot-reload affects only *new* runs.
- **I4** Capabilities enforced **at call time** via one `EffectiveCapabilities` object —
  never prompt-only.
- **I5** Flows (L3 DAG) are not v1.
- **I6** Spawning is opportunistic by default; mandatory only when the persona declares it.
- **I7** The opportunistic path must be engineered to *actually fire* (anti-underuse).
- Comms: three disjoint planes — EngineEvent (runtime) / Bus Msg (semantic) /
  ProgressView (derived, never a source of truth).

## Build order (law)

`core → child engine → persona/delegate → strategy SDK → inproc bus → inproc engine → broker/flows`

## Layout (target)

`src/core` · `src/engine` · `src/bus` · `src/orchestration` · `src/persona` · `src/tools`
· `src/commands` · `src/ui` · `src/extension.ts` (single ExtensionFactory).

## Conventions

- TypeScript ESM, loaded by Pi via `jiti`. Import host packages from `@earendil-works/pi-*`
  (do **not** bundle your own copies).
- `core/*` is **pure** (no Pi imports) and unit-tested. Tests run with
  `node --import tsx --test`.
- Cross-OS: use Pi's spawn / process-kill / path / temp helpers, never raw `child_process`.
- TDD for `core/*`; verify with `npm run typecheck` and `npm test` before moving up a layer.
- **Erasable-syntax only** (no TS parameter properties / enums / namespaces) so the code runs
  under `node --experimental-strip-types`, tsx, jiti, and Bun alike.

## Status & roadmap

**Shipped & tested** (165 tests via `node --test`, strict `tsc --noEmit` clean):
- **v0.1** — `core/*`, `ChildProcessEngine` (stream parser, adapter, UTF-8 streaming, hard
  per-child timeout + abort), persona controller + gating, `delegate` tool, `loader`,
  `extension.ts`. Loadable in real Pi (mock-pi integration tested).
- **v0.2** — voting reducers (status union + bias guards + normalised vote keys + dissent
  preserved on the fallback path), `magi`, persona `params`, mandatory turn-interception (the
  `input` hook auto-runs a strategy persona), `/orchestrate`.
- **v0.3** — async **execution + tracker + peek + completion-notify** (`engine/async`); the
  in-process `Bus` seam (`bus/inproc`, scaffolding); the **unified agent tree + navigable
  overlay** (`ui/agent-tree`, `ui/agent-overlay`, `f9` / `/agents`) with live per-core
  streaming, spanning strategy cores + delegate legs + async runs.
- **Invariants wired & tested:** I2 limits (the Strategy SDK enforces maxChildren + token
  budget; `delegate` clamps concurrency/children; child timeout) · I3 per-run contract pinning
  (`makeEngine` pins `contract@hash` on first use) · I4 one `EffectiveCapabilities` resolved on
  activation, consulted by the gate **and** the active-tool set (delegation is preserved under a
  tools allowlist).
- **MAGI redesign (supersedes the I6 mandatory example):** the three cores carry complementary
  biases (Propulsore / Conservatore / Catalizzatore) and run via a **`council` tool** the MAGI
  persona (an executor) consults per decision, then *applies* the ruling and re-convenes —
  state → decision → execution. Per-persona model config (`persona/config-store` →
  `~/.pi/agent/persona/config.json`) runs each ensemble's cores on different models (asked on
  first run). Bundled personas: coder, review, antagonist, magi, elite, planner, researcher,
  reviewer; agents incl. the dynamic skill-driven `operator`.

**Remaining (seam-ready; some need a live Pi — do NOT build blind):**
- v0.3 live **steering** (redirect/resume a running child; child→supervisor channel): needs the
  broker (v0.5) or the InProcessEngine (v0.4). Launch + peek + completion-notify work.
- v0.4 `InProcessEngine`: a second `StrategyEngine` backend on Pi's `AgentHarness`. Drops in
  behind the seam; needs real-Pi wiring + tests (the `bus/inproc` seam is ready).
- v0.5 flows: declarative DAG over strategies (**JSON-first**: `*.flow.json`) + journaled
  resume; cross-process broker (port `pi-subagents-comtac`).
- niceties: strategy-file loader, the **sequential MAGI deliberation pipeline** (Melchior→
  Balthasar→Casper in chain, vs the parallel vote), a guaranteed first-consult for magi,
  surfacing async runs via the bus (not just follow-up turns).
