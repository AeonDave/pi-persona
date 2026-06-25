# pi-persona — Architecture Design Spec

- **Date:** 2026-06-25
- **Status:** Draft for review (architecture-first; no implementation yet)
- **Author:** Dave (AeonDave) + Claude
- **Supersedes:** `pi-subagents` (fork of nicobailon — fully cut), `pi-subagents-comtac`, `pi-subagents-persona`
- **Targets:** Pi coding agent (`@earendil-works/pi-*`), monorepo at `D:\Sources\pi` v0.80.2

> This document defines **structure, interfaces, and modular separation only**. It is the founding
> architecture for a single unified Pi extension, `pi-persona`, that replaces three existing packages
> with one cohesive, modular, cross-OS, high-quality codebase. Implementation is planned separately.
>
> **Binding overlay:** the companion `2026-06-25-pi-persona-implementation-guardrails.md` hardens these
> decisions for implementation and **wins on any conflict** (scope phasing, capabilities-at-call-time,
> per-run pinning, trusted-not-sandboxed strategies, comm-plane separation).

---

## 1. Goals & non-goals

### Goals
1. **One unified plugin** (`pi-persona`) that subsumes delegation/engine + coordination/bus + persona/identity, with **zero capability loss** vs. the three current packages (see §10 lose-nothing map).
2. **Govern orchestration from `persona.md` with a clear grammar** — subagents, parallel agents, supervisor mode — declaratively.
3. **Strategies are files on a core SDK.** A new strategy (magi → triumvirate) is authored by dropping a file that calls core-exposed primitives. No engine edits.
4. **Progressive effort ladder (L0–L3):** the simple case (a `researcher` that spawns a subagent per search) stays trivially simple; complexity is opt-in.
5. **Intelligent, uniform communication** across sub-agents, parallel agents, and async agents in separate processes — one logical API, transparent backend, **a contract that is easy to change on the fly**.
6. **Cross-OS by construction** (Windows + POSIX), reusing Pi's own helpers.
7. **Modularity wins:** a small, stable core API; everything else (agents, strategies, flows, personas, contracts) is files on top. Easy to fix, maintain, and update.
8. **Clean cut from nicobailon** — reimplement on Pi-native primitives only.

### Non-goals
- Not a workflow scripting product for end users beyond strategy/flow authoring.
- Not backwards-compatible with the old package boundaries (single plugin; `pi-intercom`/old packages must not coexist).
- No new model providers — reuse Pi's `ModelRegistry`.

---

## 2. Pivotal decisions (ADR-style)

| # | Decision | Rationale | Consequence |
|---|----------|-----------|-------------|
| **D1** | **Engine = abstraction with two backends** behind one `Engine` interface: `InProcessEngine` (default, on `AgentHarness`) and `ChildProcessEngine` (`pi --mode json -p`). | In-process is cheaper, shares auth/registry, enables JSONL branch sharing, and makes supervisor↔subagent comms in-process (kills broker/naming/env IPC for the common case). Child-process is the proven path for hard isolation (worktree, crash, revive). | Strategies are backend-agnostic. Default in-process; switch to child for `isolation: worktree`/process transport/live async coaching. |
| **D2** | **One shared `core`**: a single frontmatter/YAML parser, one opencode permission engine, one `naming` module, one `discovery`, one `config`, one set of env-var constants, one return-`contract`. | Removes the two-parser duplication and the byte-compatible naming **mirror** (a whole class of drift bugs). | `core` is pure (no Pi imports), unit-tested. |
| **D3** | **Three authoring surfaces, data-driven:** `agents/*.md`, `strategies/*` (files on a core SDK), `flows/*.yaml` (declarative DAG). All lower to engine primitives + JS reducers. | Matches "modularity wins" and "new strategy is easy to author." | Built-in strategies ship **as files** (also reference examples). |
| **D4** | **Personas are a thin layer over orchestration:** persona = identity + optional default strategy/flow + a declarative `orchestration:` grammar. | Antagonist = `critic-loop`; MagiSystem = `magi`; researcher-per-search = L0 prompt. All become configuration. | Persona file is the control surface. |
| **D5** | **Bias mitigations baked into reducers** (anonymize authors, shuffle order, keep-best-fallback, stability stop). | Research is clear that naive consensus/MAD/LLM-judge underperform and amplify bias. | Voting/judging is safe-by-default, deterministic JS. |
| **D6** | **Cross-OS by construction.** In-process avoids IPC; the optional cross-process `bus` reuses comtac's socket/pipe broker (unref'd, stale-reclaim, home-namespaced). | Windows + POSIX parity with no fragile per-OS code in strategies. | Reuse Pi's `spawnProcess`/`getPiInvocation`/`killProcessTree`/temp/path helpers. |
| **D7** | **Contract is schema-defined and hot-editable.** Return contract + bus message fields live in an editable `contract` file, hot-reloaded; reducers/bus read fields generically. | "Contratto facile da modificare in corsa." | Add/remove fields without recompiling. |

