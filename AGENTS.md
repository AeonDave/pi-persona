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

**Shipped & tested** (127 tests via `node --test`, strict `tsc --noEmit` clean):
- **v0.1 vertical** — `core/*`, `ChildProcessEngine` (+ stream parser, adapter), persona
  controller + gating, `delegate` tool, `loader`, `extension.ts` wiring, bundled
  coder/review/antagonist personas + agents + `teams.yaml`. Loadable in Pi (typechecks
  against the real ExtensionAPI; mock-pi integration tested).
- **v0.2** — voting reducers (status union + bias guards), `magi` (+ MELCHIOR/BALTHASAR/CASPER
  cores), persona `params` + numeric YAML + 2-level nesting, **mandatory turn-interception**
  (the `input` hook auto-runs a strategy persona's orchestration), `/orchestrate`.
- **v0.3 foundation** — in-process `Bus` seam (`bus/inproc`).

**Remaining (seam-ready; some need a live Pi to verify — do NOT build blind):**
- v0.3 async coaching: async child execution + tracker; `intercom`/`contact_supervisor` tools
  over the Bus; idle + periodic-peek supervision (§4.9). Real coaching of *child-process*
  agents needs the cross-process broker (v0.5) **or** the InProcessEngine (v0.4).
- v0.4 `InProcessEngine`: a second `StrategyEngine` backend on Pi's `AgentHarness` /
  `createAgentSession`. Drops in behind the existing seam; **needs real-Pi wiring + tests**.
- v0.5 flows: declarative DAG over strategies (needs a YAML list-of-maps parser extension, or
  JSON flow files) + journaled resume; cross-process broker (port `pi-subagents-comtac`).
- niceties: strategy-file jiti loader, inline-map `{…}` YAML, effort tiers.
