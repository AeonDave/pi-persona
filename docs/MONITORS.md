# Time and event wakes

The supervisor receives a UTC and local clock snapshot when a run starts, alongside the original
session start and elapsed duration. The precise clock arrives as hidden model-visible context,
preserving the cached system prefix. During a long run it can call `timer` with `{"action":"now"}`
to refresh the clock. This is sampled wall-clock time, not a continuously updated model sense.

Use `timer arm` for a known time. Use `monitor arm` when a program can report the event you care
about, never one whose only job is to elapse time. Sub-agent completions and Exocom messages already
wake the supervisor automatically, so neither tool should wait on them.

## Background programs

`monitor` starts an executable with literal arguments in the current workspace and returns an id
immediately. There is no implicit shell. For shell syntax, pass a script file to the appropriate
shell. Windows `.cmd` launchers likewise need an explicit shell; a native executable or script
interpreter avoids platform-specific quoting.

| Mode | When the model wakes | Typical source |
|---|---|---|
| `exit` | The launched program finishes, with its exit code and bounded output tail | Build or local job |
| `output` | A nonempty stdout line arrives | File watcher, filtered log tail, system-event subscription, service adapter |

For example, start an existing build script and get its completion:

```json
{"action":"arm","command":"node","args":["scripts/build.mjs"],"label":"build finished","mode":"exit","timeoutSeconds":900}
```

Or start an existing event adapter that prints only meaningful state changes:

```json
{"action":"arm","command":"node","args":["scripts/watch-status.mjs"],"label":"status changed","mode":"output","timeoutSeconds":600,"maxEvents":3}
```

Adapters can use native file/system subscriptions, a program's streaming API, or inexpensive
polling inside the program when no subscription exists. The model does not run a polling loop.
Print one short event per line to stdout; send diagnostic chatter to stderr. Flush output promptly
(for Python, use `-u` or `flush=True`). Repeated identical lines are ignored for that watch.
Monitor stdout and stderr are captured automatically within fixed limits. For a complete, unlimited
transcript, keep using the program's own log file; monitor capture is bounded diagnostic evidence.

The model can continue independent work while a monitor runs. Events wait while it is busy and
arrive together at an idle boundary. When only the event remains, it should end its turn. Natural
requests such as “let me know when this build finishes” are enough; tool parameters are for the
model or an integration, not something the user needs to manage.

## Visibility

An armed timer or active monitor shows as a row in the agent widget and the F9 / `/agents` overlay,
beside the sub-agents: `◉ <label>  <id> · <mode> · <elapsed> · deadline in <remaining>` for a monitor
(`<id> · output · k/N events` as events arrive), `⏰ <label>  <id> · fires in <remaining>` for a timer
(just `⏰ <id>  fires in <remaining>` when the timer has no label).
The countdown replaces the stall clock, so a quiet watch is never `⚠ stalled`. While a process runs,
its latest useful stdout/stderr progress is displayed on its row, including partial lines and carriage-return
progress updates. Tails ingest every chunk immediately; their display is updated at the existing UI
frame cadence instead of rebuilding the full row for every chunk. Terminal events and cancellation
include the final tail immediately. This is a bounded, sanitized UI projection: it does not create a
model wake or consume an output-event allowance. `⏎` opens the command, cwd, times, bounded live output tails and last 40 event
lines (monitor), or the fire time and message (timer); `x` cancels that
one watch like `monitor cancel` / `timer cancel`. These are rows, not agents: no steer, `X` stop-all
skips them (`intercom stop { to: "all" }` likewise leaves them alone; cancel with `monitor cancel` /
`timer cancel` or `x`), and they never count in `N agents` or reach telemetry. A finished row settles
and leaves like an async run: its final ✓/✗/■ goes to the tree change stream (telemetry excluded), not
to the screen.

## Session-owned logs and results

`monitor { action: "result" }` lists retained captures, including completed jobs; add `id` to read one.
The default read shows a short tail; `full: true` reads the complete **retained** capture, not bytes
already discarded by the capture limit. This is retrieval, not a wait: do not poll it for completion.
`list` still lists only active watches. IDs are activation-unique so reload cannot confuse an old log
with a newly launched process.