---

## 3. The orchestration effort ladder (L0–L3)

The system **must make the simple case simple**. Complexity is opt-in. This ladder is the primary UX contract.

| Level | What you write | Who drives the fan-out | Canonical example |
|-------|----------------|------------------------|-------------------|
| **L0 — prompt-driven** | Just the persona **body** + keep the `delegate` tool. No `orchestration:` block. | The supervisor LLM, as its prompt directs. | **`researcher` that spawns a subagent per search** — the prompt says "for each search query, delegate a `web-search` subagent." Identical to today's personas. |
| **L1 — declarative shape** | One `orchestration:` block: `mode: solo\|parallel\|pipeline` (+ optional `per:`/`roster:`/`params:`). | The engine, deterministically (incl. dynamic `per:`-item fan-out). | `researcher` that **deterministically** fans out one child per item of a structured list (`per: queries`). |
| **L2 — strategy file** | A `strategies/<name>.js` using the core SDK. | The strategy code. | `magi` (best-of-N vote), `antagonist` (critic loop), `triumvirate` (custom rules). |
| **L3 — flow file** | A `flows/<name>.yaml` DAG composing strategies + rosters. | The flow scheduler (resumable). | `deep-review`: gather → critique → decide, with a checkpoint gate. |

**Rule:** L0 requires nothing new; you climb only when you want determinism/structure/reuse. A persona may pin a default level (`orchestration.mode`/`strategy`/`flow`) or leave it at L0.

---

## 4. Authoring surfaces & grammar

### 4.1 Agent definition — `agents/<name>.md` (one unified format)

Markdown + YAML frontmatter; body = the agent's system prompt. **One parser** serves agents, personas, chains, strategies' inline agents.

```yaml
---
name: web-search
description: Runs one focused web search and returns structured findings   # routing signal
role: worker                 # worker | proposer | aggregator | judge | critic | persona
tools: [web_search, read]    # least-privilege allowlist
model: anthropic/claude-...  # exact id wins
effort: balanced             # fast | balanced | deep  -> {provider,id,thinking} profile
thinking: medium             # off|minimal|low|medium|high|xhigh (or via effort)
isolation: none              # none | worktree | session-branch
context: fresh               # fresh | fork  (fork = branch parent JSONL leaf)
systemPromptMode: replace    # replace (default for agents) | append
persona_axis: logic          # optional, for MAGI-style diversity (logic|ethics|practical|...)
outputContract: default      # ref to a contract schema (editable)
---
You are a focused web researcher. Given a query, ...
```

All current `pi-subagents` frontmatter fields are preserved (model/fallbackModels/thinking/tools/`mcp:`/extensions/subagentOnlyExtensions/inheritProjectContext/inheritSkills/defaultContext/skills/output/defaultReads/defaultProgress/completionGuard/interactive/maxSubagentDepth/package/...). See §10 A3.

### 4.2 Persona definition — `personas/<name>.md` (the control surface)

A persona is an agent file with `persona: true` **plus** the orchestration grammar. The body is the **supervisor** system prompt.

```yaml
---
name: magi
label: "🧠 MAGI"
persona: true
model: anthropic/claude-...        # optional supervisor model (snapshot/restore baseline)
thinking: high
systemPromptMode: append           # append (default for personas) | replace
tools:    { allow: ["*"], deny: [] }      # supervisor's active tools (must keep `delegate`)
delegate: { allow: ["melchior","balthasar","casper"] }   # absent ⇒ "sees everyone" (companion default)
skills:   [code-review]

orchestration:                     # ← the clear grammar (optional; absent ⇒ L0)
  mode: strategy                   # solo | parallel | pipeline | strategy | flow
  strategy: magi                   # when mode: strategy → strategies/magi.js
  flow: ~                          # when mode: flow → flows/<name>.yaml
  roster: magi                     # team name in teams.yaml (the governed agents)
  per: ~                           # structured field to fan out one child per item (L1)
  params: { rounds: 3, aggregate: unanimity, diversity: persona }
  execution:
    sync: async                    # sync | async
    transport: in-process          # in-process | process   (separate OS process)
    isolation: none                # none | worktree | session-branch
    concurrency: 3
  comm:
    contract: default              # editable contract schema (hot-reload)
    coaching: on                   # live steer/ask over the bus while children run
  supervision:                     # while async children run, the supervisor goes idle
    idleWhileRunning: true         #   default: spend no tokens while children work
    wake:
      onChildMessage: true         #   event wake: child notifications (contact_supervisor)
      onChildComplete: true        #   event wake: a child finishes
      everyMs: 0                   #   periodic peek; 0/off = notifications only (cost-aware)
    onWake: peek                   # peek | peek-and-steer (steer may coach running children)
    peekDigest: compact            # compact | detailed (how much child data per wake)
---
You are the MAGI orchestrator. ...
```

