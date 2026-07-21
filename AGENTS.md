# AGENTS.md — pi-persona

A single Pi coding-agent extension (`@earendil-works/pi-*`) that makes the agent a **supervisor**
of switchable **personas** + file-based **orchestration strategies**. Loaded by Pi via tsx/jiti —
no build step. Design contract (binding on any conflict): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md);
the orchestration layer in depth: [`docs/STRATEGIES.md`](docs/STRATEGIES.md).

## Commands

- Typecheck (must stay clean): `npm run typecheck`  (`tsc --noEmit`, strict)
- All tests: `npm test` · unit only: `npm run test:unit`
- One file: `node --import tsx --test test/unit/core/frontmatter.test.ts`
- Live end-to-end (REAL model calls, spends tokens): `npm run drive -- --persona <name> --model <provider/id> "<prompt>"`
  - Control ops: `LIVE_MODEL=<provider/id> node --import tsx scripts/control-test.mjs` (STEER/STOP/RESUME)
  - Models must be **provider-qualified**, e.g. `claude-pro-max-native/claude-opus-4-8` or `.../claude-haiku-4-5`.

## Conventions

- **Erasable-syntax-only** TS (no enums / namespaces / parameter-properties) — runs under
  strip-types, tsx, jiti, Bun. `erasableSyntaxOnly` is on; keep it that way.
