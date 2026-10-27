# Compaction and continuity evaluation proposal

**Status (2026-10-27):** native idle timing is restored at the user's request, but activation is
hard-blocked by a reproduced Pi 1.4.0 compaction lifecycle defect. The Context settings show the
unavailability; no idle scheduler or lifecycle hooks are installed while the host is unqualified.
Saved preferences and environment values cannot bypass the block. Custom summaries, continuity
checkpoints and comparative-quality experiments remain deferred. The current settings contract is
in [REFERENCE.md](../REFERENCE.md); native Pi compaction remains the only runtime path.

The earlier settings implementation plan has been closed. This proposal retains the authorized
timing policy, its blocking evidence, the restored implementation's activation gate, unresolved
research and evaluation gates. Revalidate every host
seam against the supported Pi release before implementation; historical Pi 1.3 qualification notes
are intentionally not carried forward.

## Authorized idle timing and failed admission gate

Upstream tracking: [Pi issue #7738](https://github.com/earendil-works/pi/issues/7738) is closed, but
the [2026-10-12 follow-up](https://github.com/earendil-works/pi/issues/7738#issuecomment-6128063305)
describes the same failure-hook cleanup race on 1.1.0. Our independent 1.4.0 reproduction below
confirms that closure is not evidence this narrower case was fixed. No duplicate issue was opened.
Our [2026-10-27 follow-up](https://github.com/earendil-works/pi/issues/7738#issuecomment-6436968518)
includes a standalone reproduction (3/3 runs) and the tested correction: retain a controller local
to each operation, read its signal locally, and guard every shared-state cleanup by controller
identity, including success, catch and finally. Three offline tests passed against a temporary SDK
copy: overlapping cancellation, successful completion of the second request, and protection of its
controller from the older request's cleanup. The installed host was unchanged. These results do not
qualify the upstream TypeScript build, full suite or real-provider summarization.

The user selected these defaults on 2026-10-27:

| Control | Agreed behavior once the host is qualified |
|---|---|
| Enable | Off by default; opt in through `/persona-settings` |
| Idle interval | 15 minutes |
| Context threshold | Known current context occupancy strictly above 40%, not cumulative token usage |
| Attempt limit | One attempt per idle episode, including failure, cancellation or a result still above the threshold |
| Generator | Pi's native preparation and summary generation, with its provider/auth/cancellation semantics |

New foreground work or genuine terminal activity resets the idle clock. Startup, reload, branch
navigation and compaction completion alone must not manufacture a new episode. Admission must
exclude running/queued workers, pending input or editor drafts, orchestration, unanswered asks and
queued notifications. Future timer alarms and passive monitors are not themselves active workers;
their fired deliveries must remain queued safely during compaction. Unknown context usage skips
admission. The evaluated first scope was TUI only: RPC cannot inherit TUI input buffering by assumption.

The spike exercised a pure episode policy, saved/environment settings, the real extension factory,
fake-clock worker/notification integration, and the actual Pi 1.4.0 SDK with a local faux provider.
Several checks passed, including one-attempt behavior and held timer delivery. Those passes did
**not** satisfy the safety gate: a normal overlapping manual compaction still failed.

Reproduced sequence, using only public SDK calls/hooks and synthetic history:

1. Start an owned `ctx.compact()` and hold its `session_before_compact` handler.
2. Submit a second `session.compact()`, the same session API called by TUI `/compact`. Its abort
   cancels the first operation and waits for idle.
3. Release the first handler; its cancellation clears the shared controller and emits
   `compaction_end`, then awaits an ordinary asynchronous `session_compact_failed` handler.
4. The second operation now starts. A Persona-style public hook returns `{ cancel: true }` to
   reject it while the first callback is pending.
5. While that hook emission yields, the first operation's `finally` clears the second controller.
   The second error handler dereferences the now-absent controller's `signal`.

Observed result: `Cannot read properties of undefined (reading 'signal')`, with **two
`compaction_start` events but only one `compaction_end`**. The final standalone reproduction used
zero provider requests and zero network requests. This was reproduced separately from the full
test run. Source anchors in the installed Pi 1.4.0 `dist/core/agent-session.js` are `compact()`
(2230 onward), early clearing (2335), awaited failure hook (2344), and unconditional final clearing
(2354). TUI `/compact` dispatch precedes its generic input-buffering path in
`dist/modes/interactive/interactive-mode.js` (2611 versus 2664).

Keeping ownership until the native callback, gating `before_agent_start`, vetoing threshold/overflow
compactions and rejecting overlapping manual hooks was insufficient. The remaining defect is host
controller ownership/cleanup, not a missing threshold or debounce. Do not suppress the exception,
patch private host fields or intercept the user's `/compact` keystrokes. The restored settings must
state that activation is blocked, rather than imply that an unavailable toggle can enable the feature.

The user subsequently authorized keeping the implementation in the repository while disabled.
Its pure episode tests remain executable. Negative integration checks must prove that even an
explicit saved/environment opt-in cannot register the idle scheduler, terminal input listeners,
compaction hooks or model requests. This is a deliberate qualification block, not an old-host
compatibility path or a hidden experimental opt-in. Updating Pi alone does not unlock it: a future
Persona change must first qualify the supported host and explicitly remove the block.

Run `node scripts/idle-compaction-host-check.mjs` for the standalone, offline host admission check.
It asserts correct cancellation and paired lifecycle events, so it fails on the affected Pi 1.4.0.
It is separate from the normal suite, which verifies Persona's disabled behavior. A passing host
check is necessary but does not replace the remaining input, wake and cancellation checks below.

Reopening gate: qualify per-operation controller ownership and identity-guarded cleanup in the
supported host, then rerun the active-manual-overlap reproduction and input/wake/cancellation
scenarios. The tested correction preserves Pi's existing second-cancels-first behavior; neither a
new API nor generalized serialization is required to fix this race. A public non-aborting, atomic
`compactIfIdle` operation could simplify future admission independently. Preserve
the default-off/no-scheduler path, test current TUI and explicitly unsupported modes, and verify
Intercom/Exocom/timer delivery without loss or duplicate wakes. Do not claim semantic quality or cost
improvements from a timing change alone.

### Restore verification (2026-10-27)

- Full suite on Windows: 2,990 tests, 2,988 passed, zero failed, two expected Windows skips.
  `npm run typecheck` and `git diff --check` passed.
- Focused tests cover the pure episode policy, forced saved/environment opt-ins, unavailable
  settings, and the real SDK in TUI/RPC mode. Native manual compaction remains callable; no automatic
  compaction, terminal subscription or wake is introduced by the blocked installer.
- `npm run smoke:exocom` passed its real socket/pipe discovery, messaging, attribution, reply,
  claim, budget and cleanup checks. The existing Exocom toast condition remains unchanged.
- A real `scripts/drive.ts` run in an isolated profile with idle opt-in forced on completed one
  `openai/gpt-6-luna` worker at requested `xhigh`, using a complete structured brief and no worker
  tools. It returned `IDLE_SMOKE_OK`, one done/zero failed, exit 0. This is a delegation smoke,
  not an enabled-compaction qualification. The temporary profile was removed.
- The standalone host check exits 1 on the installed Pi 1.4.0 (the reproduced controller defect).
  The same check passes against the isolated SDK copy with the proposed controller fix, with two
  cancellations and paired start/end events, no provider/network calls and no saved summary.
  The installed SDK remains unmodified. Neither result unlocks the feature.

## Research basis and limits

- The [Pi context-window proposal](https://www.reddit.com/r/PiCodingAgent/comments/1x776vc/i_built_a_pi_extension_so_my_agent_doesnt_fall/)
  measures context and asks the agent to write a handoff. It does not compact or create the handoff;
  its author reports no measurable benchmark.
- The proposal's [current source](https://github.com/utpalsinghdev/pi-extensions/tree/main/packages/pi-context-window)
  supports percentage or fixed-token thresholds, but is not an automatic compaction scheduler.
- [Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  supports recall-first tuning on complex traces before reducing information.
- [Chroma's context-rot experiments](https://www.trychroma.com/research/context-rot) show model- and
  input-dependent degradation; they do not establish a universal cutoff for current coding agents.
- [Factory's evaluation](https://factory.com/news/evaluating-compression) suggests recall, artifact,
  decision and continuation probes. Its vendor results do not qualify this design.
- [OpenAI cache guidance](https://developers.openai.com/cookbook/examples/prompt_caching_201)
  motivates measuring the complete resumed-task cost instead of assuming a handoff is cheaper.
- [AutoCompact](https://arxiv.org/abs/2610.02163) studies a trained policy, not a drop-in prompt.
  Only its abstract was reviewed; its reported gains do not predict this plugin's results.

A second [successor-session proposal](https://www.reddit.com/r/PiCodingAgent/comments/1wqatix/killed_context_anxiety_with_automatic_session/)
describes a configurable token ladder, stronger wrap-up prompts and eventual handoff to a fresh
session. It links no implementation or comparative benchmark. A new session tears down runtime
resources; preserving cwd, model and thinking alone would not settle workers, asks, results,
timers, monitors, Exocom obligations, permissions or partial-cutover recovery. Do not treat a
published threshold as a default or add automatic session rollover under this proposal.

Changing what is retained may be worth evaluating. Earlier timing, smaller summaries and better task
performance are separate outcomes and must be measured separately.

## Runtime boundary

- While activation is blocked, preserve native Pi compaction preparation, generation,
  overflow recovery and delivery. Add no scheduler, model request, wake, timer, injected checkpoint
  or summary artifact to the current path.
- Native compaction remains the default and sole production path until a separately authorized,
  measured design proves otherwise. Do not mirror native settings into a Persona-owned store.
- Unknown or estimated context usage stays unknown; do not substitute cumulative worker usage,
  session age or zero for live context.
- A context hook is not proof that a provider request ran. Any future marker needs tested
  consumption, retry, cancellation and session/branch identity semantics.
- A saved checkpoint or summary is historical evidence, not live runtime truth. It cannot answer
  asks, collect reports, relaunch work or authorize a child action.
- Preserve explicit provider pins, auth, billing and cancellation semantics. A direct model call is
  not evidence of parity with Pi's native summary generation.

## Candidates to evaluate

### Native timing with native summary

Use this as the baseline. A test may compare the native threshold with an earlier threshold while
keeping native summary generation fixed. Record the effective native settings and their effect on
summary output limits. Do not falsify a model's context-window declaration to force a cut point.
Only the narrow idle-timing policy above is authorized; it must first clear the host admission gate.

### Supervisor continuity checkpoint

First opt-in candidate, if a current public host seam supports it. Keep native summary generation;
derive a small factual checkpoint from authoritative runtime state: run IDs and aliases, pending ask
IDs, uncollected result references and the next supervisor action only when runtime state knows it.
Never infer intent from counters.

A future spike could arm a session/branch-bound marker at compaction without sending a message, then
build a request-local snapshot at the next relevant context preparation. If an operator entry is
mirrored, it must be bounded and expandable and use a verified public append API. Start with only the
first post-compaction provider-request chain. State when the snapshot was observed because a worker
may finish immediately afterward. Include IDs, statuses and references, never ask bodies or report
payloads. Do not drain inboxes, mark results collected, answer questions, relaunch work, wake an idle
model or inject growing status on every turn.

### Structured summary experiment

Separate experiment, not a native-generator replacement by assumption. Evaluate a task-oriented
summary of the objective, constraints, decisions, evidence status, changed artifacts, unresolved
questions and next concrete action. Keep references rather than copied logs; retain rejected
approaches only where they prevent a known repeated failure.

Never copy hidden reasoning, secrets, repetitive acknowledgements, skill catalogs or claims that the
receiving model already read a skill. Do not rewrite history, invoke a handoff skill, create a session
or write durable memory during compaction. Worker reports remain attributed untrusted data. If an
optional skill pointer is included, state only that it may be relevant to the next action.

Before considering a custom summary path, test prior summaries, split-turn prefixes, tool/result
pairing, context edits, file provenance, usage, timeout, cancellation and bounded output. Explicitly
support a versioned provenance format and mode transitions. Revalidate native handling of custom
streams, virtual models, auth/base URLs, thinking and retries against the current supported host. Use
only public APIs; if parity requires a host capability, propose the narrowest public capability for
separate approval. Failed or cancelled attempts need visible usage/failure semantics and must not
hide paid fallbacks or retry after user abort.

## Evaluation and acceptance

Use safe, synthetic, versioned repository tasks with known ground truth. Do not copy private sessions
into fixtures. Separate timing from summary-method effects:

1. Native timing with native summary: baseline.
2. Earlier native threshold with native summary: timing only.
3. Same threshold with native summary and runtime checkpoint: continuity only.
4. Same threshold with structured summary: summary method only.

Use identical prepared prefixes followed by real task resumption. Include at least 12 trace families,
three repeats, two model families and three to five successive compactions for drift-sensitive cases.
Start with a small pilot and estimate full token cost before the live matrix. Recorded fixtures are
not live qualification.

Cover changed requirements, superseded plans, exact error/test evidence, large user-message spans,
shell/MCP file edits, pending supervisor asks, a worker finishing during summarization, uncollected
reports, Exocom obligations, model/auth failures, mode switches/resume, mixed Italian/English input
and worker-output injection attempts.

Measure constraint/fact recall, decision and artifact accuracy, false-done claims, correct next
action and task completion, duplicate/lost control deliveries, complete input/output/cache usage,
summary plus resumed-task cost, latency and context reduction. Prefer deterministic checks for
executable properties; use blind model grading only for semantic dimensions and independently review
disagreements. Never claim a fix because a model judge prefers the prose.

Hard acceptance: zero safety/constraint violations and lost/duplicate control deliveries in the
qualification corpus; exact native-path equivalence in deterministic host tests; no known
task-success regression within a model family. Any claimed quality improvement requires paired
results with uncertainty, not one successful demo or a compression target. Inconclusive evidence
keeps the candidate experimental or unshipped.

Cross-platform validation must cover Windows, Linux and macOS: paths, LF/CRLF/BOM, concurrent
writers, save interruption, rename contention and permission failures. Cover TUI/RPC/JSON/print,
Mind reinjection without memory writes, Flow compaction events and optimizer coexistence. Consult
[ARCHITECTURE.md](../ARCHITECTURE.md) for current runtime boundaries before any future change. Engine
or communication changes also require the repository's live-drive qualification.

## Deliberate non-goals

- No universal "dumb zone", compulsory early compaction, automatic successor session, adaptive
  LLM router, vector database or extra model request per normal turn.
- No changing running-worker models or permissions, weakening fork guards or bypassing explicit
  provider pins to make a configuration appear usable.
- No automatic durable-memory promotion, whole-history deletion or detached snapshot treated as
  current runtime truth.
- No implementation, paid model trial or release claim without a separate owner decision and the
  gates above.
