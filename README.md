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
| **Contract** | the structured shape a sub-agent returns (so votes tally) | `contracts/*.yaml` |

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
| `flow` tool · `/flow` | run a **DAG** of strategies (`*.flow.json`), journaled so an interrupted flow resumes |
| persona `mode:` | `solo` (opportunistic — the LLM delegates by judgement) · `parallel` · `pipeline` · `strategy:<name>` · `flow:<name>` (mandatory — the engine runs the shape) |

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

A persona declares how it works:

- **nothing** → *opportunistic*: it uses the `delegate` tool when a task has independent parts —
  the simple case stays simple ("research X, Y, Z" spawns one sub-agent per search).
- `orchestration: { mode: parallel \| strategy, strategy, roster }` → *mandatory*: the strategy
  runs automatically on the turn (e.g. `review` fans out security/perf/tests; `antagonist` runs a
  critic loop).
- `council: { strategy, roster, params }` → *tool-driven*: the supervisor consults the council on
  demand, then executes the ruling and re-convenes.

## Add an ensemble — no code

A nine-member, best-of-7, multi-round council is three files:

```yaml
# teams.yaml
magiv2: [a1, a2, a3, a4, a5, a6, a7, a8, a9]
```

```markdown
<!-- personas/magiv2.md -->
---
name: magiv2
label: "🧠 MAGI v2"
persona: true
council:
  strategy: council-rounds      # built-in multi-round deliberation
  roster: magiv2
  params: { rounds: 3, bestOf: 7 }
---
You are the supervisor of a nine-core council. Consult it for each decision, then execute the
ruling with your tools and re-convene when a new decision arises.
```

Each `agents/aN.md` gives a core its bias and a JSON vote. Want a different vote rule or a new
deliberation shape? Drop a strategy file in `src/orchestration/strategies/` — it uses the same
`agent` / `parallel` / `reduce.vote` SDK — and name it in the `council:` block.

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
