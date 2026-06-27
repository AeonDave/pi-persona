# pi-persona

A [Pi](https://github.com/earendil-works/pi) extension that turns the coding agent into a
**supervisor of specialized sub-agents**. You pick a **persona** — a supervisor identity that
decides *how* the agent works — and it delegates, fans out, deliberates, or executes accordingly.

## What it does

- **Personas** — switch with **`f8`** or `/persona`. A persona is a system prompt plus a way of
  working: from opportunistic "delegate when it helps" to a mandatory multi-agent strategy to a
  deliberating **council** the supervisor consults before acting.
- **Sub-agents** — real, isolated `pi` runs, each shown by a friendly `name · model` (e.g.
  "pippo · sonnet-4-6"). The supervisor delegates one, or fans out many in parallel, each with its
  own model, skills, and tool allowlist. A generic `operator` becomes a specialist from the skills
  it loads.
- **Strategies** — orchestration defined in small files over a Strategy SDK: parallel **fan-out**,
  a sequential **pipeline** (chain / debate), a **map** (per-item fan-out over a runtime list), a
  generator↔critic **loop**, an ensemble **vote** (`magi`) / **multi-round council** (`council-rounds`),
  and an impartial **judge**.
- **Flows** — a declarative **DAG over strategies** in a `*.flow.json` file: each phase runs a
  strategy over a roster, wired by `needs`; independent phases fan out in parallel and each
  phase's output feeds its dependents. Pinned by hash and **journaled** so an interrupted flow
  **resumes** where it left off. Run with `/flow <name> <task>`.
- **Live view** — one **agent tree** sticks above the input and shows every sub-agent (strategy
  cores, delegate legs, background runs) as it runs. **`f9`** (or `/agents`) opens a bordered,
  navigable overlay — ↑↓ to move, ⏎ to drill into an agent and watch its output (reasoning + answer)
  stream live, **`x` to stop** one, and **`s` to steer** a running in-process sub-agent (inject a
  redirect mid-run).

## How it works

- **Two engines, one seam.** Sub-agents run **in-process** by default (a `createAgentSession`
  per agent — fast, and **steerable**: you can inject a message into a running sub-agent). Set
  `PI_PERSONA_ENGINE=child` to spawn each as an isolated `pi --mode json -p` process instead.
  Either way pi-persona never re-spawns supervisors (no fork bombs), the same hard limits apply
  (timeout, token budget, concurrency, max children) with cooperative abort, and each run's
  output `contract@hash` is pinned so a hot reload can't change a run mid-flight.
- **Everything is data.** Personas and agents are Markdown + YAML frontmatter; teams are a
  `teams.yaml`; strategies are small TypeScript files registered by name. A persona's
  capabilities (which tools, which delegate targets) resolve once and are enforced on every call.
- **Decide, then do.** A council persona consults its ensemble through the `council` tool, gets a
  ruling (winner + tally + recorded dissent), then **executes** it with its own tools and
  re-convenes when execution raises a new decision — state → decision → execution.
- **Model-aware.** A sub-agent `model` can be a loose name ("sonnet"): it resolves to your own
  session provider's id (not a look-alike you're not logged into). `/models [query]` searches the
  installed models; an ensemble runs its cores on *different* models for diverse blind spots.

## Concepts

| Thing | Is | Lives in |
|---|---|---|
| **Persona** | a switchable supervisor identity + way of working | `personas/*.md` |
| **Agent** | a sub-agent the supervisor runs (prompt + model + tools) | `agents/*.md` |
| **Team** | a named roster of agents | `teams.yaml` |
| **Strategy** | how a roster is orchestrated (vote, loop, rounds…) | `src/orchestration/strategies/*.ts` |
| **Contract** | the structured shape a sub-agent returns (so votes tally) | `contracts/*.contract.json` |

## Building blocks — the core API

Everything above is composed from a small, fixed set of primitives. A **strategy** is just a
TypeScript file composing the **Strategy SDK**; a **persona** picks whether and how those run.
`magi` is nothing more than a `.md` persona + a file that calls `parallel` + `reduce.vote` — and
`judge`, `self-repair`, `map`, … would be exactly the same: new *files* on this API, **no new
core needed**.

**Strategy SDK** — what a strategy file composes (`src/orchestration/sdk.ts`):

| Primitive | Does |
|---|---|
| `agent(spec)` | run **one** sub-agent → structured `AgentResult`. `spec` may carry model / tools / skills / `outputContract` |
| `parallel(thunks, {concurrency})` | run **many at once**, bounded by the run limits. Also the basis of "map": `parallel(items.map(…))` |
| `reduce.aggregate(results)` | merge N results into one (used by fan-out) |
| `reduce.vote(candidates, opts)` | tally the candidates' **own** votes → `winner / tie / no_consensus / invalid_outputs`, dissent preserved |
| `reduce.judge(candidates, order?)` | anonymise + label N candidates for an **impartial judge** (§4.3): run `agent(judge, {task: ballot})`, then map the verdict back with `pick(label)` |
| `roster.team(name)` | the agents of a named team |
| `signal` · `limits` · `log` | cooperative abort · the hard ceilings (children/concurrency/budget/timeout) · progress |
| *series & loops* | plain `await` / `for` — strategies are TS, so they sequence and iterate natively (that is all `pipeline` and `critic-loop` are) |

