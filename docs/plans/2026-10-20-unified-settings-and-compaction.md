# Unified Persona settings and opt-in compaction

Status: settings implemented in 1.17.1; compaction remains a proposal, not benchmark-qualified.
Date: 2026-10-20.

## Decision in brief

Current user decision supersedes the initial settings proposal: implement `/persona-settings`,
independent of native Pi `/settings`, with one Persona-owned file for preferences, participant
models and last selection. Retire the active `config.json`/`state.json` writers through recoverable
migration. Native Pi settings and compaction controls are excluded from this implementation.

Untouched compaction settings must produce the existing native Pi behavior. Native
compaction remains the only scheduler. An opt-in supervisor-continuity mode should
be evaluated before taking ownership of summary generation. A fully custom summarizer
is a separate experiment with provider, correctness, and quality gates.

Settings implementation and the patch releases were subsequently authorized. Compaction development
and paid compaction-provider trials still require a separate decision.

## Evidence and interpretation

- The [Reddit proposal](https://www.reddit.com/r/PiCodingAgent/comments/1x776vc/i_built_a_pi_extension_so_my_agent_doesnt_fall/)
  measures context and relies on an instructed agent to write a handoff. It does not
  compact or create the handoff. The author acknowledges having no measurable benchmark.
- Its [current source](https://github.com/utpalsinghdev/pi-extensions/tree/main/packages/pi-context-window)
  supports percentage or fixed-token thresholds, but no automatic compaction scheduler.
- Our [handoff skill](../../../malskill/behaviours/handoff/SKILL.md) distinguishes transfer
  to another context from continuing within the same Pi session. Reuse its emphasis on
  next action, evidence, uncertainty, artifact pointers, and secret exclusion; do not
  automatically export handoff files, restart sessions, or treat summaries as established truth.
- [Anthropic's engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  supports recall-first tuning on complex traces before reducing excess information.
- [Chroma's experiments](https://www.trychroma.com/research/context-rot) demonstrate
  model- and input-dependent degradation, not a universal 60–70% cutoff for current coding agents.
- [Factory's evaluation](https://factory.com/news/evaluating-compression) suggests useful
  recall, artifact, decision, and continuation probes. Its vendor results do not qualify our design.
- [Cache guidance](https://developers.openai.com/cookbook/examples/prompt_caching_201)
  motivates measuring complete resumed-task cost, not assuming a handoff is cheaper.
- [AutoCompact](https://arxiv.org/abs/2610.02163) studies a trained policy, not a drop-in
  prompt. Only the abstract was reviewed; its reported gains are not a prediction for this plugin.

Research conclusion: changing what is retained is worth evaluating. Smaller summaries,
earlier compaction, and better task performance are distinct outcomes and must be measured separately.

### Second Reddit proposal: automatic successor sessions

The [Sayl post](https://www.reddit.com/r/PiCodingAgent/comments/1wqatix/killed_context_anxiety_with_automatic_session/)
describes a configurable raw-token ladder: early task wrap-up, stronger prompts later,
and eventual cutover into a fresh session carrying a handoff. It says project/model/thinking
are retained and native compaction remains a backstop. No implementation or comparative
benchmark is linked in the post; those preservation and quality claims are unverified here.

Useful design ideas are safe-boundary wrap-up, explicit continuation state, and reversible
operator controls. The absence of native compaction does not eliminate lossy compression:
the successor receives a model-written handoff instead. Repeated handoffs can still drift.
For Persona, a new session is also a runtime teardown, not just a shorter prompt.
Automatic rollover would need a separate lifecycle contract covering live workers, pending
asks, result collection, timers/monitors, Exocom obligations, permissions, and recovery
after partial cutover. Preserving cwd/model/thinking alone is insufficient. Do not add
automatic session rollover to the current scope or treat the published thresholds as defaults.
An ended turn, `agent_settled`, and a completed task are different facts. None alone
proves that the session has no remaining coordination obligations.

## Current contracts that constrain implementation

Source qualification uses installed Pi 1.3.0 and local upstream tag `v1.3.0`, commit
`71023aec1546d6d677a65669c5665c0927ce0dd0`. The working checkout of `../pi` and rolling
`latest` documentation are not interchangeable with that version.

- Native trigger: `contextTokens > contextWindow - reserveTokens`. Native defaults:
  reserve 16,384 and retained recent tail approximately 20,000 tokens.
- In this version, reserve also influences summary-output limits. Do not promise an
  independent percentage policy by silently translating it into a stored reserve.
- `getContextUsage()` can be estimated or unknown, including after compaction. Never
  substitute cumulative worker usage, session age, or zero for unknown live context.
- `pi.getSettings()` returns a copy. There is no public live-settings setter or API
  to register rows in Pi's built-in `/settings`.
- `session_before_compact` accepts cancellation or a complete replacement result,
  not an additional-instructions return for the native generator.
- `ctx.compact()` is manual compaction and aborts the active operation. Boundary
  compaction drafts have different lifecycle behavior; neither is an automatic-scheduler shortcut.
- Ordinary compaction preserves Persona runtime maps. `/reload` tears down workers,
  asks, monitors, timers, broker, and Exocom presence. `/persona reload` is different:
  it refreshes Persona resources, not the running host's settings.

Relevant implementation: `src/core/config.ts`, `src/persona/config-store.ts`,
`src/persona/model-participants.ts`, `src/extension.ts`, `src/extension/hooks.ts`,
`src/engine/async.ts`, `src/ui/model-picker.ts`, and the matching host extension types.

## Settings product contract

The entry point works without an active persona. A selected persona is required only
for operations whose ownership is per-persona. Existing commands remain shortcuts to
the same implementation, especially `/persona models [council-persona]`.

| Section | Contents | Authoritative owner |
| --- | --- | --- |
| General | Default persona, remember selection, discovery, seed behavior | Persona preferences; CLI/environment retain precedence |
| Models | Council members, MAGI cores, judges, critics, synthesizers, generators, flow participants | Existing participant resolver and per-persona assignments |
| Execution | Engine, child thinking, startup/hard limits, async retention, retry-ledger mode, change reporting | Persona execution configuration; active runs retain snapshots |
| Notifications and behavior | Status/check-in cadence, delegation nudges, supervisor/worker spine | Persona configuration and prompt-source files |
| Compaction (deferred) | Native effective settings, per-model overrides, optional continuity/summarizer policy | Pi owns native settings; not part of the current settings panel |
| Integrations | Broker and Exocom configuration/scope; companion status and links | Existing integration owners; no duplication of Mind/Flow preferences |
| Definitions and diagnostics | Persona/agent tools, permissions, coaching, strategy parameters, teams, flows, source files | Existing definitions; source-aware view rather than a second definition editor |

Every row reports effective value, saved value when different, source, scope,
editability, application timing, and reset target. Search and progressive disclosure
keep ordinary settings usable while showing all public configuration in advanced views.
Internal child guards, bus addresses, secrets, and runtime handles are not editable preferences.

Application timing is explicit: immediately, next supervisor turn, future worker/run,
resource reactivation, or host reload/start. Saving never mutates a running worker's
captured contract, model, capabilities, limits, or billing pin.

### Ownership, precedence, and persistence

- For previously environment-only preferences, add sparse, versioned Persona preferences
  with `explicit environment > user preference > existing default`. Invocation flags retain
  their existing precedence; no new project preference layer is introduced.
  Preserve each environment variable's published grammar; do not mutate `process.env`
  to implement menu choices. Invocation flags retain their existing precedence.
- Only actually implemented preferences become writable. A launch-only setting can
  be saved and marked pending; security-sensitive definition fields show their source
  and use their existing explicit resource-edit workflow.
- Consolidate preferences, per-persona model assignments and last selection in versioned
  `<agentDir>/persona/settings.json`. Use locked, atomic patches with exact-key `set`/`unset`.
  Import legacy model/state files only if the canonical file is absent; archive exact originals
  as `.migrated` after commit. Do not dual-write or overwrite malformed canonical data.
- Native compaction keys remain in native Pi settings, not a second Persona mirror.
  Native precedence, including exact provider/model overrides, must remain intact.
  Resolve the actual host profile/settings directory; do not assume `~/.pi/agent`
  or conflate Persona's `PI_AGENT_DIR` override with host `PI_CODING_AGENT_DIR`.
- Reset means remove the selected override and reveal its real inherited source;
  it does not mean write today's defaults or erase unrelated user configuration.
- File writes preserve unrelated keys, use bounded validated patches and coordinated
  locking, and report save failures without claiming persistence. Test interoperation
  with Pi's own settings writer, not just two instances of our writer.
  The native writer/lock interoperability spike is a real gate: do not import private
  host modules or ship an unlocked fallback. If current public primitives are insufficient,
  propose the smallest upstream patch capability before enabling native write controls.

### Model assignments

Reuse participant metadata instead of hardcoding MAGI or Judge. Include auxiliary
`type: "agent"` strategy parameters and flow actors. Preserve resolution precedence:
inline pin > saved role assignment > saved agent assignment > agent file > session model.

Show the preferences' owner separately from the borrowed council profile. Existing
`/persona models magi` edits the active caller's preferences, not MAGI's identity.
Show when the same assignment is shared across functions. Do not advertise independent
per-function pins unless stable function-slot keys are introduced in both the picker
and runtime resolver, with old keys as tested fallback. That expansion is not required
for the first unified panel and must not arrive as an accidental routing change.

Keep refresh explicit inside the panel, preserve existing command behavior, preserve
choices on refresh/auth failure, and never switch providers silently. Catalog visibility
is not proof of available authentication. A preference change affects future runs only.

## Compaction modes and scope

### A. Native: default and exact escape hatch

Absent Persona overrides means no change to native preparation, generation, cut point,
overflow recovery, requests, or delivery. No extra model call, wake, timer, summary
artifact, or checkpoint injection. Custom native user/project settings remain effective,
including disabled automatic compaction. Reset removes only the overrides being reset.

The panel edits native reserve/recent-tail settings, showing the derived trigger for
the actual model. A percent/token-target editor may preview a one-time conversion,
but the stored authoritative native value and its output-budget consequence stay visible.
Do not falsify a model's context-window declaration to force an earlier threshold.

Current Pi requires saved native changes to be distinguished from active settings.
No automatic `/reload`: offer a clear pending state and an explicit apply/restart
workflow that warns about all live resources, not only the supervisor's idle flag.
Resolve the writer/locking integration before enabling these write controls.

### B. Supervisor continuity: first opt-in candidate

Retain native summary generation and its auth/provider/virtual-model behavior. Add
only a small factual checkpoint derived from existing authoritative runtime state:
run IDs and aliases, pending ask IDs, uncollected result references, and next required
supervisor action when the runtime knows it. Do not invent task intent from runtime counters.

Preferred spike: `session_compact` arms a session/branch-bound generation marker and
does not send a message. The next relevant `context` builds a request-local snapshot
from current runtime state. Mirror the same snapshot into a bounded expandable
operator entry using public APIs, after proving append behavior at that hook boundary.
Do not use a persistent model-facing custom message merely to store this inventory.

Initially target only the first post-compaction provider-request chain, not a new
per-turn status injection. A `context` call does not prove the provider request ran:
test marker consumption, retry idempotence, cancellation, and session/branch epochs.
The snapshot states when it was observed; a worker may finish immediately afterward.
The capsule contains IDs/status/references, never ask bodies or report payloads. It
does not drain inboxes, mark results collected, answer questions, or relaunch work.
It must be current when prepared, bounded, operator-visible and expandable, and must
not wake an idle model or replay asks/completions. Old snapshot statuses are historical.
No per-turn growing status history, model-generated fact ledger, new context-window
tool, separate search index, or duplicate artifact store is needed for this phase.

This protects orchestration continuity; it does not claim to improve the native
narrative summary. Enable it only if downstream evaluation confirms a benefit.

### C. Structured summary: separate experimental candidate

Evaluate a task-oriented summary covering current objective, constraints, decisions,
evidence status, changed artifacts, unresolved questions, and next concrete action.
Keep references instead of copied logs. Carry rejected approaches when they prevent
known repeated failures. Preserve explicit uncertainty and user priorities.

Never copy assistant hidden reasoning, secrets, repetitive acknowledgements, skill
catalogs, or unverified claims of having loaded every skill. Do not rewrite history,
execute a handoff skill, create a new session, or write Mind memory as part of compaction.
A summarized worker report remains attributed untrusted data, not a permission or instruction.
Optional skill pointers must be relevant to the next action and must not assert that
the receiving model has already read or applied their contents.

This adapter must prove correct handling of previous summaries, split-turn prefixes,
tool-call/result pairing, context edits, file provenance, usage, timeouts, cancellation,
and bounded output. Pi does not automatically carry file details from prior `fromHook`
compactions; explicitly support a versioned provenance format and mode transitions.

The native generator resolves custom streams, virtual models, auth headers/base URLs,
thinking and retry behavior through host internals. A direct model call is not proof
of parity. Prefer a narrow public native-generation/extra-instructions capability if
host cooperation is later approved. Do not modify `../pi` now. With current APIs,
qualify supported provider paths before offering a custom mode; report unsupported
combinations rather than silently changing models or showing a nonfunctional control.

Summary model inherits the selected model unless the user explicitly chooses another
supported provider-qualified model. Failed/cancelled attempts must have visible usage
and failure semantics; never hide a second paid fallback or retry after a user abort.

Initial opt-in policy scope is the supervisor. Workers continue using their native Pi
settings; the panel says so. A worker policy requires explicit propagation and tests
for both engines, worktree cwd differences, and guarded child-extension activation.

## Development sequence and acceptance

| Stage | Outcome and primary seams | Acceptance |
| --- | --- | --- |
| 0. Baseline and spikes | Record dirty-tree baseline; inventory all consumed configuration; qualify Pi 1.3 APIs, native writer locking and checkpoint delivery | Read-only/default path unchanged; unsafe host APIs and unsupported combinations explicitly rejected |
| 1. Typed resolution and storage | Pure settings catalog/resolver; sparse preferences; model patch/reset operations | No defaults materialized; truthful provenance; reset and concurrent set/unset; no unknown-field loss or altered env grammar |
| 2. Unified settings UI | `/persona-settings`; reuse participant resolver, picker, diagnostics and existing shortcuts | No persona required for global controls; TUI/RPC/headless behavior; cancellation and session-change safety; bounded rendering |
| 3. Native compaction controls | Narrow Pi-owned edits, model-specific display, pending/apply state | Native equivalence with custom native settings; untouched unrelated keys; no automatic worker teardown or false live-apply claims |
| 4. Continuity prototype | Opt-in runtime checkpoint using verified public delivery seam | No model wake, duplicate ask/report, stale live status or extra LLM call; bounded operator-visible state |
| 5. Summary experiment | Structured candidate, provider/provenance adapter qualification or explicit host capability proposal | Split-turn, repeated compaction and mode switches correct; auth/billing unchanged; cancellation has no partial summary commit |
| 6. Evaluation and docs | Paired quality/cost trials, independent review, README/reference/architecture updates | Publish only supported controls and measured claims; native remains default and reset path |

Settings implementation modules: `src/core/settings.ts` (pure catalog/resolution),
`src/persona/settings-store.ts` (single canonical persistence owner),
`src/extension/persona-settings.ts`, `src/extension/persona-model-settings.ts` and
`src/ui/persona-settings.ts` (command/model editing/UI). A cohesive
`src/extension/compaction.ts` remains only a possible future design target.

Existing tests to extend include `test/unit/core/config.test.ts`,
`test/unit/persona/config-store.test.ts`, `test/unit/persona/model-participants.test.ts`,
and `test/integration/model-picker-participants.test.ts`. New integration tests must
exercise the actual Pi 1.3 host; the current development Pi packages are 1.0.0 and do
not by themselves qualify new 1.3 behavior. Resolve the declared host-floor decision
explicitly if a required API cannot retain that contract; do not silently claim compatibility.

## Evaluation: quality before compression ratio

Use safe, synthetic/versioned repository tasks with known ground truth; do not copy
private sessions into fixtures. Separate timing from summary-method effects:

1. Native timing + native summary: baseline.
2. Earlier native threshold + native summary: timing only.
3. Same threshold + native summary + runtime checkpoint: continuity only.
4. Same threshold + structured summary: summary method only.

Use identical prepared prefixes for controlled comparisons, followed by real task
resumption. Include at least 12 trace families, 3 repeats, two model families, and
3–5 successive compactions for drift-sensitive cases. Begin with a smaller pilot and
estimate full token cost before the live matrix; recorded fixtures are not live qualification.

Cases: changed user requirements, superseded plans, exact error/test evidence, a large
single user-message span, shell/MCP file edits, pending supervisor asks, a worker finishing
during summary generation, uncollected reports, Exocom obligations, model/auth failure,
mode switches and resume, mixed Italian/English input, and worker-output injection attempts.

Measure constraint/fact recall, decision and artifact accuracy, false-done claims,
correct next action and task completion, duplicate/lost deliveries, full input/output
and cache usage, summarization plus resumed-task cost, latency and context reduction.
Use executable/deterministic checks first and blind model grading only for semantic
dimensions, with human/independent review of disagreements. Never claim a failing
behavior is fixed because an LLM judge likes the prose.

Hard acceptance: zero safety/constraint violations and lost/duplicate control deliveries
in the qualification corpus; exact native-path equivalence in deterministic host tests;
no known task-success regression within a model family. A claimed quality improvement
requires paired results with uncertainty, not one successful demo or a compression target.
If evidence is inconclusive, keep the candidate experimental or do not ship it.

Cross-platform validation covers Windows/Linux/macOS: paths, LF/CRLF/BOM, concurrent
writers, save interruption, rename contention and permission failures. Test TUI/RPC/JSON/print,
Mind re-injection without memory writes, Flow compaction events, and optimizer coexistence.
Run project typecheck, full hermetic tests and dependency audit for any dependency changes;
engine/comm changes also require the repository's live-drive qualification.

## Deliberate non-goals

- No universal "dumb zone", compulsory early compaction, autonomous new-session handoff,
  adaptive LLM router, vector database, or extra model request per normal turn.
- No changing running-worker models/permissions, weakening fork guards, or bypassing
  explicit provider pins to make a configuration appear usable.
- No automatic durable-memory promotion, whole-history deletion, detached snapshot
  treated as current runtime truth, or broad refactor of unrelated dirty work.
- No commit, tag or publication until implementation is separately requested and qualified.
