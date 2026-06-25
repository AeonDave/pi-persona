# pi-persona — Implementation Guardrails & Decision Ledger (BINDING)

- **Date:** 2026-06-25
- **Status:** BINDING during implementation. Complements `2026-06-25-pi-persona-architecture.md` (the "Spec").
- **Precedence:** Where this document and the Spec conflict, **this document wins** (it encodes review-hardened decisions). The Spec defines the target shape; this defines the *buildable order, invariants, and runtime guarantees* that keep the code clean, clear, and modular.

> Purpose (per the external review): capture **every decision** so nothing is lost, respond **critically** to the
> external evaluation (confirm / adjust / reject with reasons), and fix the binding runtime models. Read this
> before writing any module; treat the §6 lose-nothing list as the regression gate before cutover.

---

## 1. The five hard invariants (binding)

| # | Invariant | Enforcement point |
|---|-----------|-------------------|
| **I1** | `ChildProcessEngine` is the **correctness baseline**. `InProcessEngine` is an optimization and stays swappable behind the `Engine` seam. Every behavior test must pass on child-process **first**. | `engine/` seam; CI runs the behavior suite against the child backend as the reference. |
| **I2** | Strategy files are **trusted project code**, NOT a security sandbox. Gated by Pi **project-trust**; the SDK is a constrained API **by convention**; safety comes from **runtime limits**, not isolation. | `orchestration/strategy` loader + `project_trust` + runtime limits (§4.7). |
| **I3** | **Per-run pinning.** A run pins `contract@hash`, `strategy@version`, and `reducer@version` at start. Hot-reload affects **new** runs only; an active run never changes schema/logic mid-flight. | `engine/` run init snapshots the pinned set; file-watch warns but does not mutate active runs. |
| **I4** | **Capabilities enforced at call time**, never prompt-only. Every tool call, delegate, bus action, and process-transport request passes an `EffectiveCapabilities` check. | `tools/`, `bus/`, `engine/` all consult one `EffectiveCapabilities` (§4.1). |
| **I5** | **Flows (L3 DAG) are not v1.** Strategy files are the ceiling for the first useful releases. | Feature-flagged; not built until v0.5+. |
| **I6** | **Spawning is opportunistic by default; mandatory only when the persona declares it.** Two first-class cases: *opportunistic* ("program this, solve that" — the supervisor MAY delegate, its choice) and *mandatory* ("you are 3 agents doing a/b/c" — the strategy spawns deterministically, the LLM cannot opt out). | `persona.orchestration` mode (§4.8). |
| **I7** | **Adoption is a success criterion, not a nicety.** The opportunistic path must be engineered to actually fire — the current system's under-delegation (it delegates rarely, is underused) is the explicit failure to avoid. Never force spawning in opportunistic mode; instead make delegation compelling, low-friction, well-coached, and model-agnostic. | delegate-tool quality + persona prompts + fast spawn (§4.8). |

These three sentences are the review's headline corrections and are now law:
1. *Strategy JS = trusted project code, gated by project_trust. Not a sandbox.*
2. *Each run pins contract/strategy/reducer version; hot-reload is for new runs only.*
3. *Permissions enforced at runtime on every tool/delegate/bus call.*

---

## 2. Critical response to the external evaluation

Verdicts: ✅ adopt · 🔧 adopt-with-change · 🟰 already in Spec, now hardened · ❌ reject.

