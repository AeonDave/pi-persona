# Working comfortably with Pi Persona

Choose the outcome you want, describe what counts as finished, and let the supervisor coordinate
the work. You can inspect or redirect individual workers without managing every hand-off.

## Choose a starting persona

| Your request | Start with | What to expect |
|---|---|---|
| Implement or fix something | `dev` | A scoped change, checks, and a concise explanation of the result |
| Review a change | `audit` | Prioritized, evidence-backed findings; edits only when requested |
| Turn an idea into an implementation plan | `planner` | Decisions, dependencies, and verifiable steps without changing application code |
| Investigate a question | `researcher` | Sources, conclusions, uncertainty, and durable notes when the scope warrants them |
| Apply one operation across many independent items | `swarm` | Explicit coverage of completed, failed, and remaining items |
| Repair a failing build or verify an implementation | `verify` | Fresh checks on the actual tree; repairs only when requested, with unresolved failures stated clearly |

Switch with `/persona <name>` or F8 (the default shortcut). `/persona seed` installs missing defaults. Existing customized
persona files remain yours; `/persona restore` replaces installed defaults, so use it only when
you intend to discard those customizations.

Restart Pi after updating the extension. Known, untouched defaults upgrade automatically; customized
copies remain unchanged and can be compared with the bundled persona before adopting individual edits.

An effective request names the intended result and its constraints. For example:

> Fix the cancellation bug. Preserve the public API and my existing edits. Delegate independent
> investigations, implement the fix, and run the relevant checks. Tell me what changed and what
> remains unverified.

## Follow the work without constant polling

For a fixed-time reminder, ask for a timer. For a build finishing or a file, log, or system event,
ask for a monitor. Pi runs a small event-producing program and brings the result back when the
supervisor is free. Keep the session open, and cancel a watch when its purpose ends. See
[time and event wakes](MONITORS.md) for examples and limits.

- **F9** opens the agent tree. Enter opens a selectable worker's output; `s` sends a course correction;
  `x` requests cancellation; Escape goes back or closes the panel.
- **`/peek`** gives a compact progress view. A quiet worker is a reason to inspect its last
  progress and current activity, not to launch a duplicate immediately.
- **Background results arrive automatically.** A supervisor can continue independent work while
  they run. `intercom wait` joins results when the next step depends on them.
- **Answer a waiting worker before joining it.** A coaching worker may need a decision from its
  supervisor before it can finish. An unanswered question is actionable work.
- **Steering is a request.** Check the subsequent output to see whether the worker incorporated
  it. Check the terminal result after requesting cancellation; changes already made are not undone.

A truncated message includes a message id. The supervisor can retrieve its retained body with
`intercom { action: "message", messageId: "m1" }`. A worker's final report has a run id instead:
`intercom { action: "result", to: "run-1" }`. Retention is bounded and session-local, so save any
evidence needed beyond the current session as a project artifact.

For a long task, useful updates say what changed, what is blocked, and what happens next. Worker
names help distinguish concurrent work; the final answer should use file names and concrete
outcomes that make sense without remembering those names.

## Work with another Pi through Exocom

Use Intercom for this supervisor's workers and Exocom for independent Pi sessions. Ask a peer for
a relevant second opinion or coordinate work already in progress. A bounded implementation task
belongs in a worker brief with explicit ownership and a success criterion.

When Exocom is enabled, use its listed targets to keep messages attached to the right session.
Exchange decisions and evidence when they affect the work; acknowledgement-only conversations
add noise. If a peer has joined from another workspace, agree which workspace owns each artifact.
That peer's membership does not grant it a write claim in the selected workspace.

## Read completion as an evidence statement

A useful completion tells you what changed, which checks ran against the final state, and what
still needs attention. A successful review, a passing mocked test, and a live integration check
answer different questions. Skipped checks and partial batch coverage remain visible.

The bundled persona prompts guide these habits. Tool capabilities, engine limits, and filesystem
isolation are enforced separately by the runtime; a persona's prose does not create a sandbox.
