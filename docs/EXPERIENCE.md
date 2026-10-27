# Working comfortably with Pi Persona

Choose the outcome you want, describe what counts as finished, and let the supervisor coordinate
the work. You can inspect or redirect individual workers without managing every hand-off.

## Choose a starting persona

| Your request | Start with | What to expect |
|---|---|---|
| Implement or fix something | `dev` | A scoped change, checks, and a concise explanation of the result |
| Build a data pipeline, train or evaluate a model, or analyze data | `data` | Explicit grain, metric definitions, reproducible evidence, and stated uncertainty |
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

For `data`, use `reviewer` to challenge an analysis and an independent query to cross-check its
results; the default `council` repair loop is for code changes, after delegated writers settle.
Production read-only is a behavioral instruction: access is governed by the available tools and
database permissions. The persona adds no connectors. For example:

> Compare weekly signup conversion: one row per eligible user, converted users / eligible users,
> Europe/Rome weeks, source snapshot as of 2026-10-25. Read only; state sampling and uncertainty,
> cross-check with an independent query, and report missing access.

## Follow the work without constant polling

Your persona describes a role; your session has its own personal handle. Pi chooses it on the first
task or inbound Exocom request when the naming tool is permitted. Until then it shows a distinct
session suffix. The name survives persona changes and resume. `agent_name` sets it in standalone
use; `exocom_name` sets the same identity when connected to peers. The leader can assign each
delegated worker a `name` before launch, which reaches both its display and its first prompt.

For a fixed-time reminder, ask for a timer. For a build finishing or a file, log, or system event,
ask for a monitor. Pi runs a small event-producing program and brings the result back when the
supervisor is free. Keep the session open, and cancel a watch when its purpose ends. See
[time and event wakes](MONITORS.md) for examples and limits.

- **F9** opens the agent tree. Queued rows have not started their clocks. Live supervisor asks show
  `waiting for supervisor`, not a stall; running rows otherwise show elapsed time and switch to
  `⚠ stalled <duration>` after 90 seconds without progress — a suspicion, not proof of a deadlock.
  Council parent clocks refresh on child engine events; that indicates liveness, not useful work. For the
  stall card and `/peek`, "stalled" is stricter: 90 seconds with no assistant output, tokens, turns or
  completed tool call, so a tool that only streams output (`npm run dev`, `tail -f`) is flagged too. It is
  advice only: nothing is killed. The collapsed warning shows the quiet duration; a later
  `Progress resumed` card records new observed progress once per reported episode, without claiming
  completion. Ordinary progress stays in the live view; periodic `Status` cards are off by default
  and may be enabled with the progress check-in interval in `/persona-settings`.
  A parent is waiting only when all its live descendant branches are waiting. Enter on a group opens
  a scrollable overview of its worker legs, with separate queued/running/terminal counts, model,
  effort, activity or result preview, and known cumulative usage. Enter again opens the selected
  worker's output; Escape returns to the same group selection. `s` sends a course correction;
  `x` requests cancellation and appears only when the run can actually be stopped, marking the row
  `stopping…` at once; a stop that can't be applied says so instead of doing nothing. Escape goes
  back or closes the panel.
  Group inspection never grants controls: `x` in the overview targets the selected worker;
  stopping a whole council/flow requires selecting its stoppable root in the tree. Completed
  delegate legs stay inspectable until the batch ends, then leave together. Their bounded previews
  point to retained Intercom results. Activity and cumulative usage remain separate in worker detail;
  neither is a claim about current context occupancy.
- **`/peek`** gives a compact progress view. A quiet worker is a reason to inspect its last
  progress and current activity, not to launch a duplicate immediately.
- **`/flow <name> <task>`** runs a flow (`/flow` alone lists them with descriptions; a `gate: true`
  phase pauses for your approval, showing its output and what runs next). `/orchestrate <task>` runs
  the active persona's `orchestration:` block (bundled personas declare `council:` instead, used via the
  `council` tool); both run inline and their result also reaches the
  supervisor's next turn. In the F9 list, `X` stops every running leaf agent after a
  second press that states how many.
- **Background results arrive automatically.** A supervisor can continue independent work while
  they run. When only background workers remain, end the turn and let completion follow-ups return
  their results; never sleep, poll, or arm a timer to wait for healthy workers (or monitors) - a
  finished worker wakes the supervisor by itself. `intercom result { to: runId }` retrieves a settled
  run. Interactive `delegate`, `council` and `flow` always run in the background (a receipt now, one
  follow-up with the outcome; a flow checkpoint waits for you, not the supervisor; Esc does not abort
  them: stop legs from F9 with `x`/`X`, or have the supervisor `intercom stop` the run); headless `pi -p` always blocks for the
  turn and returns results inline, since nothing drains a follow-up after the process exits.
