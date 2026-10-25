# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows the version scheme
used in its [GitHub releases](https://github.com/AeonDave/pi-persona/releases).

## [1.17.5](https://github.com/AeonDave/pi-persona/releases/tag/v1.17.5) - 2026-10-25

### Added

- A visible asynchronous Mind maintenance worker, pinned to the current session model and effort.
  It shares normal concurrency, F9 controls and result archival, has no tools or model fallback,
  and returns its completion to Mind without starting another supervisor turn.
- Loaded-companion presence, live memory ownership and bounded `Mind` activity rows. Mind can
  require the actual loaded Persona partner and follow persona changes even with persistence off;
  both engines freeze that owner for delegated legs. Activity stays separate from agents, controls,
  wakes and model usage. These paired contracts require the updated Mind and Persona together.

### Fixed

- Council, MAGI, auxiliary actors and flow legs keep their own model and effort in the live
  tree and F9 when abbreviated roles collide or identical roles use different inline pins.
  Runtime callbacks carry exact attempt identity; retries clear stale observations and terminal
  rows use the engine's observed model. Saved model assignments remain keyed by the full role.
- Terminal-result capture survives reactivation of the same extension and tracker. Shutdown
  revokes the old archive owner without removing the capture observers or changing their order
  before completion notifications; late results cannot enter another session's archive.
- Child broker contacts confirm one-way delivery only after admission to the host bus.
  Full inboxes, disconnects, cancellation and missing receipts no longer report `delivered: true`.
  Receipts are bounded and never count as a supervisor answer or authorization.
  Unconfirmed sends and errors after admission no longer claim that the message was dropped;
  the supervisor may already have received it.
- Reference-flow diagnostics fence worker excerpts even on the defensive missing-reference path.
- A worker-provided patch remains usable after worktree capture fails, with an explicit warning
  that the patch was not verified against the final worktree state.

## [1.17.4](https://github.com/AeonDave/pi-persona/releases/tag/v1.17.4) - 2026-10-25

### Added

- Voluntary Exocom collaboration: generation-bound shared tasks with atomic pickup/write claims,
  expiring optional invitations, bounded attributed evidence publication and self-reported profiles.
  Stale ownership remains visible without automatic takeover; task/evidence reads are paginated.
  See [the collaboration guide](docs/COLLABORATION.md) for the authority and retention contracts.
- Uniform operator views across every pi-persona surface: tool cards and commands use compact
  purpose lines with shared-literal expansion (monitor, timer, models, read_result, agent_name,
  contact_supervisor, contact_peer); session cards share the delegate-family frame (`Event · datum`
  titles, indented clipped lines, boilerplate-free compact with drift-guarded projections, full
  payload on expansion); the agent tree and F9 overlay show each leg's effort sigla (`mn l m h xh mx`,
  off renders nothing) with honest requested→observed divergence, and delegate launch cards show the
  full effort level next to the model.
- Audited all operator notifications: bounded and sanitized toasts, single-surface settlement
  announcements (done/stopped announce once via the follow-up card; failures keep their immediate
  durable surface).
- Installed-tarball qualification harness (`scripts/qualify-package.mjs`): packs and inspects the
  artifact, installs it into isolated temporary hosts, and exercises real delegation, stop and
  shutdown on both engines with a faux provider, network tripwires and empty credential stores.
  Current policy: latest stable Pi only (1.4.0); historical host versions are rejected.
- Per-leg thinking/effort: a typed `thinking` level on agents, delegate single/batch calls, roster
  and council members, and auxiliary actors. Precedence is explicit leg/member > agent definition >
  the existing configured/inherited child setting; malformed values fail before launch. Both engines
  report requested and observed Pi effort separately (an observation is Pi's requested effort, never
  a claim about provider cognition); the child engine passes a separate `--thinking` argument and the
  model-suffix synthesis is gone.
- Bounded durable terminal results: settled delegate/council/flow outcomes are saved as versioned
  session entries with immutable `result:<UUID>` references (count/byte budgets, honest truncation
  and storage receipts). `intercom results` lists them and `intercom result { ref, offset, limit }`
  reads pages after reload — read-only: no respawn, no rebilling, no extra wake. The restore notice
  now distinguishes vanished runtime work from retained terminal reports.

### Fixed

- Show every council/flow participant's launch model and requested effort, including auxiliary
  judges and repeated roles with distinct inline selections. Persist the receipt for history;
  pending model setup remains explicit. Role hints omit code and technical identifiers rather than
  turning environment-variable names or Git refs into reviewer labels.
- Treat failed model-availability reads as unavailable rather than advertising the whole catalog.
  Session identity failures remain explicit and cannot reuse a previous owner or synthesize a
  process-based identity; branch recovery restores the persisted name.
- Admit granted bridge communication tools through Pi 1.4's plain tool allowlist, so a read-only
  worker can still contact its supervisor. Empty grants, explicit exclusions and semantic bus denial
  remain restrictive; sibling contact requires peer opt-in.
- Refuse incompatible reference-flow journal versions and non-successful archived phases without
  respawning completed work, including unapproved saved checkpoints. Retain truncation provenance
  in resumed previews and final reports.
- Label compact status usage as cumulative input/output tokens, distinct from context occupancy.
- Preserve observed model identity after recovery in terminal results and completion views, while
  launch cards retain the original selection. Requested and observed values remain distinguishable.
- Announce a successful or stopped async run ONCE: the completion follow-up card is the single
  settlement surface (the tree row already settles immediately); the duplicate info toast is gone.
  Failures keep their immediate durable card/sanitized toast.
- Pin isolated worktree exports to the starting commit, preserving worker commits together with later
  uncommitted changes and new files in the returned patch.
- Keep unanswered supervisor decisions/interviews unresolved instead of suggesting implicit approval.
  Expose explicit outcomes and suppress bus activity for already-cancelled calls.

### Removed

- Remove the `/persona none` alias; use `/persona off` to deactivate the current persona.
- Remove obsolete host API facades, the CJS-only Pi resolver fallback, unused session/notifier
  options, unemitted identity-message aliases and redundant internal re-exports. Callers and test
  fixtures now use the current Pi contracts directly.

### Changed

