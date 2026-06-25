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