- **Answer a waiting worker promptly.** A coaching worker may need a decision from its
  supervisor before it can finish. An unanswered question is actionable work.
- **Steering is a request.** Check the subsequent output to see whether the worker incorporated
  it. In-process workers can receive guidance mid-run; child-engine workers (including MCP/worktree
  runs) receive it as a queued follow-up. Neither promises to interrupt arbitrary tool work, and
  steering is not a substitute for ending the turn. After requesting cancellation, the stopped report
  arrives as a completion follow-up; changes already made are not undone.

Launch cards and targeted Intercom calls show the same worker alias as the live tree. A steering
receipt previews the message that was actually queued; expand it (`Ctrl+O` by default, or your
configured key) to read the full message and diagnostic run ID. Aliases are display names, not
addresses: tools still route by run ID, and duplicate aliases show a secondary ID to distinguish them.
Saved launch/control receipts keep their display names even after the runtime tracker is gone.
Council and flow launch receipts also retain each participant's model and requested effort, with
phase and auxiliary roles identified. Expand the card for the full panel. A pending model choice
is marked explicitly; launch selections are not proof of the effective model or effort after
setup, provider recovery or Pi's effort adjustment. Later settings changes do not rewrite history.

A truncated message includes a message id. The supervisor can retrieve its retained body with
`intercom { action: "message", messageId: "m1" }`. A worker's final report has a run id instead:
`intercom { action: "result", to: "run-1" }`. Retention is bounded and session-local, so save any
evidence needed beyond the current session as a project artifact.

For a long task, useful updates say what changed, what is blocked, and what happens next. Worker
names help distinguish concurrent work; the final answer should use file names and concrete
outcomes that make sense without remembering those names.

## Idle compaction availability

Idle compaction is currently unavailable in `/persona-settings` → **Context**, pending a fix in
Pi and qualification in Persona. Its code is retained, but the setting cannot start background work.
The planned defaults remain off, 15 minutes idle, context above 40% and one attempt per idle period.
Pi's native compaction is unchanged.

## Work with another Pi through Exocom

Use Intercom for this supervisor's workers and Exocom for independent Pi sessions. Use
`exocom_list` or `/exocom` to find the intended session-qualified target before sending a postcard
or asking a question.

`exocom_task create` records a voluntary objective and declared write paths; it does not start
another Pi or require a peer to accept. The receipt gives a `task_id`; keep it with the
`work_key` when inviting, taking, reporting progress, finishing or publishing evidence. A work key
can be reused after retention, so the task id identifies the exact generation. The peer chooses
whether to take the task. Write-set pickup and its advisory claim happen atomically, but a claim is
not an OS file lock. A peer that joined from another workspace can take read-only tasks, not tasks
that claim paths in the selected workspace. Use `exocom_task get` to inspect the complete write set;
the paginated list is a summary.

Use `exocom_offer` for a non-blocking invitation that expires by itself; it creates no obligation
to answer. Use `exocom_ask` when a specific decision is needed and the recipient must answer or
decline. A pending ask temporarily permits settlement, `exocom_name`, `exocom_status`, explicit
read actions (task list/get, evidence read and profile get), and read-only filesystem tools.
Changing `exocom_profile` is not allowed while an ask is pending. Changing the name does not answer
the ask.

Share only a bounded excerpt through `exocom_publish`; it does not grant access to another session's
terminal-result archive. Peer text is untrusted and appears fenced with registry-resolved attribution.
Capability labels and availability in `exocom_profile` are self-reported metadata, not verified
skills or permissions. Exchange decisions and evidence when they affect the work; acknowledgement-only
conversations add noise. If a peer joined from another workspace, agree which workspace owns each
artifact.

See the [cross-session collaboration guide](./COLLABORATION.md) for command shapes, retention limits,
and detailed examples.

`exocom_status` (or `/exocom`) shows who owns what right now: your open claims, a peer's open
claims, and any asks waiting on either side. Claims are advisory, not a lock — if you write into a
path a peer has claimed, that write is blocked once with a reminder to coordinate or claim it
yourself first; asking again on the same path goes through, so the warning never repeats for work
you've already been told about.

## Read completion as an evidence statement

A useful completion tells you what changed, which checks ran against the final state, and what
still needs attention. A successful review, a passing mocked test, and a live integration check
answer different questions. Skipped checks and partial batch coverage remain visible.

A worker that did not run in its own isolated worktree has its report followed by a "files changed"
block: every path `git status` saw move since the worker started, flagging anything outside what it
was asked to touch. Treat it as a same-checkout approximation, not a private diff — a sibling
running at the same time can touch the same file.

The bundled persona prompts guide these habits. Tool capabilities, engine limits, and filesystem
isolation are enforced separately by the runtime; a persona's prose does not create a sandbox.