| # | Review point | Verdict | Resulting binding rule / reasoning |
|---|--------------|---------|-------------------------------------|
| 1 | Scope too big → brutal vertical slice | 🔧 | Adopt a tighter v0.1 (§3). **Refinement (my call):** L1 declarative `mode: parallel\|solo\|pipeline` **compiles to a built-in strategy file**, so there is exactly **one** fan-out implementation (the `fanout` strategy), not a separate `orchestration/minimal` plus an SDK fan-out. This is *more* modular than both the Spec's original and the review's split. |
| 2 | "Strategy sandbox" underestimated | 🟰→law | I2. Stop calling it a sandbox. jiti-loaded, project-trust-gated, constrained-API-by-convention. Real protection = limits (budget/depth/concurrency/timeout/abort), not isolation. |
| 3 | Hot-reload contract breaks mid-run | 🟰→law | I3, extended to also pin **strategy** and **reducer** versions (review only named the contract; loop/vote logic can change too). |
| 4 | `InProcessEngine` most fragile | 🟰→law | I1. Child baseline; in-process deferred to v0.4 after parity tests. |
| 5 | Bus/Engine/Progress overlap | ✅ | Three **separate planes** with disjoint vocabularies and a no-name-collision rule (§4.2). `progress_update` is a **Bus message only**; the UI progress is a derived `ProgressView`, never a source of truth. |
| 6 | Permission model too complex | ✅ | One `EffectiveCapabilities` object, checked at call time (§4.1). Unify the three glob layers into a single resolver that *produces* it. |
| 7 | Flows YAML not for v1 | 🟰→law | I5. |
| 8 | Reducers too winner-centric | ✅ | Reducer returns a **status union** `winner\|tie\|no_consensus\|invalid_outputs` with `dissent`/`invalid` preserved + a logged tally (§4.3). Voting preconditions made explicit. |
| 9 | Persona file too heavy | ✅ | Add **presets** (`orchestration: { preset: magi-default }`) that expand to the full block; keep authored persona files light (§4.5). |
| 10 | Discovery needs `doctor explain` | 🟰→law | `/doctor` from day one with a precise resolved/shadowed output (§4.6). |
| — | "Turn lose-nothing map into tests/issues, not narrative" | ✅ | §6 is the **regression gate**: each row becomes a test or task; cutover is blocked until green. |
| — | Strategy **DSL instead of JS** (review Option B) | ❌ | Reject for v1. JS-on-SDK is the agreed extensibility model ("magi today, triumvirate tomorrow") and the user explicitly wants strategies-as-files-using-core-functions. We keep JS but label it trusted (I2), which is the review's own Option A recommendation. |

**Net:** I agree with the review almost entirely; the disagreements are (a) I *unify* L1-declarative into the built-in strategy mechanism instead of building a parallel `orchestration/minimal`, and (b) I keep JS strategies (not a DSL). Both choices reduce code and increase modularity.

---

## 3. v0.1 — refined scope & Definition of Done

**Build set (and nothing else):**
```text
core/frontmatter   core/permissions   core/discovery   core/contract   core/naming(min)   core/config   core/ids+types
engine/child       engine/guards(min)
orchestration/sdk(minimal)   orchestration/strategy(loader)   orchestration/reducers(aggregate+stance)
strategies/fanout.js   strategies/critic-loop.js
persona/apply   persona/gating   persona/switch(min)
tools/delegate
contracts/default.yaml (frozen, pinned per run)
commands/persona   commands/doctor
```