- Clarify and regression-test `/persona restore`: overwrite all bundled defaults without pruning
  additional custom personas, agents or resources. Settings, credentials and sessions are not reset.
- Target the latest stable Pi only (currently 1.4.0): development pins, `MIN_PI_VERSION`, docs and
  the package-qualification gate move together, and historical host versions are rejected. A scoped
  development override pins `undici` past known advisories inside the Pi 1.4.0 host dependency tree.
- Align source SDK smoke checks with the canonical settings store and the current interactive vs
  headless execution contract; settings qualification also rejects historical host versions.

## [1.17.3](https://github.com/AeonDave/pi-persona/tree/v1.17.3) - 2026-10-23

### Added

- Show bounded, sanitized live stdout/stderr tails for monitors without adding semantic events or
  model wakes. Recover terminal captures with `monitor result`, including after reload, from the
  owning session JSONL rather than sidecar files. Session-wide visibility includes sibling branches;
  record/byte budgets remain global across navigation and reload. Document secret retention and copies.

### Changed

- Use native Input and fuzzy search in model pickers, preserve exact qualified references and current
  selection, and show useful model metadata. Keep catalog eligibility and provider routing unchanged.
- Consolidate plugin-owned session cards, bounded literal tool previews and width-aware widgets.
  Expanded prose uses native Markdown; logs and operational diagnostics remain literal. Reuse active
  theme colors and host-owned tool shells. Settings hints follow configured keybindings.
- Display active and completed agent usage through the same directional input/output/cache/cost
  formatter, using copied existing counters without changing accounting or budgets.

- Show the current model first in `models`, followed by nearby candidates from its provider, textual
  name root and numbered generation, ordered by cost band then numeric version. Preserve distinct
  worker variants without filling the list with cheap legacy models. Explicit queries still search the full eligible catalog.
  Numeric host prices determine relative `cost:low`/`cost:medium`/`cost:high` bands per provider;
  missing/zero prices stay unknown. Context and reasoning support accompany them without equating
  price with capability, speed or effort. No model-name-to-tier table is used.
- Make supervised delegation the normal choice for bounded independent work, while keeping quick,
  trivial or tightly coupled work available to the supervisor. The supervisor owns decisions and
  reviews results; model selection favors suitable recent candidates without forcing an explicit
  alternative when only the current model is known to work.
- Rewrite the Dev, Elite and Swarm prompts in `c475341` around task-fit delegation and direct-work
  exceptions. Migrate recognized pristine v1.17.2 copies to the new defaults while preserving
  user-edited copies. Swarm now documents that one worker model serves the whole `map` batch.
- Cache current-provider model candidates for the supervisor. Acquire them once, refresh when the
  base provider/model changes or the catalog is explicitly queried/refreshed, and reuse them across ordinary turns.
  Explicit user choices can still select another configured provider; the LLM chooses worker task fit.
- Give delegate launches a compact alias-led header with agent/model metadata and a brief receipt.
  Persist async TUI failures as expandable cards: concise cause first, full technical diagnostic on
  expansion, with the existing single supervisor completion wake. Use the active theme's semantic colors.

### Fixed

- Describe omitted model selection truthfully: saved and agent-configured choices remain in force.
  Selecting the supervisor deliberately requires its exact qualified reference and authorization.
- Respect staged shared model assignments while preserving direct and inline overrides.
- Read tool failures from the native host render context; preserve literal host diagnostics and retain
  Markdown for real reports with failed legs. Bound Exocom previews and show expansion hints only when needed.
- Neutralize bidi and Unicode separators in recovered monitor logs and both archive-card views without
  rewriting raw captures. Coalesce full monitor projection into the existing UI frame instead of rebuilding
  it per chunk; terminal events, cancellation and teardown preserve the last tail and clear pending work.
- Qualify the settings SDK smoke against the intended narrow-picker truncation contract while requiring
  complete qualified references at wider widths and cancellation without writes.
- Share capped gateway shortlists across model roots, starting with the active model's root, instead
  of letting alphabetically early vendors fill the list. Recognize snapshot dates inside model IDs,
  including Bedrock adapter suffixes, without treating those dates as release versions.
- Invalidate cached candidates after explicit model refresh, including partially successful refreshes.
  Apply the same `models` capability gate to the standing brief and delegation reminders.
- Retry unsaved automatic model choices after a stopped picker. Serialize `/orchestrate` and `/flow`
  setup with checkpoint dialogs, and allow stopping a command while its setup is still queued.
- Respect the host's per-model availability filters instead of restoring every model of an active or
  registered provider. Curated native-extension catalogs and the exact current model remain discoverable.
  Delegation reminders use the same eligible catalog and preserve the current model within their cap.
  Provider authentication is no longer presented as a guarantee of account access to every model.

## [1.17.2](https://github.com/AeonDave/pi-persona/tree/v1.17.2) - 2026-10-22

### Added

- Let an agent declare the area it alone writes with `writeSet` in its frontmatter (`research` declares
  `[.research/]`): a write-capable `delegate` leg that names no `writeSet` inherits it, so a persona with
  `requireDisjointWrites` no longer refuses a read-in-intent agent as an unknown writer and the supervisor
  does not have to strip its tools. A leg's own `writeSet` still wins, and the field stays declarative.
  The disjoint-ownership refusal now names each missing leg with the parameter to add (`writeSet`, or
  `tools: ["read","grep","find","ls"]`) and the `concurrency: 1` alternative.
- Show armed timers and active monitors as rows in the sticky agent widget and the F9 / `/agents` panel,
  beside sub-agents: `◉ <label>  <id> · <mode> · <elapsed> · deadline in <remaining>` (an `output`
  monitor reads `k/N events` as they arrive) and `⏰ <label>  <id> · fires in <remaining>` (just
  `⏰ <id>  fires in <remaining>` when the timer has no label). A countdown
  replaces the stall clock, so a quiet watch is never flagged `⚠ stalled`. `⏎` opens the command, cwd,
  times and last 40 event lines (monitor) or the fire time and message (timer); `x` cancels that one
  watch or alarm like `monitor cancel` / `timer cancel`. They are rows, not agents: `X` stop-all, the
  `N agents` status and telemetry never count them, and they are not restored after a restart.
