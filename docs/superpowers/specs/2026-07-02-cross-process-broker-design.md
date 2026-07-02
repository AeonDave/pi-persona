# Cross-process bus broker (v0.5) — design

**Date:** 2026-07-02 · **Status:** approved · **Scope:** comm plane + steer for CHILD-PROCESS
sub-agents (the `PI_PERSONA_ENGINE=child` engine and every `isolation: worktree` leg, which
always runs through it). Port source: `D:\Sources\pi-subagents-comtac` (audited 2026-07-02 —
transport/protocol layers are pure, tested, ~570 LOC; the Pi-integration layer is NOT ported,
it is re-integrated into pi-persona's own seams).

## 1. Problem

In-process children enjoy the full comm plane (contact_supervisor, contact_peer, delivery
bridge, live steer). Child-PROCESS children have NONE of it: `pi -p` reads stdin to EOF before
starting (no channel), pi-persona self-disables inside them (fork-bomb guard), and steer is
impossible — the f9 `s` key and `intercom steer` silently do not apply. Worktree isolation
always uses the child engine, so every isolated leg (e.g. `compete` competitors) is mute and
unsteerable. The guardrails planned exactly this milestone: "v0.5+ … cross-process broker",
"comtac code is the port source".

## 2. Decisions (user-approved)

| # | Decision | Rationale |
|---|----------|-----------|
| B1 | **Session-scoped endpoint, supervisor-hosted.** POSIX: `~/.pi/agent/pi-persona/broker-<sessionId>.sock` · Windows: `\\.\pipe\pi-persona-<sanitized-home>-<sessionId>`. The SUPERVISOR is always the host; children only connect. NO host election (drop comtac's 12-attempt loop — its global per-user bus needed it; a per-session bus does not). Stale-socket reclaim on create (POSIX: unlink if not connectable); `unref()`d server; permanent error sink. | Two concurrent supervisors must never share a bus (handle collisions, peer-scope leaks). Election removal deletes the most delicate comtac code path. |
| B2 | **The broker is a RELAY into the local `InProcessBus`.** On a child's `register(handle)` the host registers a PROXY participant on the local bus; envelopes addressed to remote handles are drained (`takeWhere`, mirroring the in-process delivery bridge) and forwarded as frames; incoming child frames become normal local bus traffic (`send` → `bus.send`; a blocking ask → the host runs `bus.ask` ON BEHALF of the remote child and sends the reply frame back when the supervisor answers). | The supervisor side (intercom, idle notifier, peek, f9) does not change BY CONSTRUCTION — remote children are indistinguishable from local ones. This is the "same surface" promise in `bus/inproc.ts`'s header, kept literally. |
| B3 | **Child side = bridge-only extension mode.** The child engine spawns with `PI_PERSONA_BUS=<endpoint>` + `PI_PERSONA_HANDLE=<handle>` (in addition to today's `PI_PERSONA_DISABLE=1`/`PI_PERSONA_CHILD=1`). When `PI_PERSONA_BUS` is set, the extension loads ONLY the bridge: broker client (connect w/ backoff, register), `contact_supervisor` + `contact_peer` bound to the wire, inbound messages surfaced as **fenced, attributed follow-ups** (`pi.sendMessage`, comtac's mechanism; same `fenceUntrusted`, attribution outside the fence). No personas, no delegate/council, no input hooks — the fork-bomb guard stays intact. | One env var flips a mute child into a connected one; the orchestration surface stays sealed. |
| B4 | **Steer frames.** With the broker active, the child-engine adapter exposes `onSteerable`: steer(text) → a `steer` frame → the bridge surfaces it as a follow-up attributed to the supervisor. `intercom steer` and the f9 `s` key then work uniformly on BOTH engines. Steer-for-child is queued-turn semantics (follow-up), not mid-turn injection — documented, same as comtac. | The single biggest capability gap closed; worktree legs become steerable. |
| B5 | **Opt-in, default OFF.** `PI_PERSONA_BROKER=1` (env) or `broker: true` (config). Off ⇒ the child engine spawns exactly as today (no env vars, no host, zero behavior change). On ⇒ the extension starts the host lazily on first child-engine spawn and tears it down on session end. | "È a scelta, il default rimane tale." |
| B6 | **Protocol: comtac framing verbatim, message set slimmed to pi-persona semantics.** 4-byte BE length + UTF-8 JSON, 16 MiB cap, poisoned-on-error reader (port `framing.ts` as-is + its fuzz tests). Messages: `register/registered`, `send` (envelope: `id, from, to, kind, text, expectsReply`), `reply` (askId + text), `steer`, `list`/`peers` (engine-scoped peer roster for the child's `contact_peer list`), `error`, `bye`. DROP comtac's presence/sessions/attachments/broadcasts (YAGNI — no inter-session roster here). | Keep the proven wire format; delete the product surface pi-persona doesn't need. |
| B7 | **Peer scoping across the wire.** When a child-engine run has `peers: true` (and `canUseBus`), the adapter registers `handle + label (roleHint) + engine-instance group` with the host; `list` frames are answered from that registry (same per-engine-instance scoping rule as in-process — deviation 1 of the peer-comm plan, now spanning both engines). The send budget stays in the child-side tool. | Same isolation guarantee in both worlds; `map`/`debate`/`pair` on worktree legs regain live exchange with zero strategy changes. |

## 3. Components (target layout)

- `src/bus/broker/paths.ts` — endpoint naming (B1), session-id sanitisation; pure.
- `src/bus/broker/framing.ts` — comtac port, unchanged semantics; pure.
- `src/bus/broker/messages.ts` — the B6 frame catalog + validators; pure.
- `src/bus/broker/host.ts` — the supervisor-side server + relay (B2): net server (unref'd,
  stale reclaim), per-connection registration, proxy registration on the injected
  `InProcessBus`, outbound drain (onMessage + takeWhere), ask brokering, peer-roster answers
  (B7), teardown (close → unregister proxies). Pure over injected `net`-like + bus (testable
  with a loopback pair; integration test over a real socket/pipe).
- `src/bus/broker/client.ts` — comtac client port slimmed: connect with capped exponential
  backoff, register, frame send/receive, reply correlation for blocking asks (10-min cap,
  mirrors `bus.ask`), clean `bye` on dispose. Pure over an injected socket factory.
- `src/bridge.ts` (or `src/child-bridge.ts`) — the child-mode wiring (B3): env detection,
  client lifecycle on `session_start`/`session_shutdown`, `pi.registerTool` of the two wire
  tools, inbound → fenced follow-up. Loaded INSTEAD of the full extension when
  `PI_PERSONA_BUS` is set (the factory checks env before anything else).
- `src/engine/adapter.ts`/`child.ts` — when the broker is on: mint the handle (same
  `agent#seq` scheme), pass env vars, register peer-group data with the host, expose
  `onSteerable` (B4), unregister on settle.
- `src/extension.ts` — the `PI_PERSONA_BROKER` flag (B5), lazy host startup, session-end
  teardown, doctor line (endpoint + connected children).

## 4. Error handling

- Child cannot connect (host gone, flag off in parent, race): capped retries, then the bridge
  logs once and the child runs EXACTLY as today (mute executor) — never a crash, never a hang.
- Frame errors: poisoned reader per comtac; the offending connection is dropped and its proxy
  unregistered (its peers see "gone", inherited semantics).
- Host death mid-run: children keep executing (their work does not depend on the bus); sends
  report undelivered; blocking asks time out with the standard "no reply" result.
- The host never keeps Pi alive (`unref`) and never crashes the supervisor (error sink);
  teardown is idempotent.
- Security posture unchanged from comtac (same-user trust domain, endpoint under the user's
  home); the session-id namespace additionally prevents same-user cross-session mixing. No
  auth token in v1 — documented explicitly.

## 5. Testing

- Port comtac's suite shape: framing fuzz (partial frames, oversize, garbage), broker
  round-trip over a REAL socket/pipe (register → send → reply → steer → bye), reply
  correlation + timeout, stale-socket reclaim, unref/teardown.
- Host relay unit tests against a real `InProcessBus`: proxy registration, outbound drain
  forwards supervisor sends, ask brokering resolves on `bus.reply`, peer-roster scoping.
- Bridge unit tests with a fake `pi`: env detection, tool binding, fenced follow-up format
  (attribution outside the fence), connect-failure degradation.
- Adapter tests: env vars passed only when the flag is on; steer plumbed; handle unregistered
  on settle.
- Live drive: `PI_PERSONA_BROKER=1 PI_PERSONA_ENGINE=child npm run drive -- …` — steer a
  child-process run, watch contact_supervisor traffic, then a worktree `compete` leg
  reporting progress (manual, human-run).

## 6. Out of scope

- Inter-session intercom (comtac's original product) — the endpoint is deliberately
  per-session; the protocol would allow it later.
- Mid-turn steer injection in children (follow-up semantics only, comtac's mechanism).
- Auth tokens / multi-user hardening (same-user trust domain, as comtac).
- `context: fork` for children — unrelated deferral, stays deferred.
- AGENTS.md "Boundaries" update happens IN this wave (the broker is no longer deferred), but
  the legacy-repo warning about `pi-subagents-comtac` paths stays.
