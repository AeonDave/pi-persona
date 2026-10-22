# AGENTS.md — pi-persona

A single Pi coding-agent extension for **supervised multi-agent orchestration**: async workers,
live steering, cross-session collaboration, and switchable personas. Loaded by Pi via tsx/jiti —
no build step. Design contract (binding on any conflict): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md);
the orchestration layer in depth: [`docs/STRATEGIES.md`](docs/STRATEGIES.md);
the shared behavioral prompt layer: [`docs/SPINE.md`](docs/SPINE.md).

## Commands

- Typecheck (must stay clean): `npm run typecheck`  (`tsc --noEmit`, strict)
- All tests: `npm test` · unit only: `npm run test:unit`
- Settings SDK smoke (isolated profile, no provider/network requests):
  `node --import tsx scripts/settings-smoke.mjs [absolute-pi-package-entry]`.
  Omitting the argument uses the development SDK; pass an installed host entry to qualify that version.
- One file: `node --import tsx --import ./test/setup/hermetic-env.ts --test test/unit/core/frontmatter.test.ts`
  - The second `--import` is the hermeticity choke point: it strips the whole `PI_PERSONA_*`
    namespace and pins `PI_AGENT_DIR` at a throwaway dir before any test module loads, so a
    variable exported in your shell (or by CI) cannot reconfigure the extension under the suite.
    A test that exercises a variable sets it for itself, after that has run. Drop the flag and you
    are testing your shell, not the code.
- Live end-to-end (REAL model calls, spends tokens): `npm run drive -- --persona <name> --model <provider/id> "<prompt>"`
  - `drive.ts` exits non-zero and prints `[persona] ...` when the requested persona is not installed.
  - Control ops: `LIVE_MODEL=<provider/id> node --import tsx scripts/control-test.mjs` (STEER/STOP/RESUME)
  - Interactive wake contract (manual, spends tokens, refuses without `LIVE_MODEL`):
    `LIVE_MODEL=<provider/id> npm run smoke:wake` — RPC session, 3-leg `delegate` fan-out, asserts ONE
    wake carrying all results and no peek/timer/sleep polling before it. Run it before a release.
  - Models must be **provider-qualified**, e.g. `claude-pro-max-native/claude-opus-4-8` or `.../claude-haiku-4-5`.

## Conventions

- **Erasable-syntax-only** TS (no enums / namespaces / parameter-properties) — runs under
  strip-types, tsx, jiti, Bun. `erasableSyntaxOnly` is on; keep it that way.