- Run `council` and `flow` as ONE tracked background run in interactive sessions (TUI and RPC), like
  `delegate`: the call returns a receipt, ONE completion follow-up carries the ruling or outcome, and
  `intercom result`, `peek`, `stop`, `stop { to: "all" }` and f9 reach it through the same `async:<runId>`
  root. Headless `pi -p` launches the same run and joins it inline. A run holds one `maxConcurrency` slot
  (shown `queued` until granted); the strategy SDK's own semaphore still gates its legs. A flow parked at
  a checkpoint reads `waiting for operator at checkpoint <id>`, is skipped by the stall watchdog, and never
  wakes the model.
- Stop a `/flow`, `/orchestrate` or mandated `orchestration:` run as a whole: each registers its own abort
  under its root row, so shutdown and reload end it instead of letting later rounds start. In f9, `x`
  on that root row stops the whole run.
- Hand an operator-run `/flow` or `/orchestrate` result to the supervisor's NEXT turn as a passive,
  fenced message bounded to 12k characters, beside the existing card.
- Generate the `council` strategy catalog from the registry: a `Strategy` may declare `when`, `roster`
  and `required`, and the tool description renders one line per strategy. A call missing a `required`
  param (`judge`, `compete` without `params.judge`) is refused up front, before any run, tree row or
  model picker. The standing brief gains one decision-class line (contested fork -> magi, rival complete
  answers -> judge, rival implementations -> compete, N items -> map, draft + critique -> critic-loop,
  fixed stages -> flow).
- Add a peek/result poll guard and a long-sleep guard, both under `config.nudge`
  (`PI_PERSONA_NUDGE=off` disables them). A repeated `intercom peek` or `result` on a still-running run
  whose answer has not changed is refused, then asks Pi to end the turn; a leading long `sleep`/`Start-Sleep`
  is stopped while background children run or are being launched (interactive only). `steer` and `stop`
  reset the poll guard.
- Deliver a `delegate` `tasks` fan-out as ONE completion follow-up when its last member settles, with
  every failed leg named on its own line, and show a `delegate · N legs  k/N settled` header row for
  fan-outs of two or more legs. A fan-out receipt maps each run id to its call-sign; an unknown id on
  `intercom result`, `steer` or `stop` lists the known runs.
- Add `intercom stop { to: "all" }` and an f9 `X` stop-all (press twice; the first press states the
  count). Runs already stopping are skipped, never force-cleared in bulk. `stop all` covers every tracker
  run, `council` and `flow` included; `X` counts and signals every stoppable leaf and every run root that has a stop handle.
- Add `running for <duration>` to a running run's peek line (omitted while queued).
- Add a restore notice: a reload, in-session resume or `pi -c` tells the supervisor once, through a
  passive next-turn message, which runs, timers and monitors did not survive, and run ids continue
  instead of restarting at `run-1`.
- Show the gated phase's output (12 lines) and what runs next at a flow checkpoint, with Reject as the
  default. `/flow` and the supervisor brief list flows with descriptions, tagging gated flows.
- Label `fanout`, `synthesize` and `map` sections by lens or item (`reviewer · SECURITY`,
  `item 2: <text>`); `structured.results[i].member` carries the label when it differs from the agent.
- Add `scripts/wake-smoke.mjs` (`LIVE_MODEL=<provider/id> npm run smoke:wake`): a manual, token-spending
  live check that an interactive 3-leg fan-out gets one automatic wake with no peek, timer or sleep
  polling before it.
- Make `drive.ts` exit non-zero when the requested persona is not installed, and point F8 and `/doctor`
  at `/persona seed` when no personas are installed.
- Add the legacy seed digests for `elite` v1.12.2-v1.14.0, `swarm` v1.14.0-v1.14.2, the MAGI cores
  v1.11.0-v1.14.0, and v1.17.1 `dev`, `planner`, `researcher`, `verify`, `swarm`, `judge` and `magi`,
  with a release guard test that prints the missing row.
- Add the `architect` agent: a read-only planner (`read`, `grep`, `find`, `ls`) for ONE change that
  returns Goal, Non-goals, Steps (owner and acceptance check each), Risks and Open decisions, and
  never edits. A new `design` team pairs it with `reviewer` as the `critic-loop` generator and critic.
- Add a CORRECTNESS lens (logic, off-by-one, races, null handling, unhandled errors, broken invariants)
  as the first member of the `review` team, so `audit`, `deep-review` and every `synthesize` panel
  now run four lenses: correctness, security, performance and tests. A user copy of `teams.yaml`
  (`~/.pi/agent/persona/teams.yaml` or project `.pi/teams.yaml`) keeps its own `review` roster, so add
  the CORRECTNESS member there by hand; the new `design` team resolves from the builtin layer.

### Changed

- Update the four Pi development SDK packages together to 1.3.0, TypeBox to 1.4.2 and the locked
  Node 22 typings to 22.20.5. Update the pinned setup-node, Scorecard, upload-artifact and CodeQL
  Actions to their reviewed upstream releases; keep the Pi 1.0.0 host floor and optional peers.
- Frame the hand-off as the supervisor's role: it holds the objective, the plan and the judgement, and
  anything simple or mechanical goes to a leg so its context stays on the task. The standing brief says
  so (what fits in one tool call stays inline) and adds one sizing rule: call `models` once at the start
  and give every leg a `model` of the supervisor's own provider, the lightest that can do the job.
  `dev`, `elite` and `swarm` carry the same wording. The by-hand reminder lands sooner (3 substantive
  calls and ~1k tokens, was 5 and ~2k), names four delegate targets (those the active persona's own
  prompt mentions first), and lists the session provider's models (up to 10, nothing persisted).
  `models` marks the session model with `(you)`.
- Esc no longer aborts an interactive `council` or `flow`: stop it from f9 (`x` on its root row, `X`) or have the supervisor `intercom stop` the run.
  A mistyped council strategy or roster now fails in the completion follow-up instead of as an immediate
  tool error. Persona `council:` defaults and the pre-turn `orchestration:` path are unchanged;
  `/orchestrate` and `/flow` stay inline and operator-driven.
- Stop crediting streamed tool output as child progress (reverses the 1.17.1 liveness credit). A run
  advances only on assistant output, tokens, turns or a completed tool call (`madeHeadway`), so a
  chatty long-running tool (`npm run dev`, `tail -f`) raises the operator-only stall card; nothing is
  killed and the model is not woken. A council or flow run is credited per leg. The idle-timeout failure
  now says to raise the leg's `timeoutMs`.