**Supervisor surface** — what a persona / the LLM drives:

| Surface | Does |
|---|---|
| `delegate` tool | spawn sub-agent(s): **single or parallel** × **sync** (blocks the turn) or **async** (background; result returns as a follow-up) |
| `council` tool | convene a biased roster → vote → ruling + tally + recorded dissent (the tool form of the vote strategy) |
| `intercom` tool | the **comm plane**: `list`/`inbox`/`reply`/`send` to talk to running sub-agents (pairs with each child's `contact_supervisor`) |
| `flow` tool · `/flow` | run a **DAG** of strategies (`*.flow.json`), journaled so an interrupted flow resumes; a phase `gate: true` is a **checkpoint** (approve before its dependents run) |
| persona `mode:` | `solo` (opportunistic — the LLM delegates by judgement) · `parallel` · `pipeline` · `strategy:<name>` · `flow:<name>` (mandatory — the engine runs the shape) |
| persona `coaching:` | opt into the comm plane — a `coaching: on` persona gives its children a `contact_supervisor` tool so they report progress / ask blocking decisions while they run (async) |
| `isolation: worktree` | an agent (frontmatter) or a `delegate` task runs in a throwaway **git worktree** — its edits/tests never touch the main tree, and it's force-removed after |
| `council: { preset: <name> }` | expand a `presets/<name>.preset.json` (strategy/roster/params) so persona files stay light — authored fields override |
| `contracts/<name>.contract.json` | a hot-editable structured-return contract, requested by name via `outputContract`, **pinned per run** so a mid-run edit can't change behaviour |

**Built-in strategies** (files on the SDK above):

| Strategy | Shape |
|---|---|
| `fanout` | parallel — every roster agent on the same task, aggregated |
| `pipeline` | series / chain — each agent builds on the previous one's output |
| `map` | dynamic fan-out — a splitter breaks the task into a runtime list, one worker per item, aggregated |
| `critic-loop` | generator → critic → revise, until the critic stops rejecting |
| `magi` | parallel panel → **self-vote** → ruling + tally + dissent |
| `council-rounds` | multi-round `magi`, best-of-X (re-deliberates until a supermajority) |
| `judge` | parallel panel → an **impartial arbiter** picks the best (anonymised) |

**Where a new shape lives** (core vs file vs config — nothing hidden):
- `judge`, `map`, `pipeline`, `critic-loop`, … → **strategy files** on the SDK. Adding one needs no core change.
- `self-repair` → **persona config**: it's `critic-loop` whose critic is a **`verifier` agent** that *runs* the build/tests (`personas/self-repair.md` + `agents/verifier.md`, team `repair: [builder, verifier]`). Ground truth gates acceptance, not an opinion.
- `debate` → **persona config**: the `pipeline` strategy + a deliberation roster (the cores in a chain instead of a parallel vote).

Only `reduce.judge` extended the **core** (the §4.3 anonymise-for-judge helper) — everything else is a file or persona on top of it.

**Talking to running sub-agents (the comm plane).** A `coaching: on` persona (e.g. `coach`) gives
each in-process child a **`contact_supervisor`** tool; the supervisor reads/answers with
**`intercom`**. The two are wired over a handle-based in-process **bus** — a distinct plane from
engine runtime events and the agent-tree progress view (they never collide).

| Child calls `contact_supervisor` | Supervisor sees it via |
|---|---|
| `progress` (one-way) | the `delegate`/`council` result (sync) or `intercom inbox` / the opt-in periodic peek (async) |
| `decision` / `interview` (waits) | an **event-wake follow-up** → answer with `intercom { action: "reply", askId, message }`. Honoured for **async** runs only; a sync run downgrades it to one-way (no deadlock) |

Idle supervision is cost-aware: while async children run, the supervisor spends nothing until a
child wakes it (a blocking ask) — or, if `PI_PERSONA_PEEK_MS` is set, a periodic peek surfaces a
compact digest. Steering a running child still goes through the f9 overlay (`s`).

A persona declares how it works:

- **nothing** → *opportunistic*: it uses the `delegate` tool when a task has independent parts —
  the simple case stays simple ("research X, Y, Z" spawns one sub-agent per search).
- `orchestration: { mode: parallel \| strategy, strategy, roster }` → *mandatory*: the strategy
  runs automatically on the turn (e.g. `review` fans out security/perf/tests; `antagonist` runs a
  critic loop).
- `council: { strategy, roster, params }` → *tool-driven*: the supervisor consults the council on
  demand, then executes the ruling and re-convenes.

## Examples

Everything below is **data** — drop the files in (discovery: builtin < `~/.pi/agent/` < project
`.pi/`) and switch persona with **`f8`**. Code is needed only to add a brand-new strategy *shape* (last example).

**1 · Opportunistic delegation** — the simplest persona, no orchestration block. The supervisor
delegates by judgement; "research X, Y and Z" fans out one sub-agent per item in a single call.

```markdown
<!-- personas/researcher.md -->
---
name: researcher
persona: true
---
You research thoroughly. For independent sub-questions, fan out `scout` sub-agents in ONE
`delegate` call (`tasks: [...]`), each with a disjoint scope, then synthesize their findings.
```

**2 · A review council** — convene biased cores in parallel through the `council` tool, then act
on the ruling. Swap `strategy` for `critic-loop` (generator↔critic, like `antagonist`) or
`council-rounds` (multi-round vote) without touching code.

```yaml
# teams.yaml
review: [security, performance, tests]
```
```markdown
<!-- personas/review.md -->
---
name: review
persona: true
council: { strategy: fanout, roster: review }
---
Convene the council before sign-off, then apply its findings yourself.
```

**3 · Coaching** — talk to sub-agents *while they run*. A `coaching: on` persona gives its
children a `contact_supervisor` tool; the supervisor reads/answers with `intercom`.

```markdown
<!-- personas/coach.md -->
---
name: coach
persona: true
coaching: true
---
Delegate with `async: true` and tell each sub-agent to report progress and ask blocking
`decision`s via `contact_supervisor`; use `intercom inbox` to read and `intercom reply` to answer.
```

**4 · A flow with a human checkpoint** — a DAG over strategies; `gate: true` pauses for your
approval before dependents run. Journaled, so an interrupted run resumes. Run `/flow gated-build "<task>"`.

```json
// flows/gated-build.flow.json
{
  "name": "gated-build",
  "phases": [
    { "id": "plan",   "strategy": "magi",     "roster": "magi",   "gate": true },
    { "id": "build",  "strategy": "pipeline", "roster": "repair", "needs": ["plan"] },
    { "id": "verify", "strategy": "fanout",   "roster": "review", "needs": ["build"] }
  ]
}
```

**5 · A structured-return contract** — so votes/judges tally mechanically. Drop a JSON file; a
strategy requests it by name via `outputContract`, and it's pinned per run.

```json
// contracts/review-verdict.contract.json
{ "name": "review-verdict",
  "fields": {
    "vote":       { "type": "string", "required": true },
    "severity":   { "type": "enum",   "values": ["low", "medium", "high", "critical"] },
    "confidence": { "type": "number", "min": 0, "max": 1 }
  } }
```

**6 · Isolated work in a throwaway git worktree** — edits/tests never touch your tree; the
worktree is force-removed after. Per agent (frontmatter) or per `delegate` call:

```markdown
<!-- agents/sandbox.md -->
---
name: sandbox
isolation: worktree
tools: [read, write, bash]
---
```
```js
// …or ad-hoc, in a delegate tool call:
{ agent: "operator", isolation: "worktree", task: "try the risky refactor and report if tests pass" }
```

**7 · A preset keeps persona files to one line** — it expands a `*.preset.json`; authored fields override.

```json
// presets/magi-rounds.preset.json
{ "strategy": "council-rounds", "roster": "magi", "params": { "rounds": 3, "bestOf": 3 } }
```
```yaml
# personas/magiv2.md frontmatter:
council: { preset: magi-rounds }
```

**8 · A brand-new ensemble** — a nine-member, best-of-7, multi-round council is two data files
pointing at the built-in `council-rounds` strategy (no code):

```yaml
# teams.yaml
bigcouncil: [a1, a2, a3, a4, a5, a6, a7, a8, a9]
```
```markdown
<!-- personas/bigcouncil.md -->
---
name: bigcouncil
persona: true
council: { strategy: council-rounds, roster: bigcouncil, params: { rounds: 3, bestOf: 7 } }
---
Consult the council per decision, then execute the ruling and re-convene on a new decision.
```

Each `agents/aN.md` gives a core its bias + a JSON vote. Want a *different vote rule*? Drop a
`src/orchestration/strategies/<name>.ts` using the same `agent` / `parallel` / `reduce.vote` SDK
and name it in the `council:` block — **that** is the only case that touches code.

## Keys & commands

- **`f8`** cycle persona · **`f9`** / `/agents` agent overlay (↑↓ navigate · ⏎ open · `x` stop · `s` steer · esc)
- `/persona [name\|off\|list]` · `/models [query]` · `/orchestrate <task>` · `/flow <name> <task>` · `/peek [id]` · `/doctor`
- env: `PI_PERSONA_ENGINE=child` (spawn instead of in-process) · `PI_PERSONA_CHILD_THINKING=<level>`

## Develop

```bash
npm install
npm run typecheck   # strict tsc --noEmit
npm test            # node --test
```

Design notes (binding) live in
[`docs/superpowers/specs/`](docs/superpowers/specs/) — the guardrails doc wins on any conflict.

## License

MIT