- tsconfig is strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` +
  `noUnusedLocals` + `noUnusedParameters`. Keep `tsc` clean before moving on.
- `src/core/*` is **pure** (no Pi imports) and unit-tested. Import host packages from
  `@earendil-works/pi-*`; never bundle copies.
- npm publishes as `@aeondave/pi-persona`. Pi supplies the four `@earendil-works/pi-*` packages
  and `typebox`: keep them as `peerDependencies: "*"` with development-only copies, never runtime
  dependencies. The supported host floor is Pi ≥ 1.0.0 (`MIN_PI_VERSION` and the README); Node.js
  must be ≥ 22.19 to match that host. Keep the npm
  `files` allowlist explicit for docs/artwork, inspect `npm pack --dry-run`, and never publish drafts.
- Supply-chain controls: pin every GitHub Action to a verified full commit SHA; keep top-level
  token permissions read-only, grant write permissions only to the reporting job that needs them,
  and disable persisted checkout credentials. Dependabot proposes updates; it does not auto-merge.
  Keep the four Pi development packages in one update group so their APIs stay aligned.
  Match `@types/node` to the oldest supported Node major, including in CI; upgrade them together.
  Keep security overrides scoped to the affected development dependency and version; remove them
  when upgrading Pi if the new dependency graph no longer needs them.
  Run the full dependency audit (including development dependencies), tests and typecheck after
  lockfile updates. A development override does not patch a user's installed Pi host.
- **Cross-OS**: use Pi's spawn/kill/path/temp helpers (`getPiInvocation`, `killProcessTree`), not raw
  `child_process`. Windows kill goes straight to `taskkill /F /T`; always attach an `error` listener.
- Two engines behind the `StrategyEngine` seam: **InProcessEngine** (`engine/inproc`,
  `createAgentSession`, DEFAULT) and **ChildProcessEngine** (`engine/child`, spawns `pi --mode json -p`,
  the correctness baseline + the path worktree isolation uses). Opt out with `PI_PERSONA_ENGINE=child`.
  BOTH enforce `RUN_LIMITS.timeoutMs` as an **idle window** (no events/output ⇒ abort; the inproc
  watchdog is armed for every child; a live pending ask from that child re-arms it) AND
  `PI_PERSONA_AGENT_MAX_MS` as an **opt-in hard wall-clock cap** (lifetime ceiling armed once, never
  reset — catches a busy loop the idle window never does; OFF by default (0 = unlimited) so a healthy,
  progressing child runs to completion, set `<ms>` to arm it) AND
  `PI_PERSONA_AGENT_STARTUP_MS` as a **startup deadline** (a child that makes ZERO progress — no
  completed turn / tokens / streamed output — within the window is killed as a stalled start; the
  first real progress cancels it, so a slow-but-streaming turn is never touched; default 300000,
  `0` disables). It fast-fails the "never started" case the generous idle window is too slow for —
  notably a headless `mcp: true` leg whose `pi-mcp-adapter` hangs on interactive OAuth; `adapter.ts`
  turns that (turns===0 + `spec.mcp`) into a clear pre-auth remedy instead of an opaque timeout.
  The child engine delivers the task over **stdin** (`pi -p` prepends piped stdin) — never argv,
  which would hit Windows' ~32 KiB command-line cap on flow-phase tasks. Every delegate leg, and every
  tracked `council`/`flow` run (one slot for the whole run), headless included, shares one
  `maxConcurrency` launch pool (`Semaphore` in `orchestration/parallel.ts`), so a fan-out can't open more
  concurrent sessions than that; the strategy SDK's own semaphore gates the legs INSIDE a run.
  Any event re-arms the idle window (a chatty tool is never killed), but stall credit follows one rule,
  `madeHeadway` (`engine/async.ts`): raw tool-output chunks earn none, so a leg whose tool streams forever
  raises only the operator-only stall card (nothing is killed, the model is not woken). The idle-timeout
  failure text names the `timeoutMs` remedy.
  Each strategy SDK also gates every `agent()` call through one semaphore, including direct
  `Promise.all` calls; `parallel` overrides cannot raise its concurrency ceiling. Token budgets
  gate admission using completed usage, so already-running legs can overshoot the threshold.
  In-process cancellation and deadlines cover session construction; coaching exemptions apply
  after it finishes. A cancelled factory's late session is disposed, but its ref-counted guard
  stays held until the factory settles because Pi's loader itself cannot be forcibly cancelled.
- **Cross-process broker** (`src/bus/broker/{paths,framing,messages,host,client}.ts`, on by default,
  spec B1-B7; `PI_PERSONA_BROKER=off` restores pre-broker spawn): session-scoped (POSIX socket /
  Windows named pipe under the session id), supervisor-hosted, lazily started on the FIRST actual
  child-engine build (a `PI_PERSONA_ENGINE=child` run, any `isolation: worktree` leg, or an
  `mcp: true` leg — those ALWAYS use the child engine). It is a RELAY into the local `InProcessBus`:
  a connected child is indistinguishable from an in-process one, so the supervisor side (intercom,
  idle notifier, f9, peek) is unchanged BY CONSTRUCTION. It gives child-process runs
  `contact_supervisor`/`contact_peer` AND **steer** (closing the child-engine steer gap —
  `intercom steer`/f9 `s` work on both engines; a child's steer is follow-up-queued, not mid-turn
  injection). Off ⇒ `deps.broker` is never built, the host never starts, and the child spawns
  byte-identical to pre-broker pi-persona — see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-comm-plane-in-practice).
- **Provider fallback**: `buildEngine` wraps the engine in `withModelFallback` (`engine/fallback.ts`).
  A provider-qualified `spec.model` is an explicit provider/billing pin and is strict by default:
  a failed `openai-codex/...` leg never silently moves to OpenCode, and a failed
  `claude-pro-max-native/...` leg never silently moves to a metered third-party route. Unpinned/default
  selections may retry the SAME model id only through the data-driven, family-compatible provider
  policy (OpenAI-family → OpenAI providers; Claude-family → the native Claude provider). A caller may
  explicitly opt a pinned run into cross-provider recovery. Only `failureKind === "provider"` reroutes;
  abort/timeout/contract/unknown/agent are terminal.
  Strategy/council/flow runs disable that provider search and use SDK-level main-only recovery:
  `provider`/`unknown-model` may retry ONCE on the current supervisor model, including a saved or
  inline-pinned choice (explicit user-authorized exception). Never borrow a peer model, never restart
  a stopped/timed-out/contract-failed leg, and charge each attempt to child/token limits and usage.
  Ordinary delegate pins remain strict. Recovery must remain visible in metadata/UI and MAGI rulings.
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
  appended to the agent's own) + `skills` — prompt-level only, capabilities stay the gate.
  `delegate` has NO `sync`/`async` parameter and `intercom` has NO `wait`: interactive sessions
  (`ctx.hasUI`, TUI and RPC) ALWAYS run `delegate` in the background (each result an idle-gated
  completion follow-up; a `tasks` fan-out is ONE follow-up when its last member settles), headless
  `pi -p` ALWAYS blocks and returns results inline (nothing drains a follow-up after the single turn).
  A finished child wakes the supervisor by itself, so any in-turn wait (a sleep, a peek loop, a
  `timer`/`monitor` used as a wait) blocks the wake it waits for. The prompt layer says to end the
  turn; the call-time guards (`PollGuard` on repeated `peek`/`result`, the long-`sleep` block) live
  under `config.nudge` (`PI_PERSONA_NUDGE=off`). `council` and `flow` follow the same rule through
  `tools/background-run.ts` (`createBackgroundRuns`): interactive, ONE tracker run rooted at
  `async:<runId>` (receipt now, one completion follow-up); headless, the same run joined inline. A
  persona's `council:` defaults resolve exactly as before when the call omits strategy/roster/params; the
  mandated `orchestration:` path stays pre-turn and inline, and `/orchestrate`, `/flow` and that path
  register their own abort under their root row (`visibleRoot`). A rejected `gate: true` returns
  `stoppedAtGate` (`ok` stays false, so mandatory flows still fail closed; a tracker run settles
  `stopped`). Stop-all, checkpoint waits, operator-result hand-off, run ids, restore honesty, flow journal
  identity (`flowRunHash`) and retention are in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#supervision--the-waiting-model).
  Periodic async status and each newly detected stall episode are durable, expandable operator-only
  entries; stalls never wake the model. Completions, asks, and unread bus messages keep their
  existing actionable paths.
  Message ids and run ids are separate: `intercom message { messageId }` retrieves retained bus
  text, `intercom result { to: runId }` retrieves a settled run. Both explicit and automatic inbox
  drains retain bounded history (256 messages / 256,000 body characters). Ask settlement clears
  unread and buffered prompts; broker errors/cancellation remain correlated to the original request.
- **Sub-agent output is untrusted** — wrap it with `fenceUntrusted` (in `extension.ts`) before it
  reaches the supervisor as a follow-up or tool result (prompt-injection defense).
- **Delegation nudges** (`core/nudge.ts`, on by default): a `tool_result` hook watches the supervisor's
  OWN tool stream and, when a delegating persona grinds heavy work by hand (output burn since the
  last `delegate`/`council`/`flow` crosses a threshold),
  APPENDS a compact labelled checkpoint to that command's result for the model AND emits the same
  checkpoint as a durable, expandable `pi-persona-nudge` TUI-only entry for the operator. It is never
  hidden/context-only: tool renderers may suppress their own `content`, but cannot suppress the
  separate card. This is runtime reinforcement in recent context, where a top-of-prompt persona
  directive has decayed. Pure state machine (`DelegationNudge`); gated to
  personas holding the `delegate` tool; sub-agents run in separate sessions so the hook only sees the
  supervisor. Its counterweight is **`PersistenceNudge`** — a leg that comes back `[BLOCKED]`/`FLAG:
  UNKNOWN` gets a "don't bank it yet" reminder on each of its three delivery paths (the inline
  `delegate`/`council`/`flow` result — headless only; the background completion
  via `engine/async.ts`'s `renderCompletion`; and an explicit `intercom result` of a done run), but
  they do not scan the same text: `observe` scans the whole sync tool result (every leg's body,
  failures included; a headless `delegate` returns it unclipped), while `renderCompletion` scans only `status: "done"`
  runs. A background leg that FAILED while emitting `[BLOCKED]` therefore gets the failure block but no
  persistence note — deliberate (see the `renderCompletion` doc comment), not a bug to "fix" silently.
  Nested reports from codemode's `ctx.executeTool` retain bounded provenance through Pi's explicit
  `parentToolCallId`; never infer nesting from the call-id string. Only an outer result that relays
  the surrender marker gets the note/card. Nested programmatic data is never patched with a reminder,
  and discarded reports never generate an invisible one. Relay state clears at turn/session settlement.
  `config.nudge` (`PI_PERSONA_NUDGE=off`) silences all of it: the `tool_result` hook (the by-hand
  reminder and the sync-result persistence one) and the `renderCompletion` / `intercom result` paths,
  which take their `scan` through the same gate — so a collected report carries no note either.
  Its standing counterpart is the **delegation brief** (`core/brief.ts`): `before_agent_start` appends
  a live, capability-filtered roster (agents, teams and flows, with descriptions and gated flows tagged in
  headless sessions) + a hand-off default (with one decision-class → method line, checked against the
  registry) to the system-prompt TAIL every turn — discovery that survives context burn.
- **Sibling peer comm (in-process)**: a strategy can opt a run into direct sibling messaging
  (`AgentRunSpec.peers` — the `debate` strategy does). The child gets a `contact_peer` tool
  (`bus/peers.ts`): `list`/`send`, ONE-WAY only (blocking stays supervisor-only, so peers can
  never deadlock), peer list scoped per engine instance (never the whole bus), send budget 20,
  message body limit 8,000 characters (oversized sends do not consume the budget).
  Delivery: the in-process engine's bridge steers incoming bus messages into the child session,
  fenced with the sender attributed OUTSIDE the fence — the same bridge delivers the supervisor's
  `intercom send` (previously a dead letter). Gated by `EffectiveCapabilities.canUseBus` (OFF iff
  the persona explicitly denies `intercom`). The child engine ignores `peers`.
  Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-comm-plane-in-practice) + [`docs/STRATEGIES.md`](docs/STRATEGIES.md).
  On the peer plane: `debate` and `pair` always; `map`/`synthesize` opt-in via `params.peers`.
  `magi`/`judge`/`fanout` stay peer-less BY DESIGN — independence is their bias guard
  (uncorrelated errors; an anonymised ballot cannot survive members who talked) — do not "fix"
  this. `compete` runs its competitors with `isolation: worktree` (REQUIRES a clean git repo; missing
  repo/dirty checkout/worktree failure fails closed and never falls back to the real tree) and returns
  the winning diff for the SUPERVISOR to apply.
- **exocom** (`src/exocom/*`, `src/tools/exocom*.ts`; opt-in `PI_PERSONA_EXOCOM=1` / `--exocom`,
  capability-gated): a plane apart from everything above — those are all INTERNAL to one supervisor's
  own run (hierarchical, session-keyed children); exocom is FLAT and EXTERNAL, between independent
  top-level pi instances sharing one selected scope, no parent/child relationship. Bare `--exocom`
  keeps the current workspace scope; exact `--exocom=Ab0T` joins that existing workspace's scope from
  another cwd through a persistent, collision-aware, case-sensitive four-character Base62 alias.
  The scope selects registry/transport/ledger/artifacts, while every peer advertises its actual home
  workspace id/code/safe label so external file sets are explicit. A foreign peer is advisory for
  writes: it can inspect its own files and use postcards/ask/answer/wait/progress/release, but
  `exocom_claim` is inactive and rejected because the ledger's paths are repository-relative to the
  scope workspace. The code is a same-host/same-agent-dir join reference, not authentication.
  Postcards remain one-way and non-blocking: `exocom_list`/`exocom_send`
  plus `exocom_name` (a reply is a send with `in_reply_to` set). The separate shared JSONL work
  ledger adds `claim`/`ask`/`answer`/`decline`/non-blocking `wait`/`progress`/`release`: overlapping
  open write sets NACK atomically, and a pending targeted ask gates that participant to answer/decline,
  read-only tools, and `exocom_name` identity metadata. Semantic frames are signed immediate-wake signals; the ledger is authoritative
  if delivery is deferred. This is cooperative runtime coordination, not OS authorization. All ten
  tools remain in `EXOCOM_TOOL_NAMES` (with `claim` withheld for a foreign member), targeted denies win independently, and joining requires
  `canUseBus` plus at least one callable closer (`answer` or `decline`) so a published peer cannot be
  wedged by an obligation it has no way to settle. If `exocom_name` is permitted, an unnamed top-level
  Pi is prompted to invent a task-derived call-sign on its first user or inbound peer turn
  (no catalog or extra model call). Naming is metadata permitted during pending asks, without
  settling them; a targeted deny suppresses the prompt. Session identity is shared with standalone
  `agent_name` and persisted across resume/persona changes. Until a handle is chosen, its actionable
  naming bootstrap is delivered through the `context` hook because custom Exocom wakes can bypass
  `before_agent_start`; after selection the hook stays silent. The session-hash suffix of a qualified target survives renames and telemetry resolves the
  same canonical session.
  Reuses the broker's wire framing
  (`bus/broker/framing.ts`) and the
  core fence (`fenceUntrusted`/`attributeInbound`) — no new trust-sensitive code path; inbound
  attribution is resolved from the registry, never the envelope's self-reported `from_name`.
  Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#exocom--the-external-plane).

## Testing

- Offline SDK harnesses must await `session_shutdown` before SDK `dispose()` and temporary-profile
  deletion. `dispose()` disconnects SDK listeners; it does not join extension-owned writers.
- TDD: write the failing test first for `core/*` and any behavior change; watch it fail, then fix.
- Done = `npm run typecheck` clean **and** full suite green. The suite has **two** intentional skips,
  both Windows-only — the runner reports `skipped 2` on Windows and `skipped 0` elsewhere (see
  Accepted diagnostics).
- When touching engines / strategies / the comm plane, also verify with a live `scripts/drive.ts`
  run (concurrency, steer, worktree, and contact_supervisor are not fully provable from unit tests).

## Project structure

- Session identity: `src/core/session-identity.ts` defines validated names and session-bound
  persistence; `src/extension/identity.ts` registers `agent_name` and the pre-name context bootstrap.
  Exocom uses that same state. A delegate's optional `AgentRunSpec.name` is leader-assigned
  display identity, propagated to both engines without changing routing ids.
  Async launch/control cards use that alias, with persisted tool-result snapshots for history.
  Keep run IDs for routing/diagnostics, not primary display identity; disambiguate duplicate aliases.
  Steering cards preview the accepted message and expose all of it with Pi's expand-key binding.
  Runtime metadata guidance belongs in the stable supervisor system prompt, not a new user-like
  acknowledgement message. Keep initial setup/actionable asks working, preserve user-visible history,
  and never re-inject a chosen identity. Progress `tokens` is cumulative input/output usage, not live
  context occupancy; labels must make that distinction explicit.

- Session clock and event wakes: `timer now` refreshes the run-start clock snapshot; timer alarms
  require an explicit timezone for absolute times. `monitor` runs bounded event-producing programs
  (`output`) or jobs (`exit`), with both `monitor` and `bash` permissions. Pure lifecycle is in
  `src/core/monitor.ts`, process/delivery adapters in `src/monitor/`; use the existing idle notifier
  and process-tree cleanup. Session-scoped, no restoration on restart. See [`docs/MONITORS.md`](docs/MONITORS.md).
  Armed timers and active monitors also show as agent-tree rows (`monitor:<id>` / `timer:<id>`, never
  agents): `src/ui/wake-rows.ts` is the pure projection, fed by the core seams `TimerScheduler`
  `onArmed`/`onCancelled`, `MonitorManager` `onArmed`/`onRemoved` and `createMonitorSession`'s `observe`
  option (a terminal event is observed before the permission gate). A countdown replaces the stall clock; `x`
  cancels one via the stop registry; `X`, the `N agents` count and telemetry exclude them.

- `src/core/` — pure kernel: frontmatter, permissions, contract (+`parseContract`), config, discovery, fence (`fenceUntrusted`), brief (`buildDelegationBrief` — the per-turn roster + standing hand-off default; `buildExocomBrief` — the per-turn exocom peer roster, the peer-vs-sub-agent split, and the relevance bound on a peer exchange), timer (`TimerScheduler` — the alarm engine behind the `timer` tool), session-runs (pure restore-notice helper: what a reload/resume lost + the run-id counter), types.
- `src/engine/` — `child.ts`, `inproc.ts` (default), `adapter.ts`, `async.ts` (async tracker/peek), `worktree.ts` (git-worktree isolation), `stream.ts` (event→state).
- `src/orchestration/` — `sdk.ts` (`agent`/`parallel`/`reduce`), `strategy.ts` (registry), `strategies/*.ts`, `voting.ts`, `flow*.ts` (DAG + JSONL journal + checkpoint gates), `roster.ts` (teams + `rosterSpec`: a roster member is a bare name OR an inline `{ agent, role, model, skills }` that specialises one agent — every strategy runs members through `rosterSpec`).
- `src/bus/` — `inproc.ts` (handle-based bus: send/ask/reply/onMessage), `contact.ts` (child `contact_supervisor` tool), `peers.ts` (child `contact_peer` sibling tool — one-way, engine-scoped), `broker/` (cross-process relay, on by default: `paths.ts`/`framing.ts`/`messages.ts` pure, `host.ts`/`client.ts` over `node:net`; `PI_PERSONA_BROKER=off` restores pre-broker spawn). `src/bridge.ts` — the child-mode-only wiring loaded when `PI_PERSONA_BUS` is set.
- `src/persona/` — `persona.ts` (parse + `expandCouncilPreset`), `controller.ts`, `gating.ts`, `orchestrate.ts`, `config-store.ts` (pure model helpers), `settings-store.ts` (sole persistent settings owner).
- `src/tools/` — `delegate.ts`, `intercom.ts`, `exocom.ts`, `background-run.ts` (tracked background council/flow runs: `launch`/`settle`, `TrackedRun`). `src/ui/` — agent-tree/overlay, model-picker, `presentation.ts` (the collapsed-card compaction/sanitization helpers), `wake-rows.ts` (the monitor/timer → tree-row projection), `usage.ts`. `src/extension.ts` — the single ExtensionFactory (wires tools/commands/hooks/engines).
- Bundled data-driven assets (discovery precedence builtin < user `~/.pi/agent/persona` < project `.pi/`):
  `personas/*.md`, `agents/*.md` (personas+agents share a folder, split by `persona: true` — a
  persona and an agent must NOT share a name; e.g. `researcher` is the persona, `research` the agent),
  `teams.yaml`, `flows/*.flow.json`, `contracts/*.contract.json`, `presets/*.preset.json`.
- Personas/agents load ONLY from the user dir (`~/.pi/agent/persona/agents`) and project `.pi/agents` —
  the bundled `personas/`+`agents/` are a **seed source, not a live discovery layer**, so a fresh
  install shows NO personas until the user installs them. `/persona seed` copies missing defaults
  in, `/persona restore` force-restores originals (`src/core/seed.ts`). First-run auto-install is
  **opt-in**: off by default, enable with `PI_PERSONA_SEED=on` (guarded once by marker
  `.pi-persona-seeded`). Release prep: add the previous tag's digest
  to `LEGACY_SEEDED_DEFAULTS` for every changed persona/agent (the guard test in `seed.test.ts` prints the row).
  F8 and `/doctor` point to `/persona seed` when no personas are installed. Contracts/presets/teams keep a builtin layer (they aren't personas).
- `scripts/` — `drive.ts` (headless `pi -p` log) + `drive-status.ts` (its pure exit-code/status projection), `control-test.mjs`, `flow-test.ts`, `live-suite.mjs` (every strategy/mode against a real model), `exocom-smoke.mjs` (real socket/pipe round-trip, chat + semantic claim; run via `npm run smoke:exocom`). `test/` — unit + integration.

## Adding a new X (data-driven — usually no core change)

Settings use `/persona-settings`, a full-page registry-driven UI independent of Pi's `/settings`.
The only active preferences file is `<agentDir>/persona/settings.json` (version, sparse preferences,
per-persona model assignments, last selection). `src/core/settings.ts` owns row metadata and validation;
add/remove public preferences there rather than special-casing UI fields. Route every write through
`patchPersonaSettings`; exact null patches remove overrides without erasing concurrent edits.
The retired `config.json` and `state.json` are migration inputs only, archived as `.migrated` after
the canonical file commits. Malformed files remain untouched; never add a truncating fallback writer.
Scalar preferences apply after a Pi restart or native `/reload`, not `/new` (never auto-reload live workers).
Model edits apply to future runs through the existing participant resolver. `/persona reload` only
refreshes resources, not startup preferences. Native Pi settings and compaction are not owned here.
Mind/Flow contribute supported current values through `pi-persona:settings:collect:v1` (`{ add(id, values) }`);
their five preferences share the same registry/file. Do not hard-import a companion or start services
while collecting settings. Flow port/idle changes are for the next shared-service start, never a restart
of a service other Pi sessions are using. Skill Optimizer remains independent.

1. **Strategy**: add `src/orchestration/strategies/<name>.ts` (export a `Strategy`), register it in `strategy.ts` `BUILTINS`, add a unit test. Declare `when` (one line), `roster` (positional roles, only where position matters) and `required` (param keys a call must carry) — the `council` tool description is generated from them (`strategyCatalog`) and refuses a missing required param up front; never hand-write a strategy list.
2. **Persona**: `personas/<name>.md` — frontmatter `persona: true` + optional `council:` / `orchestration:` / `delegation:` / `coaching: true`; runtime behavior is field-driven, never keyed to a persona name.
3. **Agent**: `agents/<name>.md` — optional `tools`, `model`, `writeSet` (repository-relative paths the
   agent alone writes, e.g. `research` → `[.research/]`; inherited by a `delegate` leg that gives none, so
   the ownership gate sees a declared owner — declarative, never enforced), `isolation: worktree`, `mcp: true`
   (routes the leg through the child engine so `pi-mcp-adapter` initializes and its `mcp*`/direct
   tools work — the default in-process engine leaves them "not initialized"; also settable per-leg
   via `delegate`'s `mcp: true` / `AgentRunSpec.mcp`. Pass a server session id in the task to share
   an HTTP backend's state).
4. **Team**: one line in `teams.yaml` (`name: [agent, ...]`), or per-member `- { agent, role, model?, skills? }` to build an ensemble of perspectives from ONE agent (e.g. `review` is one `reviewer` × 4 lens roles; `design` pairs `architect` + `reviewer` for `critic-loop`). Same-agent members are disambiguated in the live tree by a role hint (`reviewer · SECURITY`) via `rosterNodeKeys`/`roleHint` (`roster.ts`) + the SDK's per-run key (`sdk.ts`), so four lenses show as four steerable nodes — keep the seeding loops and the SDK key derivation in lockstep if you touch either.
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

- Two skipped Windows-only cases in `test/integration/child-engine.test.ts` (force tree-kill and external-signal handling) — intentional, do not "fix".
- `test/integration/broker.test.ts` (real socket/pipe round-trip) runs UNGATED on every platform,
  Windows named pipes included — it proved reliable across repeated runs; do not add a skip to it
  without first confirming genuine flakiness (see the v0.5 broker task report).