- Rewrite the eight bundled personas (`audit`, `dev`, `judge`, `magi`, `planner`, `researcher`, `swarm`,
  `verify`) into one shape and size (1.2-2.5 KB bodies) and register their v1.17.1 copies as migratable.
  `swarm` declares `ownership` (`enforce` is opt-in), `audit` requires briefs, `verify` requires fresh verification, and
  `dev`/`planner` name real delegate targets instead of teams.
- Show a tracked council/flow in peek by tokens only (no false "0 turns"), name the panel on council
  cards (the team, or the ad-hoc members), and have background-run receipts tell the supervisor not to
  sleep, poll, peek or arm a timer, but to end the turn.
- Build the legs of a background council/flow with `async: true` (`TrackedRun.background`), so a
  coached leg's `contact_supervisor` ask can block while the supervisor is idle.
- Make the headless `timer`/`monitor` arm results and the `[Session wakes]` tail say the wake lands only
  if it fires before the turn settles, and reword both tools as wake sources, not polling.
- Key flow resume on flow + task + cwd, and clear only the finished run's journal lines. A rejected
  checkpoint is a stop, not a failure: the run settles `stopped`, keeps the gated plan, and reports
  `flow stopped · checkpoint <id>` (`ok` stays false, so mandatory flows still fail closed).
- Treat `flow` as a hand-off in the delegation nudge: a successful flow resets the by-hand run and a
  failed one gets no re-dispatch checkpoint. The persistence note now says to verify directly or
  re-dispatch with a sharper brief.
- Keep a MAGI core's round-1 vote when its reflection leg fails (other than a stop), and name the keep
  and any budget-skipped reflection in the ruling footer.
- Raise the `PI_PERSONA_ASYNC_RETAIN` default from 25 to 64, the `tasks` cap, so one call cannot evict
  its own early finishers.
- Trim policy prose the per-turn brief already carries from the `delegate` description, and replace the
  hand-written Patterns and Strategies lines in the `council` description with the generated catalog
  (about +140 tokens).
- Register the 1.14.2-1.17.1 `elite` and 1.14.0-1.17.1 `audit` seeds as migratable, so untouched
  installed copies pick up the new prompt wording automatically.
- Clip a `timer` label longer than 120 characters (ending in `…`) instead of keeping it unbounded.
  The clipped label is what `timer list`, the arm receipt, the fire follow-up and the agent-tree row
  show.
- Make `reviewer` the critic of plans and documents as well as code: a PLAN lens (a missing step, an
  unverifiable claim, an unowned risk, a check that cannot prove its step) and a verdict rule that is
  deliberately not strict, `LGTM` whenever nothing must-fix remains, with nits listed as optional.
- Give `planner` a declared `council:` default, the `design` loop (`architect` drafts, `reviewer`
  critiques, two rounds), and say so in its method; a fork evidence cannot settle still goes to
  `council` with `strategy: "magi"`. Migrating a pristine v1.14.0-v1.17.1 `planner` seed now installs
  the `architect` agent it needs.
- Shorten the bundled prompts for less context per leg, keeping every rule and the pinned persona
  structure: `dev`, `swarm`, `planner`, `researcher`, `audit`, `verify`, `magi` and `judge` now sit at
  about 2.0-2.3 KB; `operator` (4.2 KB to 3.0 KB), `research`, `reviewer`, `verifier` and the MAGI cores
  are tighter and say **BE BRIEF. BE CLEAR.** The two surrender markers and the runtime-scan sentence
  in `operator` are unchanged.

### Fixed
- Diagnose missing hashed Pi host bundle modules as local host failures on both engines, preserve
  the original error and explain recovery in a fresh Pi process with the same provider/model.
  These failures no longer trigger provider/model recovery; aborts and timeouts retain precedence.
- Keep partial `synthesize` panels explicit: report failed or empty gatherers to the merger and
  in the final output, headline and coverage metadata, so a missing review lens cannot look complete.
- Normalize JSON-string `tasks` in the live wake smoke with the delegate tool's existing parser;
  keep its three-scout, result-marker, single-wake and no-polling checks.
- Keep read-only research fan-outs admissible when the agent declares a default `writeSet`:
  only effective writers inherit that default; explicit caller ownership keeps its existing checks.
- Keep model-sizing guidance consistent with the active persona's tool permissions and the host's
  active tools; do not direct a supervisor to call an unavailable `models` tool.
- Let stopping a background council or flow dismiss its initial model picker and release the run
  without saving partial or late selections. Serialize automatic model setup with checkpoint dialogs
  so concurrent runs cannot displace one another's prompts.
- Resolve loose `delegate` model names more forgivingly: a `provider/loose-id` pin matches inside
  that provider (`claude-pro-max-native/opus-4-6`), version dots and dashes are interchangeable
  (`opus-4.6`), and an unknown name lists the session provider's models first instead of the
  catalog head.

- Stop a failed `flow X` on task A from silently resuming its finished phases under `flow X` on task B.
- Stop run ids restarting at `run-1` after a reload or resume, which let `intercom result run-1` return
  an unrelated run.

### Removed

- Remove the `delegate` `sync` and `async` parameters. Interactive sessions always run `delegate` in the
  background and deliver each result as a completion follow-up; headless `pi -p` always blocks and returns
  results inline.
- Remove `intercom wait` with its `sync` and `timeoutMs` parameters: a finished child wakes the supervisor,
  and `intercom result { to: runId }` retrieves a settled run.
- Remove the headless one-shot stall wake. Stalls are operator-only cards and never wake the model;
  `PI_PERSONA_PEEK_MS` drives only the stall card and the unread-message wake.

## [1.17.1](https://github.com/AeonDave/pi-persona/releases/tag/v1.17.1) - 2026-10-20

### Added

- Add `/persona-settings`, a dedicated TUI/RPC editor for pi-persona preferences, persona model
  assignments, and diagnostics, plus `/persona-settings show` for a read-only headless report. The
  full-page TUI supports filtering, resetting a saved override, and opening model settings.