**Reasoning for the two deltas vs. the review's MVP:**
- I include a **minimal SDK + `fanout.js` + `critic-loop.js`** (not raw `mode:parallel` plumbing) because (a) it proves the strategy-as-file mechanism — the heart of extensibility — in the first slice, and (b) `fanout` (parallel) + `critic-loop` (iterative) exercise **both** fundamental loop shapes, de-risking the SDK design. `mode: parallel\|solo` are declarative sugar over these built-ins.
- v0.1 reducers are only **aggregate/merge** (for fanout) and **stance-gate** (for critic-loop). The **voting** reducers (majority/unanimity/judge) + the rich status model land in **v0.2 with `magi`**, because v0.1 has nothing that votes. (More precise than the review's "basic reducers".)
- v0.1 `discovery` implements the precedence *model* (builtin < user < project) for personas/agents/strategies/contracts; **package-manifest and legacy `.agents` sources defer to v0.2** (scope control; still explainable via `/doctor`).

**Definition of Done (v0.1) — all must hold:**
1. `agents/*.md` and `personas/*.md` load through the **single** frontmatter engine; project shadows user shadows builtin, and `/doctor` explains the resolution.
2. Activating a persona applies prompt/model/thinking/tools with **snapshot+restore** of baselines (model/thinking restored on omit; tools restored from the **full** registry).
3. `delegate` runs **one** named agent and **N** agents at bounded concurrency through `ChildProcessEngine`, returning structured output validated against the **pinned** `default` contract, with `usage`/`error`/`provenance`.
4. A persona with `orchestration: { mode: parallel, roster: review }` produces structured outputs from multiple child agents (the acceptance test) — via the `fanout` built-in strategy.
5. `critic-loop` runs generator→critic→revise with a round cap and a "no new findings" stop.
6. Every tool/delegate call passes `EffectiveCapabilities`; deny-wins, allowlist semantics, and "restricting `tools` does not silently drop `delegate` unless explicitly denied" all hold and are tested.
7. Windows **and** POSIX: child spawn + process-tree kill smoke tests pass (cross-spawn / `getPiInvocation` / `killProcessTree`).
8. `core/*` modules are pure and unit-tested; `npm run typecheck` and `npm test` are green.

**Explicitly NOT in v0.1:** bus, broker, in-process engine, session fork, worktree, flows, live coaching, magi voting, rich UI widget, package/legacy discovery.

---

## 4. Binding runtime models

### 4.1 `EffectiveCapabilities` — the single capability gate

```ts
interface EffectiveCapabilities {
  tools: ReadonlySet<string>;            // resolved tool allowlist (incl. whether `delegate` survives)
  delegateTargets: ReadonlySet<string>;  // which agents may be spawned
  skills: ReadonlySet<string>;
  mcpServers: ReadonlySet<string>;
  extensions: ReadonlySet<string>;
  canSpawn: boolean;                     // fan-out authorization (depth/builtin-tool gated)
  canUseBus: boolean;
  canUseProcessTransport: boolean;
  limits: { maxChildren: number; maxDepth: number; maxConcurrency: number; timeoutMs: number; budgetTokens: number };
}
```
Built **once** by unifying persona + agent + settings glob layers (deny-wins; `allow` present ⇒ allowlist; absent ⇒ default-allow). **Checked at call time** in `tools/`, `bus/`, `engine/`. Prompt text is advisory only. Tests assert that prompt-only restriction is never the enforcement path.

### 4.2 Three communication planes (disjoint; no name collisions)

```text
EngineEvent  (runtime/telemetry, derived UI)   : started · token · tool_call · completed · failed · usage
Bus Msg      (semantic agent↔agent)            : question · reply · decision_request · progress_update · dissent
ProgressView (derived read-only view)          : computed FROM EngineEvents (+ optional Bus); never authored, never a source of truth
```
Rule: a concept name lives in **exactly one** plane. `progress_update` is a **Bus** message (the comtac `contact_supervisor` semantic); the UI progress widget is a `ProgressView` derived from EngineEvents — it must **not** also be an EngineEvent named `progress`. Engine events are not routed as agent messages and vice-versa.

### 4.3 Reducer result model (binding, used from v0.2)

```ts
type ReducerResult = {
  status: "winner" | "tie" | "no_consensus" | "invalid_outputs";
  winner?: AgentResult;
  dissent?: AgentResult[];   // always preserved when present (minority report)
  invalid?: AgentResult[];   // outputs that failed the contract / had no usable vote
  tally: Tally;              // logged; reproducible
  usedFallback: boolean;     // keep-best-as-fallback was applied
};
```
Voting preconditions (enforced before tallying): identical input to all candidates · rigid output contract · evidence field required for verifiable claims · `no_consensus`/`no decision` is a legal outcome · a separate verifier handles checkable facts · order shuffled + authors anonymized into any LLM-judge · tally logged · dissent never dropped.

### 4.4 Per-run pinning

```ts
interface RunPins { contract: { name: string; hash: string }; strategy: { name: string; version: string }; reducer: { name: string; version: string } }
```
Snapshotted at run start; a mid-run file change emits `pin changed; active run keeps pinned version` and applies only to the **next** run. Flow replay (later) reuses the journaled pins, never the current files.

### 4.5 Persona presets (keep files light)

```yaml
# persona.md
orchestration: { preset: magi-default, params: { rounds: 3 } }   # params override the preset
```
A preset (`presets/magi-default.yaml` or built-in) expands to the full `orchestration:` block; authored params override preset values. Personas may still inline the full block when they want. `/doctor` shows the **expanded** block.

### 4.6 `/doctor` resolution output (binding from day one)

```text
/persona doctor magi
persona:  magi      ← <project>/.pi/personas/magi.md   (shadows: ~/.pi/agent/personas/magi.md, builtin)
strategy: magi      ← builtin/strategies/magi.js
contract: magi-dossier@sha256:abc…  ← ~/.pi/agent/contracts/magi-dossier.yaml
team:     magi      ← <project>/.pi/teams.yaml  → [melchior, balthasar, casper]
effective-capabilities: tools={…} delegate={…} canSpawn=true canUseBus=false limits={…}
engine-backend: child-process   run-limits: {maxChildren:8, maxDepth:2, concurrency:3, timeoutMs:120000}
```
`/doctor` (no arg) also reports runtime paths, discovery roots, and any shadowed files across all kinds.

### 4.7 Strategy execution = trusted code + runtime limits (not a sandbox)

- Loaded via Pi's jiti pipeline; discovered with standard precedence; **gated by `ctx.isProjectTrusted()`**.
- The SDK object is the **only** intended surface (constrained API **by convention**). We do **not** claim isolation from `fs`/`net`/`process`.
- Real safety = **runtime limits** applied by the engine regardless of strategy code: `maxChildren`, `maxDepth`, `maxConcurrency`, `timeoutMs`, `budgetTokens`, and cooperative `signal` abort. A strategy that ignores `signal` is still bounded by hard ceilings.

### 4.8 Enforcement semantics: opportunistic vs mandatory (the prime directive)

`f8` cycles the personas; the **active persona's `orchestration` decides whether and how sub-agents run.** Two first-class behaviors — **both must work well, for any loaded LLM:**

**A) Opportunistic (default — `mode: solo` or no `orchestration` block).** The supervisor is a normal agent holding the `delegate` tool. It delegates **when useful, by its own judgement** — the classic "plan this, solve that" loop. Spawning is **never forced**. (L0; e.g. a `researcher` whose prompt says "for each search, delegate a web-search agent" — but the LLM decides.)

