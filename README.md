<p align="center">
  <img src="assets/banner.png" alt="pi-persona — advanced multi-agent orchestration layer for Pi">
</p>

A multi-agent orchestration layer for the [Pi](https://github.com/earendil-works/pi) coding agent.
It turns one agent into a **supervisor** that runs specialized sub-agents — synchronously or in the
background, one at a time or fanned out in parallel — coordinates them with composable strategies
(vote, judge, critic-loop, map, synthesize, DAG flows), and lets you watch, steer, stop, and message
them mid-run. Sub-agents specialize *dynamically* (skills + an on-the-fly role + model + tools), so
new behavior needs no new files.

A **persona** is the top layer: a switchable *modus operandi*, from "delegate opportunistically" to a
mandatory deliberating council. Everything under it is data (Markdown + `teams.yaml` + small strategy
files), so you reshape the whole system without touching the core. An active persona can also borrow
another installed persona's council for one decision with `council({ persona: "magi", question: "…" })`
— only the council shape is borrowed, the caller stays active.

> **Bundled personas are opt-in.** A fresh install ships none — run `/persona seed` (or
> `/persona restore`) once to install the defaults into `~/.pi/agent/persona/`, then edit them or add
> your own. Project (`.pi/`) overrides user overrides builtin, so your copy always wins.

> **Companion — durable memory.** [pi-persona-mind](https://github.com/AeonDave/pi-persona-mind) is a
> separate, optional extension giving each persona a persona-aware *mind*: long-term memory, decaying
> working memory per project, and a deferred-intent backlog, re-injected every turn so it survives
> compaction and restart. Delegation-aware (a background leg inherits only a lean, read-only mind).
> Loosely coupled — pi-persona neither requires nor depends on it.

## What it does

| | |
|---|---|
| **Sub-agents, background-first** | Delegate one or fan out many; each is an isolated run with its own model, skills, tools, and optional git-worktree isolation. Interactive sessions return run ids immediately and deliver results as follow-ups (`sync: true` blocks; headless stays sync) |
| **Always-on discovery** | Every turn the supervisor's prompt carries a live delegation brief — the installed agents/teams/flows plus a standing hand-off default — so delegation never depends on a decayed persona line, and a wrong agent name comes back with the installed list |
| **Live supervision** | Peek progress, steer a run mid-flight, hard-stop it. A `coaching` persona adds a two-way bus where a child asks a blocking `decision` and you reply. All under hard limits (timeout, token budget, concurrency, max children) with cooperative abort |
| **Composable strategies** | Orchestration is small files over a Strategy SDK: fan-out, pipeline, map, critic-loop, vote, council rounds, judge, synthesize, debate, pair, compete. Adding one is a new file, not a core change |
| **Dynamic specialization** | A generic `operator` becomes a specialist from the skills it loads plus an on-the-fly `role`. One roster can specialize a single agent into several perspectives inline (`{ agent, role, model }`) |
| **Flows** | A declarative DAG over strategies (`*.flow.json`): phases wired by `needs`, fanning out where independent, journaled so an interrupted flow resumes; `gate: true` pauses for approval |
| **Exocom across workspaces** | Independent top-level Pi instances share presence, fenced postcards, and a durable claim/ask ledger. `--exocom` joins the current workspace; `--exocom=Ab0T` attaches a Pi whose own workspace holds different files |
| **Progressive-disclosure UI** | Sticky widgets and completed tool cards stay bounded; a collapsed `delegate` card lists failed legs first, a failed `council`/`flow` card leads with the cause. `f9` opens the full live tree |
| **Plugin-neutral telemetry** | Bounded, allowlisted lifecycle metadata for pi-persona-flow and future plugins, scoped by `producerId`. Never stores prompts, model output, tool arguments, paths, or secrets, and cannot steer a run — [`docs/TELEMETRY.md`](docs/TELEMETRY.md) |

## Concepts

| Thing | Is | Lives in |
|---|---|---|
| **Persona** | a switchable supervisor identity + way of working | `personas/*.md` |
| **Agent** | a sub-agent the supervisor runs (prompt + model + tools) | `agents/*.md` |
| **Team** | a named roster of agents | `teams.yaml` |
| **Strategy** | how a roster is orchestrated (vote, loop, rounds…) | `src/orchestration/strategies/*.ts` |
| **Contract** | the structured shape a sub-agent returns (so votes tally) | `contracts/*.contract.json` |
| **Spine** | an optional shared behavioral layer, off by default, edited like a persona | `prompts/spine.md` · `spine.worker.md` |

## How it works

- **Two engines, one seam.** Sub-agents run in-process by default (a `createAgentSession` each — fast
  and steerable). `PI_PERSONA_ENGINE=child` spawns each as an isolated `pi --mode json -p` process
  instead. Either way pi-persona never re-spawns supervisors, the same hard limits apply, and each
  run's `contract@hash` is pinned so a hot reload cannot change a run mid-flight.
- **Everything is data.** Personas and agents are Markdown + YAML frontmatter, teams are `teams.yaml`,
  strategies are small TypeScript files registered by name. A persona's capabilities resolve once and
  are enforced on every call.
- **Decide, then do.** A council persona consults its ensemble through the `council` tool, gets a
  ruling (winner + tally + recorded dissent), executes it with its own tools, and re-convenes when
  execution raises a new decision — state → decision → execution.
- **Time-aware.** Pi's base prompt has no clock. Every settled leg reports its wall time, an inbound
  peer message says how long ago it was sent, and the system prompt carries a session anchor read from
  the session file's own start, so it survives compaction *and* restart. The anchor is deliberately
  coarse (quarter hours, then hours) to keep the cached prefix stable.
- **Model-aware.** A loose `model` name ("sonnet") resolves to your own session provider's id; an
  ensemble runs its cores on *different* models for diverse blind spots. Provider-qualified choices
  are strict billing pins. Within MAGI, a core failing on a provider/unknown-model error may be
  recovered once on a model already proven healthy in that council; abort, timeout, contract, and
  agent failures stay terminal. `/models [query]` searches the installed models.

## Bundled personas, agents & teams

Installed by `/persona seed`; switch with `f8`. These are examples, not runtime identities — no code
branch checks for `elite`, `dev`, or any other name, and your own persona can declare the same
delegation policy, council, strategy, team, flow, contracts, tools, and coaching behavior. For a
practical guide to choosing one and following background work, see
[Working comfortably with Pi Persona](docs/EXPERIENCE.md).

**Personas** — the supervisor you become:

| Persona | What it's for |
|---|---|
| `elite` | Security supervisor-coach — lead operator for assessment work; loads the right technique skill per phase, owns connectivity/pivots/channels, delegates heavy/parallel/long work, drives to the objective with evidence |
| `dev` | Software engineer **and** reviewer — tests-first flow, loads the right coding skills, reviews its own and others' changes with cited `file:line` evidence, delegates large/parallel work |
| `researcher` | Deep-research supervisor — fans one deep-dive agent out per sub-question, follows links recursively, consolidates sourced findings into `.research/<topic>/` |
| `planner` | Planning-first orchestrator — decomposes goals into bounded, verifiable steps and writes plan/design docs; never edits code, hands implementation to `dev` and investigation to `researcher` |
| `magi` | MAGI triarchy — three deliberately-biased cores vote → ruling + tally + recorded dissent, with one anonymised **reflection** round so a core can catch a blind spot without groupthink |
| `audit` | Parallel audit council — one `reviewer` runs three lens passes (security · performance · tests), then a `reviewer` **merges** them into one de-duplicated verdict (`synthesize`) |
| `judge` | The three MAGI cores each argue a distinct complete position; an impartial, anonymised arbiter (`reviewer`) picks the most convincing |
| `swarm` | Batch/sweep — auto-decomposes a "same operation across N items" task, one worker per item in parallel, consolidated (`map`) |
| `verify` | Verify-to-passing loop — an `operator` changes the code, the `verifier` agent *runs* the build/tests and approves only when they pass |

**Agents** — the workers a supervisor delegates to:

| Agent | Role | Tools |
|---|---|---|
| `operator` | Generic executor — becomes a specialist from the skills it loads; edits in place or returns an artifact | all |
| `scout` | Read-only explorer — gathers context, reports answer-first with evidence | read/grep/find/ls |
| `research` | Deep-dive research worker — recursive link-following over the best available fetch tools, writes cited findings to `.research/` | no `edit` |
| `reviewer` | One senior reviewer, parameterised by focus — correctness/security/performance/tests, full-spectrum or a single lens (also the `judge` arbiter) | read/grep/find |
| `verifier` | Runs the project's build/tests; approves only when they pass green | read/bash |
| `evidence-verifier` | Replays a claimed result against its stated scope and approves only reproducible proof | read/bash |
| `melchior` · `balthasar` · `casper` | The MAGI cores — Propulsore · Conservatore · Catalizzatore | read/grep/find |

**Teams** (`teams.yaml`) — named rosters a strategy runs over. A member is a bare agent name or an
inline `{ agent, role, model, skills }` map that specialises one agent, so `review` is one `reviewer`
with three lens roles rather than three files:

| Team | Members | Used by |
|---|---|---|
| `review` | `reviewer` × 3 lenses (security · performance · tests) | the `audit` council · the `deep-review` flow's `gather` phase · the `gated-build` flow's `verify` phase |
| `repair` | operator, verifier | the `verify` persona's council · `dev`'s critic-loop council · the `gated-build` flow's `build` phase |
| `evidence-assurance` | operator, evidence-verifier | evidence-grade sequential critic loop |
| `magi` | melchior, balthasar, casper | `magi` (self-vote) and `judge` (arbiter picks) |
| `swarm` | scout (splitter), operator (worker) | `swarm` (map) |
| `build` | operator × 2 | `compete` best-of-N (e.g. `dev`'s `roster: 'build'` second opinion) |

## Core API

Everything above is composed from a small, fixed set of primitives. A strategy is a TypeScript file
composing the **Strategy SDK**; a persona picks whether and how those run. `magi` is nothing more than
a `.md` persona plus a file that calls `parallel` + `reduce.vote`.

**Strategy SDK** (`src/orchestration/sdk.ts`) — what a strategy file composes:

| Primitive | Does |
|---|---|
| `agent(spec)` | run **one** sub-agent → structured `AgentResult`; `spec` may carry model / tools / skills / `outputContract` |
| `parallel(thunks, {concurrency})` | run **many at once**, bounded by the run limits — also the basis of "map" |
| `reduce.aggregate(results)` | merge N results into one (used by fan-out) |
| `reduce.vote(candidates, opts)` | tally the candidates' **own** votes → `winner / tie / no_consensus / invalid_outputs`, dissent preserved |
| `reduce.judge(candidates, order?)` | anonymise + label N candidates for an **impartial judge**, then map the verdict back with `pick(label)` |
| `roster.team(name)` | the agents of a named team |
| `signal` · `limits` · `log` | cooperative abort · admission/runtime limits · progress |
| *series & loops* | plain `await` / `for` — strategies are TS, so `pipeline` and `critic-loop` are just that |

**Supervisor surface** — what a persona and the LLM drive:

| Surface | Does |
|---|---|
| `delegate` tool | spawn sub-agent(s), single or parallel — background by default in interactive sessions, `sync: true` blocks the turn |
| `council` tool | convene a biased roster → vote → ruling + tally + recorded dissent (the tool form of the vote strategy) |
| `intercom` tool | interact with running sub-agents: `peek` · `result` · `wait` · `steer` · `stop`; `list`/`inbox`/`message`/`reply`/`send` drive the coaching bus |
| `timer` tool | read the fresh UTC/local clock with `now`, or schedule a wake: `arm { message, delaySeconds \| atIso }` · `cancel` · `list`. Up to 32 one-shot alarms, delivered when the supervisor is idle; in-memory per session |
| `monitor` tool | run a background job (`mode: exit`) or event-producing program (`mode: output`) and wake the supervisor automatically: `arm` · `list` · `cancel`. Bounded events, deadlines, owned-process cleanup — [time and event wakes](docs/MONITORS.md) |
| `flow` tool · `/flow` | run a DAG of strategies (`*.flow.json`), journaled so an interrupted flow resumes; a phase `gate: true` is an approval checkpoint |
| `models` tool | list / search the authenticated model ids (`provider/id`) — ★ marks the session provider |
| persona `mode:` | `solo` (opportunistic) · `parallel` · `pipeline` · `strategy:<name>` · `flow:<name>` (mandatory — the engine runs the shape) |
| persona `coaching:` | opt into the comm plane — children get `contact_supervisor` to report progress or ask blocking decisions while they run |
| persona `delegation:` | generic runtime policy: complete cold-start briefs, a default output contract, disjoint parallel write ownership, fresh-verifier ordering |
| `isolation: worktree` | the run happens in a throwaway clean-Git worktree and returns an exported diff; non-Git/dirty checkout or oversized artifact fails closed — never falls back to the real tree |
| `council: { preset }` | expand a `presets/<name>.preset.json` so persona files stay light — authored fields override |
| `contracts/*.json` | a hot-editable structured-return contract, requested by name via `outputContract`, pinned per run |

**Built-in strategies** (files on the SDK above):

| Strategy | Shape | Params (name · default) |
|---|---|---|
| `fanout` | parallel — every roster agent on the same task, aggregated | *(none)* |
| `pipeline` | series / chain — each agent builds on the previous one's output | *(none)* |
| `map` | dynamic fan-out — a splitter breaks the task into a runtime list, one worker per item, aggregated (opt-in live cross-talk via `params: { peers: true }`) | `maxItems` · the run's `maxChildren` − 1 (the splitter takes a slot) · `peers` · `false` |
| `critic-loop` | generator → critic → revise; only explicit approval succeeds, exhaustion returns the unresolved review as failure | `generator` · roster[0] · `critic` · roster[1] · `rounds` · `3` |
| `magi` | parallel panel → **self-vote** → ruling + tally + dissent, plus one anonymised **reflection** round by default (`reflect: false` for a pure poll) | `aggregate` · `"majority"` · `reflect` · `true` |
| `council-rounds` | multi-round `magi`, best-of-X (re-deliberates until a supermajority) | `rounds` · `3` · `bestOf` · majority of roster · `aggregate` · `"majority"` |
| `debate` | 2+ members work in parallel and exchange positions live (peer-to-peer), then a majority vote settles it | `bestOf` · majority of roster · `aggregate` · `"majority"` |
| `judge` | parallel panel → a successful **impartial arbiter** picks the best (anonymised); a failed arbiter cannot select from partial JSON | `judge` · *(required)* · `contract` · none |
| `synthesize` | parallel gatherers → one **synthesiser** merges the labeled findings into one coherent answer (opt-in live cross-talk via `params: { peers: true }`) | `synthesizer` · first roster agent · `peers` · `false` |
| `pair` | driver executes while a navigator inspects the same ground live: risk checklist up front, corrections per milestone, final review (peer-to-peer) | *(none)* |
| `compete` | N competitors implement in isolated git worktrees; a successful blind judge picks; on judge failure every valid diff returns unjudged (requires a git repo) | `judge` · *(required)* · `ballotDiffChars` · `6000` |

Params are declared per strategy and looked up by `knownParams()`; `/doctor` lists the same schema
live, and `test/unit/docs/doc-claims.test.ts` guards this table against drift. Unknown param keys only
warn, never hard-fail.

### Supervising running sub-agents — the `intercom` plane

The supervisor's *internal* comm with the children it spawned, in layers:

| Layer | Needs | What you get |
|---|---|---|
| **Observe & control** | any persona | `peek` watches async sub-agents · `wait` joins them (blocks, returns results) · `steer` injects a soft course-correction · `stop` requests cancellation. The `f9` overlay does the same by hand (`s`, `x`). Cancelling a worker does not undo its existing changes |
| **Retrieve** | any persona | `result { to }` returns one retained run payload in full; `message { messageId }` returns one bus message by its inbox id. Session-local, bounded to 256 messages / 256,000 body chars; an evicted or unknown id errors. Neither starts a worker |
| **Message bus** | `coaching: true` | children get `contact_supervisor`: `progress` surfaces in the result and `intercom inbox`, a blocking `decision` wakes you with a follow-up you answer via `intercom reply` |
| **Sibling peer comm** | strategy opt-in | `debate` and `pair` members always get `contact_peer` (one-way, no cross-child blocking); `map` and `synthesize` add it with `params: { peers: true }` |

- **Idle supervision is cost-aware.** While async children run, a silent watchdog wakes an idle
  supervisor on two signals only: a child that *newly* looks stalled or messages you
  (`PI_PERSONA_PEEK_MS=0` opts out), and an occasional routine check-in digest
  (`PI_PERSONA_CHECKIN_MS`, ~5 min). Between those it stays quiet; completions arrive on their own.
- **Nudges, on by default.** *DelegationNudge* appends a "hand it off" line when a delegating persona
  grinds heavy work by hand; *PersistenceNudge* appends a "don't bank it yet" line when a leg returns
  `[BLOCKED]`/`FLAG: UNKNOWN`. `PI_PERSONA_NUDGE=off` silences both on every delivery path.
- **Cross-process broker, on by default.** Extends steer and the comm plane to legs that do not run
  in-process (`PI_PERSONA_ENGINE=child`, every `isolation: worktree` and every `mcp: true` leg) over a
  session-scoped relay (POSIX socket / Windows named pipe), started lazily. `PI_PERSONA_BROKER=off`
  restores pre-broker spawn.

Design and trust boundaries: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-comm-plane-in-practice).

> **MCP in sub-agents.** By default a sub-agent runs in-process and gets **no MCP** — its `mcp*` tools
> return "not initialized". Mark the agent `mcp: true` (frontmatter) or pass `mcp: true` on the
> `delegate` task to run it on the child engine, which does connect to the servers in
> `~/.pi/agent/mcp.json`. Two caveats:
>
> - **Pre-authenticate first.** That leg is a fresh, UI-less `pi -p` child, so a server needing
>   interactive OAuth cannot authenticate and the child stalls. pi-persona fast-fails it at the
>   startup deadline (`PI_PERSONA_AGENT_STARTUP_MS`, default 5 min, `0` disables) with a clear error.
>   Fix: authenticate once in a normal session (`/mcp auth <server>`); the cached token is reused.
>   HTTP backends that key state by a session-id argument need that id in the task, not a login.
> - **Target-egress rule.** A local tool registration, stdio process, or loopback endpoint is not
>   proof of local egress — its backend may relay to a hosted service. When the rules of engagement
>   bind traffic to your workstation/VPN, use Pi's built-in `bash` or an executor whose source IP you
>   verified with your own canary. The bundled `elite` prompt propagates that invariant into every
>   delegated leg; it is a behavioral safeguard, not a network sandbox.

## Multi-agent quick start

Seed the bundled personas once, then start a supervisor:

```text
/persona seed
pi --persona elite
```

Delegate a self-contained task and keep working while it runs:

```js
delegate({ agent: "operator", task: "Inspect the failing login flow; report root cause and a minimal fix." })
intercom({ action: "peek" })
```

For collaboration between independent Pi processes, open the same workspace in two terminals with
`pi --exocom` (optionally `--persona <name>`), then:

```js
exocom_name({ name: "<invented from the current task>" }) // Pi does this on its first unconstrained turn
exocom_list({})
exocom_send({ target: "<qualified target from exocom_list>", message: "Review the API boundary and send back concrete risks." })

exocom_claim({ work_key: "api-review", write_set: ["src/api"], slice: "Review and fix the API boundary" })
exocom_ask({ target: "<qualified target>", work_key: "api-review", question: "Is the transport contract safe to change?" })
exocom_wait({ work_key: "api-review", ask_id: "<ask_id returned above>" }) // non-blocking; wakes on answer/timeout
exocom_answer({ work_key: "api-review", ask_id: "<received ask_id>", ok: true, evidence: "Tests and file references" })
exocom_release({ work_key: "api-review" })
```

`/exocom` shows the workspace's persistent four-character code. To attach a Pi running in **another**
workspace, use the exact equals form (case-sensitive):

```text
D:\project> pi --exocom            # /exocom shows: workspace project [Ab0T]
D:\document-corpus> pi --exocom=Ab0T
```

Both then share the first workspace's registry, transport, asks, and postcards, while each advertises
the workspace it can actually inspect. A foreign member participates in `send`, `ask`,
`answer`/`decline`, `wait`, `progress`, and release, but cannot place repository-relative claims in
the joined ledger. The code is a join reference, not a secret, and works only between same-host
processes sharing a Pi agent directory.

| | Intercom | Exocom |
|---|---|---|
| Shape | Hierarchical: supervisor → its spawned sub-agents | Flat: independent Pi ↔ Pi peers |
| Control | `peek`, `result`, `wait`, `steer`, `stop`; coaching `inbox`/`message`/`reply`/`send` | Presence/postcards (`list`, `send`, `name`) plus the work ledger (`claim`, `ask`, `answer`/`decline`, non-blocking `wait`, `progress`, `release`) |
| Lifecycle | Created by `delegate` / `council`, owned by the supervisor | Opt-in with `--exocom` / `PI_PERSONA_EXOCOM=1`; `--exocom=Ab0T` joins that workspace scope |
| Authority | Supervisor owns and can abort its children | No peer owns another; the initiator coordinates de facto, with no special authority |

Both planes are asynchronous and keep inbound text fenced. Work coordination is durable runtime state:
overlapping open write-set claims are rejected, an `ask` stays an obligation until `answer`/`decline`
or cleanup, and a pending inbound ask limits that Pi to response tools plus read-only work. On exocom
**replying is the exception, not the default** — an exchange stops once a round no longer moves the
work it was for, which is a relevance bound rather than a round cap. This is cooperative coordination
between local same-user processes, not OS-level authorization or a network protocol. Lifecycle, trust
boundaries, and transport: [`ARCHITECTURE.md`](docs/ARCHITECTURE.md); orchestration shapes:
[`STRATEGIES.md`](docs/STRATEGIES.md).

## Recipes

Everything below is data — drop the files in (discovery: builtin < `~/.pi/agent/persona/` < project
`.pi/`) and switch persona with `f8`. Only a brand-new strategy *shape* touches code.

**Opportunistic delegation** — the simplest persona, no orchestration block:

```markdown
<!-- personas/researcher.md -->
---
name: researcher
persona: true
---
You research thoroughly. For independent sub-questions, fan out `scout` sub-agents in ONE
`delegate` call (`tasks: [...]`), each with a disjoint scope, then synthesize their findings.
```

**A review council + a per-call override** — `council:` is the persona's *default* deliberation; the
`council` tool's own args override it for one call, no file edit.

```yaml
# teams.yaml — one `reviewer` agent, three lens roles
review:
  - { agent: reviewer, role: "Focus ONLY on the SECURITY lens" }
  - { agent: reviewer, role: "Focus ONLY on the PERFORMANCE lens" }
  - { agent: reviewer, role: "Focus ONLY on the TESTS lens" }
```
```markdown
<!-- personas/myaudit.md — the bundled `audit` persona is exactly this -->
---
name: myaudit
persona: true
council: { strategy: synthesize, roster: review, params: { synthesizer: reviewer, peers: true } }
---
Convene the council before sign-off, then apply its merged findings yourself.
```
```js
// one-off: run THIS decision as a debate over the same roster — no file edit.
council({ question: "cache this or recompute?", strategy: "debate", roster: "review", params: { bestOf: 2 } })
```

**A delegation policy on any persona** — keyed by declared fields, never by `name`. The runtime rejects
incomplete briefs before a model call, supplies a missing contract, rejects overlapping or missing
ownership for parallel writers, and refuses a declared verifier that would start before or beside a
material writer in the same call (or while a mutating background run is still in flight). Only
`read`/`grep`/`find`/`ls` count as read-only; shell-capable, MCP-enabled, and unknown toolsets fail
closed as writers. `writeSet` is a scheduling contract, not an OS sandbox.

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
`requiredArtifacts`, and `stopConditions`. `verificationAgents` names ordinary installed agents —
there is no built-in verifier identity.

**A mandatory-orchestration persona** — `orchestration:` runs the strategy automatically every turn
(the LLM cannot opt out) and folds the result into the prompt; use `council:` instead when it should
run only on demand. The hand-off is fail-closed: only `ok:true` is presented as a ruling, everything
else is labelled evidence to repair and verify.

```markdown
<!-- personas/myguard.md -->
---
name: myguard
persona: true
orchestration: { mode: strategy, strategy: magi, roster: magi, params: { reflect: false } }
---
Every turn is decided by the MAGI triarchy first (no reflection round); you present and act on it.
```

**Coaching** — talk to sub-agents *while they run*. Add `coaching: true` to give children a
`contact_supervisor` tool, then read and answer with `intercom inbox` / `intercom reply`.

**A custom agent** — `tools` accepts an allowlist (`[read, grep]`) or an `allow`/`deny` block; omit it
to inherit the session tool set, `tools: []` grants none. `model`, `isolation: worktree`, and
`mcp: true` are optional. The body is the prompt. `purpose:` is an optional one- or two-word
**verticalization** — the lens the agent argues from (`Propulsore`, `Conservatore`) — not prompt text,
but a label wherever a human meets it as a council member, so a roster reads as a set of roles.

```markdown
<!-- agents/hardener.md -->
---
name: hardener
description: Locks down a change's security posture — authz, input validation, secrets handling.
tools: [read, grep, edit, bash]   # or `tools: { deny: [edit] }` to inherit everything but one
model: opus
isolation: worktree
---
You are the Hardener. Given a diff or area, find and FIX authz/access-control gaps, injection and
unsafe-sink risks, secrets/token mishandling, and missing input validation. Cite `file:line`.
```

**A flow with a human checkpoint** — a DAG over strategies; `gate: true` pauses for approval before
dependents run. Journaled, so an interrupted run resumes. Run `/flow gated-build "<task>"`.

```json
// flows/gated-build.flow.json
{
  "name": "gated-build",
  "phases": [
    { "id": "plan",   "strategy": "magi",        "roster": "magi",   "gate": true },
    { "id": "build",  "strategy": "critic-loop", "roster": "repair", "needs": ["plan"] },
    { "id": "verify", "strategy": "fanout",      "roster": "review", "needs": ["build"] }
  ]
}
```

**A structured-return contract** — so votes and judges tally mechanically. Drop a JSON file; a
strategy requests it by name via `outputContract`, and it is pinned per run.

```json
// contracts/ship-verdict.contract.json
{ "name": "ship-verdict",
  "fields": {
    "vote":       { "type": "string", "required": true },
    "severity":   { "type": "enum",   "values": ["low", "medium", "high", "critical"] },
    "confidence": { "type": "number", "min": 0, "max": 1 }
  } }
```

**A preset keeps persona files to one line** — it expands a `*.preset.json`; authored fields override.

```json
// presets/magi-rounds.preset.json
{ "strategy": "council-rounds", "roster": "magi", "params": { "rounds": 3, "bestOf": 3 } }
```
```yaml
# any persona's frontmatter — a full multi-round MAGI council in one line:
council: { preset: magi-rounds }
```

**Each strategy in one runnable line** — point any council-driven persona at these:

```js
council({ question: "adopt library X or hand-roll it?", strategy: "debate",  roster: "review" })
council({ question: "implement the rate limiter",       strategy: "pair",    roster: "repair" })
council({ question: "optimize this hot loop",           strategy: "compete", roster: "build",  params: { judge: "reviewer" } })
council({ question: "port src/legacy to the new SDK",   strategy: "map",     roster: "swarm",  params: { peers: true } })
council({ question: "audit this change",                strategy: "synthesize", roster: "review", params: { synthesizer: "reviewer", peers: true } })
```

**The only case that touches code** — a brand-new strategy *shape* (a new vote rule, a custom loop).
Drop a `src/orchestration/strategies/<name>.ts` on the same SDK, register it, and name it in any
persona's `council:` block. Everything else above is data.

## Keys & commands

**Keys** — `f8` cycle persona · `f9` (or `/agents`) agent overlay: ↑↓ navigate · ⏎ open · `x` stop ·
`s` steer · esc.

**Commands** — `/persona [name|off|list|reload|seed|restore]` · `/models [query]` ·
`/orchestrate <task>` · `/flow <name> <task>` · `/peek [id]` · `/exocom` · `/doctor`.

**CLI flags** (per run) — `--persona <name>` starts with that persona active and errors if it is not
installed · `--exocom` joins this workspace's Exocom plane · `--exocom=Ab0T` joins another workspace's
scope from a different cwd. Model and reasoning effort are Pi's own flags: `--model <provider/id>`,
`--thinking <off|minimal|low|medium|high|xhigh|max>`, `--list-models`.

**Environment** — the knobs worth reaching for; `src/core/config.ts` declares the full set:

| Variable | Default | Effect |
|---|---|---|
| `PI_PERSONA_ENGINE` | in-process | `child` spawns each sub-agent as an isolated `pi` process |
| `PI_PERSONA_CHILD_THINKING` | inherited | reasoning effort for child-engine sub-agents |
| `PI_PERSONA_SEED` | off | `on` auto-installs the bundled personas on first run |
| `PI_PERSONA_BROKER` | on | `off` disables the cross-process comm plane and steer for child/worktree/MCP legs |
| `PI_PERSONA_PEEK_MS` | 30000 | peek watchdog tick — the fast stall/message wakeup; `0` disables |
| `PI_PERSONA_CHECKIN_MS` | 300000 | routine direction check-in digest while async children run; `0` disables |
| `PI_PERSONA_AGENT_MAX_MS` | off | per-agent hard wall-clock cap; unset means a healthy child runs to completion |
| `PI_PERSONA_AGENT_STARTUP_MS` | 300000 | per-agent startup deadline — kills a child producing no progress of its own (e.g. an `mcp: true` leg stalled on init); `0` disables |
| `PI_PERSONA_NUDGE` | on | `off` silences both nudges on every delivery path |
| `PI_PERSONA_EXOCOM` | off | `1` joins the current workspace's Exocom scope (same as bare `--exocom`); cross-workspace selection is CLI-only |
| `PI_PERSONA_SPINE` | off | `on` or a path enables the shared behavioral layer injected between Pi's base prompt and the persona body — see [SPINE.md](docs/SPINE.md) |
| `PI_PERSONA_SPINE_LEGS` | follows `PI_PERSONA_SPINE` | the same selector for delegated legs alone, so the pair expresses all four measurement arms |

## Develop

```bash
npm install
npm run typecheck   # strict tsc --noEmit
npm test            # node --test
```

Design notes live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the design contract),
[`docs/STRATEGIES.md`](docs/STRATEGIES.md) (the orchestration layer in depth), and
[`docs/TELEMETRY.md`](docs/TELEMETRY.md) (the observer/export wire contract).

**Pi compatibility.** pi-persona tracks Pi's published SDK: peer deps float on `*` and the committed
lockfile pins a known-good build. Two seams absorb SDK churn — the in-process engine tolerates
`createAgentSession`'s `modelRegistry → modelRuntime` migration, and the local `ThinkingLevel` mirror
is kept a superset of upstream's with a cast at each boundary. After bumping the pi packages, run
`npm run typecheck`: it is the gate that catches an SDK surface change.

## License

MIT