- Persist preferences, per-persona model assignments, and the remembered persona in one versioned
  `<agentDir>/persona/settings.json`. On first migration, the retired model and state files are
  imported and unchanged originals are archived as `.migrated` when safe; failed or unsafe
  migration keeps the source files and reports a warning.
- Let users select a model-settings owner and profile explicitly without activating it. Model
  assignments affect future runs; inline pins remain read-only, and resetting removes only the
  saved override. Public environment overrides retain startup precedence; scalar preference changes
  wait for a Pi restart or native `/reload` (not `/new`) and are never auto-reloaded.
- Keep persona-selection revisions separate from unrelated settings saves so companion memory scopes
  can follow explicit re-selections without mistaking model edits for persona switches.
- Include the loaded Mind/Flow companions in the same panel and preferences file, using optional
  public-bus discovery rather than hard plugin dependencies. Keep Skill Optimizer separate and
  preserve per-run `--no-flow` and the existing shared service's lifetime.

### Fixed

- Count streamed textual tool output as child liveness without adding tool output to the assistant
  transcript. Queued delegates start their stall window only after concurrency admission.
- Keep interactive stall episodes operator-only and expandable. Headless runs receive at most one
  successfully delivered stall wake per run lifetime; real progress still re-arms operator episodes.
- Reject malformed UTF-8 settings and migration inputs rather than silently replacing bytes during
  a save. Preserve invalid originals and keep concurrent preference/model edits in one safe store.

## [1.17.0](https://github.com/AeonDave/pi-persona/releases/tag/v1.17.0) - 2026-10-19

### Added

- `/persona models [council-persona]` refreshes the host catalog and reopens model selection for
  the active caller's council participants, preserving cancelled choices, unrelated assignments,
  and explicit inline model pins. No supervisor switch or model request is required.
- A hermetic installed-host Pi 1.3.0 qualification script covers real command dispatch, assignment
  persistence, custom-message starts and missing-auth council recovery without network requests.

### Fixed

- Publish terminal progress for single delegates before removing their tree node, preserving `done`
  status in Flow and other telemetry consumers.
- Preserve Exocom reply references and optional target-correlated transport IDs while keeping each
  queued/terminal telemetry row stable; retain bounded broadcast delivery receipts.
- Report an exact acknowledged broadcast receipt as delivered even when failures for other peers
  exceed the retained sample; recipients without exact evidence remain conservatively unknown.
- Classify Pi's `No API key found for <provider>` diagnostic as a provider failure in both engines,
  allowing the existing single main-model recovery for councils/strategies/flows. Ordinary delegate
  provider pins remain strict; aborts, timeouts, contract and agent failures remain terminal.
- Report a refused persona model switch instead of silently recording an override when Pi rejects
  it for missing authentication; keep the actual session model and restoration state intact.
- Remove a timing race from the supervisor-ask telemetry test: verify the persisted timeout
  transition history rather than polling a transient 20 ms state through asynchronous disk writes.

## [1.16.3](https://github.com/AeonDave/pi-persona/releases/tag/v1.16.3) - 2026-10-13

### Fixed

- Reject Pi `+name`/`-name` tool modifiers in agent and per-run allowlists before either engine
  starts. Those selectors are literal allowlist entries in pi-persona; Pi 1.2 instead applies them
  to its default tools. Use `deny` or `excludeTools` for denials.

## [1.16.2](https://github.com/AeonDave/pi-persona/releases/tag/v1.16.2) - 2026-10-08

### Fixed

- Keep routine async check-ins visible as durable, expandable operator status entries without starting
  model turns; completion, ask, unread-message, and newly-stalled follow-ups remain actionable wakes.
- Show periodic status while the supervisor is busy, without consuming pending actionable messages.
- Keep stall/message delivery independent of status-card persistence failures and report those failures
  non-fatally. Align supervisor guidance and documentation with the status-only check-in contract.

## [1.16.1](https://github.com/AeonDave/pi-persona/releases/tag/v1.16.1) - 2026-10-06

### Fixed

- Publish the real pending-supervisor-ask state as `agent.updated` telemetry for Flow. Refresh it on
  ask delivery and reply/timeout/cancellation settlement, without duplicate events or text-based
  guesses; queued and terminal state remain authoritative.
- Make the native offline codemode harness await extension shutdown before deleting its temporary
  profile; SDK `dispose()` alone does not flush the extension's telemetry writer.

### Packaging

- Add the npm author and focused Pi gallery keywords; align the banner preview and pinned install
  examples with this release.

## [1.16.0](https://github.com/AeonDave/pi-persona/releases/tag/v1.16.0) - 2026-10-03

### Compatibility

- Require Pi ≥ 1.0.0 and Node.js ≥ 22.19. Update the development cohort to Pi 1.0's four coordinated
  host-package pins and qualify its SDK and tool lifecycle. Pre-1.0 Pi hosts are no longer supported;
  the host packages and TypeBox remain wildcard peers supplied by Pi, not bundled runtime copies.
- Update the live control harness to use Pi 1.0's session `modelRuntime` through the public
  `ModelRegistry` facade instead of the removed session registry property.
- An authored `council.members` field is now validated. Older malformed fields that were ignored
  must be corrected or removed; council calls fail with the field diagnostic instead of selecting
  an unrelated fallback panel.

### Fixed

- Reserve mandatory downstream child slots before optional model recovery in `map`, `pipeline`,
  `critic-loop`, and `council-rounds`. Provider outages no longer spend the slots needed by later
  workers, verifiers, steps, or rounds and turn completed work into a run-fatal admission error.
- Pass live supervisor-ask state to the `intercom peek` tool, including untargeted peeks; a child
  waiting for its supervisor is not reported as stuck. Collapsed steer receipts identify the run.
- Honor members-only council profiles for active and explicitly selected personas, including their
  params when MAGI is selected explicitly as the same default strategy. Evaluate each configured
  agent-model lookup once.
- Carry persistence checkpoints through nested codemode reports when their `[BLOCKED]`/`FLAG:
  UNKNOWN` marker is relayed to the model. Suppressed nested output stays unchanged; only the outer
  visible result receives the checkpoint and its expandable card.
- Surface telemetry cleanup/write diagnostics without requiring debug mode; diagnostics remain
  non-fatal. Failed admission removes only the empty directories created by that attempt.
