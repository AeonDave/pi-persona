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

`core → child engine → persona/delegate → strategy SDK → inproc engine → flows`

## Layout (target)

`src/core` · `src/engine` · `src/orchestration` · `src/persona` · `src/tools`
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

**v0.5 cleanup & decisions (audit vs the spec, nothing left behind):** removed dead code —
the unwired `bus/inproc` scaffolding, the `Effort` tier stub (§8, never built), and the
**slim of `EffectiveCapabilities`** to the *enforced* gate (`tools` + `delegateTargets`):
dropped `skills` (a parsed-but-never-enforced *false control*), `limits` (a dead duplicate
of `RunLimits`), `canSpawn` (now derived via `canFanOut`), and `canUseBus`/`canUseProcessTransport`
(the bus/broker placeholders). Filled the spec §4.6 gap: `/doctor` now prints the
**effective-capabilities** line and the (correct) engine backend + flows. Added the **`flow`
tool** so the supervisor self-launches a DAG (guarded like the other orchestration tools).
Deliberately NOT built (and why, so they don't return as debt): the §6 **completion/mutation
guard + acceptance provenance** — there is no auto-accept path to guard (the supervisor always
reads & judges results; verification is composable as an explicit flow phase); **presets**
(§4.5) and **`@self`** (§8) — personas inline their block cleanly, no demand; flow **gates/
checkpoints** — the journal already enables stop/resume, add the schema field when a real flow
needs it.

**Shipped & tested** (239 tests via `node --test`, strict `tsc --noEmit --noUnusedLocals
--noUnusedParameters` clean):
- **v0.1** — `core/*`, `ChildProcessEngine` (stream parser, adapter, UTF-8 streaming, hard
  per-child timeout + abort), persona controller + gating, `delegate` tool, `loader`,
  `extension.ts`. Loadable in real Pi (mock-pi integration tested).
- **v0.2** — voting reducers (status union + bias guards + normalised vote keys + dissent
  preserved on the fallback path), `magi`, persona `params`, mandatory turn-interception (the
  `input` hook auto-runs a strategy persona), `/orchestrate`.
- **v0.3** — async **execution + tracker + peek + completion-notify** (`engine/async`); the
  **unified agent tree + navigable overlay** (`ui/agent-tree`, `ui/agent-overlay`, `f9` /
  `/agents`) with live per-core streaming, spanning strategy cores + delegate legs + async runs.
  (The `bus/inproc` scaffolding was removed in the v0.5 cleanup — never wired; the cross-process
  broker will supply its own transport. `EffectiveCapabilities.canUseBus/canUseProcessTransport`
  remain as the spec'd I4 placeholders for it.)
- **v0.3 polish** — live **message streaming** (the stream parser folds `message_update` →
  transcript + in-progress reasoning, so a thinking core shows its work, not just tokens);
  **fenced-JSON-tolerant** contract parsing (`extractJsonCandidate` — a member's ```json``` no
  longer voids its vote); a **searchable model picker** (`ui/model-picker`) over only the
  **configured** models (`getAvailable`), used by the per-agent ensemble popup, the resolver,
  and `/models`; **canonical votes** (bare option token) so unanimous-but-qualified cores tally
  together; the **council card** renders the readable ruling (not the raw JSON), collapsed by
  default; each core shows its **model** beside its name in the tree.
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
  first run). Bundled personas: coder, review, antagonist, magi, self-repair, elite, planner,
  researcher, reviewer; agents incl. the dynamic skill-driven `operator` and a `verifier`.
- **Strategy set (files on the SDK) + core `reduce.judge`:** the built-ins are `fanout`
  (parallel), `pipeline` (series/chain → also `debate`), `map` (per-item fan-out over a runtime
  list), `critic-loop` (gen↔critic; the basis of `self-repair` with a test-running `verifier`
  critic), `magi` (vote), `council-rounds` (multi-round best-of-X), and `judge` (parallel panel →
  impartial arbiter). Vote-style rendering (readable ruling + dissent) is shared in
  `orchestration/render.ts` (magi + council-rounds). The ONLY core API added was `reduce.judge`
  (§4.3 anonymise-for-judge); everything else is a strategy *file* or persona *config*. A
  registry test guards that every built-in stays reachable by name.

- **v0.4 `InProcessEngine` (`engine/inproc`) — now the DEFAULT backend:** runs sub-agents
  IN-PROCESS via `createAgentSession` (no `pi -p` spawn), behind the same seam. Opt back to the
  spawn-based child engine with `PI_PERSONA_ENGINE=child`. The agent's persona is an **appended
  system prompt** (a scoped `DefaultResourceLoader`); the fork-bomb guard is the env flag
  (`PI_PERSONA_DISABLE` set around session creation → pi-persona self-disables, while auth
  providers like pi-claude still load) plus the orchestration tools excluded; the session factory
  is **injectable** for deterministic tests, and a sub-agent with no model falls back to the
  session model. Unlocks live **steering** — `agent.steer()` threaded engine → SDK/delegate → a
  per-node registry → the f9 overlay (`s` to type a message into a running sub-agent). Validated
  live with free models: delegate + magi council in-process, and steer redirecting a running
  agent mid-run. Harnesses: `scripts/drive.ts` (headless `pi -p` log mode) and
  `scripts/control-test.mjs` (STEER/STOP/RESUME via the in-process engine).
- **v0.5 flows (`orchestration/flow*`, `/flow`):** a declarative DAG over strategies, JSON-first
  (`*.flow.json`, the magi council's ruling). Phases each run a strategy over a roster, wired by
  `needs`; ready phases fan out in parallel and each upstream output threads into its dependents'
  task. Pure core — `parseFlow` (validate + dangling/cycle check), `topoOrder` (Kahn), `runFlow`
  (engine-injected) — is fully unit-tested; `flowHash` pins the DAG (I3, reuses the contract
  hasher) and a **JSONL journal** gives resume (done phases skipped, cleared on success). Discovery
  builtin<user<project (`.pi/flows/`); `/flow <name> <task>` runs it with the live tree (phases →
  cores). Bundled: `flows/deep-review.flow.json`. Live harness: `scripts/flow-test.ts`.

**Remaining (seam-ready; some need a live Pi — do NOT build blind):**
- flow niceties: gates/checkpoints, a `flow` tool (so the supervisor itself can launch one),
  and the cross-process broker (port `pi-subagents-comtac`) for distributed phases.
- niceties: strategy-file loader, the **sequential MAGI deliberation pipeline** (Melchior→
  Balthasar→Casper in chain, vs the parallel vote), a guaranteed first-consult for magi,
  surfacing async runs via the bus (not just follow-up turns).
