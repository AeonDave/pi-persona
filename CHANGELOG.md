# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows the version scheme
used in its [GitHub releases](https://github.com/AeonDave/pi-persona/releases).

## [Unreleased]

### Compatibility

- Update the development cohort to Pi 1.0's four coordinated host-package pins and audit compatible
  API use. This does not raise the supported floor: pi-persona still supports Pi ≥ 0.83. The current
  Pi host packages require Node.js ≥ 22.19; this is a host runtime requirement, not a pi-persona
  floor change. No release has been made; package version remains 1.15.2.
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