- Release a telemetry writer lease after its terminal writes finish without waiting for the shared
  retention sweep over unrelated sessions; explicit maintenance joins remain available.
- Harden the exported council-preset expansion boundary with normalized strategy names and the
  same strategy/roster/params allowlist as the JSON loader; validated authored members remain intact.
- Resolve live tree and telemetry model labels for auxiliary actors through the same role-specific
  participants as the picker, including inline model pins and repeated SDK keys. Ambiguous short
  role hints omit an uncertain model rather than attributing a different participant's choice.

### Changed

- Make general council guidance proportionate while preserving MAGI and Judge's specialized focus;
  all eleven strategies remain available through the same tool. Add ephemeral inline council members
  and specialized external actors without creating persona/team files.
- Include role-specific members and external arbiters in model selection; respect configured models
  and remember prompts per participant rather than suppressing later teams for the whole persona.
- Recover model/provider failures across strategies and flows once on the supervisor's current model,
  including unavailable saved or pinned choices. Remove MAGI's peer-model substitution; report the
  switch, account both attempts, and preserve child/token limits and cancellation.
- Use worker aliases in async launch cards and targeted Intercom call headers, matching the live tree.
  Persist display identity in tool results so history remains readable after reload or tracker eviction;
  routing still uses run IDs, with a secondary ID shown when aliases collide.
- Show the accepted steering message as a compact preview, with Pi's expand-key hint for the full
  message and diagnostic run ID. Replace repetitive soft-request/cancellation boilerplate with a
  concise queued receipt; steering remains a request, not proof of execution or cancellation.
- Make context-burn checkpoints aware of Pi's nested-tool metadata: raw inner results do not
  consume the model-visible output budget or receive invisible reminders. Permission gates,
  telemetry and genuine successful hand-off resets still apply inside codemode.
- Show an immediate async completion banner with the worker's display name, including successful
  runs. The semantic report still arrives once through the idle-gated completion path, and a failed
  UI notification cannot swallow it.
- Replace the child watchdog test's load-sensitive kill-latency assertion with an observed blocked →
  released → idle-timeout barrier; preserve the two intentional Windows-only skips.
- Clarify that automatic background completion follow-ups and end-turn guidance are the intended
  async default: continue independent work, and do not monitor or join all workers when they are the
  only remaining work. `intercom wait` now snapshots without blocking by default in interactive/RPC
  sessions; `sync: true` opts into its bounded join, while headless remains blocking by default and
  `sync: false` opts out. Snapshots collect only already-settled reports, leaving running work active.
  Queued steering does not preempt an explicitly blocking join. A real Pi 1.0 SDK test with a local faux provider characterizes steering becoming
  dormant when delayed input hooks outlast the active run. No unsafe input-triggered join abort ships.
- A council call that switches strategy no longer inherits unrelated profile params; params continue
  to merge when the selected strategy is unchanged, and unknown explicit keys still warn.
- Show live supervisor asks as `waiting for supervisor`, rather than stalled, in the tree, F9 and
  peek; refresh council parent clocks on child progress. A waiting worker becomes eligible for
  stall detection again when its ask settles. Steering an already-settled run points to its result.
- Add age-based telemetry cleanup with a 30-day default; see
  [`docs/TELEMETRY.md`](docs/TELEMETRY.md) for the retention contract.
- Reuse one tree snapshot per F9 list redraw for rows, selection and waiting state; remove an
  unreachable delegate-title branch and distinguish event liveness from proof of useful progress.
- Align the README and technical guides on async snapshots/joins, steering delivery, model-selection
  precedence, members-only councils, and automatic `map` verifier headroom.

After updating, let active workers settle and restart Pi (or use `/reload`). `/persona reload`
refreshes definitions, not extension code. Existing custom personas and provider pins are preserved.

## [1.15.2](https://github.com/AeonDave/pi-persona/releases/tag/v1.15.2) - 2026-09-28

### Distribution

- First npm publication on 2026-09-29 as `@aeondave/pi-persona@1.15.2`, with the same runtime
  version. The existing GitHub tag is unchanged; npm adds scoped package metadata and installation
  instructions. The registry's `gitHead` identifies the packaging commit.
- Declare Pi-provided packages and TypeBox as wildcard peers, with pinned development copies only.
  Explicitly allowlist public documentation and selected artwork; exclude drafts and development
  harnesses from the npm tarball. Add the gallery banner and F8 persona-switching video preview.
- Lead the README and package description with supervised multi-agent orchestration, live steering,
  and cross-session collaboration; personas configure that workflow.

### Fixed

- Add stable supervisor-side runtime guidance against repeated identity/prefetch acknowledgements,
  including resumed sessions and custom/replace personas without the optional spine. The naming
  bootstrap now explicitly ends at the successful tool action. No extra corrective turns are injected,
  no history is rewritten, and explicit user questions or unresolved actions remain actionable.
- Replace conversational naming confirmations with a neutral saved/unchanged handle receipt, shared
  by the model-facing result and the visible renderer.
- Label async progress token counts as cumulative input/output rather than leaving them open to
  interpretation as current context usage. Routine updates distinguish status from a new user task.

### Changed

- Delegation, failed-hand-off, and persistence nudges are now compact labelled checkpoints with an
  explicit trigger and action. Token counts are identified as estimates, session-bound work is
  separated from delegable work, and each synchronous checkpoint is mirrored from its semantic tool
  result into a durable, expandable TUI-only card. This keeps it visible even when a tool renderer
  suppresses result content without duplicating it into model context or triggering another turn.
- Refresh the README with a clearer installation guide, the Prism banner, and an illustrated
  supervisor/worker workflow.

After updating, let active delegated runs settle, then restart Pi or use `/reload` before the next
user turn. `/persona reload` refreshes persona definitions, not extension code. Existing chat
history is preserved; the runtime guidance discourages repetition without filtering model output.

## [1.15.1](https://github.com/AeonDave/pi-persona/releases/tag/v1.15.1) - 2026-09-20

### Changed

- Development validation now uses the current Pi `0.85.1` packages, TypeBox `1.3.34`, and the
  current Node 22 tooling line while retaining the supported Pi `>=0.83.0` runtime floor.
