# pi-persona

An **advanced multi-agent orchestration layer** for the [Pi](https://github.com/earendil-works/pi)
coding agent. It turns one agent into a **supervisor** that runs specialized sub-agents —
**synchronously or in the background**, one at a time or fanned out in parallel — coordinates them
with a library of **composable strategies** (vote, judge, critic-loop, map, synthesize, DAG flows),
and lets you **watch, steer, stop, and message** them while they work. Sub-agents are specialized
**dynamically** (skills + an on-the-fly role + model + tools), so new behaviors need no new files.

A **persona** is the top layer: a switchable *modus operandi* that wires all of the above into a
coherent way of working — from "delegate opportunistically" to a mandatory deliberating council.
Everything under it is data (Markdown + `teams.yaml` + small strategy files), so you customize the
whole system without touching the core.

> **The bundled personas are opt-in.** A fresh install ships **no** personas — run **`/persona seed`**
> (or `/persona restore`) once to install the defaults into `~/.pi/agent/`, then edit them or add
> your own. See [Bundled personas](#bundled-personas-agents--teams).

## What it does

- **Sub-agents, sync or async.** Delegate one, or fan out many in parallel — each an isolated `pi`
  run with its own model, skills, tools, and optional **git-worktree isolation**, shown by a
  friendly `name · model`. Run **synchronously** (block for the result) or **`async: true`** (in the
  background so you keep working); collect async results with `/peek` or `intercom wait` (a join).
- **Live supervision.** While sub-agents run: **peek** their progress, **steer** one mid-run (inject
  a redirect), **stop** (hard-abort), and — with a `coaching` persona — a two-way **message bus**
  where a child asks you a blocking `decision` via `contact_supervisor` and you `reply`. All bounded
  by hard limits (timeout, token budget, concurrency, max children) with cooperative abort.
- **Composable strategies.** Orchestration lives in small files over a Strategy SDK: parallel
  **fan-out**, a sequential **pipeline** (chain/debate), a **map** (per-item fan-out over a runtime
  list), a generator↔critic **loop**, an ensemble **vote** (`magi`, with a reflection round) /
  **multi-round council**, an impartial **judge**, and a gather→merge **synthesize**. Adding one is
  a new file — no core change.
- **Dynamic specialization — no file per specialist.** A generic `operator` becomes a specialist
  from the **skills** it loads plus an on-the-fly **`role`** (extra system prompt at delegation
  time). A **team roster** can even specialise ONE agent into several perspectives inline
  (`{ agent, role, model }`) — e.g. one `reviewer` run as three lens-focused passes.
- **Flows.** A declarative **DAG over strategies** (`*.flow.json`): phases wired by `needs`,
  independent ones fanning out in parallel, each feeding its dependents. Pinned by hash and
  **journaled**, so an interrupted flow **resumes**; a phase `gate: true` pauses for your approval.
- **Personas.** Switch with **`f8`** or `/persona` — the *modus operandi* layer: opportunistic
  delegation, a mandatory multi-agent strategy, or a deliberating **council** consulted before acting.
- **Live view.** One **agent tree** sticks above the input showing every sub-agent (strategy cores,
  delegate legs, background runs). **`f9`** (or `/agents`) opens a near-fullscreen overlay — ↑↓ to
  move, ⏎ to read an agent's **full chronological log** (reasoning, `⚙ tool` calls, answers
  accumulate — nothing overwritten), **`x`** to stop, **`s`** to steer. Queued cores show as `queued`.

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

## Bundled personas, agents & teams

None of these are installed automatically. Run **`/persona restore`** (or `/persona seed`) once to
copy them into `~/.pi/agent/` so you can edit them or add your own (see
[Keys & commands](#keys--commands)) — a fresh install has no personas until you opt in. Switch
persona with **`f8`**.

**Personas** — the supervisor you become:

| Persona | What it's for |
|---|---|
| `elite` | Security player-coach — lead operator for pentest / red-team / lab-CTF; loads the right technique skill per engagement phase, owns tunnels/pivots/shells, delegates heavy/parallel/long work. |
| `dev` | Software engineer **and** reviewer — tests-first flow, loads the right coding skills, reviews its own/others' changes with cited `file:line` evidence, delegates large/parallel work. |
| `researcher` | Deep-research supervisor — fans one deep-dive agent out per sub-question, follows links recursively, consolidates sourced findings into a `.research/<topic>/` folder. |
| `planner` | Planning-first orchestrator — decomposes goals into bounded, verifiable steps and writes plan/design/architecture docs; never edits code, hands implementation to `dev` and investigation to `researcher`. |
| `magi` | MAGI triarchy — three deliberately-biased cores vote → ruling + tally + recorded dissent, with one anonymised **reflection** round so a core can catch a blind spot without groupthink. |
| `audit` | Parallel audit council — one `reviewer` runs three lens-focused passes (security · performance · tests), then a `reviewer` **merges** them into one de-duplicated verdict (`synthesize`). |
| `judge` | The three MAGI cores each argue a distinct complete position; an impartial, anonymised arbiter (`reviewer`) picks the single most convincing. |
| `swarm` | Batch/sweep — auto-decomposes a "same operation across N items" task, runs one worker per item in parallel, consolidates (`map`). |
| `verify` | Verify-to-passing loop — an `operator` changes the code, the `verifier` agent *runs* the build/tests and approves only when they pass, looping until the checks actually pass. |

**Agents** — the workers a supervisor delegates to:

| Agent | Role | Tools |
|---|---|---|
| `operator` | Generic executor — becomes a specialist from the skills it loads; edits in place or returns an artifact, per its granted tools | all |
| `scout` | Read-only explorer — gathers context, reports answer-first with evidence | read/grep/find/ls |
| `research` | Deep-dive research worker — recursive link-following over the best available fetch tools, writes cited findings to `.research/` | no `edit` (web/fetch/write) |
| `reviewer` | One senior reviewer, parameterised by focus — correctness/security/performance/tests, full-spectrum or a single lens (also the `judge` arbiter) | read/grep/find |
| `verifier` | Runs the project's build/tests; approves only when they pass green | read/bash |
| `melchior` · `balthasar` · `casper` | The MAGI cores — Propulsore · Conservatore · Catalizzatore | read/grep/find |

**Teams** (`teams.yaml`) — named rosters a strategy runs over. A member is a bare agent name **or**
an inline `{ agent, role, model, skills }` map that specialises one agent (so `review` is one
`reviewer` with three lens roles, not three files):

| Team | Members | Used by |
|---|---|---|
| `review` | `reviewer` × 3 lenses (security · performance · tests) | the `audit` council (synthesised) |
| `repair` | operator, verifier | `verify` |
| `magi` | melchior, balthasar, casper | `magi` (self-vote) and `judge` (arbiter picks) |
| `swarm` | scout (splitter), operator (worker) | `swarm` (map) |

## Building blocks — the core API

Everything above is composed from a small, fixed set of primitives. A **strategy** is just a
TypeScript file composing the **Strategy SDK**; a **persona** picks whether and how those run.
`magi` is nothing more than a `.md` persona + a file that calls `parallel` + `reduce.vote` — and
`judge`, `verify`, `map`, … would be exactly the same: new *files* on this API, **no new
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
| `intercom` tool | interact with running sub-agents: **`peek`** (watch) · **`wait`** (join — block until async run(s) settle and collect the results) · **`steer`** (soft redirect) · **`stop`** (hard-abort) work for **any** persona on async runs; **`list`/`inbox`/`reply`/`send`** are the coaching message bus (paired with each child's `contact_supervisor`) |
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
| `magi` | parallel panel → **self-vote** → ruling + tally + dissent, plus one anonymised **reflection** round by default (`reflect: false` for a pure independent poll) |
| `council-rounds` | multi-round `magi`, best-of-X (re-deliberates until a supermajority) |
| `judge` | parallel panel → an **impartial arbiter** picks the best (anonymised) |
| `synthesize` | parallel gatherers → one **synthesiser** merges the labeled findings into a single coherent answer (the "reduce" `fanout` lacks) |

**Where a new shape lives** (core vs file vs config — nothing hidden):
- `judge`, `map`, `pipeline`, `critic-loop`, … → **strategy files** on the SDK. Adding one needs no core change.
- `verify` → **persona config**: it's `critic-loop` whose critic is a **`verifier` agent** that *runs* the build/tests (`personas/verify.md` + `agents/verifier.md`, team `repair: [operator, verifier]`). Ground truth gates acceptance, not an opinion.
- a **chain/debate** persona → just point a persona's `council` at the `pipeline` strategy over a roster (the cores build on each other instead of voting in parallel) — no code.

Only `reduce.judge` extended the **core** (the §4.3 anonymise-for-judge helper) — everything else is a file or persona on top of it.

**Watching, steering, and talking to running sub-agents.** Two layers, deliberately separate:

- **Observe / join / steer / stop — any persona, no coaching needed.** `intercom { action: "peek" }` watches
  your async sub-agents; `wait` **joins** them (blocks until they settle and returns their results — for when
  an async result is now needed before the next step); `steer` injects a soft course-correction; `stop`
  **hard-aborts** one (a steer is only a request the child may ignore). The `f9` overlay does the same by
  hand (`s` steer, `x` stop the selected agent).
- **Message bus — needs `coaching: on`** (every delegating supervisor has it). Children get a
  **`contact_supervisor`** tool to *reach you*: `progress` updates surface in the result / `intercom inbox`,
  and a blocking `decision` wakes you with a follow-up you answer via `intercom reply`. Idle supervision is
  cost-aware — the supervisor spends nothing until a child wakes it (or a periodic peek, if `PI_PERSONA_PEEK_MS` is set).

## Write your own

Copy a bundled file from `~/.pi/agent/agents/` and edit it, or drop a new `.md`: it's a **persona**
if its frontmatter has `persona: true`, otherwise an **agent**. Project (`.pi/`) overrides user
overrides builtin, so your copy always wins.

**A persona** (the supervisor you become) — `name`, `label`, `persona: true`, `description`, and a
body (the supervisor system prompt). Choose *how it works*:

- **nothing** → *opportunistic*: the LLM delegates by judgement when a task has independent parts
  ("research X, Y, Z" spawns one sub-agent per search).
- `council: { strategy, roster, params }` → *tool-driven*: convene the council on demand, then
  execute the ruling and re-convene.
- `orchestration: { mode: parallel|pipeline|strategy, strategy, roster }` → *mandatory*: the strategy
  runs automatically every turn.

`strategy` is one of the **built-in strategies** (table above). Optional fields: `coaching: true`,
`model`, `thinking`, `delegate: { allow|deny: [...] }`, `systemPromptMode: append|replace`,
`council: { preset: <name> }`.

**An agent** (a worker you delegate to) — `name`, `description` (the routing signal that says when to
use it), `tools: [read, grep, …]` (least-privilege; omit to inherit all), optional `model` and
`isolation: worktree`, and a body (the agent's prompt). Reference it from a `teams.yaml` roster, or
delegate to it directly. The recipes below show each shape end-to-end.

## Examples

Everything below is **data** — drop the files in (discovery: builtin < `~/.pi/agent/` < project
`.pi/`) and switch persona with **`f8`**. Code is needed only to add a brand-new strategy *shape* (last note).

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
on the ruling. Swap `strategy` for `critic-loop` (generator↔critic, like `verify`) or
`council-rounds` (multi-round vote) without touching code.

```yaml
# teams.yaml — one `reviewer` agent, three lens roles (a member can specialise one agent inline)
review:
  - { agent: reviewer, role: "Focus ONLY on the SECURITY lens" }
  - { agent: reviewer, role: "Focus ONLY on the PERFORMANCE lens" }
  - { agent: reviewer, role: "Focus ONLY on the TESTS lens" }
```
```markdown
<!-- personas/myaudit.md  (the bundled `audit` persona is exactly this shape) -->
---
name: myaudit
persona: true
# three lens-focused reviewer passes in parallel, then one synthesiser merges them into a
# single de-duplicated verdict (fanout would only concatenate).
council: { strategy: synthesize, roster: review, params: { synthesizer: reviewer } }
---
Convene the council before sign-off, then apply its merged findings yourself.
```

**3 · Coaching** — talk to sub-agents *while they run*. The bundled delegating supervisors
(`elite`, `dev`, …) already have it; add `coaching: true` to any persona of your own to give its
children a `contact_supervisor` tool, then read/answer with `intercom`.

```markdown
<!-- personas/mylead.md -->
---
name: mylead
persona: true
coaching: true
---
Delegate with `async: true` and tell each sub-agent to report progress and ask blocking
`decision`s via `contact_supervisor`; use `intercom inbox` to read and `intercom reply` to answer.
(`peek`/`steer`/`stop` work for any persona — coaching only adds the message bus.)
```

**4 · A flow with a human checkpoint** — a DAG over strategies; `gate: true` pauses for your
approval before dependents run. Journaled, so an interrupted run resumes. Run `/flow gated-build "<task>"`.

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

**5 · A structured-return contract** — so votes/judges tally mechanically. Drop a JSON file; a
strategy requests it by name via `outputContract`, and it's pinned per run.

```json
// contracts/ship-verdict.contract.json
{ "name": "ship-verdict",
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
# any persona's frontmatter — a full multi-round MAGI council in one line:
council: { preset: magi-rounds }
```

**The only case that touches code:** a brand-new strategy *shape* (a new vote rule, a custom loop).
Drop a `src/orchestration/strategies/<name>.ts` using the same `agent` / `parallel` / `reduce.*` SDK,
register it, and name it in any persona's `council:` block. Everything else above is data.

## Keys & commands

- **`f8`** cycle persona · **`f9`** / `/agents` agent overlay (↑↓ navigate · ⏎ open · `x` stop · `s` steer · esc)
- `/persona [name\|off\|list\|reload\|seed\|restore]` · `/models [query]` · `/orchestrate <task>` · `/flow <name> <task>` · `/peek [id]` · `/doctor`
- env: `PI_PERSONA_ENGINE=child` (spawn instead of in-process) · `PI_PERSONA_CHILD_THINKING=<level>` · `PI_PERSONA_SEED=on` (opt in to first-run auto-install; off by default)

**Opt-in, and your copies win.** Personas/agents are **not installed automatically** — a fresh
install shows none. Run `/persona seed` to copy the bundled defaults into `~/.pi/agent/` (or
`/persona restore` to force-overwrite them back to the originals); the bundled dir is only the
seed source, so nothing loads until you install it. Once installed you **edit them and add your
own** — the supervisor runs your copies (project `.pi/agents` and your user dir; set
`PI_PERSONA_SEED=on` if you want the first-run auto-install instead).

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