The archive belongs to the **whole session tree**, not only the active conversation branch.
`result` can therefore list or retrieve a log from a sibling branch that is absent from the current
transcript. Branch navigation changes the transcript, not archive visibility or ownership. Both
retention budgets below are shared across all branches and remain shared after reload.

A terminal event or cancellation saves one bounded stdout/stderr snapshot and outcome as a custom
entry in the owning Pi session. An expandable operator-only log card exposes it without adding the
raw log to model context or triggering another turn. No per-chunk session entries or sidecar files
are written. Shutdown/reload stops processes and saves their available diagnostics; resume can read
the snapshots but never restarts the processes. A hard crash can lose a running job's not-yet-saved
capture. In a non-persistent session, logs remain in memory only.

Deleting the owning session file removes its stored logs with it. Reload, ordinary shutdown and
context compaction are not deletion. Forking/copying a session can copy its historical log entries;
each copy then owns its own data, with no shared external file to orphan or delete accidentally.
Backups and exports may also retain copies; deleting the original session is not secure erasure
of those copies. Treat captured stdout/stderr as session data: printed credentials, signed URLs
and other secrets can be stored in the JSONL. Sanitize/redact sensitive output in the producing
program before capture. Display sanitization is not secret redaction; requesting `result` returns
the selected retained text to the model, even when it originated on a sibling branch.

Each capture retains the last 16,384 UTF-16 code units of stdout and stderr independently, plus at
most 16,384 code units of status text. Live F9 tails retain 4,000 code units per stream. The journal
admits at most 64 terminal records and a conservative 2 MiB cumulative serialized-data budget per
session (JSON escaping, metadata and envelope allowance included). Historical entries, even unknown
formats, consume that budget; reload does not reset it. Once exhausted, new captures remain only in
the bounded runtime history, and `result` explicitly reports the storage limitation. Truncation and
persistence failures never claim a complete or durable log.

## Lifetime and limits

- `list` shows active watches; `cancel` with the returned `id` stops the owned process tree and
  removes that watch's queued events. It never stops an unrelated job merely because its status
  is being observed by an adapter.
- Defaults are one output event and a ten-minute deadline. Limits are eight active monitors,
  twenty distinct output events per monitor, and twenty-four hours of lifetime.
- Exit, launch errors and deadline expiry produce terminal notices. Reaching the output event
  count ends the watch immediately; the notice says the watch ended, without claiming the job succeeded.
- Lines and diagnostics are bounded. The session retains at most 64 pending events, delivers up
  to four per batch, and reports omitted older events if a busy model cannot keep up.
- Keep Pi open. Watches are in memory and stop on shutdown, reload, or session replacement;
  they are not restored on resume. A headless `pi -p` invocation that exits after its answer is
  not a persistent monitoring service: an alarm or event wakes it only if it lands before the single
  turn settles, and the arm result says so instead of inviting the model to end its turn.

## Permissions and architecture

Starting a command requires both `monitor` and `bash` to be active and allowed by the persona.
Changing to a persona that removes either permission stops its monitors and discards queued
events. Normal Exocom pending-question gates apply to monitor calls as well.

This is command execution with the host user's access, not an OS sandbox or a read-only guarantee.
An extension that enforces command-specific policy through `tool_call` must inspect `monitor`
as well as `bash`; Pi Persona does not synthesize another extension's Bash hooks. External event
text is fenced as untrusted data before delivery, with runtime id, time and outcome outside the fence.

The pure `src/core/monitor.ts` owns limits and lifecycle. `src/monitor/process.ts` adapts a process
using the existing process-tree cleanup helper. `src/monitor/session.ts` connects bounded events
to the existing `IdleCoalescingNotifier` and `sendPersonaFollowUp` path. No separate wake broker,
public listener, durable queue, or new orchestration engine is introduced.

The design follows the background-program model described in the official
[Claude Monitor documentation](https://code.claude.com/docs/en/tools-reference#monitor-tool).
Protocol-specific integrations can be ordinary adapter programs; direct WebSocket connections
and persistent services are outside this tool's current scope.

For live verification, `scripts/monitor-smoke.mjs` runs a persistent Pi RPC session and checks an
automatic model turn after a local event. It requires an explicit `LIVE_MODEL=provider/id` because
it spends provider tokens. Unit and integration tests use deterministic clocks and local programs.