- Release metadata is now guarded as one version set across the package manifest, lockfile,
  telemetry producer, changelog, and README install pin.

### Fixed

- A chosen session identity is no longer re-injected as a hidden user-like message before every
  provider request. The context hook now emits only the actionable, pre-name bootstrap, preventing
  tool-loop continuations from narrating repeated identity confirmations.
- Repeating `agent_name` with the active handle reports it as unchanged instead of announcing a
  fresh identity again.

## [1.15.0](https://github.com/AeonDave/pi-persona/releases/tag/v1.15.0) - 2026-09-18

### Added

- Live elapsed-time clock and a stall badge (`⚠ stalled <duration>`) on every running row in the
  agent tree and the F9 overlay; cancelling a worker now marks its row `stopping…` immediately, and
  a stop that cannot be applied says so instead of doing nothing. A row that is only queued (not yet
  running) no longer shows the stall badge.
- A warning toast announces a provider-fallback reroute (`<agent>: <from> failed, retrying on
  <to>`) instead of switching silently.
- A non-worktree leg's result now gets a "files changed" report appended: every path `git status`
  saw change while the leg ran, flagging anything outside the leg's own declared `writeSet`. Costs
  two `git status` spawns per leg (down from four — the repository root is resolved once and
  reused, skipping a redundant `rev-parse` gate); `PI_PERSONA_LEG_CHANGE_REPORT=off` disables it.
- A supported Pi host version floor (0.83) is declared once and enforced consistently:
  `peerDependencies`, `/doctor`'s new `pi: <version> (requires ≥ 0.83.0)` line, and the README.
- `exocom_status` (tool) and `/exocom` (command) now show who owns what in the current Exocom
  scope: your claims, peers' claims, and asks waiting on either side.
- A `write`/`edit` whose path lands inside a peer's open Exocom claim is now blocked once with a
  reminder to coordinate (`exocom_ask`) or claim the path first; the identical retry is allowed
  through.
