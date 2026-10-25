# Compaction and continuity evaluation proposal

**Status:** deferred. This document records future evaluation questions, not shipped behavior or
authorization to implement compaction controls. Unified Persona settings shipped in 1.17.1; their
current contract is in [REFERENCE.md](../REFERENCE.md). Native Pi compaction remains the only
runtime compaction path. A separate decision is required before implementation or paid provider
trials.

The earlier settings implementation plan has been closed. This proposal retains only its unresolved
compaction research, future design options and evaluation gates. Revalidate every host seam against
the supported Pi release before designing implementation; the historical Pi 1.3 qualification notes
are intentionally not carried forward.

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

- With no future opt-in feature enabled, preserve native Pi compaction preparation, generation,
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
This experiment does not authorize shipping a new settings control.

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
