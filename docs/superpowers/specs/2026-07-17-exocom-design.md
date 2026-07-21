# exocom — external agent-to-agent collaboration — Design

**Date:** 2026-07-17
**Status:** Design approved. Ready for the implementation plan.

## Purpose

Let several **independent, top-level pi-persona instances** open in the same workspace — same, different, or no persona — discover each other and collaborate. You type a task in **one** instance; it drives the others (they message each other, do real work with their own tools, and report results back), all visible live.

This is the one collaboration axis pi-persona lacks today. Its existing cross-process comm is strictly **hierarchical** — a supervisor talking to the *ephemeral sub-agent workers it spawned*, and the rendezvous is keyed by `sessionId`, so two hand-launched instances in the same folder never even discover each other (the design doc lists "inter-session intercom" as deliberately deferred, `ARCHITECTURE.md`). exocom adds the missing **flat** axis: persistent, co-equal, independently-launched instances. The two planes are complementary, not overlapping:

- **intercom / contact_peer / broker** = *inside* one supervisor's run (spawned ephemeral children). **Internal.**
- **exocom** = *between* independent top-level instances. **External.**

(The names encode this: intercom = internal comm; **exocom** = external comm.)

## Locked decisions

1. **Interaction model — one-way messages + async correlated reply.** A send is **non-blocking** and returns a `msg_id`. The receiver, when it has something, replies with `in_reply_to=<msg_id>`; the reply is delivered back to the sender as a **fenced follow-up** labelled as the correlated reply. There is **no blocking await** (avoids the mutual-await deadlock class pi-persona engineered out) and **no auto-capture of "last assistant text"** (fragile) — the receiver replies explicitly.
2. **Activation — opt-in, default OFF.** Primary toggle `PI_PERSONA_EXOCOM=1` (env, matching pi-persona's env-only convention — it registers zero CLI flags today); `--exocom` boolean flag as a per-invocation convenience. Additionally gated by the active persona's `canUseBus` capability. OFF ⇒ no bind, no registry, no tools — byte-identical to today.
3. **Topology — peer-to-peer + file registry (coms-style), NOT an elected hub.** Each instance binds *its own* socket and self-registers in a workspace-scoped registry; discovery = reading the registry; sends are point-to-point. Genuinely flat — no host election, no failover, no single point. (The alternative, reviving comtac's 12-attempt host election, was rejected: it contradicts the flat model and adds failover complexity.)

## Non-goals (MVP)

- No blocking `await` tool; no `response_schema` JSON auto-parse (replies are fenced text).
- No cross-device transport. That is a future **`exocom-net`** (a Bun HTTP+SSE hub + bearer token, the **same** 2-tool semantics → the transport is swappable). Deliberately out of scope now: for same-folder it is pure overhead (an always-on daemon + token + port).
- No privileged coordinator role. Whoever you type into coordinates *de facto*; all instances are symmetric peers.
- No mesh routing/forwarding beyond direct sends (a hop cap only guards accidental reply chains).
- None of pi-multiagent's hierarchical machinery: no DAG scheduler / per-step limits, no capability/authority matrix gating peers (the **fence** — data, not instructions — is the boundary; peers already hold their own full top-level authority), no blocking delivery-ack, no manifest artifact-fortress, no `steer`/`follow_up` child-control channels. See **Robustness refinements** for the subset that IS borrowed.

## Architecture

### Rendezvous & workspace scope

- **Workspace** = the project root via `findProjectRoot(cwd)` (nearest `.git` else `cwd`) — the same resolution pi-persona already uses. Two instances in the same repo share a workspace and discover each other; `cwd` differences within one repo do not split them.
- **Registry layout** under `<agentDir>/pi-persona/exocom/<workspace-hash>/`:
  - `agents/<name>.json` — one entry per live instance (atomic temp-then-rename write).
  - `sockets/<session_id>.sock` (POSIX) — the per-instance endpoint. Windows: named pipe `\\.\pipe\pi-persona-exocom-<session_id>`.
  - `<workspace-hash>` = `sha256(projectRoot).slice(0,24)` (pi-persona's slug convention).
- Optional `--exocom-project <name>` to group beyond the folder (future-friendly; default = the workspace hash).

### Lifecycle (session_start, only when enabled)

1. Resolve identity (below).
2. Bind the instance's own socket/pipe, reusing the broker's stale-socket reclaim (`attemptListen`/`isConnectable`: unlink only a socket provably not connectable; never a live one).
3. Write the registry entry atomically.
4. Start three unref'd timers:
   - **heartbeat (~30 s):** re-write the entry with live status (context %, **active persona**, inbox depth, `heartbeat_at`), self-heal if the file vanished, and reflect a runtime `/persona` switch.
   - **prune:** remove dead entries — `process.kill(pid, 0)` (ESRCH ⇒ dead), plus a socket-connectable probe as a second signal (guards pid reuse).
   - **pool refresh:** ping live peers for the widget's agent cards.
5. Clean shutdown (session_shutdown / SIGINT / SIGTERM): stop timers, close the server, unlink the socket, remove the registry entry.

### Envelopes (line-delimited JSON, reusing `framing.ts`)

- `message` — `{ msg_id, from_session, from_endpoint, from_name, text, in_reply_to?, hops, ts }`. A **reply** is just a `message` with `in_reply_to` set (one path for send + reply). `from_name` is display metadata only — **never trusted for attribution** (see fencing).
- `ping` / `pong` — liveness + an "agent card" (name=persona, model, context %, inbox depth) for the pool.
- `ack` / `nack` — transport-level handshake.

## Identity — from the active persona

- `name` = the active persona name (`elite` / `judge` / `dev`) + a collision suffix resolved against live registry entries (`elite`, `elite2`, …). If **no persona** is active → `pi-<6 hex of session_id>`. Override with `--exocom-name`.
- `purpose` = the persona's description; `color` = the persona's label colour.
- Refreshed on a `/persona` switch via the heartbeat, so the pool always shows the **current** persona, never a stale one.

## Tools (2)

### `exocom_list`
List peer instances in the workspace. Per peer: `name` (= persona), model, live context %, purpose, alive. `project="*"` scans all workspaces (rare).

### `exocom_send`
`{ target, message, in_reply_to? }`. Sends `message` to `target` — a peer `name`, or `"*"` to broadcast to all live peers. **Non-blocking**; returns `msg_id` once the receiver acks. If `in_reply_to` is set, it is a **correlated reply** to a message this instance received (labels the follow-up on the original sender's side). Throws if the target is unreachable.

*(No `exocom_await` — replies are async follow-ups. No separate reply tool — `in_reply_to` on `exocom_send` is the reply.)* Optional `exocom_inbox` (review/ack received messages, like intercom inbox) may be added if cheap; the fenced follow-up delivery covers the MVP without it.

## Collaboration flow (the headline UX)

1. You type a task in **elite**. elite: `exocom_send(target:"dev", message:"audit src/auth for injection; report file:line")` → `msg_id M1`, non-blocking; elite keeps working or ends its turn.
2. **dev** receives a **fenced** follow-up: `[exocom] message from <resolved: dev-peer elite> — reply with in_reply_to=M1:` + fenced text → this triggers dev's next turn; dev audits with its own tools.
3. dev: `exocom_send(target:"elite", message:"2 issues: auth.ts:31 …, auth.ts:88 …", in_reply_to:"M1")`.
4. **elite** receives a fenced follow-up correlated to M1: `[exocom] reply from dev to your M1:` + fenced text → elite continues (fix, synthesise, or hand off). No blocking anywhere; the whole exchange is event-driven, exactly like async-run completions.

## Inbound delivery, fencing & guardrails (the security core)

- Every inbound `message` is delivered with `attributeInbound(resolvedLabel, text)` + `fenceUntrusted` — **attribution outside the fence, text inside**. `resolvedLabel` is derived from the **registry entry keyed by the connecting session/endpoint**, never from the envelope's self-reported `from_name` ⇒ a peer cannot spoof authority (e.g. claim to be "your supervisor").
- Delivery uses the existing `IdleCoalescingNotifier`: only to an idle, unqueued supervisor, never mid-stream — the same discipline as async completions and timer wakes.
- **Trigger-on-inbound:** an inbound message triggers the receiver's next turn — this is what makes "see them work together" happen. Because it is a *remote* turn-trigger, it is bounded:
  - **Opt-in on both ends** + `canUseBus` gate.
  - **Hop cap** — a `message` carries `hops`, incremented on a correlated send; dropped past `MAX_HOPS` (default 6). Bounds accidental A→B→A→… loops.
  - **Per-sender inbound rate limit** — a small token bucket per `from_session`; a chatty or looping peer cannot force unbounded turns.
  - All instances are the user's **own local, opted-in** processes (lower trust distance than a network peer), but the fence + caps still apply as defence in depth.

## Reply correlation

- `exocom_send` records a pending correlation `{ msg_id → { target, created_at } }` (bounded map, 30-min TTL). It is **not** a blocking promise — purely for labelling.
- An inbound `message` whose `in_reply_to` matches a local pending id is delivered as a "reply to M" follow-up; an inbound with no/unknown `in_reply_to` is a fresh message. A broadcast `msg_id` may receive several correlated replies (each delivered); the pending entry is TTL-expired, not first-reply-cleared.

## Activation & gating

- Enabled when `PI_PERSONA_EXOCOM` is set truthy (`=1`, mirroring `PI_PERSONA_BROKER`) **or** `--exocom` is passed. `--exocom` is declared via `pi.registerFlag` at load so pi's parser accepts it; read at session_start.
- Additionally requires the active persona's `canUseBus` capability. No persona / no capability ⇒ the exocom tools are not registered and no plane is started.
- OFF ⇒ no bind, no registry, no tools; the flag declaration is inert.

## UI

- A **pool widget** (reusing the coms/agent-overlay pattern): one row per peer — coloured swatch, `name` (= persona), model, a context-usage bar, purpose. Placed below the editor / in the `f9` overlay.
- `/exocom` command: refresh the pool; `--all` / `--project <name>` scope toggles.
- Status line: `📡 exocom · <name>@<workspace> · N peers`.

## Coexistence with the hierarchy plane

exocom is a **separate plane**; it never touches the delegate / council / broker path. A single instance can be **both** a supervisor (delegating ephemeral children via intercom/broker) **and** an exocom peer (collaborating with sibling instances) — the planes are independent and independently gated. Documented crisply in `ARCHITECTURE.md`: *intercom/contact_peer = within one supervisor's run; exocom = between independent supervisors.*

## Reused primitives (already in the codebase)

- Socket bind + stale reclaim + liveness probe — `src/bus/broker/host.ts` (`attemptListen`/`isConnectable`).
- Cross-OS endpoint naming — `src/bus/broker/paths.ts` (swap the `sessionId` key for a workspace key).
- Wire framing + structural validators — `src/bus/broker/framing.ts`, `messages.ts`.
- Idle-coalesced delivery — `IdleCoalescingNotifier` (`src/engine/async.ts`).
- Fence + attribution — `src/core/fence.ts` (`fenceUntrusted`, `attributeInbound`).
- Persona identity + capability gate — `src/persona/*`, `canUseBus` (`src/core/capabilities.ts`).
- Project-root resolution — pi-persona's `findProjectRoot`.

**New building blocks to add** (present in coms, absent in the broker): pid-liveness prune + heartbeat, the workspace-keyed self-registration registry, and persona-derived identity.

## Modules / files

- `src/exocom/registry.ts` — **pure:** entry type, atomic read/write, prune (pid + connectable), unique-name resolution.
- `src/exocom/envelope.ts` — **pure:** envelope types + validators + hop/correlation helpers.
- `src/exocom/plane.ts` — bind/serve/point-to-point send/inbound wiring over `framing` + `fence`; ping/pong pool. (I/O lives here, thin over the pure modules.)
- `src/tools/exocom.ts` — `exocom_list` + `exocom_send` (+ optional `exocom_inbox`), registered only when enabled.
- `src/extension.ts` — opt-in gate (env/flag/canUseBus), identity from the active persona, wire plane + notifier + widget + `/exocom` command + shutdown.
- Docs — `ARCHITECTURE.md` (a new "exocom — external plane" section), `README.md` (env + a short "collaborate across instances" blurb), `AGENTS.md` (the plane distinction).

## Robustness refinements (adopted from pi-multiagent — MVP-scaled)

Analysed `Tiziano-AI/pi-multiagent` (a hierarchical DAG orchestrator — a *different* axis). It does **not** change exocom's core; these are the robustness patterns worth borrowing, all leaving the flat / one-way / non-blocking / registry-attributed / fenced model intact. Scale every cap to an **interactive** plane (small), not pi-multiagent's day-scale detached runs.

- **R1 — inbound injection cap.** Head-truncate an inbound `message` to a small size (~8 KB / ~200 lines) with a `[truncated N chars]` notice *before* it enters the receiver's turn — a second, much smaller cap than the framing DoS guard (16 MiB), so a peer can't flood/derail another's context. (pmulti `result-truncation.ts`.)
- **R2 — per-sender cumulative budget.** Alongside the rate limit + hop cap, a per-sender budget (count + bytes per window), so a slow drip *under* the rate limiter still can't accumulate unbounded wakeups/bytes. (mirrors exocom's own sender-side `MAX_PEER_SENDS`; pmulti `rpc-parent-message-budget.ts`.)
- **R3 — large-payload handoff via artifact.** If a `message` exceeds an inline threshold (~12 KB), spill the full text to a workspace-scoped temp file and send `{ preview, path }`; the receiver reads the path on its own turn. Small message, no blocking. Lightweight (bounded preview + a containment check) — **not** pmulti's full manifest fortress. (pmulti `step-output-artifact.ts`.)
- **R4 — classify + single reconnect on send.** On send, classify the socket error: a *peer-restarting* error (`ECONNREFUSED`/`ENOENT`) gets ONE reconnect attempt; *peer-gone* prunes the entry. No backoff loop. (discipline from pmulti `transport-retry-policy.ts`.)
- **R5 — fail-closed envelope preflight.** An `isExocomFrame` structural validator rejects malformed / unknown-field / wrong-typed frames at ingress, before attribution/fence/delivery. (mirrors broker `isFrame` + pmulti `preflight-shape.ts`.)
- **R6 — delivery min-interval + notice ceiling.** Give the `IdleCoalescingNotifier` a `minIntervalMs` floor and a per-session `maxDeliveries` ceiling, so a chatty peer's N notes become a bounded, coalesced trickle, not N receiver turns. (pmulti `run-notifier.ts`.)
- **R7 — registry hygiene.** `unref()` the heartbeat/prune timers; add a stale-heartbeat TTL eviction (drop entries whose heartbeat is older than K intervals even when the cross-namespace pid check is inconclusive); emit a `bye` on clean exit so peers deregister promptly. Prevents ghost entries (the same class as the v1.6.3 ghost-run fix). (pmulti `detached-run.ts` retention.)
- **R8 — (sender, msg_id) dedup.** A small receiver-side dedup set keyed by `(from_session, msg_id)`, so a re-sent frame (R4's reconnect) can't double-trigger a turn — makes at-least-once send idempotent at the receiver. (pmulti `message-idempotency.ts`.)

These fold into the existing sections: R1/R2/R5/R6/R8 into *Inbound delivery & guardrails*; R3/R4 into *exocom_send*; R7 into *Lifecycle*.

## Deferred — ideas for pi-persona's EXISTING delegation/flow (separate axis, NOT exocom)

pi-multiagent is the same axis as pi-persona's `delegate`/`council`/`flow`, so these are notes for a **future** pass, explicitly out of exocom's scope:

- **D1** — declarative per-graph **authority matrix** (`allowFilesystemRead/Shell/Mutation/ExtensionCode`) for delegate/flow legs → `src/tools/delegate.ts`, `src/orchestration/flow.ts`.
- **D2** — tool-catalog provenance + duplicate-name **ambiguity diagnostics** for dynamic `skills`/`tools` routing → delegate dynamic-agent construction.
- **D3** — flow-graph authoring **repair hints** (concrete "move X under Y") → `src/orchestration/flow.ts` validator.
- **D4** — stalled-step **"why not runnable"** (unmet `needs`/`after` with statuses) → `src/orchestration/flow-run.ts`.
- **D5** — per-leg **output byte-cap + artifact spill** in leg aggregation → `src/orchestration/reducers.ts`, `flow-run.ts`.
- **D6** — **notify modes** (`none|final|milestones`) + terminal-retention for async runs → `src/engine/async.ts` (a refinement of the peek/check-in UX).
- **D7** — single evidence-gated **transport retry for delegate legs** (idempotent read-only 502/ECONNRESET) — retry belongs on the leg runner, not on exocom peers → delegate leg runner.

## Testing

- `test/unit/exocom/registry.test.ts` — write/read/prune/unique-name, pid-liveness, atomic write, self-heal.
- `test/unit/exocom/envelope.test.ts` — validators, hop increment/cap, correlation match.
- Anti-spoof: inbound attribution is resolved from the registry, never from the envelope's `from_name`.
- A Pi-surface smoke test (mock pi) for tool registration under the opt-in gate + persona identity.
- Pure-first / TDD, matching pi-persona's conventions (tabs, erasable-syntax TS, `node --test`, strict `tsc`).

## Known limitations (accepted for MVP)

- **Windows named-pipe ACLs** are default (any local user can connect) — the same residual pi-persona's broker already has; documented, not a regression. POSIX socket dir is `0700`.
- pid-reuse can briefly resurrect a dead entry until the connectable probe prunes it.
- Same-machine only (cross-device is the future `exocom-net`).
