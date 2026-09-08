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
| `agent(spec)` | run one sub-agent and return a structured `AgentResult`; `spec` may carry `name`, model, tools, skills, or `outputContract` |
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
| `delegate` tool | spawn one or more sub-agents; interactive calls are background-first, while `sync: true` blocks the turn |
| `council` tool | run the selected strategy over a roster and return its result; voting strategies preserve tally and dissent |
| `intercom` tool | observe and control internal runs with `peek`, `result`, `wait`, `steer`, and `stop`; `list`, `inbox`, `message`, `reply`, and `send` drive the coaching bus |
| `timer` tool | read the fresh clock with `now`, or schedule an idle wake with `arm`, `cancel`, and `list`; alarms are one-shot and in-memory per session |
| `monitor` tool | run a bounded job (`mode: exit`) or event-producing program (`mode: output`) and wake the supervisor; see [`MONITORS.md`](./MONITORS.md) |
| `flow` tool and `/flow` | run a journaled DAG of strategies; `gate: true` creates an approval checkpoint |
| `models` tool | list or search authenticated model ids in `provider/id` form; the session provider is marked |
| persona `mode:` | choose `solo`, `parallel`, `pipeline`, `strategy:<name>`, or `flow:<name>` |
| persona `coaching:` | give children `contact_supervisor` for progress and blocking decisions |
| persona `delegation:` | require briefs, set an output contract, schedule disjoint writes, and order fresh verification |
| `isolation: worktree` | run in a clean throwaway Git worktree and return an exported diff; non-Git, dirty, or oversized cases fail closed |
| `council: { preset }` | expand a reusable `presets/<name>.preset.json`; authored fields override the preset |
| `contracts/*.json` | define a hot-editable structured return requested through `outputContract` and pinned per run |

The delegate tool's optional `name` is carried into `AgentRunSpec.name` and reaches both engine
backends, keeping a caller-provided run label available in the live tree and runtime result.

### Supervising running sub-agents — the `intercom` plane

The supervisor's internal communication with children has three layers:

| Layer | Needs | What you get |
|---|---|---|
| **Observe and control** | any persona | `peek` watches async sub-agents; `wait` joins them; `steer` sends a soft correction; `stop` requests cancellation. The `f9` overlay provides the same controls (`s`, `x`). Cancelling a worker does not undo existing changes |
| **Retrieve** | any persona | `result { to }` returns one retained run payload; `message { messageId }` returns one retained bus message. History is bounded to 256 messages and 256,000 body characters, and retrieval never starts a worker |
| **Message bus** | `coaching: true` | children get `contact_supervisor`; progress appears in results and `intercom inbox`, while a blocking `decision` wakes the supervisor for `intercom reply` |
| **Sibling peer comm** | strategy opt-in | `debate` and `pair` members always get one-way `contact_peer`; `map` and `synthesize` add it with `params: { peers: true }` |

Delegated output is untrusted and is fenced before it reaches the supervisor. Async runs report
failures to the supervisor, and a repeated identical failed delegation is stopped by the runtime
ledger before another child is spawned.

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
persona changes. `agent_name` is unavailable while Exocom is active; its call-time capability check
also rejects empty, unsafe, generic, or reserved persona/agent names.

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

## Configuration and data

Personas and agents are Markdown files with YAML frontmatter. Teams, flows, contracts, and presets
are data files. Discovery precedence is builtin < user `~/.pi/agent/persona` < project `.pi/`.
Personas and agents are loaded from the user and project agent folders; bundled persona and agent
files are seed sources. A fresh install has no installed personas until `/persona seed`,
`/persona restore`, or opt-in first-run seeding installs them.

| Definition | Location | Purpose |
|---|---|---|
| Persona | `personas/*.md` or installed `agents/*.md` with `persona: true` | supervisor prompt, capabilities, delegation, council, orchestration, and coaching |
| Agent | `agents/*.md` or project `.pi/agents/*.md` | worker prompt, optional tools/model/isolation/MCP |
| Team | `teams.yaml` | named roster of bare agent names or inline `{ agent, role, model, skills }` members |
| Flow | `flows/*.flow.json` | strategy phases connected by `needs`, optionally gated |
| Contract | `contracts/*.contract.json` | structured output fields requested by name and pinned per run |
| Preset | `presets/*.preset.json` | reusable council strategy, roster, and parameter bundle |

`tools` accepts an allowlist such as `[read, grep]`, an `allow`/`deny` object, or `[]` for no tools.
Omit it to inherit the session tool set. `model`, `isolation: worktree`, `mcp: true`, and `purpose`
are optional agent metadata. The body is the agent prompt. Inline roster members specialise one
agent with a role, model, or skills without requiring another agent file.

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
intercom({ action: "peek" })
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
# teams.yaml — one reviewer agent, three lens roles
review:
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

**A delegation policy on any persona** — fields are generic and are never keyed to a persona name.
The runtime rejects incomplete briefs before a model call, supplies a missing contract, rejects
overlapping or missing ownership for parallel writers, and refuses a declared verifier that would
start before or beside a material writer in the same call or while a mutating background run is in
flight. Only `read`, `grep`, `find`, and `ls` count as read-only; shell-capable, MCP-enabled, and
unknown toolsets fail closed as writers. `writeSet` is a scheduling contract, not an OS sandbox.

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
approval. Save as `.pi/flows/gated-build.flow.json`:

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
stop, `s` steer, and Esc close.

**Commands** — `/persona [name|off|list|reload|seed|restore]` · `/models [query]` ·
`/orchestrate <task>` · `/flow <name> <task>` · `/peek [id]` · `/exocom` · `/doctor`.

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
| `PI_PERSONA_PEEK_MS` | 30000 | fast async stall/message wakeup tick; `0` disables it |
| `PI_PERSONA_CHECKIN_MS` | 300000 | routine direction check-in while async children run; `0` disables it |
| `PI_PERSONA_AGENT_MAX_MS` | off | opt-in per-agent hard wall-clock cap; unset leaves healthy work running |
| `PI_PERSONA_AGENT_STARTUP_MS` | 300000 | startup deadline for a child that makes no progress; `0` disables it |
| `PI_PERSONA_NUDGE` | on | `off` silences delegation and persistence nudges |
| `PI_PERSONA_EXOCOM` | off | `1` joins the current workspace Exocom scope; cross-workspace selection is CLI-only |
| `PI_PERSONA_SPINE` | off | `on` or a path enables the shared behavioral layer; see [`SPINE.md`](./SPINE.md) |
| `PI_PERSONA_SPINE_LEGS` | follows `PI_PERSONA_SPINE` | selector for delegated legs, allowing all four spine measurement arms |

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