*Make-it-fire requirements (BINDING — the current system is underused; that is the failure to avoid):*
- The `delegate` tool description is **compelling and concrete** (what it's for, when to reach for it, the structured value returned) and **model-agnostic** — it must read as obviously-useful to whatever LLM is loaded.
- Opportunistic persona bodies **coach delegation** with explicit heuristics (independent subtasks → parallel delegate; wide reads → scout; risky change → reviewer), never leaving it implicit.
- **Low friction:** fast spawn, visible progress, results that obviously help. Friction is why delegation doesn't happen — minimize it (a core reason the in-process engine matters later: cheaper/faster ⇒ used more).
- Success is measured by **delegations actually happening on suitable tasks**, not by the capability merely existing.

**B) Mandatory (`mode: strategy|flow`, or `parallel|pipeline` with a `roster`/`per`).** The persona's strategy **is** the execution model; the **engine runs the multi-agent shape deterministically**, regardless of the LLM's inclination. "You are 3 agents doing a/b/c" ⇒ the `magi`/roster strategy spawns all three on every task; the LLM cannot skip it, only do its part within the shape.

**Rule:** opportunistic = LLM-driven **and** system-encouraged; mandatory = engine-driven **and** LLM cannot skip. A persona picks exactly one; absent `orchestration` ⇒ opportunistic. Neither path may degrade the other (an opportunistic persona must not silently force spawns; a mandatory persona must not depend on the LLM choosing to delegate).

### 4.9 Waiting & coaching: sync wait vs async idle (coaching is v0.3, async-only)

**The waiting mode follows `execution.sync`:**
- **`sync` (blocking — v0.1 default):** the supervisor **actively waits** for the children to finish and does nothing else — the `delegate`/strategy call holds the turn and returns only on completion (results still stream for visibility). Simplest and most predictable; **no idle, no peek, no mid-run steering**.
- **`async` (non-blocking — v0.3):** the supervisor returns control and goes **idle** (free to do other work), woken by notifications and/or an opt-in periodic peek. **Coaching/steering applies only here.**

When a persona dispatches **async** children (often on **different models**), the supervisor goes **idle by default and spends no tokens** until something wakes it. Two complementary wake sources:
- **Event wake** (default on): a child sends `contact_supervisor` — `need_decision`/`interview_request` block for a reply; `progress_update` is one-way. Surfaced as a follow-up that triggers a supervisor turn. (Bus Msg plane.)
- **Periodic peek wake** (opt-in, `supervision.wake.everyMs`): a timer injects a synthetic **peek** turn carrying a **compact ProgressView digest** (per-child status/phase/last-progress/usage) so the supervisor can decide to **steer**. Off by default — each peek costs tokens.

On any wake the supervisor may: do nothing → re-idle; **steer/coach** a running child (Bus Msg / engine `resume`/`steer`); answer a `need_decision`; cancel a child; or spawn more. The peek digest is read-only **ProgressView** (derived from EngineEvents, §4.2); steering is a **Bus Msg** — the planes stay separate.

Binding rules:
- **Idle is free:** no supervisor tokens spent while children run unless a wake fires.
- **Periodic peek is opt-in and cost-aware:** default off; small intervals burn tokens — peeks use the **compact** digest (never full transcripts); an optional `maxPeeks`/budget cap bounds spend.
- **Bounded lifecycle:** the peek timer is cleared when all children finish, on cancel, and on `session_shutdown`/reload (reload-hygiene; never leak timers).
- **Coaching gated:** steering a child requires the persona's `coaching: on` and passes `EffectiveCapabilities.canUseBus`.

---

## 5. Phasing (agreed cut)

```text
v0.1  core · child engine · minimal SDK · fanout + critic-loop · persona apply/gating · delegate · frozen contract · /persona · /doctor
v0.2  fuller SDK · magi · teams.yaml · voting reducers (status model) · contract validation · usage/cost aggregation · package/legacy discovery
v0.3  in-process bus · intercom · contact_supervisor · async coaching · idle supervisor + dual wake (event + opt-in periodic peek) + steer
v0.4  InProcessEngine · session fork · context: fresh|fork   (only after child parity tests)
v0.5+ flows DAG · journaled resume · checkpoint gates · worktree isolation · cross-process broker
```
Build order law: `core → child engine → persona/delegate → strategy SDK → inproc bus → inproc engine → broker/flows`.