Grammar notes:
- `mode: solo` → classic single supervisor (L0/L1). `parallel`/`pipeline` → built-in shapes (L1). `strategy`/`flow` → L2/L3.
- Every field except `mode` is optional with safe defaults. **Absent `orchestration:` ⇒ pure L0** (today's behavior).
- `delegate`/`tools`/`skills` keep opencode `{allow,deny}` semantics (deny-wins; absent ⇒ default-allow = "never strip Pi power").

### 4.3 Strategy definition — `strategies/<name>.js` (files on the core SDK)

A strategy is a small module exporting `meta` + `run(input, sdk)`. It uses **only** the injected SDK (the functions the core exposes). Built-ins ship in this exact form.

```js
// strategies/magi.js  — "best-of-N priority vote over 3 fixed personas"
export const meta = {
  name: 'magi',
  kind: 'vote',
  paramsSchema: { rounds: 'int=1', aggregate: 'majority|unanimity=majority', diversity: 'persona|model|temperature=persona' },
}
export async function run(input, sdk) {
  const team = sdk.roster.team(input.roster ?? 'magi')          // [melchior, balthasar, casper]
  const candidates = await sdk.parallel(
    team.map(agent => () => sdk.agent({ agent, task: input.task, outputContract: 'magi-dossier' })),
    { concurrency: input.params.concurrency ?? team.length },
  )
  return sdk.reduce[input.params.aggregate](candidates, {        // 'unanimity' | 'majority'
    anonymize: true, shuffle: true, keepBestFallback: true, minorityReport: true,
  })
}
```

```js
// strategies/triumvirate.js — "magi tomorrow, different rules" (copy + tweak)
export const meta = { name: 'triumvirate', kind: 'vote', paramsSchema: { veto: 'bool=true' } }
export async function run(input, sdk) {
  const [consul, censor, tribune] = sdk.roster.team('triumvirate')
  const props = await sdk.parallel([consul, censor].map(a => () => sdk.agent({ agent: a, task: input.task })))
  const judged = await sdk.agent({ agent: tribune, task: sdk.contract.pack(props), outputContract: 'verdict' })
  if (input.params.veto && judged.structured.stance === 'reject') return sdk.fail('tribune veto', { dissent: judged })
  return sdk.reduce.judge([...props], { judge: tribune, anonymize: true })
}
```

```js
// strategies/critic-loop.js — the Antagonist
export const meta = { name: 'critic-loop', kind: 'critic', paramsSchema: { rounds: 'int=3', stop: 'dry|max=dry', critic: 'string=skeptic' } }
export async function run(input, sdk) {
  let work = await sdk.agent({ agent: input.generator ?? '@self', task: input.task })
  return sdk.loopUntilDry(async (round) => {
    const critique = await sdk.agent({ agent: input.params.critic, task: sdk.contract.challenge(work), outputContract: 'critique' })
    if (critique.structured.stance !== 'reject') return sdk.done(work)
    work = await sdk.agent({ agent: input.generator ?? '@self', task: sdk.contract.revise(work, critique) })
    return sdk.continue(work)
  }, { maxRounds: input.params.rounds, stop: input.params.stop })
}
```

**Execution model (binding — see guardrails §4.7):** strategy files are **trusted project code**, loaded via Pi's jiti pipeline, discovered with the standard precedence (§7.3), and **gated by Pi project-trust** (`ctx.isProjectTrusted()`). The SDK is injected as a **constrained API by convention — NOT a security sandbox** (we do not claim isolation from `fs`/`net`/`process`). Safety comes from **runtime limits** the engine enforces regardless of strategy code (budget, concurrency, depth, timeout, cooperative `signal` abort). Contract/strategy/reducer versions are **pinned per run** (§14.1).

### 4.4 Flow definition — `flows/<name>.yaml` (declarative DAG)

```yaml
name: deep-review
phases:
  - id: gather
    strategy: fanout
    roster: review
  - id: critique
    strategy: critic-loop
    needs: [gather]
    params: { rounds: 3, stop: dry }
  - id: decide
    strategy: magi
    needs: [critique]
    join: true                 # reducer node over upstream outputs
gates:
  - after: decide
    type: checkpoint           # journaled human approval (block + feedback)
resume: journaled              # replay finished nodes; run only changed/remaining
```

Flows are **statically verified** before running (acyclicity, references resolve, `join` reducers valid), and **resumable** via a journal (finished nodes replay from disk, no re-spend).

### 4.5 Roster — `teams.yaml` (runtime-switchable)

```yaml
# ~/.pi/agent/teams.yaml (global) | <project>/.pi/teams.yaml (project, wins)
magi:        [melchior, balthasar, casper]
triumvirate: [consul, censor, tribune]
review:      [security, performance, tests]
```

`/team <name>` switches the active roster at runtime; "save current as template" writes agent files + updates `teams.yaml` (scope global|project).

### 4.6 Contract — `contracts/<name>.yaml` (hot-editable return + message schema)

```yaml
# contracts/default.yaml — the structured return contract (the voting/judging linchpin)
fields:
  result:    { type: string, required: true }    # actionable conclusion / answer
  output:    { type: string }                     # exact anchors, file:line, decisive snippets
  evidence:  { type: string }                     # what was validated; paths ruled out
  learnings: { type: string }                     # assumptions, reusable gotchas
  vote:      { type: string }                     # canonical answer key (majority)
  confidence:{ type: number, min: 0, max: 1 }     # weighted vote
  stance:    { type: enum, values: [approve, reject, revise] }   # critic/debate
  dissent:   { type: string }                     # MAGI minority report
```

Reducers and the bus read fields **generically** from the loaded contract, so editing this file (and hot-reloading) changes the contract with no code change. Strategies request a contract by name (`outputContract: 'magi-dossier'`).

---

## 5. Module map (separation)

Single published plugin; internal modules with **acyclic, downward-only** dependencies. `core/*` modules are **pure** (no Pi imports) and unit-tested.

```
pi-persona/src/
  core/            ← pure kernel, unit-tested, no Pi-runtime coupling
    frontmatter/   one MD+YAML engine: frontmatter for agents|personas|chains; standalone YAML for flows|contracts|teams (strategy `meta` comes from the JS file's export)
    permissions/   opencode glob resolver (deny-wins, allowlist|denylist|absent⇒default)
    naming/        SINGLE source for session/child handles (kills the byte-compat mirror)
    discovery/     precedence builtin < package < user < project; dirs + manifests
    config/        settings.json "pi-persona" namespace + env PI_* (constants defined once)
    contract/      contract schema loader + types + reducer-facing field access (hot-reload)
    ids/ types/    runId, child index, JSON-pointer keys; shared types
  engine/          ← "run an agent → structured result", backend-agnostic
    engine.ts      Engine interface + concurrency pool + abort + usage/cost aggregation
    inproc/        InProcessEngine on AgentHarness (default)
    child/         ChildProcessEngine on `pi --mode json -p` (cross-OS spawn helpers)
    session/       JSONL fork/branch, session dirs, resume/revive
    worktree/      git-worktree isolation (+ setup hook)
    guards/        completion/mutation guard, depth guard, acceptance gates
  bus/             ← coordination (DEFAULT in-process; broker optional)
    inproc/        in-process mailbox/event-bus (ask/reply, presence) — handle-based
    broker/        comtac-derived socket/pipe broker (cross-proc / cross-session)
    protocol/      message types, length-prefixed framing, validators
    intercom/      intercom + contact_supervisor tools, backend-agnostic
  orchestration/   ← the heart
    sdk/           the Strategy SDK injected into strategy files (agent/parallel/pipeline/reduce/ask/loopUntilDry/phase/budget/roster/contract/log/signal)
    strategy/      Strategy loader + registry; built-in files (solo|fanout|vote|magi|critic-loop|debate|moa)
    reducers/      majority|ranked|judge|synthesize|unanimity + bias mitigations
    roster/        teams.yaml loader, runtime-switchable rosters
    flow/          DAG parse → static verify → schedule → journaled resume
    progress/      phase/agent progress model (feeds UI widget)
  persona/         ← identity layer (today's persona, generalized)
    persona.ts     persona = identity + orchestration grammar binding
    apply/ gating/ before_agent_start inject; snapshot/restore model/thinking/tools; delegate/tool gating
    state/ switch/ persistence (last selection), seeding; f8 cycle + /persona + picker
  tools/           ← LLM-facing tools (TypeBox): delegate/subagent, intercom, contact_supervisor, flow/run, vote/challenge
  commands/        ← slash: /run /chain /parallel /flow /persona /team /comtac /doctor
  ui/              ← widgets, status keys, renderers, clarify TUI, progress panel
  extension.ts     ← single ExtensionFactory: wires modules to pi.*
```

**Dependency rule:** `core` ← all; `engine`,`bus` → `core`; `orchestration` → `engine`+`bus`+`core`; `persona` → `orchestration`+`core`; `tools`/`commands`/`ui` → lower layers; `extension.ts` wires. No upward deps; no cycles.

---

## 6. Core interfaces (the seams)

```ts
// ── engine ────────────────────────────────────────────────────────────────
interface AgentSpec {
  agent: string | InlineAgentDef;          // name (agents/*) or ad-hoc inline def, or '@self'
  task?: string;
  model?: string; effort?: 'fast'|'balanced'|'deep'; thinking?: ThinkingLevel; tools?: string[];
  context?: 'fresh'|'fork'; isolation?: 'none'|'worktree'|'session-branch';
  outputContract?: string;                 // validates the structured return
}
interface AgentResult {
  output: string; structured?: Record<string, unknown>; usage: Usage;
  acceptance: Acceptance; provenance: Provenance; error?: EngineError;   // null on recoverable failure
}
interface RunHandle { id: string; handle: AgentHandle; events: AsyncIterable<AgentEvent>; result: Promise<AgentResult>; abort(): void }
interface Engine {
  run(spec: AgentSpec, ctx: RunCtx): RunHandle;
  runMany(specs: AgentSpec[], opts: { concurrency: number }): RunHandle[];
}

// ── orchestration SDK (injected into strategy files) ────────────────────────
interface StrategySDK {
  agent(spec: AgentSpec): Promise<AgentResult>;
  parallel(thunks: Array<() => Promise<AgentResult>>, opts?: { concurrency?: number }): Promise<AgentResult[]>;
  pipeline(items: unknown[], ...stages: Stage[]): Promise<unknown[]>;
  reduce: Reducers;                                   // majority|ranked|judge|synthesize|unanimity
  loopUntilDry(fn: (round: number) => Promise<LoopStep>, opts: { maxRounds: number; stop: 'dry'|'max' }): Promise<AgentResult>;
  ask(to: AgentHandle, msg: Msg): Promise<Reply>;     // coaching over the bus
  send(to: AgentHandle, msg: Msg): void;
  phase(title: string, opts?: { budget?: number }): void;
  roster: { team(name: string): string[]; resolve(name: string): AgentDef };
  contract: { pack(rs: AgentResult[]): string; challenge(r: AgentResult): string; revise(r: AgentResult, c: AgentResult): string };
  budget: Budget; progress: Progress; log(msg: string): void; signal: AbortSignal;
  done(r: AgentResult): LoopStep; continue(r: AgentResult): LoopStep; fail(reason: string, extra?): never;
}
interface Strategy { meta: StrategyMeta; run(input: StrategyInput, sdk: StrategySDK): Promise<StrategyResult> }
type Reducer = (cands: AgentResult[], opts: ReduceOpts) => { winner: AgentResult; tally: Tally; dissent?: string; usedFallback: boolean };

// ── flow ────────────────────────────────────────────────────────────────────
interface Flow { parse(src: string): FlowSpec; verify(s: FlowSpec): Diagnostic[]; run(s: FlowSpec, sdk: StrategySDK): Promise<FlowResult> }

// ── persona ──────────────────────────────────────────────────────────────────
interface Persona {
  name: string; label: string; isPersona: true;
  model?: string; effort?: string; thinking?: string; systemPromptMode: 'append'|'replace';
  tools?: Permission; delegate?: Permission; skills?: Permission;
  orchestration?: OrchestrationGrammar;     // §4.2; absent ⇒ L0
  body: string; source: string;
}

// ── bus (one API, two backends) ───────────────────────────────────────────────
interface Bus {
  selfName(): string;
  list(): Peer[];
  send(to: AgentHandle, msg: Msg): void;
  ask(to: AgentHandle, msg: Msg): Promise<Reply>;   // blocks for reply (in-proc or cross-proc)
  reply(msg: Msg): void;
  pending(): Pending[];
}
```

`AgentHandle` is a **logical** reference (object handle in-process; resolved to a broker name only when crossing a process). This is what makes the comm "intelligent": strategies address peers by handle, and the bus picks the transport.

---

## 7. Cross-cutting design

### 7.1 Communication model
- **In-process (default):** `bus/inproc` is a handle-based mailbox + event bus. `ask()` resolves against the in-memory peer; no naming contract, no IPC, no OS-specific code.
- **Cross-process (opt-in):** when `execution.transport: process` (or coaching a child-process async), `bus/broker` (comtac-derived) carries frames over a Unix socket / Windows named pipe, home-namespaced, `unref()`-d, with stale-socket reclaim and length-prefixed framing. The `naming/` module (single source) maps handles ↔ broker names.
- **Same logical API both ways** (`send/ask/reply/list`). Coaching (live steer) and `contact_supervisor` escalation work uniformly.
- **Editable contract:** payloads validate against the hot-reloaded `contract` schema (§4.6); reducers/bus read fields generically → "modify on the fly."

- **Supervision & coaching loop:** while async children run, the supervisor is **idle** (no token spend), woken by **child notifications** and/or an **opt-in periodic peek** (`supervision.wake.everyMs`); on wake it reads a compact progress digest (ProgressView) and may **steer** running children over the bus. See guardrails §4.9.

### 7.2 Cross-OS
Reuse Pi helpers, never raw `child_process`: `spawnProcess`/`spawnProcessSync` (cross-spawn on win32), `getPiInvocation()` (resolve current `pi` binary on any OS), `killProcessTree` (`taskkill /F /T` vs process-group), `getShellConfig`, `createTempDir/createTempFile`, `joinPath/absolutePath/canonicalPath`, cwd-encoded session dirs, `crlfDelay` line reads. Keep comtac's Windows null-DACL dir guard.

### 7.3 Discovery & precedence (identical across all file kinds)
`builtin < installed package < user (~/.pi/agent/...) < project (<root>/.pi/...)`; project wins collisions; `.json` beats `.md` for chains; both `pi-subagents.*` and `pi.subagents.*` manifest keys honored (now `pi-persona.*` primary, legacy keys accepted). Personas/strategies/flows/teams/contracts each get a discovery dir following the same rule. Seeding writes bundled files into the same dirs they load from (idempotent, never overwrites user edits).

### 7.4 Error handling
- Engine: per-run `AbortController`; recoverable failures return `AgentResult.error` / `null` + diagnostics (never silently lost); `fallbackModels` on provider/quota/auth/timeout failures only.
- Strategy SDK: a stage that throws drops that item to `null` (filterable); `sdk.fail()` aborts the strategy with structured dissent.
- Hooks never throw in hot paths (`context`/`transform` return fallbacks).
- Bus: `ask` ambiguity throws rather than guessing; delivery failure returns a live-roster hint; broker error sink never crashes Pi.
- Guards: completion/mutation guard, depth guard (fan-out **blocked**, not hidden, at cap), acceptance provenance (child-claimed ≠ runtime-verified).

### 7.5 Testing strategy
- **Pure unit tests** for all `core/*` (frontmatter, permissions, naming, discovery, contract, reducers) — no Pi imports, like today's `persona.ts`/`permissions.ts`.
- **Reducer property tests** (bias mitigations: anonymize/shuffle/keep-best-fallback/stability).
- **Engine contract tests** against a mock harness + a real child-process smoke test.
- **Bus**: in-proc round-trip, broker round-trip, framing fuzz, reconnect/failover stress, reply-ambiguity (port comtac's suite).
- **Strategy/flow**: golden tests for built-ins (magi/critic-loop/fanout) on a stub engine; flow static-verify negative tests; journaled-resume replay test.
- **Integration**: mock-`pi` extension test exercising activation, prompt injection, gating, list filtering, a parallel fan-out, and a magi vote end-to-end.

---

## 8. Data-flow scenarios

1. **L0 researcher (per-search subagent)** — persona body instructs "delegate a `web-search` per query." Supervisor calls the `delegate` tool N times in one turn → `Engine.runMany` (in-proc) → results stream to the widget → supervisor synthesizes. No strategy, no config.
2. **L1 researcher (deterministic fan-out)** — `orchestration: { mode: parallel, per: queries }`; the engine expands the structured `queries` array → one child per item (bounded concurrency) → aggregated to `{previous}`-style output.
3. **MagiSystem (L2 vote)** — persona `strategy: magi`; `strategies/magi.js` runs `parallel` over the `magi` roster, each returning a `magi-dossier` contract → `reduce.unanimity` (anonymized, shuffled, minority report) → winner + dissent into the turn.
4. **Antagonist (L2 critic loop)** — persona `strategy: critic-loop`; generator → critic (`stance`) → revise; `loopUntilDry` stops on "no new findings" or `rounds`. Optional live coaching via `bus`.
5. **deep-review (L3 flow)** — `flows/deep-review.yaml`: `fanout` → `critic-loop` → `magi`, checkpoint gate, journaled resume.

---

## 9. Antagonist & MagiSystem as pure configuration (payoff)

- `personas/magi.md`: `persona: true`, `orchestration.mode: strategy`, `strategy: magi`, `roster: magi`.
- `personas/antagonist.md`: `persona: true`, `orchestration.mode: strategy`, `strategy: critic-loop`, `params: { rounds: 3, critic: skeptic }`.
- `teams.yaml`: `magi: [melchior, balthasar, casper]`.
- New variant (`triumvirate`): drop `strategies/triumvirate.js` + a roster; point a persona at it. **No engine change.**

---

## 10. Lose-nothing map (inventory → modules)

Every capability from the three packages maps to a module; verdicts other than **keep** are noted.

- **A (engine/tools, `pi-subagents`)** → `engine/` + `tools/` + `commands/` + `orchestration/`:
  single `delegate`/`subagent` tool (single/parallel `tasks[]`/`count:N`/chain `{previous}`/dynamic `expand` fan-out/`as` named outputs/phase-label); async (`async`/status/interrupt/resume-revive/append-step/stale reconcile/dedupe/`asyncByDefault`); discovery & overrides; prompt assembly (`replace`/`append`, inherit ctx/skills, `context: fresh|fork`, fork filtering); models/thinking/tools/`mcp:`/extensions/skills; output/structured-output/`outputMode`/`maxOutput`/acceptance/progress; worktrees + setup hook; session dirs; `share:gist` (**improve:** make URL/`gh` configurable); completion guard; long-running control; artifacts + cleanup; depth guard; fan-out authorization; nested-run plumbing; clarify TUI; slash commands; live rendering; prompt-template bridge; 7 prompt templates; orchestration skill; doctor; reload hygiene; Windows null-DACL guard. **(improve:** unify frontmatter parser with C; unify naming with B.)**
- **B (bus, `pi-subagents-comtac`)** → `bus/`:
  intercom (`list/send/ask/reply/pending/status`); contact_supervisor (need_decision/interview_request/progress_update); embedded broker + host-election + failover; `unref()` lifecycle + error sink; POSIX stale-socket reclaim / win32 pipe; cross-OS addressing + home-namespacing; length-prefixed framing (16 MiB cap); protocol validators; client reconnect/backoff; presence/roster; reply-tracker ambiguity; timeouts; `/comtac`; `alt+m` compose; footer status; config + safe defaults; inbound `followUp` surfacing; delivery-failure live-roster hint. **(merge:** naming + env constants become shared `core` modules; "no coexistence with pi-intercom" becomes "built-in bus" doc.)**
- **C (persona, `pi-subagents-persona`)** → `persona/` + `core/permissions`:
  persona = top-level identity; `persona: true` marker; frontmatter fields; `composeSystemPrompt` append/replace; `before_agent_start` inject; footer status; **model/thinking snapshot-restore baseline** (subtle); **tools restore via full registry** (subtle); delegate gating (now via typed engine calls, not text parsing — **improve**); list filtering; tool allowlist on every call; opencode permission resolver; flippable delegate-default; `f8` cycle + `/persona`; seeding; discovery dirs; persistence (read-at-start/write-on-gesture); config envs; 4 bundled personas; deactivate restore; clean composition with other extensions.

**Subtle behaviors checklist (must not lose):** model/thinking baseline snapshot-once/restore-on-omit; tools restored via `getAllTools`; delegate-default = allow; "if you restrict `tools`, keep `delegate`/`subagent`"; completion guard read-only detection; unref'd broker + never-unlink-live-socket; `context: fork` fails fast (no silent downgrade) + fork filtering; fan-out only via builtin tool name; structured output is the only fan-out source; `forceTopLevelAsync ⇒ clarify:false`; acceptance child-claimed ≠ verified; persona persistence read-only at session_start; distinct UI status/widget keys; `disableThinking` global suffix strip; reload hygiene; `reply` ambiguity throws.

---

## 11. Migration / staging (high level; details → implementation plan)

1. **`core/` first** (pure, testable): frontmatter, permissions, naming, discovery, config, contract, ids/types — with full unit tests. This is the foundation and de-risks everything.
2. **`engine/`**: ship `ChildProcessEngine` first (proven parity, lose-nothing), define the `Engine` seam, then add `InProcessEngine` (AgentHarness) as the default optimization.
3. **`bus/`**: in-proc backend first; port comtac broker as the cross-proc backend behind the same API.
4. **`orchestration/`**: SDK + reducers + roster + strategy loader; built-in strategy files (solo/fanout/vote/magi/critic-loop); then flow engine.
5. **`persona/` + `tools/` + `commands/` + `ui/`**: wire the control surface, the grammar, gating, and the slash/widget UX.
6. **`extension.ts`**: single factory; doctor; seed bundled personas/strategies/teams/contracts.
7. **Parity gate:** the §10 checklist is the acceptance test before cutover.

---

## 12. Open questions / risks
- **Strategy sandbox depth:** how strict to make the constrained context (pure SDK only vs. allow selected Node builtins). Default: pure SDK + project-trust gate; revisit if authors need more.
- **In-process context-window pressure:** many in-proc children share one Node heap; for large fan-outs prefer `transport: process`. Document the threshold.
- **`@self` semantics** in strategies (generator = the supervisor's own model vs. a named agent). Default: a dedicated agent; `@self` is sugar for "same model/effort as persona."
- **Flow language ceiling:** YAML DAG vs. needing a JS escape hatch for dynamic flows. Default: YAML + a `strategy:`-node escape (a node can be any strategy file), which covers dynamic fan-out without a JS flow language.
- **Effort/model tiers source of truth:** `settings.json` `pi-persona.effortProfiles` + `modelTiers`; reconcile with per-agent `model`/`effort`.

---

## 13. Decision log (this conversation)
- Unify into one plugin `pi-persona`; cut nicobailon entirely. ✔
- Architecture-first: structure + interfaces + modular separation. ✔
- In-process engine default + child-process backend for isolation. ✔
- In-process bus default + optional comtac broker. ✔
- Strategies as files on a core SDK (built-ins ship as files). ✔
- Persona.md is the control surface with a clear `orchestration:` grammar. ✔
- Progressive effort ladder L0–L3; the simple case stays simple. ✔
- Editable/hot-reloadable contract for return + comm. ✔
- First release shipped as narrow vertical cuts (v0.1→v0.5+), not big-bang. ✔ (§14)

---

## 14. Implementation Plan (phased delivery)

> Supersedes the high-level §11 staging. The architecture stays ambitious; the **first release does not**.
> Build `pi-persona` as a modular system, but ship it as a sequence of **narrow vertical cuts**.

### 14.0 Direction

The first goal is **not** to ship the full L0–L3 system. It is to prove the full vertical path:

```text
persona.md → delegate/engine → child agent → structured result → reducer/synthesis
```

Everything else layers on only after this path is stable. Correct build order:

```text
core → child engine → persona/delegate → strategy SDK → inproc bus → inproc engine → broker/flows
```

This avoids the main failure mode: building a complete orchestration framework before proving the basic agent execution path.

### 14.1 Hard implementation rules (non-negotiable)

1. **`ChildProcessEngine` is the correctness baseline.** Implement child-process execution first (isolation, crash containment, parity). `InProcessEngine` is an optimization and must remain swappable behind the `Engine` seam.
2. **Strategies are trusted project code in v1.** Do not present JS strategies as a hard security sandbox. Gate behind Pi **project trust**, expose only the SDK **by convention**, and enforce budget/fan-out/concurrency/depth/timeout limits **at runtime**.
3. **Contracts are pinned per run.** Contracts may hot-reload for *new* runs, but an active run keeps the contract **version/hash** loaded at start — reducers, bus messages, and flow replay never change behavior mid-execution.
4. **Permissions are enforced at runtime.** Tool/delegate/skill/transport restrictions are **not prompt-only**: every tool call, delegate call, bus action, and process-transport request passes through an `EffectiveCapabilities` object.
5. **L3 flows are not v1.** YAML DAG, journaled resume, checkpoint gates are phase-two/three. Strategy files are enough for the first useful release.

### 14.2 v0.1 — Minimal vertical slice

**Scope:** `core/`, `engine/child/`, `persona/`, `tools/delegate`, `orchestration/minimal`, `contracts/basic`, `commands/doctor`.

**Required behavior:** load `agents/*.md`; load `personas/*.md`; apply persona prompt/model/thinking/tool settings; delegate to one named agent; delegate to multiple agents with bounded concurrency; return structured output against a **pinned** contract; preserve basic usage/error/provenance; diagnostics to debug discovery + permissions.

**Explicitly NOT in v0.1:** no bus, no broker, no in-process engine, no flow DAG, no live coaching.

**Acceptance test:** a persona with
```yaml
orchestration: { mode: parallel, roster: review }
```
produces structured outputs from multiple child agents through `ChildProcessEngine`.

### 14.3 v0.2 — Strategy SDK (L2)

**Add:** `orchestration/sdk`, `orchestration/strategy`, `orchestration/reducers`, `teams.yaml`, `strategies/fanout.js`, `strategies/critic-loop.js`, `strategies/magi.js`.

**Strategy surface (only):** `sdk.agent()`, `sdk.parallel()`, `sdk.reduce.*`, `sdk.roster.team()`, `sdk.contract.*`, `sdk.budget`, `sdk.signal`.

**Runtime must enforce:** max child agents/run, max nesting depth, max concurrency, timeout, budget ceiling, abort propagation. Strategy loading is **trusted code**, not a security boundary.

### 14.4 v0.3 — In-process bus

**Add:** `bus/inproc`, `bus/protocol`, `tools/intercom`, `tools/contact_supervisor`. Keep three sources of truth **distinct**, never competing:

```text
Engine events = runtime lifecycle
Bus messages  = semantic agent communication
Progress      = derived UI view
```

### 14.5 v0.4 — InProcessEngine (only after child-engine parity tests)

**Add:** `engine/inproc`, `session/fork`, `context: fresh|fork`.

**Rules:** child-process stays reference behavior; in-process globally disable-able; large fan-out auto-falls-back to process transport; a child crash/error must not corrupt parent state; context sharing is **explicit, never accidental**.

**Default policy:**
```text
concurrency <= 3            → in-process allowed
large fan-out              → process transport preferred
worktree/session isolation → child process required
```

### 14.6 v0.5+ — Cross-process bus & flows

**Add:** `bus/broker`, `flows/*.yaml`, journaled resume, checkpoint gates, worktree isolation, live async coaching. Flows stay a layer **above** strategies; the flow engine stays simple: parse, verify, schedule, persist, resume. A flow node may call any strategy.

### 14.7 Non-negotiable regression checklist (before replacing old packages)

model/thinking snapshot+restore · tools restored from **full** registry · deny-wins permissions · delegate-default stays companion-compatible · restricting `tools` does not silently remove `delegate` unless explicitly denied · completion guard · depth guard blocks fan-out **visibly** · `context: fork` fails fast if unavailable · structured output is the **only** source for deterministic fan-out · child-claimed success separated from runtime-verified acceptance · discovery precedence is explainable · Windows/POSIX spawn + process-kill smoke tests pass.

### 14.8 Diagnostics required from day one (`/doctor`)

Must explain: resolved persona · resolved agent · resolved strategy · resolved contract · resolved team · shadowed files · effective permissions · selected engine backend · contract hash · run limits. Without this, debugging project/user/global precedence becomes painful.

### 14.9 Stance

Modular system, shipped as a sequence of narrow vertical cuts. Architecture ambitious; first release minimal but **excellent and complete along the vertical**.
