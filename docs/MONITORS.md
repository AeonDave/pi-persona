# Time and event wakes

The supervisor receives a UTC and local clock snapshot when a run starts, alongside the original
session start and elapsed duration. The precise clock arrives as hidden model-visible context,
preserving the cached system prefix. During a long run it can call `timer` with `{"action":"now"}`
to refresh the clock. This is sampled wall-clock time, not a continuously updated model sense.

Use `timer arm` for a known time. Use `monitor arm` when a program can report the event you care
about. Sub-agent completions and Exocom messages already wake the supervisor automatically.

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
Keep complete logs in the program's normal log file if they are needed later.

The model can continue independent work while a monitor runs. Events wait while it is busy and
arrive together at an idle boundary. When only the event remains, it should end its turn. Natural
requests such as “let me know when this build finishes” are enough; tool parameters are for the
model or an integration, not something the user needs to manage.

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
  not a persistent monitoring service.

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