- tsconfig is strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` +
  `noUnusedLocals` + `noUnusedParameters`. Keep `tsc` clean before moving on.
- `src/core/*` is **pure** (no Pi imports) and unit-tested. Import host packages from
  `@earendil-works/pi-*`; never bundle copies.
- **Cross-OS**: use Pi's spawn/kill/path/temp helpers (`getPiInvocation`, `killProcessTree`), not raw
  `child_process`. Windows kill goes straight to `taskkill /F /T`; always attach an `error` listener.
- Two engines behind the `StrategyEngine` seam: **InProcessEngine** (`engine/inproc`,
  `createAgentSession`, DEFAULT) and **ChildProcessEngine** (`engine/child`, spawns `pi --mode json -p`,
  the correctness baseline + the path worktree isolation uses). Opt out with `PI_PERSONA_ENGINE=child`.
  BOTH enforce `RUN_LIMITS.timeoutMs` as an **idle window** (no events/output ⇒ abort; the inproc
  watchdog is disabled for coaching children that may legitimately block on a supervisor reply) AND
  `PI_PERSONA_AGENT_MAX_MS` as an **opt-in hard wall-clock cap** (lifetime ceiling armed once, never
  reset — catches a busy loop the idle window never does; OFF by default (0 = unlimited) so a healthy,
  progressing child runs to completion, set `<ms>` to arm it) AND
  `PI_PERSONA_AGENT_STARTUP_MS` as a **startup deadline** (a child that makes ZERO progress — no
  completed turn / tokens / streamed output — within the window is killed as a stalled start; the
  first real progress cancels it, so a slow-but-streaming turn is never touched; default 90000,
  `0` disables). It fast-fails the "never started" case the generous idle window is too slow for —
  notably a headless `mcp: true` leg whose `pi-mcp-adapter` hangs on interactive OAuth; `adapter.ts`
  turns that (turns===0 + `spec.mcp`) into a clear pre-auth remedy instead of an opaque timeout.
  The child engine delivers the task over **stdin** (`pi -p` prepends piped stdin) — never argv,
  which would hit Windows' ~32 KiB command-line cap on flow-phase tasks. Async delegate launches
  share one `maxConcurrency` semaphore (`Semaphore` in `orchestration/parallel.ts`), so an async
  fan-out can't open more concurrent sessions than a sync one.
- **Cross-process broker** (`src/bus/broker/{paths,framing,messages,host,client}.ts`, opt-in via
  `PI_PERSONA_BROKER=1`, spec B1-B7): session-scoped (POSIX socket / Windows named pipe under the
  session id), supervisor-hosted, lazily started on the FIRST actual child-engine build (a
  `PI_PERSONA_ENGINE=child` run, or any `isolation: worktree` leg — worktree ALWAYS uses the child
  engine). It is a RELAY into the local `InProcessBus`: a connected child is indistinguishable from
  an in-process one, so the supervisor side (intercom, idle notifier, f9, peek) is unchanged BY
  CONSTRUCTION. It gives child-process runs `contact_supervisor`/`contact_peer` AND **steer**
  (closing the child-engine steer gap — `intercom steer`/f9 `s` now work on both engines; a child's
  steer is follow-up-queued, not mid-turn injection). Off (default) ⇒ `deps.broker` is never built,
  the host never starts, and the child spawns byte-identical to pre-broker pi-persona — see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-comm-plane-in-practice).
- **Provider fallback**: `buildEngine` wraps the engine in `withModelFallback` (`engine/fallback.ts`).
  A run whose model's PROVIDER fails at call time (auth/outage/5xx/model-not-supported) is retried on
  the SAME model id under another authenticated provider, walking the whole chain (session provider
  first) until one responds — "priority to the supervisor's provider, but try others and switch on
  error". Only `failureKind === "provider"` reroutes; abort/timeout/contract/unknown/agent are terminal.
  Engines classify the cause on the `AgentResult` (`failureKind` + resolved `modelUsed`); keep those
  set when you touch `inproc.ts`/`adapter.ts` or the fallback silently stops working.
- **Fork-bomb guard**: children run with env `PI_PERSONA_DISABLE=1` so pi-persona self-disables inside
  them. NEVER pass `noExtensions` (it blocks the pi-claude auth provider). The guard is **ref-counted**
  in `inproc.ts` — keep it concurrency-safe (parallel strategies build several sessions at once). Both
  engines also export `PI_PERSONA_LEG=1` for a delegated leg — a **dedicated** marker (unlike the
  user-settable `PI_PERSONA_DISABLE`) so a companion extension can tell a real leg from a disabled
  supervisor; set it in lockstep with the disable guard (in-process guard + child `spawn` env).
- Three disjoint comm planes: **EngineEvent** (runtime) / **Bus Msg** (semantic, `src/bus`) /
  **ProgressView** (derived UI, never a source of truth). Capabilities are enforced at call time via
  one `EffectiveCapabilities`, never prompt-only. Per-run pinning: `contract@hash` is frozen at start.
  Same principle for retries: async failures are ALWAYS reported to the supervisor (never suppressed);
  blind retry loops are stopped by the runtime `DelegationLedger` (an identical agent+model+task
  delegation that failed twice is vetoed before it spawns).
- Dynamic sub-agents: `delegate` shapes an on-the-fly specialist with `role` (extra system prompt,
  appended to the agent's own) + `skills` — prompt-level only, capabilities stay the gate. Async runs
  are joined with intercom `wait` (bounded ≤ the bus-ask timeout; collected results are discarded from
  the pending completion follow-up so they are never double-reported). In interactive sessions
  `delegate` is background-by-default (`sync: true` opts a call out; headless `pi -p` defaults to
  sync so the single turn carries the result).
- **Sub-agent output is untrusted** — wrap it with `fenceUntrusted` (in `extension.ts`) before it
  reaches the supervisor as a follow-up or tool result (prompt-injection defense).
- **Delegation nudges** (`core/nudge.ts`, `config.nudge`, on unless `PI_PERSONA_NUDGE=off` silences
  BOTH): a `tool_result` hook watches the supervisor's OWN tool stream and, when a delegating persona
  grinds heavy work by hand (output burn since the last `delegate`/`council` crosses a threshold),
  APPENDS a reminder to that command's result — runtime reinforcement in recent context, where a
  top-of-prompt persona directive has decayed. Pure state machine (`DelegationNudge`); gated to
  personas holding the `delegate` tool; sub-agents run in separate sessions so the hook only sees the
  supervisor. Its counterweight is **`PersistenceNudge`** — a leg that comes back `[BLOCKED]`/`FLAG:
  UNKNOWN` gets a "don't bank it yet" reminder on whichever path the report arrives (sync result,
  background completion, or `intercom wait` — the last two via `engine/async.ts`'s `renderCompletion`).
  Its standing counterpart is the **delegation brief** (`core/brief.ts`): `before_agent_start` appends
  a live, capability-filtered roster (agents/teams/flows) + a hand-off default to the
  system-prompt TAIL every turn — discovery that survives context burn.
- **Sibling peer comm (in-process)**: a strategy can opt a run into direct sibling messaging
  (`AgentRunSpec.peers` — the `debate` strategy does). The child gets a `contact_peer` tool
  (`bus/peers.ts`): `list`/`send`, ONE-WAY only (blocking stays supervisor-only, so peers can
  never deadlock), peer list scoped per engine instance (never the whole bus), send budget 20.
  Delivery: the in-process engine's bridge steers incoming bus messages into the child session,
  fenced with the sender attributed OUTSIDE the fence — the same bridge delivers the supervisor's
  `intercom send` (previously a dead letter). Gated by `EffectiveCapabilities.canUseBus` (OFF iff
  the persona explicitly denies `intercom`). The child engine ignores `peers`.
  Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-comm-plane-in-practice) + [`docs/STRATEGIES.md`](docs/STRATEGIES.md).
  On the peer plane: `debate` and `pair` always; `map`/`synthesize` opt-in via `params.peers`.
  `magi`/`judge`/`fanout` stay peer-less BY DESIGN — independence is their bias guard
  (uncorrelated errors; an anonymised ballot cannot survive members who talked) — do not "fix"
  this. `compete` runs its competitors with `isolation: worktree` (REQUIRES a git repo; without
  one the wrapper silently degrades to unisolated runs) and returns the winning diff for the
  SUPERVISOR to apply.

## Testing

- TDD: write the failing test first for `core/*` and any behavior change; watch it fail, then fix.
- Done = `npm run typecheck` clean **and** full suite green. The suite has **one** intentional skip
  (see Accepted diagnostics).
- When touching engines / strategies / the comm plane, also verify with a live `scripts/drive.ts`
  run (concurrency, steer, worktree, and contact_supervisor are not fully provable from unit tests).

## Project structure

- `src/core/` — pure kernel: frontmatter, permissions, contract (+`parseContract`), config, discovery, fence (`fenceUntrusted`), brief (buildDelegationBrief — the per-turn roster + standing hand-off default), timer (`TimerScheduler` — the alarm engine behind the `timer` tool), types.
- `src/engine/` — `child.ts`, `inproc.ts` (default), `adapter.ts`, `async.ts` (async tracker/peek), `worktree.ts` (git-worktree isolation), `stream.ts` (event→state).
- `src/orchestration/` — `sdk.ts` (`agent`/`parallel`/`reduce`), `strategy.ts` (registry), `strategies/*.ts`, `voting.ts`, `flow*.ts` (DAG + JSONL journal + checkpoint gates), `roster.ts` (teams + `rosterSpec`: a roster member is a bare name OR an inline `{ agent, role, model, skills }` that specialises one agent — every strategy runs members through `rosterSpec`).
- `src/bus/` — `inproc.ts` (handle-based bus: send/ask/reply/onMessage), `contact.ts` (child `contact_supervisor` tool), `peers.ts` (child `contact_peer` sibling tool — one-way, engine-scoped), `broker/` (opt-in cross-process relay: `paths.ts`/`framing.ts`/`messages.ts` pure, `host.ts`/`client.ts` over `node:net`). `src/bridge.ts` — the child-mode-only wiring loaded when `PI_PERSONA_BUS` is set.
- `src/persona/` — `persona.ts` (parse + `expandCouncilPreset`), `controller.ts`, `gating.ts`, `orchestrate.ts`, `config-store.ts`.
- `src/tools/` — `delegate.ts`, `intercom.ts`. `src/ui/` — agent-tree/overlay, model-picker. `src/extension.ts` — the single ExtensionFactory (wires tools/commands/hooks/engines).
- Bundled data-driven assets (discovery precedence builtin < user `~/.pi/agent/persona` < project `.pi/`):
  `personas/*.md`, `agents/*.md` (personas+agents share a folder, split by `persona: true` — a
  persona and an agent must NOT share a name; e.g. `researcher` is the persona, `research` the agent),
  `teams.yaml`, `flows/*.flow.json`, `contracts/*.contract.json`, `presets/*.preset.json`.
- Personas/agents load ONLY from the user dir (`~/.pi/agent/persona/agents`) and project `.pi/agents` —
  the bundled `personas/`+`agents/` are a **seed source, not a live discovery layer**, so a fresh
  install shows NO personas until the user installs them. `/persona seed` copies missing defaults
  in, `/persona restore` force-restores originals (`src/core/seed.ts`). First-run auto-install is
  **opt-in**: off by default, enable with `PI_PERSONA_SEED=on` (guarded once by marker
  `.pi-persona-seeded`). Contracts/presets/teams keep a builtin layer (they aren't personas).
- `scripts/` — `drive.ts` (headless `pi -p` log), `control-test.mjs`, `flow-test.ts`. `test/` — unit + integration.

## Adding a new X (data-driven — usually no core change)

1. **Strategy**: add `src/orchestration/strategies/<name>.ts` (export a `Strategy`), register it in `strategy.ts` `BUILTINS`, add a unit test.
2. **Persona**: `personas/<name>.md` — frontmatter `persona: true` + optional `council:` / `orchestration:` / `coaching: true`.
3. **Agent**: `agents/<name>.md` — optional `tools`, `model`, `isolation: worktree`, `mcp: true`
   (routes the leg through the child engine so `pi-mcp-adapter` initializes and its `mcp*`/direct
   tools work — the default in-process engine leaves them "not initialized"; also settable per-leg
   via `delegate`'s `mcp: true` / `AgentRunSpec.mcp`. Pass a server session id in the task to share
   an HTTP backend's state).
4. **Team**: one line in `teams.yaml` (`name: [agent, ...]`), or per-member `- { agent, role, model?, skills? }` to build an ensemble of perspectives from ONE agent (e.g. `review` is one `reviewer` × 3 lens roles). Same-agent members are disambiguated in the live tree by a role hint (`reviewer · SECURITY`) via `rosterNodeKeys`/`roleHint` (`roster.ts`) + the SDK's per-run key (`sdk.ts`), so three lenses show as three steerable nodes — keep the seeding loops and the SDK key derivation in lockstep if you touch either.
5. **Flow**: `flows/<name>.flow.json` — phases + `needs`, optional `gate: true` (checkpoint).
6. **Contract**: `contracts/<name>.contract.json` (request via `outputContract`). **Preset**: `presets/<name>.preset.json`.

## Boundaries / deferred (do NOT rebuild as "missing")

- **`context: fork`** is deliberately deferred: `fresh` is the right child default. The
  **cross-process bus broker** is NO LONGER deferred — see the engine/broker bullet above and
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- This repo is `D:\Sources\pi-persona`. The separate `D:\Sources\pi-subagents-persona` (flat
  `src/index.ts`, `VALID_THINKING`, …) is a **legacy** package — different project. Always use
  explicit `pi-persona` paths in shells and sub-agent prompts (the env default cwd is the legacy one).

## Accepted diagnostics

- One skipped test: `test/integration/child-engine.test.ts` is skipped on Windows (spawn flakiness) — intentional, do not "fix".
- `test/integration/broker.test.ts` (real socket/pipe round-trip) runs UNGATED on every platform,
  Windows named pipes included — it proved reliable across repeated runs; do not add a skip to it
  without first confirming genuine flakiness (see the v0.5 broker task report).
