# pi-persona technical reference

This is the canonical technical guide for the runtime surfaces that users configure through
personas, agents, teams, flows, contracts, presets, and environment variables. The design contract
lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md); strategy shapes and their complete parameter table
live in [`STRATEGIES.md`](./STRATEGIES.md). User-oriented orientation and operating examples start
in the root [`README.md`](../README.md) and [`EXPERIENCE.md`](./EXPERIENCE.md).

## Core API

The runtime is composed from a small, fixed set of primitives. A strategy is a TypeScript file
composing the **Strategy SDK**; a persona picks whether and how those run. `magi` is a `.md` persona
plus a file that calls `parallel` and `reduce.vote`.

**Strategy SDK** (`src/orchestration/sdk.ts`) — the primitives available to a strategy:

| Primitive | Does |
|---|---|
| `agent(spec, { reserveChildren? }?)` | run one sub-agent and return a structured `AgentResult`; `spec` may carry `name`, model, tools, skills, or `outputContract`; optional reservations protect mandatory later legs from model recovery |
| `parallel(thunks, {concurrency})` | run many at once, bounded by the run limits; this also provides the basis of `map` |
| `reduce.aggregate(results)` | merge N results into one, used by fan-out |
| `reduce.vote(candidates, opts)` | tally the candidates' own votes and preserve `winner`, `tie`, `no_consensus`, `invalid_outputs`, and dissent |
| `reduce.judge(candidates, order?)` | anonymise and label candidates for an impartial judge, then map the verdict back with `pick(label)` |
| `roster.team(name)` | resolve the agents of a named team |
| `signal` · `limits` · `log` | cooperative abort, admission/runtime limits, and progress reporting |
| series and loops | plain `await` and `for`; strategies are TypeScript, so pipelines and critic loops are ordinary code |

The complete built-in strategy catalog and each strategy's declared parameters are maintained in
[`STRATEGIES.md`](./STRATEGIES.md). Parameters are declared per strategy and looked up by
`knownParams()`; `/doctor` exposes the same schema live. Unknown parameter keys warn but do not
hard-fail.

**Supervisor surface** — the tools and persona fields that drive those primitives:

