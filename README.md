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
- **Strategies** — orchestration defined in small files over a Strategy SDK: parallel fan-out, a
  generator↔critic loop, an ensemble **vote** (`magi`), and a **multi-round council**
  (`council-rounds`, best-of-X).
- **Live view** — one **agent tree** sticks above the input and shows every sub-agent (strategy
  cores, delegate legs, background runs) as it runs. **`f9`** (or `/agents`) opens a bordered,
  navigable overlay — ↑↓ to move, ⏎ to drill into an agent and watch its output stream live, and
  **`x` to stop** one.

## How it works

- **Child-process engine.** Every sub-agent is a `pi --mode json -p` child — isolated, cross-OS,
  and prevented from re-spawning supervisors (no fork bombs). The engine enforces hard limits
  (per-child timeout, token budget, concurrency, max children) and cooperative abort, and pins
  each run's output `contract@hash` so a hot reload can't change a run mid-flight.
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

- **`f8`** cycle persona · **`f9`** / `/agents` agent overlay (↑↓ navigate · ⏎ open · `x` stop · esc)
- `/persona [name\|off\|list]` · `/models [query]` · `/orchestrate <task>` · `/peek [id]` · `/doctor`

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