- The `map` strategy gains two declared params: `ownership` (`"off"`/`"declare"`/`"enforce"` —
  ignore, record, or gate on the splitter's per-item write-set before any worker spawns) and
  `verify` (an opt-in, read-only reviewer pass per completed item), plus an always-on per-item
  status ledger (`structured.items`: `completed`/`failed`/`not-run`) both params report into.
- `npm run smoke:exocom` runs the Exocom comm-plane smoke script, now checked against
  `InboundDeps` and carrying a semantic-frame check.

### Changed

- Agent-tree UI work is now bounded to the terminal's 16 ms frame cadence: structural fan-out and
  streamed progress share one sticky-widget composition, unchanged widget/status publications are
  suppressed, the F9 overlay rebuilds lazily on the next paint, and tree rendering indexes the
  hierarchy once instead of rescanning the whole fan-out for every row. Explicit stop feedback and
  shutdown clearing remain synchronous.
- The idle and startup watchdogs now stay armed for every child, coaching or not, and consult the
  bus (in-process) or the broker (child-process) for a live pending ask before closing a silent
  leg — re-arming while a supervisor reply is genuinely pending, closing it once the silence is
  real. The hard wall-clock cap (`PI_PERSONA_AGENT_MAX_MS`) remains the one unconditional backstop.
- `SupervisorBroker` consolidates the supervisor host's lifecycle into one class: a failure now
  warns once instead of repeatedly, children spawn bus-less while the broker is down rather than
  failing outright, and `/doctor` reports the broker's real state.
- Every Exocom surface that renders a peer-authored field (the status view, the write-guard
  warning) now goes through one shared sanitizer; the write guard also matches an absolute path
  against a claim correctly and bounds how many paths a single warning names.
- Internal deduplication with no behavior change: `delegate`'s unknown-agent/contract error text,
  the broker client's ask/list reason text, `SupervisorBroker`'s state reads, `AgentTree`'s
  add/update field copy, `spec-preflight`'s failure-result skeleton, the agent overlay's
  hint/notice rendering, and every capped-list rendering now share one helper each; a few dead
  exports and some `/doctor` wording were tidied along the way.

### Fixed

- The engine's unknown-agent/unknown-contract preflight is now one shared module; a
  contract-not-found error names the installed contracts, and `delegate` rejects an unknown
  `outputContract` before spawning anything, checked across a whole parallel batch.
- Worktree git operations now run asynchronously, so an isolated leg can no longer freeze the host
  session; worktree cleanup is also guarded so a cleanup failure cannot take the run down with it.
- A dropped broker connection now fails fast, and the bridge reports `⇄ offline` instead of hanging
  on the next ask.
- `exocom_wait` now wakes a waiting supervisor as soon as the peer it was waiting on leaves the
  pool, instead of waiting out the full timeout.

### Removed

- `RunLimits.maxDepth` had no runtime reader — nesting depth is actually enforced structurally (a
  child registers no `delegate`/`council`/`orchestrate`/`flow` tool and self-disables under
  `PI_PERSONA_DISABLE`); the docs now state that mechanism directly instead of a limit nothing
  enforced.
- Dead code: the unread Exocom ledger wake, `waitMatches`, and the `displayNameFor` alias.

## [1.14.2](https://github.com/AeonDave/pi-persona/releases/tag/v1.14.2) - 2026-09-08

Pi Persona now prompts sessions to choose a personal name before their first task or incoming
Exocom request, instead of displaying the persona role as their identity. The README puts
installation and everyday use first.

- Persist session names across persona switches and resume, with distinct provisional handles
  before a name is chosen. Standalone sessions use `agent_name`; Exocom sessions share the same
  identity through `exocom_name`.
- Cover first-message Exocom wakes, refresh peer presence and outgoing names after renaming, and
  allow identity metadata updates while a work question is pending. Existing tool denials and work
  obligations still apply.
- Pass supervisor-assigned worker names into the first prompt and peer labels on both in-process
  and child-process engines.
- Reject an unknown explicit `critic-loop` roster with an actionable error instead of silently
  selecting a different team.
- Clarify data-preservation, service-impact, and confirmation requirements in the bundled
  assessment and evidence-review prompts.
- Upgrade exact, untouched 1.14.1 copies of those two prompts on restart, including LF and CRLF
  installations; customized copies remain unchanged.
- Shorten the README from 488 to 159 lines, add Git URL installation and release pinning, and move
  APIs, configuration, and recipes into `docs/REFERENCE.md`.

## [1.14.1](https://github.com/AeonDave/pi-persona/tree/v1.14.1) - 2026-09-06

*No GitHub release was published for this tag; summarized from `git log v1.14.0..v1.14.1` instead
of `gh release view` (see the task report for detail).*

- Rewrote the runtime prompts of the security chain (`elite`, `operator`, `evidence-verifier`,
  `reviewer`, `research`, `scout`) in plain professional language — the method, delegation
  grammar, evidence discipline, target-egress invariant, and verification loop are unchanged, only
  the vocabulary is.
- Renamed the elite council roster `offensive-assurance` → `evidence-assurance` across the persona,
  `teams.yaml`, the README, and its unit test.
- Kept the constraints the vocabulary rewrite had softened: authorization/scope statements, the
  named-skills-only public-reference-code rule, the auth-material reuse check across every
  reachable service and principal, and the reviewer's standard injection/SSRF vocabulary. Routing
  targets that had become unresolvable are named again.
- MAGI cores: rewrapped `melchior`, gave `casper` the same closing rationale as its siblings, and
  clarified that confidence is the core's own 0.0–1.0 certainty rather than a template placeholder.
- Shortened the README from 604 to 488 lines, table-first, pointing at `docs/` for the long form.

## [1.14.0](https://github.com/AeonDave/pi-persona/releases/tag/v1.14.0) - 2026-09-06

Pi Persona can now wake a supervisor when a background job finishes or a program reports an event.
This release also strengthens delegation cancellation, bounded messaging, and the everyday persona
experience.

### Event monitoring and time awareness

- New `monitor` tool: `exit` mode reports job completion; `output` mode consumes event lines from
  file, log, system, or service adapters. Events are fenced, bounded, coalesced, and delivered at
  an idle turn boundary.
- Monitor defaults: one event and a ten-minute deadline; limits of eight active watches, twenty
  events per watch, and twenty-four hours. Cancellation stops the owned process tree and removes
  queued wakes. Both `monitor` and `bash` permissions are required.
- Fresh UTC/local clock context on every run without continually rewriting the cached system
  prefix; `timer now` refreshes the clock during a long run.
- Timer date-times without a timezone are rejected. Alarm confirmations use the scheduler clock,
  and wake notices distinguish due and observed times.

### Delegation and communication reliability

- In-process startup is covered by cancellation and deadlines, including delayed session creation
  and cleanup. The concurrent child guard stays held until outstanding initialization settles.
- The SDK enforces concurrency admission for every agent call, including direct parallel launches;
  queued and active work respects cancellation and budget checks.
- Intercom distinguishes retained messages from settled run results. Inbox and retention bounds
  protect outstanding questions; timeout, disconnect, cancellation, and broker ask settlement
  release their resources.
- Late asks and cancelled waits no longer leave stale notifications. Peer messages have explicit
  size bounds, and communication failures retain useful diagnostics.
- Overlay regression checks bound the amount of text reprocessed during streaming, keeping the real
  rendering and output checks while removing dependence on CI hardware speed.

### Persona experience

- Refined `dev`, `planner`, `researcher`, `swarm`, `audit`, and `verify` defaults, with clearer
  hand-offs, verification, progress reporting, and proportionate scope.
- Exocom prompt guidance follows each permitted action and distinguishes external workspace
  membership from a denied claim permission.
- Research workers create durable artifacts when requested or useful for reuse. Exact-pristine seed
  migrations preserve customized persona files.
- Added the experience and monitor guides, plus a persistent RPC monitor smoke harness.

## [1.13.4](https://github.com/AeonDave/pi-persona/releases/tag/v1.13.4) - 2026-09-05

- Opened the tool-start status vocabulary: `tool.started` no longer requires the literal word
  `running` — the wire contract's allowlist became a denylist, so a start event may name its own
  in-flight state, but may not claim to already be over. `tool.finished` stays closed so the
  consumer can always close the call.
- The shared conformance corpus stays byte-identical with pi-persona-flow; both new cases were
  proven RED against the previous predicate in both repos.

## [1.13.3](https://github.com/AeonDave/pi-persona/releases/tag/v1.13.3) - 2026-09-05

Patch release hardening the data-root migration 1.13.2 introduced, after an adversarial pass
reproduced four defects by running the migration against constructed filesystem states.

- The destination side is now `lstat`'d after `mkdirSync`, so a planted or stale link below the
  current root can no longer carry files through it and delete the legacy original.
- Fixed a false "could not remove" warning per migrated file under concurrency: the source itself
  is asked whether it is still there, instead of trusting an ambiguous Windows errno.
- The "this is not data loss" branch no longer leaves a silent Exocom outage: a link this run
  created is now undone and the entry reported `kept`, restoring the exact pre-run state.
- `docs/TELEMETRY.md` now names both roots for v1 flow logs, since the migration relocates that
  subtree with everything else.

## [1.13.2](https://github.com/AeonDave/pi-persona/releases/tag/v1.13.2) - 2026-09-04

Patch release that consolidates the agent-dir storage on a single root — Exocom and the broker
still wrote `<agentDir>/pi-persona` while persona data had long since moved to
`<agentDir>/persona`.

- Moves Exocom's workspace rendezvous (registry, ledger, `agents/`) under
  `<agentDir>/persona/exocom/<workspace-hash>/`, the durable `exocom/codes/` join-code aliases and
  their `.used` reservations, and the POSIX broker socket directory (the Windows named pipe is a
  pipe name, not a path, and is unchanged). Folds an existing `pi-persona` root in once at
  activation, before anything opens the rendezvous or the socket, and reports the result through
  `ui.notify` and a `/doctor` line.
- Migration is atomic, no-clobber, and resumable per file (link then unlink); a name the new root
  already owns keeps that copy and leaves the legacy copy on disk; non-regular entries (a stale
  socket, a symlink) are never followed, copied, or removed; a filesystem without hard links falls
  back to copy-then-unlink; every failure is a per-entry warning, never a startup throw.
- Upgrade note: Exocom has no dual-read, so restart every live Pi as part of the upgrade, or old and
  new sessions form two disjoint rendezvous.