| Surface | Does |
|---|---|
| `delegate` tool | spawn one or more sub-agents; interactive sessions always run it in the background (results return as completion follow-ups); headless `pi -p` always blocks and returns results inline. There is no `sync`/`async` parameter. A leg whose tool is silent longer than the idle window (180 s) fails with a message telling you to raise that leg's `timeoutMs`. A `tasks` fan-out's receipt pairs each run id with its call-sign, and one wake covers the whole batch. An optional `thinking` picks that leg's effort level (off…max); omission keeps the agent's own setting and the configured/inherited child default, and results distinguish requested from observed effort |
| `council` tool | select any installed strategy over a named roster or temporary inline `members`; voting strategies preserve tally and dissent. Interactive sessions run a council in the background, like `delegate`: a receipt with a run id now, ONE completion follow-up with the ruling (`intercom result { to: runId }` for the full payload); headless `pi -p` returns it inline. Use it when the method adds value (vote, arbiter's pick, critique loop, per-item sweep, rival builds), not for plain independent parallel work, which is `delegate`. The strategy list in the tool description is generated from the registry (`when`, positional `roster`, `*` for a required param); a call missing a required param (`judge` and `compete` need `params.judge`) fails at once with `council failed: "<strategy>" requires params.<key> — …` and launches nothing, while an unknown strategy or roster is reported by the run itself, in the completion follow-up. A persona's declared `council:` still resolves when strategy, roster and params are omitted. Per-strategy behaviour (section labels, MAGI reflection fallbacks) is in [`STRATEGIES.md`](./STRATEGIES.md) |
| `intercom` tool | observe and control internal runs with `peek`, `result`, `steer`, and `stop`; `list`, `inbox`, `message`, `reply`, and `send` drive the coaching bus. There is no `wait`: a finished child wakes the supervisor through the completion follow-up |
| `timer` tool | read the fresh clock with `now`, or schedule an idle wake with `arm`, `cancel`, and `list`; alarms are one-shot and in-memory per session; an armed alarm shows as a row in the agent widget and F9 until it fires or is cancelled |
| `monitor` tool | run a bounded job (`mode: exit`) or event-producing program (`mode: output`) and wake the supervisor; an active monitor shows as a row in the agent widget and F9 until it ends or is cancelled; see [`MONITORS.md`](./MONITORS.md) |
| `flow` tool and `/flow` | run a journaled DAG of strategies, resumable only for the same flow, task and project; `gate: true` creates an approval checkpoint, shown with the gated output and what runs next (Reject is the default). The `flow` tool runs in the background interactively (receipt, then ONE follow-up when it ends; a checkpoint waits for the operator, peek reads `waiting for operator at checkpoint <id>`, and no wake happens there) and inline headless, where every checkpoint is rejected. A rejected checkpoint is a stop (`flow stopped · checkpoint <id>`, the gated plan is kept), not a failure. `/flow` and `/orchestrate` stay inline and operator-driven, and their results also reach the supervisor's next turn. `/flow` alone lists flows with descriptions; the supervisor brief lists them too, tagging gated flows as needing a human in headless sessions |
| `models` tool | current-first model shortlist with relative cost bands; a query searches the full eligible catalog in `provider/id` form |
| persona `mode:` | choose `solo`, `parallel`, `pipeline`, `strategy:<name>`, or `flow:<name>` |
| persona `coaching:` | give children `contact_supervisor` for progress and blocking decisions |
| persona `delegation:` | require briefs, set an output contract, schedule disjoint writes, and order fresh verification |
| `isolation: worktree` | run in a clean throwaway Git worktree and return an exported diff; non-Git, dirty, or oversized cases fail closed |
| agent `writeSet:` | repository-relative paths the agent alone writes by design (`research` declares `[.research/]`); a write-capable `delegate` leg that gives no `writeSet` of its own inherits it, so a persona that requires disjoint writes sees a declared owner instead of an unknown writer. Read-only legs do not inherit it. A directory owns its subtree; absolute and `../` paths are dropped. Declarative, not a sandbox |
| `council: { preset }` | expand a reusable `presets/<name>.preset.json`; authored fields override the preset |
| `contracts/*.json` | define a hot-editable structured return requested through `outputContract` and pinned per run |

`models` without a query shows up to 40 entries total, including the current model when available,
with the current model first. Recommendations stay within its provider, textual name root and
numbered major generation, retaining the newest representative of each distinct variant. Remaining
candidates are ordered `cost:low` → `medium` → `high` → `unknown`, then by numeric version within
each band. For example, a `gpt-6-astra` supervisor sees available `gpt-6-luna` and `gpt-6.1-sol`
neighbors before considering older models. The rule reads catalog IDs, without a model-name table;
gateway vendor/region namespaces remain distinct from the model's family and generation.
If the current name has no numeric version, only provider and textual root constrain the list.
The list is not filled with older or unrelated models just to reach the cap; explicit searches and
model assignments retain the full eligible catalog. With no current model, discovery falls back to
a general shortlist sharing each provider's cap across name roots. Names are proximity hints,
not release-date metadata or proof of task fit. `★` identifies the session
provider; authentication alone does not prove that an account supports every model in its catalog.

Model details expose host metadata for context and reasoning support. `cost:low`, `cost:medium` and
`cost:high` are relative advertised API-cost bands among recent candidates of the same provider,
using equal input/output token quantities. They are not quality, throughput or reasoning-effort
ratings, and do not describe subscription billing. Missing/zero prices or an insufficient comparison
set yield `cost:unknown`. The supervisor chooses task fit using these hints and the task's difficulty;
thinking effort remains the separate delegated-thinking preference (inherited by default).

The supervisor brief reuses a cached current-provider candidate list. Discovery runs on first use,
when the base model changes (provider or model id), or on an explicit `models` query; ordinary turns
do not rescan. Switching to another provider therefore replaces the cached candidates, including
its lighter variants when present. The current provider is a default, not a user restriction: an
explicit worker-model request may select another configured provider. The LLM retains the choice.

The delegate tool's optional `name` is carried into `AgentRunSpec.name` and reaches both engine
backends, keeping a caller-provided run label available in the live tree and runtime result. A
successful or stopped run announces ONCE: the idle-gated completion follow-up is the single
settlement surface (the agent-tree row already settles immediately). A failure keeps an immediate
operator surface — in the TUI a durable expandable card with the agent, model, elapsed time and a
concise cause (expansion retains the full technical diagnostic); other modes use a concise
sanitized notification. These operator-only cards do not inject context or start a second turn.
The model-facing report remains independently idle-gated; a UI notification failure cannot discard it.

### Native codemode

Pi's native `codemode` can call callable pi-persona tools through the normal nested-tool pipeline.
Argument validation and persona permission gates still apply to every inner call; scripts do not
turn a denied tool into an allowed one. Native `model-only` and `hidden` tools are not callable.

Use scripts for independent batches or for filtering large results before returning them to the
model, not as a wrapper that prints every result in full. `Promise.allSettled()` preserves successful
siblings when a call rejects; a fulfilled `bash` call still requires checking `exit_code`.
Only printed/returned script output reaches the model. Nested results therefore do not contribute
raw bytes or invisible reminders to pi-persona's context-burn nudges; an actual successful nested
`delegate`/`council`/`flow` still resets the hand-off streak.

Pi identifies calls made through codemode's `ctx.executeTool` with `parentToolCallId`. If a nested
delegation report is relayed with `[BLOCKED]` or `FLAG: UNKNOWN`, only the outer model-visible result
gets the persistence checkpoint and its expandable card. Discarding the report creates no reminder
and never alters the programmatic inner result. See [the nudge contract](./ARCHITECTURE.md#supervision--the-waiting-model)
for the differences between inline (headless) and background reports.

The outer code/result card belongs to Pi, not pi-persona's delegate renderer. Keep bulky details
expandable (`Ctrl+O` by default; `/hotkeys` shows active bindings). `Ctrl+T` toggles thinking blocks
separately. A smaller script output also reduces model context; merely collapsing its card does not.
No replacement sandbox or renderer is required for this integration.

`outputContract` takes a contract **name**, not an inline shape — `/doctor` lists what's installed
(the built-in `default` and bundled `finding` are available without custom files). Naming one that
isn't installed is rejected before any worker
spawns, checked across every task in a parallel batch: `delegate: unknown output contract(s) "x" —
nothing was spawned. Installed contracts: default, finding` (the list is capped at 16 names; a
`, …` marker is appended only when more than 16 are installed).

### Supervising running sub-agents — the `intercom` plane

The supervisor's internal communication with children exposes these surfaces. Tree/F9/peek distinguish
queued, running, waiting for supervisor, suspected stalled and terminal runs. Waiting is derived from
a live pending ask on the exact child handle, never inferred from its last activity text:

| Surface | Needs | What you get |
|---|---|---|
| **Observe and control** | any persona | `peek` inspects async sub-agents; `steer` sends a soft correction; `stop` requests cancellation, and `stop { to: "all" }` cancels every running run, `council` and `flow` included (runs already stopping are skipped, never force-cleared in bulk; a slash or mandated run is stopped at shutdown, not by this). The `f9` overlay provides the same controls (`s`, `x`, `X`). Cancelling a worker does not undo existing changes; an unknown id on `result`, `steer` or `stop` returns a miss text listing the known runs |
| **Retrieve** | any persona | `result { to }` returns one retained run payload (`offset`/`limit` page a bounded view without collecting it; `collect: true` acknowledges whole-body collection of a live run); `result { ref, offset, limit }` reads a page of a retained terminal result after reload; `results` lists retained terminal results with immutable refs; `message { messageId }` returns one retained bus message. History is bounded to 256 messages and 256,000 body characters, terminal results to 128 entries / 8 MiB per session, and retrieval never starts a worker |
| **Message bus** | bus allowed; in-process children also require `coaching: true` | broker-connected children and coached in-process children get `contact_supervisor`, subject to explicit empty tool grants and exclusions; progress appears in results and `intercom inbox`, while a blocking `decision` wakes the supervisor for `intercom reply` |
| **Sibling peer comm** | strategy opt-in | `debate` and `pair` members always get one-way `contact_peer`; `map` and `synthesize` add it with `params: { peers: true }` |

Addressing is explicit: `steer` uses a run ID from the delegation receipt, while `send` uses the
exact live bus handle from `list`. A displayed call-sign is not an alias for either address.
`reply` needs a pending ask ID; progress messages and settled questions cannot be answered.
An archived `result` uses its `ref`, shown in the call card. Its compact range is measured in
zero-based UTF-16 offsets (start inclusive, end exclusive), not page numbers. See the
[address table and failure guidance](COLLABORATION.md#supervising-a-leg).

When supervisor contact is available, an async child's `decision` or `interview` waits for a supervisor reply.
A headless (inline) child posts the question one-way without waiting: the supervisor is parked
in that call and cannot answer. The decision/interview remains unresolved; the child may continue
only independent work already authorized, otherwise it returns a blocked/partial result. A timeout,
disconnection or failure is never permission to invent an answer. Results expose `outcome` as
`reported`, `answered`, `unavailable`, `timed-out`, `cancelled` or `failed`; `delivered` means only
confirmed delivery, not a reply or approval (false can mean unconfirmed). An already-cancelled call
sends nothing. Progress messages remain one-way.

Delegated output is untrusted and is fenced before it reaches the supervisor. Interactive
delegation always runs in the background: continue independent work, and when only children remain, end the turn for
automatic completion follow-ups; never sleep, poll, or arm a `timer` to wait for children or monitors.
Async runs report failures to the supervisor, and a repeated identical failed delegation is stopped by
the runtime ledger before another child is spawned. A run whose model's provider fails at call time (auth,
outage, 5xx) may retry the same model id through a compatible fallback provider when its selection
is unpinned; explicit delegate provider pins remain strict. Strategies and flows instead recover a
model/provider failure once on the current main model, including unavailable saved or pinned choices.
They never substitute a peer's model or search arbitrary providers. Each recovery is visible and both
attempts consume usage/child budget; stop, timeout, contract and infrastructure failures do not retry.

Any leg that does NOT run in `isolation: worktree` shares the real checkout, so its result gets a
"what changed" block appended: `--- FILES CHANGED DURING THIS LEG (shared checkout; parallel legs
may overlap) ---` followed by one `- <path> (<M|A|D|R|?>)` line per path (capped at 40, `+N more`
beyond that); a changed path outside the leg's own declared `writeSet` is flagged
`⚠ outside declared writeSet`. This is a `git status` before/after snapshot, not a private diff — a
parallel sibling touching the same file can appear here too — and it is skipped when there is
nothing to report, or when the leg IS worktree-isolated (that path already returns a real unified
diff instead).

The cross-process broker is on by default for child-engine, worktree, and MCP legs. It provides the
same supervisor communication surface over a session-scoped POSIX socket or Windows named pipe.
`PI_PERSONA_BROKER=off` restores the pre-broker child spawn behavior. See the comm-plane contract in
[`ARCHITECTURE.md`](./ARCHITECTURE.md#the-comm-plane-in-practice).

> **MCP in sub-agents.** A normal in-process leg has no MCP connection. Set `mcp: true` in an agent
> definition or delegation task to route it through the child engine, which initializes MCP from
> `~/.pi/agent/mcp.json`. A fresh UI-less child cannot complete an interactive OAuth flow, so
> authenticate the server in a normal session first. A backend that keys state by a session id must
> receive that id in the task. A local registration, stdio process, or loopback endpoint does not
> prove local target egress; verify source routing with the executor and canary required by the
> engagement. This is a behavioral boundary, not a network sandbox.

### Identity and Exocom

An unnamed standalone session receives a provisional process/session-derived handle. On its first
turn where `agent_name` is callable, the runtime context asks the model to invent a
short handle and call `agent_name` before other work. The chosen handle is separate from the active
persona and role, is persisted in the session identity entry, and remains across later turns and
persona changes. Once chosen, it is not re-injected into every provider request; the runtime and
session entry remain authoritative. `agent_name` is unavailable while Exocom is active; its call-time capability check
also rejects empty, unsafe, generic, or reserved persona/agent names.

Naming needs one tool action, not a recurring prose confirmation. A stable system-level runtime rule
distinguishes skill-prefetch bookkeeping from new user requests; it neither hides updates nor rewrites
conversation history. Periodic async status is a durable operator-only entry, not a model wake or
context message. After updating extension code, use Pi's `/reload` once
delegated work has settled (or restart/resume); `/persona reload` reloads definitions only.

With Exocom active, the corresponding tool is `exocom_name`. The first incoming peer wake can be the
first model turn in an RPC session; the context hook supplies the naming bootstrap for that custom
wake as well as for an ordinary user turn. A chosen Exocom handle updates the live registry while
its session-qualified routing target remains stable across renames. Naming metadata remains callable
when a pending ask permits `exocom_name`, but it does not settle that work ask.

Exocom is a flat, external plane between independent top-level Pi sessions. It provides presence,
fenced postcards, and a durable claim/ask ledger. `--exocom` joins the current workspace; an exact
`--exocom=Ab0T` joins an existing workspace scope from another cwd. The four-character code is a
same-host join reference, not authentication. Foreign members advertise the workspace they can
actually inspect and cannot claim repository-relative paths in another workspace's ledger.

`exocom_status` (a tool, taking no arguments) and `/exocom` (a command, which additionally lists
live peers) both render the same ownership view: your claims, peers' claims, asks waiting on you,
and your own open asks. A claim's `write_set` is advisory, not enforced: a supervisor's own
`write`/`edit` call whose path overlaps a PEER's open claim is blocked once with a reason to
coordinate (`exocom_ask`) or claim the path itself; calling the same tool again on the same path is
then allowed through (one warning per claim + normalized path, not a standing lock).

### Exocom collaboration tools

The external plane exposes fifteen call-time-gated tools: `exocom_list`, `exocom_send`,
`exocom_name`, `exocom_claim`, `exocom_ask`, `exocom_answer`, `exocom_decline`, `exocom_wait`,
`exocom_release`, `exocom_progress`, `exocom_status`, `exocom_task`, `exocom_offer`,
`exocom_publish`, and `exocom_profile`. Persona denials still apply during an active session; a
foreign-workspace member does not receive usable `exocom_claim` access.

| Tool | Contract |
|---|---|
| `exocom_list`, `exocom_send`, `exocom_name` | Discover session-qualified targets, send a one-way postcard, or set this session's display handle. A rename does not change the routing identity. |
| `exocom_claim`, `exocom_release`, `exocom_progress`, `exocom_status` | Declare advisory repository-relative ownership, release it, add progress, or inspect current ledger state. Claims do not enforce OS-level write access. |
| `exocom_ask`, `exocom_answer`, `exocom_decline`, `exocom_wait` | Send a targeted question that creates an obligation, settle an incoming ask, or arm a non-blocking wake for an answer. |
| `exocom_task` | Create a voluntary task (creation does not launch a worker), take it, report progress, finish it as `done` or `abandoned`, or inspect retained tasks. Use `list` then `get` for full details. |
| `exocom_offer` | Send an optional invitation for an open task to a peer or the pool. It expires after one hour by default and at most 24 hours; it never creates an ask or an obligation to answer. |
| `exocom_publish` | Share an explicit bounded evidence excerpt for a task, discover titles/message ids by `work_key`, and retrieve one excerpt by `msg_id`. This does not expose an `intercom` terminal-result archive. |
| `exocom_profile` | Read, set or clear this session's self-reported capability labels and availability. Up to eight labels of 48 characters each; availability is `available`, `busy`, `away` or unknown. It never grants permission or verifies skill. |

`exocom_task list` is discovery: omit `work_key` and `task_id`, then use the returned identifiers for
`get` or a task action. Summary pages default to 10 rows; `detail: true` defaults to 5, and an
explicit detailed limit above 5 is rejected. `exocom_task create` returns `task_id`, which equals
the creation message id. Carry it with `work_key` for take/progress/finish, offers and evidence
publication; the key alone is only a lookup name and can be reused after retention. Write-set pickup
and claim are committed atomically under the ledger lock. Read-only tasks can be taken from another
workspace scope. A task whose owner leaves becomes stale and cannot be taken over automatically.
Detailed paths are available through `exocom_task({ action: "get", work_key, task_id })`;
paginated list summaries may clip the write set.

While an incoming ask is pending, allowed actions are answer/decline, `exocom_name`, status, explicit
collaboration reads (`exocom_task` list/get, `exocom_publish` read, `exocom_profile` get), and
read-only filesystem tools. Profile edits and other mutations wait until the ask is settled. Identity
metadata does not settle it. Task, offer and evidence records are each capped at 64 and share a
128 KiB state budget; terminal or stale tasks and expired offers are retained for up to an hour,
while evidence is retained for up to an hour after publication. Active tasks remain while their owner
lease is live. See the [cross-session collaboration guide](./COLLABORATION.md) for workflows and
bounded examples.

## Configuration and data

Personas and agents are Markdown files with YAML frontmatter. Teams, flows, contracts, and presets
are data files. Discovery precedence is builtin < user `~/.pi/agent/persona` < project `.pi/`.
Personas and agents are loaded from the user and project agent folders; bundled persona and agent
files are seed sources. A fresh install has no installed personas until `/persona seed`,
`/persona restore`, or opt-in first-run seeding installs them. With none installed, F8, `/doctor` and
`/persona list` all point to `/persona seed`.

| Definition | Location | Purpose |
|---|---|---|
| Persona | `personas/*.md` or installed `agents/*.md` with `persona: true` | supervisor prompt, capabilities, delegation, council, orchestration, and coaching |
| Agent | `agents/*.md` or project `.pi/agents/*.md` | worker prompt, optional tools/model/isolation/MCP/writeSet |
| Team | `teams.yaml` | named roster of bare agent names or inline `{ agent, role, model, skills }` members |
| Flow | `flows/*.flow.json` | strategy phases connected by `needs`, optionally gated |
| Contract | `contracts/*.contract.json` | structured output fields requested by name and pinned per run |
| Preset | `presets/*.preset.json` | reusable council strategy, roster, and parameter bundle |

### Unified pi-persona settings

`/persona-settings` opens pi-persona's own settings editor in the TUI or RPC UI. It is a separate
extension command; it does not replace Pi's native `/settings` or edit native Pi preferences such
as compaction. The TUI is a full-page, filterable panel (`/` to search, `r` to reset the selected
saved override, `m` for model assignments, `d` for diagnostics); the RPC UI offers the same
settings, model, and diagnostics flows. `/persona-settings show` emits a read-only report and is
available in headless sessions.

The sole active settings file is `<agentDir>/persona/settings.json` (normally
`~/.pi/agent/persona/settings.json`). Its version-1 top-level shape is:

```json
{
  "version": 1,
  "preferences": { "engine": "inproc", "nudge": true },
  "personas": { "dev": { "models": { "reviewer": "provider/model-id" } } },
  "lastPersona": "dev"
}
```

`preferences` contains the public extension settings; `personas.<name>.models` preserves
provider-qualified model assignments, and `lastPersona` remembers the selection when
`PI_PERSONA_PERSIST` is enabled. The preference registry groups all editable scalar settings as:

| Group | Preference IDs |
|---|---|
| Discovery | `extraDirs`, `seed` |
| Startup | `defaultPersona`, `persist` |
| Interface | `keybinding` |
| Delegation | `delegateDefaultAllow`, `childThinking`, `engine`, `peekEveryMs`, `checkInEveryMs`, `agentHardTimeoutMs`, `agentStartupTimeoutMs`, `nudge`, `asyncRetain`, `ledgerV2`, `changeReport` |
| Collaboration | `broker`, `exocom` |
| Prompt | `spine`, `spineLegs` |
| Mind (when loaded) | `mindCapture` (`auto`/`prompt`/`off`), `mindNudge` |
| Flow (when loaded) | `flowEnabled`, `flowPort`, `flowIdleMs` |

`disabled` and the storage path are not editable preferences. Model assignments remain scoped by
persona owner, rather than being promoted into global preferences.
`selectionRevision` is internal metadata in the same file: explicit persona-selection gestures
increment it, while model/preference edits leave it unchanged. Companion readers can therefore
distinguish a re-selection from an unrelated settings save without following whole-file timestamps.
The editor never reloads Pi automatically. Scalar preferences load after a Pi restart or Pi's native
`/reload`; `/new` alone does not reactivate Persona's extension factory. `/persona reload` reloads
persona definitions and does not apply preference changes. The panel shows when a saved value is
pending reload. Model assignments are read by the
existing resolver for future runs, so they do not alter workers already running.

Mind and Flow report their supported settings through Pi's public event bus; the panel does not import
or require either plugin. Their preferences live in the same `preferences` object above, not in new
plugin configuration files. Skill Optimizer remains independent. Absent companions do not expose
nonfunctional controls. Updated companion versions are needed to contribute settings to this panel.

`flowEnabled` controls default dashboard attachment; `--no-flow` still opts out for one run.
`flowPort` is the desired port for the next shared service start, not a command to move an existing
service. `flowIdleMs` is the advanced shared-service idle grace (50–60000 ms): it applies only with
no Pi registrations **and** no browser SSE clients. Saving it never restarts another Pi's service.

Explicit public `PI_PERSONA_*` environment values retain startup precedence over saved preferences.
The panel marks an environment-controlled setting as locked; resetting its saved value only removes
that saved override and does not defeat the environment. `PI_PERSONA_DISABLE` is an internal
process guard and is not an editable setting.

When no canonical `settings.json` exists, startup imports the retired `config.json` model store and
`state.json` persona state (or the path supplied by `PI_PERSONA_STATE_FILE`) once. Successfully
migrated, unchanged legacy files are archived as `<file>.migrated`; if validation, safe archival, or
concurrency checks fail, the legacy source is kept and a warning is reported. Once `settings.json`
exists, it is the only active store: legacy files are not dual-read. An invalid or unsafe canonical
file is reported rather than overwritten. `PI_PERSONA_STATE_FILE` now only selects a legacy state
file to import when the canonical file does not yet exist; it does not move or redirect active
settings storage.

The model editor asks you to choose an owner persona and then its current or a named council
profile; it never activates that persona. It lists the roster and strategy-declared auxiliary
participants using the runtime model precedence described below. The searchable model picker uses
Pi's currently available provider-qualified models; opening the editor does not refresh provider
catalogs, and refresh is an explicit action. Saving or removing an assignment affects future runs.
Reset removes only that saved key (`null` in a settings patch), revealing lower-precedence sources
such as a bare agent assignment; inline model pins remain read-only. “Other saved assignments” lets
you remove keys outside the selected profile without exposing unsafe legacy key text.

In the TUI, the picker uses Pi's native editable search field (including paste and cursor movement).
Search matches model names, IDs and providers; an exact qualified reference takes precedence. The
participant's current eligible model is selected initially and marked separately from the session
provider indicator. Editing the query keeps the selected model while it still matches. Rows retain
the qualified reference and show context, reasoning and vision hints when supplied by the same host
catalog snapshot; missing metadata is not inferred. Pending settings choices are reflected when a
picker is reopened, and an unresolved pending reset is not presented as an active model. RPC keeps
its native selection dialog. These are presentation changes only: eligibility, provider pins,
refresh policy and the `models` tool's substring search are unchanged. No favorites or recents are
stored.

The existing `/persona models [council-persona]` shortcut remains available for the active caller.
It refreshes the model catalog before editing, and a named council profile does not change which
persona owns the saved assignments. Use the Models action in `/persona-settings` when you need to
choose the owner explicitly.

#### Companion settings adapter contract

The optional synchronous bus channel `pi-persona:settings:collect:v1` receives
`{ add(id, values) }`. A loaded supervisor companion responds with `add("mind", { mindCapture,
mindNudge })` or `add("flow", { flowEnabled, flowPort, flowIdleMs })`, using its current startup
snapshot. Each may report a supported subset. Persona validates ownership/types against the same
registry used by the editor and displays only reported fields; an unrelated plugin cannot contribute
an optimizer or native Pi setting through this channel. Contributors must not read credentials,
refresh providers, write files, wake the model or start a service in response to collection.

Persona alone patches the canonical settings file; companions read their own known fields and
preserve their standalone operation and environment overrides. They must release/re-arm their
listener with the owning extension lifecycle. Add a new control by updating registry metadata,
validation, the owning consumer and contract tests—not by adding another settings writer.

`tools` accepts an allowlist such as `[read, grep]`, an `allow`/`deny` object, or `[]` for no tools.
Entries are plain tool names or `*` patterns; Pi's `+name`/`-name` default-tool modifier
syntax is not an allowlist and is rejected. Use the `deny` field to remove tools. Omit `tools` to
inherit the session tool set. `model`, `isolation: worktree`,
`mcp: true`, `writeSet` (a list of repository-relative paths the agent alone writes, inherited by
write-capable delegate legs that name none), and `purpose` are optional agent metadata. The body is the agent prompt. Inline roster
members specialise one agent with a role, model, or skills without requiring another agent file.

### Multi-agent quick start

Follow the [installation instructions](../README.md#install), then start a coding supervisor:

```bash
pi --persona dev
```

Delegate a bounded task with the complete brief that Dev requires:

```js
delegate({
  agent: "scout", name: "Login-Trace", task: "Inspect the login flow and report the root cause.",
  brief: {
    objective: "Explain the login failure with code evidence",
    scopeRoe: "Read this repository only; do not contact external systems",
    position: "Start from the current checkout and its existing tests",
    constraints: ["Do not modify files"],
    requiredArtifacts: ["File and line references, with a suggested minimal fix"],
    stopConditions: ["Stop after finding the cause or report the missing evidence"]
  }
})
// The call returns a run id at once: end the turn. The completion arrives as a follow-up;
// `intercom result { to }` fetches a settled run, and peek/steer/stop are for when the user asks.
```

For independent Pi processes, open the same workspace in two terminals with `pi --exocom` and use
the qualified target returned by `exocom_list`:

```js
exocom_name({ name: "<invented from the current task>" })
exocom_list({})
exocom_send({ target: "<qualified target from exocom_list>", message: "Review the API boundary and send back concrete risks." })

exocom_claim({ work_key: "api-review", write_set: ["src/api"], slice: "Review and fix the API boundary" })
exocom_ask({ target: "<qualified target>", work_key: "api-review", question: "Is the transport contract safe to change?" })
exocom_wait({ work_key: "api-review", ask_id: "<ask_id returned above>" })
exocom_answer({ work_key: "api-review", ask_id: "<received ask_id>", ok: true, evidence: "Tests and file references" })
exocom_release({ work_key: "api-review" })
```

### Recipes

Everything in these examples is data. Drop files into the discovery locations above and switch
personas with `f8`. A brand-new strategy shape is the only case that requires a source file.

**Opportunistic delegation** — a simple persona with no orchestration block:

```markdown
<!-- .pi/agents/my-researcher.md -->
---
name: my-researcher
persona: true
---
You research thoroughly. For independent sub-questions, fan out `scout` sub-agents in ONE
`delegate` call (`tasks: [...]`), each with a disjoint scope, then synthesise their findings.
```

**A review council and a per-call override** — `council:` is the persona default; the tool can
override it for one call without editing the file:

```yaml
# teams.yaml — one reviewer agent, four lens roles
review:
  - { agent: reviewer, role: "Focus ONLY on the CORRECTNESS lens" }
  - { agent: reviewer, role: "Focus ONLY on the SECURITY lens" }
  - { agent: reviewer, role: "Focus ONLY on the PERFORMANCE lens" }
  - { agent: reviewer, role: "Focus ONLY on the TESTS lens" }
```

```markdown
<!-- .pi/agents/myaudit.md -->
---
name: myaudit
persona: true
council: { strategy: synthesize, roster: review, params: { synthesizer: reviewer, peers: true } }
---
Convene the council before sign-off, then apply its merged findings yourself.
```

```js
// one-off: run this decision as a debate over the same roster — no file edit
council({ question: "cache this or recompute?", strategy: "debate", roster: "review", params: { bestOf: 2 } })
```

A one-off group can be composed without editing a team file. The external arbiter is also an
agent specification, independent of the panel:

```js
council({
  question: "Choose between these designs; prioritize correctness and operational cost.",
  strategy: "judge",
  members: [
    { agent: "reviewer", role: "Evaluate correctness and failure boundaries." },
    { agent: "reviewer", role: "Evaluate operating cost and maintainability." }
  ],
  params: { judge: { agent: "reviewer", role: "Choose impartially from the anonymised options." } }
})
```

`members` overrides the named roster for this invocation only. Roles/skills do not grant tools or
bypass capability gates. Model selection covers roster members and declared auxiliary actors such
as `judge` and `synthesizer`; supported agent-valued params accept inline member specs too. Model
precedence is inline `model`, saved role assignment, saved agent assignment, agent frontmatter,
then the session model (`src/persona/model-participants.ts`).

With an active persona, UI, and at least two configured models, unassigned participants can be
picked and saved for the active persona, even when borrowing another persona's council profile.
Dismissing a picker suppresses another prompt for that participant during the session, not for
later teams with different participants. Headless runs never prompt.

Run `/persona models` to explicitly reselect the active council's models, or `/persona models magi`
to edit the MAGI panel while keeping another supervisor active. The optional name selects an
installed council persona, not a strategy or team. The command refreshes the host catalog first,
then offers each editable participant, including previously dismissed choices and saved or agent
defaults. One available model is enough for this explicit edit. Choices are saved under the **active
caller's** persona, just as for `council({ persona: "magi" })`; it never activates the borrowed
profile. Cancelled choices, unrelated assignments and other personas remain unchanged. Inline
`members[].model` pins still win and are not editable here. TUI/RPC UI is required; no model call
is made. Changes apply to future runs, not workers already running. `/persona magi` still switches
the supervisor; `/persona reload` reloads definitions without resetting saved models.
Refresh is bounded to 20 seconds cooperatively; provider errors, cancellation, or a persona/session
change cancel the edit without replacing assignments. The list uses the host's refreshed availability,
not every model in its catalog.

An unavailable choice is not overwritten: a provider or unknown-model failure may recover once
on the main model, with the switch reported and both attempts accounted. This does not relax
ordinary delegate provider pins. The MAGI persona retains its canonical core team; the Judge
persona retains impartial arbitration. Other personas choose whichever strategy fits the task.
The exact Pi diagnostic `No API key found for <provider>` counts as a provider failure in both
engines, so it can use this same bounded recovery. If the main model is the failing model too,
recovery cannot help: use `/login` or change `/model`, then reselect with `/persona models`.

**A delegation policy on any persona** — fields are generic and are never keyed to a persona name.
The runtime rejects incomplete briefs before a model call, supplies a missing contract, rejects
overlapping or missing ownership for parallel writers, and refuses a declared verifier that would
start before or beside a material writer in the same call or while a mutating background run is in
flight. Only `read`, `grep`, `find`, and `ls` count as read-only; shell-capable, MCP-enabled, and
unknown toolsets fail closed as writers. `writeSet` is a scheduling contract, not an OS sandbox.
An agent can declare the area it alone writes (`writeSet: [.research/]` in `research`); a write-capable leg that gives
no `writeSet` of its own inherits it, so a write-capable but read-in-intent agent is not refused as an
unknown writer, and a leg that does name one keeps its own. Read-only legs do not inherit defaults.

```markdown
---
name: my-project-lead
persona: true
delegation:
  requireBrief: true
  outputContract: finding
  requireDisjointWrites: true
  requireFreshVerification: true
  verificationAgents: [my-checker]
council: { strategy: critic-loop, roster: my-repair-team, params: { rounds: 3 } }
---
Delegate bounded work, then accept completion only after fresh evidence.
```

The six required `brief` fields are `objective`, `scopeRoe`, `position`, `constraints`,
`requiredArtifacts`, and `stopConditions`. `verificationAgents` names ordinary installed agents;
there is no built-in verifier identity.

When `requireBrief` is enabled, it also applies to read-only scouts. Single-worker calls put the
brief alongside `agent` and `task`; parallel calls put a complete brief inside **each** `tasks[]`
entry. A top-level brief is not inherited by the batch, and prose in `task` does not replace these
fields. A missing-brief error means the batch was rejected before any worker started: correct all
affected entries before retrying.

**A mandatory-orchestration persona** — `orchestration:` runs automatically every turn, while
`council:` runs only when requested. Only `ok: true` is presented as a ruling; failures, cancellation,
and unresolved output remain labelled evidence to repair and verify.

```markdown
<!-- .pi/agents/myguard.md -->
---
name: myguard
persona: true
orchestration: { mode: strategy, strategy: magi, roster: magi, params: { reflect: false } }
---
Every turn is decided by the MAGI triarchy first (no reflection round); present and act on it.
```

**Coaching** — add `coaching: true` to give children `contact_supervisor`, then read and answer
progress or decisions with `intercom inbox` and `intercom reply`.

**A custom agent** — the body is the worker prompt and the frontmatter sets its capabilities:

```markdown
<!-- .pi/agents/hardener.md -->
---
name: hardener
description: Locks down a change's security posture — authz, input validation, secrets handling.
tools: [read, grep, edit, bash]
model: opus
isolation: worktree
---
You are the Hardener. Given a diff or area, find and FIX authz/access-control gaps, injection and
unsafe-sink risks, secrets/token mishandling, and missing input validation. Cite `file:line`.
```

**A flow with a human checkpoint** — phases are journaled and dependents wait for a `gate: true`
approval. The checkpoint prompt shows the gated phase's output (12 lines) and what runs next, with Reject as the default. A rejection is reported as `flow stopped · checkpoint <id>` and keeps the gated output; it is not a failure, though a mandatory flow still fails closed. Headless sessions always reject checkpoints. Save as `.pi/flows/gated-build.flow.json`:

```json
{
  "name": "gated-build",
  "phases": [
    { "id": "plan",   "strategy": "magi",        "roster": "magi",   "gate": true },
    { "id": "build",  "strategy": "critic-loop", "roster": "repair", "needs": ["plan"] },
    { "id": "verify", "strategy": "fanout",      "roster": "review", "needs": ["build"] }
  ]
}
```

**A structured-return contract** — save as `.pi/contracts/ship-verdict.contract.json` so votes and
judges can tally fields mechanically:

```json
{ "name": "ship-verdict",
  "fields": {
    "vote":       { "type": "string", "required": true },
    "severity":   { "type": "enum",   "values": ["low", "medium", "high", "critical"] },
    "confidence": { "type": "number", "min": 0, "max": 1 }
  }
}
```

**A preset keeps persona files to one line** — save as `.pi/presets/magi-rounds.preset.json`:

```json
{ "strategy": "council-rounds", "roster": "magi", "params": { "rounds": 3, "bestOf": 3 } }
```

```yaml
# any persona's frontmatter
council: { preset: magi-rounds }
```

For one-line strategy calls and the canonical parameter defaults, use the table in
[`STRATEGIES.md`](./STRATEGIES.md). A new vote rule or custom loop adds
`src/orchestration/strategies/<name>.ts`, registers it in `strategy.ts`, and gets a stub-engine unit
test; the data-driven definitions above require no core change.

## Commands, flags, and environment

**Keys** — `f8` cycles persona; `f9` or `/agents` opens the agent overlay: ↑↓ navigate, ⏎ open, `x`
stop, `s` steer, and Esc close. `X` (list view) stops every running leaf agent that `x` could stop (armed
timers and monitors are not agents and are skipped): the first press states the count (`press X again to
stop N running agents`), any other key or a changed set re-asks. It is offered only for two or more;
queued or later stages may still start.

**Commands** — `/persona [name|off|list|reload|seed|restore|models [council-persona]]` ·
`/persona-settings [show]` · `/models [query]` · `/orchestrate <task>` · `/flow <name> <task>` ·
`/peek [id]` · `/exocom` · `/doctor`.

`/persona off` is the deactivation command. `/persona restore` force-restores every bundled resource
into the user persona directory: personas and agents, flows, contracts, presets, `teams.yaml`, and
the shared prompt pair. Existing bundled destinations are overwritten; additional user files are
not pruned. For example, custom `agents/pippo.md` (a persona) and `agents/pluto.md` (an agent) survive
unchanged. Reusing a bundled destination filename means opting into its replacement. This is not a
reset of `settings.json`, credentials, sessions or project-local overrides. Definitions are reloaded
afterward, including any preserved custom persona that was active.

`/doctor` reports the cross-process broker's lifecycle on one line: `broker: on — endpoint …` once
the host is listening, `broker: on — (starting…)` mid-attempt, or
`broker: on — (not started — no child-engine build yet)` before any child-engine build has run. A
bind failure reports on its own, without the `on —` prefix or a connected-children count (there is
neither while down): `broker: failed — <reason>` — children built while it is down spawn without a
bus endpoint, so they never burn connect backoff against a dead socket, and the next child-engine
build retries. A connected broker child's status shows `⇄ <handle>`; if that connection drops, the
status flips to `⇄ offline` and a fresh ask on it fails fast instead of hanging.

`/doctor` also reports the installed host's version against this extension's floor: `pi: <version>
(requires ≥ 1.4.0)`, with a trailing `— BELOW FLOOR` marker once an installed version fails the
check (`src/core/pi-compat.ts`). `pi: unknown` means the host's own `package.json` could not be
resolved (a non-standard install layout) — not a failed check.

**CLI flags** — `--persona <name>` starts with that installed persona and errors if it is missing;
`--exocom` joins this workspace's Exocom plane; `--exocom=Ab0T` joins another workspace's scope
from a different cwd. Pi owns `--model <provider/id>`, `--thinking
<off|minimal|low|medium|high|xhigh|max>`, and `--list-models`.

| Variable | Default | Effect |
|---|---|---|
| `PI_PERSONA_ENGINE` | in-process | `child` spawns each sub-agent as an isolated `pi` process |
| `PI_PERSONA_CHILD_THINKING` | inherited | reasoning effort for child-engine sub-agents |
| `PI_PERSONA_SEED` | off | `on` auto-installs bundled personas on first run |
| `PI_PERSONA_BROKER` | on | `off` disables the cross-process comm plane for child, worktree, and MCP legs |
| `PI_PERSONA_PEEK_MS` | 30000 | fast async stall-card/message tick; `0` disables it |
| `PI_PERSONA_CHECKIN_MS` | 300000 | durable expandable operator status entry while async children run; does not start a model turn; `0` disables it |
| `PI_PERSONA_AGENT_MAX_MS` | off | opt-in per-agent hard wall-clock cap; unset leaves healthy work running |
| `PI_PERSONA_AGENT_STARTUP_MS` | 300000 | startup deadline for a child that makes no progress; `0` disables it. Like the idle window, a leg waiting on a supervisor reply is not idle: the watchdog re-arms while its ask is pending, instead of killing on a blind ceiling |
| `PI_PERSONA_NUDGE` | on | `off` silences delegation and persistence nudges and disables the repeated peek/result and long-sleep guards; inline-result checkpoints stay in model-visible tool results and are mirrored to durable, expandable TUI-only cards |
| `PI_PERSONA_EXOCOM` | off | `1` joins the current workspace Exocom scope; cross-workspace selection is CLI-only |
| `PI_PERSONA_SPINE` | off | `on` or a path enables the shared behavioral layer; see [`SPINE.md`](./SPINE.md) |
| `PI_PERSONA_SPINE_LEGS` | follows `PI_PERSONA_SPINE` | selector for delegated legs, allowing all four spine measurement arms |
| `PI_PERSONA_DISABLE` | unset | any non-empty value disables the whole extension for this process (also set internally as the fork-bomb guard on delegated legs) |
| `PI_PERSONA_DIRS` | none | extra discovery directories (`;`/`,`-separated), searched alongside the user and project agent folders |
| `PI_PERSONA_DEFAULT` | none | persona activated automatically when no persona is otherwise selected |
| `PI_PERSONA_KEY` | `f8` | keybinding that cycles installed personas |
| `PI_PERSONA_PERSIST` | on | `off` stops remembering the last-selected persona across sessions |
| `PI_PERSONA_DELEGATE_DEFAULT` | allow | `deny` (or an off-word) makes an unlisted delegate target default-deny instead of default-allow |
| `PI_PERSONA_ASYNC_RETAIN` | 64 | how many settled-but-uncollected async runs are retained before FIFO-evicting the oldest (equals the `tasks` cap, so one call can never evict itself) |
| `PI_PERSONA_LEDGER_V2` | off | `on` widens the delegation-ledger retry-veto key to also include role/tools/isolation, not just agent+model+task |
| `PI_PERSONA_LEG_CHANGE_REPORT` | on | `off` disables the non-worktree files-changed report (two `git status` spawns per leg) |

`PI_PERSONA_STATE_FILE` is only a migration input for the retired standalone state file; it no
longer selects an active persistence path. The canonical store is always
`<agentDir>/persona/settings.json`.

## Development

```bash
npm install
npm run typecheck   # strict tsc --noEmit
npm test            # node --test
```

The architecture contract is [`ARCHITECTURE.md`](./ARCHITECTURE.md), orchestration behavior is
[`STRATEGIES.md`](./STRATEGIES.md), the shared prompt layer is [`SPINE.md`](./SPINE.md), and the
observer/export contract is [`TELEMETRY.md`](./TELEMETRY.md). After updating Pi packages, run
`npm run typecheck`: it catches changes at the in-process session and `ThinkingLevel` seams.