---

## 6. Lose-nothing regression gate (must be green before replacing old packages)

Turn Spec §10 into tests/tasks. Minimum must-pass list:
- model/thinking baseline snapshot-once + restore-on-omit; invalid value ⇒ keep-current (no override, no restore).
- tools restored from the **full** registry (`getAllTools`), never the active subset.
- deny-wins; `allow` ⇒ allowlist; `allow:[]` ⇒ lockdown; absent ⇒ default-allow ("never strip Pi power").
- restricting `tools` keeps `delegate`/`subagent` unless explicitly denied.
- completion/mutation guard: read-only agents skip; bash/unknown/MCP stay mutation-capable; `completionGuard:false` escape hatch.
- depth guard blocks fan-out **visibly** at cap (not hidden); fan-out only via the builtin tool name.
- `context: fork` fails fast (no silent downgrade); fork filtering strips parent-only orchestration artifacts. *(v0.4)*
- structured output is the **only** source for deterministic fan-out; prose never parsed; `expand.maxItems` mandatory.
- acceptance provenance: child-claimed success ≠ runtime-verified.
- discovery precedence explainable via `/doctor`.
- Windows null-DACL dir guard; cross-OS spawn + process-tree kill.
- async/bus subtleties *(v0.3+)*: unref'd broker never keeps Pi alive; never unlink a live socket; `reply` ambiguity throws; distinct UI status/widget keys.
- persona persistence read-only at session_start; only user gestures write.

---

## 7. Decision ledger (consolidated — nothing lost)

- **Packaging:** one unified plugin `pi-persona`; full cut from nicobailon; clean rewrite. ✔
- **Method:** architecture-first; structure + interfaces + modular separation, then phased vertical slices. ✔
- **Engine:** `Engine` seam; child-process baseline (I1); in-process as deferred optimization. ✔
- **Bus:** in-process default (v0.3); comtac-derived broker as deferred optional backend (v0.5+). ✔
- **Strategies:** files on a core SDK; built-ins shipped as files; **trusted code, not sandbox** (I2). ✔
- **Persona:** the control surface with a clear `orchestration:` grammar + **presets**. ✔
- **Ladder:** L0 prompt → L1 declarative (sugar over built-in strategies) → L2 strategy files → L3 flows (deferred). The simple case (researcher-per-search) stays L0. ✔
- **Contract:** schema-defined, hot-reload for new runs, **pinned per run** with strategy/reducer (I3). ✔
- **Capabilities:** single `EffectiveCapabilities`, enforced at call time (I4). ✔
- **Comms:** three disjoint planes (EngineEvent / Bus Msg / ProgressView). ✔
- **Reducers:** status union with preserved dissent/invalid + voting preconditions. ✔
- **Diagnostics:** `/doctor` + `/persona doctor <name>` from day one. ✔
- **Flows:** deferred to v0.5+ behind a flag (I5). ✔
- **Enforcement (prime directive):** opportunistic-by-default and *made to actually fire* (anti-underuse) vs mandatory (engine-driven, persona-declared); `f8` cycles personas; works for any loaded LLM (I6/I7, §4.8). ✔
- **Supervision:** supervisor idle while children run (no token spend); dual wake = child notifications + opt-in periodic peek; on wake, peek the ProgressView and steer via Bus if the data warrants (v0.3, §4.9). ✔
- **Lose-nothing:** §6 is the binding regression gate. ✔

---

## 8. Deliberately deferred / open (with rationale)
- **InProcessEngine internals** — deferred to v0.4; risk is Pi-internal API stability + isolation. Keep the seam clean so it drops in.
- **Cross-process broker** — deferred to v0.5+; only needed for `transport: process` and cross-session. comtac code is the port source.
- **Flow language ceiling** — YAML DAG + a `strategy:`-node escape (a node can be any strategy file) covers dynamic fan-out without a JS flow language. Revisit only if real flows exceed YAML.
- **`@self` semantics** — sugar for "same model/effort as the persona"; resolve in v0.2 when the SDK grows.
- **Effort/model tiers** — `settings.json` `pi-persona.effortProfiles` + `modelTiers`; reconcile with per-agent `model`/`effort` in v0.2.
- **Strategy isolation beyond trust** — only revisit (VM/process) if we ever load **untrusted** strategies; not a v1 concern.
