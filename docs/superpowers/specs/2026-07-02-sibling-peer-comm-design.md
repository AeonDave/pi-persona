# Sibling peer communication (in-process) + `debate` strategy — design

**Date:** 2026-07-02 · **Status:** approved · **Scope:** v1 of the p2p comm plane, in-process only.
Follow-up (separate spec): the cross-process broker port from `pi-subagents-comtac` (v0.5
milestone), which must implement THIS same peer surface across processes.

## 1. Problem

All eight strategies are hub-and-spoke: siblings never talk to each other while running. The
closest thing — `council-rounds` — is supervisor-mediated: round N's outputs are pasted into
round N+1's prompt. There is no live exchange.

Two concrete gaps:

1. **No sibling surface.** The child-side tool `contact_supervisor` (`bus/contact.ts`) is
   hard-bound to the supervisor handle. `InProcessBus.send/ask` already works between ANY two
   registered handles — the limitation is purely the tool surface.
2. **Dead-letter defect (fixed by this design).** The supervisor's `intercom send` to a child
   delivers into the child's bus inbox, but NOTHING ever drains a child inbox (only the
   `SUPERVISOR` inbox is read — `extension.ts`, `tools/intercom.ts`). The message silently rots
   until the 200-cap evicts it. The only channel that actually reaches a running child today is
   `steer` (via the extension's `steerRegistry`, by run id).

## 2. Decisions (user-approved)

| # | Decision | Rationale |
|---|----------|-----------|
| P1 | **One-way `send` only between siblings.** Blocking `ask` stays a supervisor-channel privilege. | Mutual peer asks can deadlock (A asks B while B asks A). A "conversation" emerges from reciprocal sends — the receiving agent is a live LLM and replies with its own send. Same model as Claude Code teammate SendMessage. |
| P2 | **Dedicated `contact_peer` tool**, not a `to:` parameter on `contact_supervisor`. | Tool present = capability present (the model doesn't guess); the supervisor contract stays untouched; no runtime rejection of blocking-to-peer ambiguity. |
| P3 | **Opt-in per run**: `AgentRunSpec.peers?: boolean`, set by the strategy. Default absent = today's behavior everywhere. | The user's requirement: "è a scelta, il default rimane tale". |
| P4 | **Reference strategy: `debate`** (2+ members, live exchange, then vote). | Showcases the topology; distinct from council-rounds (mediated, between-rounds) — here the exchange is direct and mid-flight. |
| P5 | **In-process only in v1.** The child-process engine ignores `peers`; the strategy degrades (parallel + vote, no live exchange) with a logged warning. | Cross-process delivery needs the broker (next spec). Steer-injection is an in-process capability (`session.agent.steer`). |

## 3. Components

### 3.1 `src/bus/peers.ts` (new, pure)

`makeContactPeerTool(bus, selfHandle, deps)` → a `contact_supervisor`-style `defineTool`:

- `list` — the live peers **of this run only**, each with a role hint:
  `reviewer#2 (SECURITY)`. The tool does NOT scan `bus.participants()`: it calls a
  `deps.listPeers()` closure provided by the engine, scoped by **peer group** (see 3.3), so a
  debate's members never see the children of a concurrent async delegate sharing the same bus.
- `send { to, message }` — one-way note (`kind: "progress"`). Returns a readable result;
  a send to a finished/unknown peer reports "peer gone — it may have already finalized"
  (`bus.send` returned false), NOT an error.
- **Peer-send budget**: a per-member cap (default 20, `RUN_LIMITS`-style constant). Once
  exhausted the tool answers "peer budget exhausted — finalize your answer". Anti ping-pong:
  two chatty members cannot loop forever (their steers re-arm each other's idle watchdogs, so
  the watchdog alone would never break the loop).

Pure module (no Pi imports beyond `defineTool`, mirroring `bus/contact.ts`), fully unit-tested.

### 3.2 Delivery bridge (in `engine/inproc.ts`)

For every child registered on the bus, the engine subscribes to incoming envelopes addressed to
its handle, drains them (`takeWhere`), and injects each into the live session via
`session.agent.steer` as a **fenced, attributed** user message:

```
[message from peer reviewer#2 · SECURITY]
<untrusted-subagent-message> … </untrusted-subagent-message>
```

- Attribution (sender handle + role hint) lives OUTSIDE the fence — a malicious payload cannot
  spoof its sender by closing the fence.
- The bridge serves ANY sender: sibling sends (new) and supervisor `intercom send`
  (**dead-letter fix** — a regression test pins this).
- Subscribe after session creation; flush the inbox once on subscribe (catches messages that
  raced registration) and on every `onMessage`. Unsubscribe in the run's `finally`.
- `fenceUntrusted` moves from `extension.ts` to a pure module (`src/core/fence.ts`) so the
  engine does not import the extension; `extension.ts` re-uses it from there.

### 3.3 SDK plumbing (`orchestration/sdk.ts`)

- `AgentRunSpec.peers?: boolean`.
- `makeSDK` mints a **peer group id** per strategy run (same lifetime as the existing per-run
  `uiSeen` map) and stamps it on specs with `peers: true`; the engine keeps
  `group → Set<handle>` and builds each tool's `listPeers()` from it. Registration/removal
  happen where the child handle is registered/unregistered today.
- The engine-spec adapter forwards `peers`/group; the **child engine ignores them** (v1).

### 3.4 Gating

`contact_peer` is bound iff `spec.peers && deps.bus && canUseBus`. This finally wires
`EffectiveCapabilities.canUseBus` — present in the guardrails object since v0.1, never consulted
("part of the object but unused until the bus/broker land"). `contact_supervisor` keeps its
existing `coaching` gate, unchanged. A child registers on the bus if EITHER applies.
Capability denial ⇒ the tool is simply not bound and the run proceeds (strategy degrades as in
P5); the denial is logged, never silent-but-invisible.

### 3.5 `debate` strategy (`orchestration/strategies/debate.ts`, registered in `BUILTINS`)

- Requires a roster of ≥ 2 (throws otherwise, like council-rounds).
- ONE parallel pass: every member runs with `peers: true` and a debate protocol appended to its
  role: *state your position early and `contact_peer send` it to every peer; when a peer's
  message arrives, rebut or concede explicitly; refine; then finalize against the contract.*
- Members finalize on `outputContract: "default"`; reducer:
  `sdk.reduce.vote(candidates, { aggregate: "majority", keepBestFallback: true })`
  (params: `{ bestOf? }` to override the threshold).
- Render mirrors council: ruling, tally, dissent (minority report) + a peer-traffic count line.
- Degraded mode (child engine / bus denied): plain fanout + vote, `sdk.log` warning.

### 3.6 UI / transparency

The existing `bus.onMessage` observer in `extension.ts` surfaces peer envelopes as a detail tick
on the sender's agent-tree node (`✉ → reviewer#2`). Peer traffic must NOT wake the idle
supervisor notifier: the wake path filters on `to === SUPERVISOR` (verify the existing filter,
pin with a test). No hidden channels: everything a sibling says to a sibling is observable from
the tree.

## 4. Data flow (debate run)

```
supervisor council(strategy: debate, roster: review, task)
  → strategy: role += protocol, peers: true, spawn N in parallel
    → member A works … contact_peer send(to: reviewer#2, "position: …")
      → bus inbox(reviewer#2) → bridge: takeWhere + fence + attribute
        → session(reviewer#2).agent.steer(...)   ← live, mid-turn
    → members finalize on contract
  → reduce.vote(majority, keepBestFallback) → ruling + tally + dissent + traffic count
→ supervisor gets one AgentResult (usage summed)
```

## 5. Error handling

- **Send to finished peer** → informative tool result, not an error (the sender finalizes alone).
- **Ping-pong** → peer-send budget (3.1). **Deadlock** → impossible by construction (P1).
- **Inbox pressure** → existing 200-cap eviction unchanged; the bridge drains promptly anyway.
- **Watchdogs** → unchanged; steered deliveries are session events and re-arm the idle clock.
- **Racing registration** → bridge flushes on subscribe (3.2).
- **Capability denied / child engine** → degrade + log (3.4, P5), never a crash.

## 6. Testing

- **Unit** — `bus/peers.ts`: list scoping (two concurrent groups don't leak), send ok / peer
  gone, budget exhaustion message. Bridge: fenced+attributed delivery, supervisor→child send
  now delivered (**dead-letter regression pin**), flush-on-subscribe, unsubscribe on finish.
  SDK: `peers` + group reach the engine spec; absent by default. `debate` on a stub engine:
  protocol in roles, `peers` set, majority ruling, `bestOf` override, degraded mode.
- **Integration** — extension mock test: a debate run shows peer traffic in the tree; the idle
  notifier does NOT fire on peer envelopes.
- **Live** — `scripts/drive.ts` scenario (steered mid-turn delivery is not fully provable from
  unit tests), per the AGENTS.md testing rule for engine/comm-plane changes.

## 7. Out of scope (deferred to the broker spec)

- Cross-process delivery (child-process engine, worktree isolation legs) — the broker port from
  `D:\Sources\pi-subagents-comtac` implements this SAME surface (`contact_peer` + bridge) over
  a socket/named-pipe transport; `AGENTS.md`'s "deliberately deferred" boundary is updated when
  that spec lands, not now.
- Blocking peer asks, broadcast primitives, persona-level (`communication:`) opt-in grammar —
  YAGNI until a strategy needs them.

## Errata (post-implementation)

- The debate render has no peer-traffic count line: `AgentResult` carries no message count, so
  peer-traffic visibility rides the engine's `activity` "✉ from …" tick (§ simplification 2)
  instead of a tally in the ruling text.
- The shared fence keeps the existing `<subagent-output>` tag (`core/fence.ts`), not this doc's
  illustrative `<untrusted-subagent-message>` — one fence tag serves all untrusted sub-agent
  content, not a peer-specific variant.
- `debate`'s `PROTOCOL` is delivered via the task text, not appended to `role`, so a member's
  `roleHint`-derived UI tree key stays identical to the `rosterNodeKeys` roster seeding (a bare
  roster member's `role` stays unset).
