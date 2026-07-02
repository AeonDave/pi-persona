# Cross-Process Bus Broker (v0.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give child-PROCESS sub-agents the full comm plane + live steer by porting the `pi-subagents-comtac` broker into pi-persona as a session-scoped relay over the existing `InProcessBus` — opt-in (`PI_PERSONA_BROKER=1`), default OFF and zero behavior change — per the approved spec `docs/superpowers/specs/2026-07-02-cross-process-broker-design.md`.

**Architecture:** New `src/bus/broker/` package: pure `paths`/`framing`/`messages` (ported from comtac, framing verbatim, messages slimmed), a `host` that RELAYS wire frames into the injected `InProcessBus` (so the whole supervisor side is unchanged by construction), and a `client` (slimmed comtac port). A child-mode `src/bridge.ts` is loaded INSTEAD of the full extension when `PI_PERSONA_BUS` is set. The child engine passes env + exposes `onSteerable` via a steer frame; the extension owns the flag, lazy host startup, and teardown.

**Tech Stack:** TypeScript (erasable-syntax-only, tsc strict), node:net, node:test + tsx. Port source (READ-ONLY reference): `D:\Sources\pi-subagents-comtac\src` — audited; framing/protocol/broker/client layers are pure Node net + JSON with no Pi imports.

## Global Constraints

- Spec is binding: `docs/superpowers/specs/2026-07-02-cross-process-broker-design.md` (decisions B1–B7).
- The port SOURCE is `D:\Sources\pi-subagents-comtac` — read the named files and adapt; do NOT add it as a dependency, do NOT copy its Pi-integration layer (`index.ts`, `tools/`), and do NOT touch that repo.
- **Default OFF is sacred:** with `PI_PERSONA_BROKER` unset the child engine must spawn EXACTLY as today (no new env vars passed, no host started). A test pins this.
- Cross-OS: use `node:net` (works for both Unix socket path and Windows `\\.\pipe\…`); every platform branch mirrors comtac's (`paths.ts`, `embedded.ts` stale-reclaim). Attach an `error` listener to every socket/server (an unhandled `error` event crashes the host).
- `src/bus/broker/{paths,framing,messages}.ts` stay pure (no Pi imports). `host.ts`/`client.ts` import only `node:net` + the pure modules + `bus/inproc.ts` types.
- tsconfig strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `noUnusedLocals` + `noUnusedParameters`. Never assign a possibly-`undefined` value to an optional property — conditional spread or guarded assignment.
- Erasable-syntax-only TS. TABS in all `src/` and `test/` files.
- Commands: typecheck `npm run typecheck` · one file `node --import tsx --test <path>` · full `npm test`. Suite ends 0 fail, exactly 1 intentional skip. Known load-sensitive flake: `test/integration/child-engine.test.ts` idle-timeout — if it fails in a full run, re-run that file in isolation to confirm; do not chase it.
- New socket/pipe integration tests are Windows-sensitive; gate a genuinely flaky one with the same skip pattern the repo already uses (`test/integration/child-engine.test.ts`) and note it — do NOT leave a flaky test ungated.
- Commit with explicit pathspecs (`git add <files> && git commit -m "…" -- <files>`), never bare `git commit`. Every message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `paths.ts` + `framing.ts` (pure ports)

**Files:**
- Create: `src/bus/broker/paths.ts`
- Create: `src/bus/broker/framing.ts`
- Create: `test/unit/bus/broker/paths.test.ts`
- Create: `test/unit/bus/broker/framing.test.ts`
- Reference (read-only): `D:\Sources\pi-subagents-comtac\src\broker\paths.ts`, `…\src\protocol\framing.ts` and their tests under `…\test\`.

**Interfaces:**
- Produces: `export function brokerEndpoint(sessionId: string, home?: string, platform?: NodeJS.Platform): string` — POSIX `~/.pi/agent/pi-persona/broker-<sessionId>.sock`; Windows `\\.\pipe\pi-persona-<sanitized-home>-<sessionId>`. `home`/`platform` injectable for tests.
- Produces: `export function sanitizeSegment(s: string): string` (lowercase, `[^a-z0-9-]`→`-`, collapse repeats).
- Produces (framing): `export function encodeFrame(obj: unknown): Buffer` (4-byte BE length + UTF-8 JSON); `export function createFrameReader(onFrame: (obj: unknown) => void, onError: (e: Error) => void): (chunk: Buffer) => void` (accumulating, greedy, 16 MiB cap `MAX_FRAME_BYTES`, poisoned-on-error).

- [ ] **Step 1: Write failing tests**

`test/unit/bus/broker/paths.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { brokerEndpoint, sanitizeSegment } from "../../../../src/bus/broker/paths.ts";

test("sanitizeSegment lowercases and replaces non-alphanumerics with hyphens", () => {
	assert.equal(sanitizeSegment("/Users/Alice"), "-users-alice");
	assert.equal(sanitizeSegment("C:\\Users\\Bob 2"), "c-users-bob-2");
});

test("brokerEndpoint is a per-session windows pipe / posix socket", () => {
	const win = brokerEndpoint("sess1", "C:\\Users\\Bob", "win32");
	assert.match(win, /^\\\\\.\\pipe\\pi-persona-.*-sess1$/);
	const posix = brokerEndpoint("sess1", "/home/bob", "linux");
	assert.equal(posix, "/home/bob/.pi/agent/pi-persona/broker-sess1.sock");
});

test("distinct sessions get distinct endpoints (no cross-session bus)", () => {
	assert.notEqual(brokerEndpoint("a", "/home/x", "linux"), brokerEndpoint("b", "/home/x", "linux"));
});
```

`test/unit/bus/broker/framing.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { createFrameReader, encodeFrame } from "../../../../src/bus/broker/framing.ts";

test("encode/decode round-trips an object across arbitrary chunk splits", () => {
	const frames: unknown[] = [];
	const read = createFrameReader((o) => frames.push(o), () => assert.fail("no error expected"));
	const buf = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "two" })]);
	for (let i = 0; i < buf.length; i++) read(buf.subarray(i, i + 1)); // one byte at a time
	assert.deepEqual(frames, [{ a: 1 }, { b: "two" }]);
});

test("a length header over the 16 MiB cap is rejected via onError and poisons the reader", () => {
	let err: Error | undefined;
	const frames: unknown[] = [];
	const read = createFrameReader((o) => frames.push(o), (e) => (err = e));
	const bad = Buffer.alloc(4);
	bad.writeUInt32BE(17 * 1024 * 1024, 0);
	read(bad);
	assert.match(err?.message ?? "", /too large/);
	read(encodeFrame({ ok: 1 })); // poisoned → dropped
	assert.equal(frames.length, 0);
});

test("malformed JSON payload triggers onError once, not a throw", () => {
	let calls = 0;
	const read = createFrameReader(() => assert.fail("no frame"), () => (calls += 1));
	const head = Buffer.alloc(4);
	const body = Buffer.from("{not json", "utf8");
	head.writeUInt32BE(body.length, 0);
	read(Buffer.concat([head, body]));
	assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test test/unit/bus/broker/paths.test.ts test/unit/bus/broker/framing.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `paths.ts`**

Port comtac `paths.ts` semantics (audit: Windows `\\.\pipe\pi-comtac-<home>`, POSIX `~/.pi/agent/comtac/broker.sock`), changing the product name to `pi-persona` and adding the `-<sessionId>` suffix (POSIX: a per-session `.sock` filename; Windows: a pipe-name segment):

```ts
/**
 * Session-scoped broker endpoint — the supervisor hosts one bus PER SESSION, so two
 * concurrent supervisors never share it (spec B1). Windows uses a named pipe, every other
 * platform a Unix domain socket under the user's Pi dir. Pure (home/platform injectable).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function sanitizeSegment(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function brokerEndpoint(sessionId: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
	const sid = sanitizeSegment(sessionId) || "default";
	if (platform === "win32") return `\\\\.\\pipe\\pi-persona-${sanitizeSegment(home)}-${sid}`;
	return join(home, ".pi", "agent", "pi-persona", `broker-${sid}.sock`);
}
```

Keep the leading `-` behaviour matched by the test (`sanitizeSegment("/Users/Alice")` → `-users-alice`? — NO: the impl above strips a leading `-`. FIX the test's first assertion to `"users-alice"` and `"c-users-bob-2"`, i.e. adjust the expected values to the implementation you ship; the point is determinism + collision-freedom, not a specific leading char. Make test and code agree.)

- [ ] **Step 4: Implement `framing.ts`**

Port comtac `framing.ts` verbatim in behaviour (4-byte BE length prefix, `MAX_FRAME_BYTES = 16 * 1024 * 1024`, buffer accumulation, greedy frame emit, `poisoned` flag set on first error, subsequent data dropped). Public surface = `encodeFrame(obj)` and `createFrameReader(onFrame, onError)`:

```ts
/**
 * Length-prefixed JSON framing (ported from pi-subagents-comtac): a 4-byte big-endian
 * length header + a UTF-8 JSON payload. A reader accumulates chunks, emits complete frames
 * greedily, caps a single frame at 16 MiB (DoS guard), and POISONS itself on the first
 * error (oversize / bad JSON) — the caller destroys the socket. Pure, identical on all OSes.
 */

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(obj: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length, 0);
	return Buffer.concat([head, body]);
}

export function createFrameReader(onFrame: (obj: unknown) => void, onError: (e: Error) => void): (chunk: Buffer) => void {
	let buf = Buffer.alloc(0);
	let poisoned = false;
	return (chunk: Buffer): void => {
		if (poisoned) return;
		buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
		for (;;) {
			if (buf.length < 4) return;
			const len = buf.readUInt32BE(0);
			if (len > MAX_FRAME_BYTES) {
				poisoned = true;
				onError(new Error(`broker frame too large (${len} bytes)`));
				return;
			}
			if (buf.length < 4 + len) return;
			const body = buf.subarray(4, 4 + len);
			buf = buf.subarray(4 + len);
			try {
				onFrame(JSON.parse(body.toString("utf8")));
			} catch (e) {
				poisoned = true;
				onError(e instanceof Error ? e : new Error(String(e)));
				return;
			}
		}
	};
}
```

- [ ] **Step 5: Run tests → pass; typecheck; commit**

Run: `node --import tsx --test test/unit/bus/broker/paths.test.ts test/unit/bus/broker/framing.test.ts` → PASS. Run `npm run typecheck` → clean. Run `npm test` → 0 fail.

```bash
git add src/bus/broker/paths.ts src/bus/broker/framing.ts test/unit/bus/broker/paths.test.ts test/unit/bus/broker/framing.test.ts
git commit -m "feat(broker): session-scoped endpoint paths + length-prefixed framing (comtac port)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- src/bus/broker/paths.ts src/bus/broker/framing.ts test/unit/bus/broker/paths.test.ts test/unit/bus/broker/framing.test.ts
```

---

### Task 2: `messages.ts` — the slimmed frame catalog + validators

**Files:**
- Create: `src/bus/broker/messages.ts`
- Create: `test/unit/bus/broker/messages.test.ts`
- Reference: `D:\Sources\pi-subagents-comtac\src\protocol\messages.ts` (audit §2: 13 types) — pi-persona keeps only what B6 lists.

**Interfaces:**
- Produces a discriminated union `Frame` and a validator `isFrame(x): x is Frame`. Frame types (B6), each `{ t: "<type>", … }`:
  - client→host: `register {handle, label?, group?, peers?: boolean}` · `send {to, kind, text, msgId, expectsReply}` · `reply {askId, text}` · `list {reqId}` · `bye`
  - host→client: `registered {handle}` · `deliver {from, fromLabel?, kind, text, msgId, expectsReply}` · `steer {text}` · `peers {reqId, peers: Array<{handle, label}>}` · `replied {askId, text}` · `error {reason}`
  - `kind` is the bus `MsgKind` (`"progress" | "decision" | "interview"`), imported as a TYPE from `../inproc.ts`.

- [ ] **Step 1: Write failing tests** — construct one of each frame, assert `isFrame` accepts it; assert `isFrame` rejects `{t:"nope"}`, a `send` missing `to`, a non-object, and a `deliver` with a numeric `text`. (Write the full test body: one `assert.equal(isFrame(x), true/false)` per case — no loops that hide which case failed.)

- [ ] **Step 2: Run → fail (module missing).**

- [ ] **Step 3: Implement** the union as a flat `type Frame = … | …` (erasable syntax — NO enum), a per-type field-shape check in `isFrame` (mirror comtac's `isMessage`/`isSessionRegistration` structural checks: every required string is `typeof === "string"`, every optional is absent-or-correct-type). Import `MsgKind` as a type only. Keep it pure.

- [ ] **Step 4: Run → pass; typecheck; commit** (`feat(broker): slimmed wire-frame catalog + validators`).

---

### Task 3: `host.ts` — the relay into `InProcessBus`

**Files:**
- Create: `src/bus/broker/host.ts`
- Create: `test/unit/bus/broker/host.test.ts`
- Reference: comtac `broker/broker.ts` (registry/router) + `broker/embedded.ts` (listen, stale reclaim, unref).

**Interfaces:**
- Consumes: `InProcessBus` (`register`/`unregister`/`send`/`ask`/`reply`/`takeWhere`/`onMessage`/`participants` — from `src/bus/inproc.ts`), `encodeFrame`/`createFrameReader`, `isFrame`/`Frame`, `brokerEndpoint`.
- Produces: `export interface BrokerHost { endpoint: string; close(): Promise<void>; connectedHandles(): string[] }` and `export async function startBrokerHost(deps: { bus: InProcessBus; supervisorHandle: string; endpoint: string; net?: typeof import("node:net"); listPeersFor?: (group: string, self: string) => Array<{handle:string;label:string}> }): Promise<BrokerHost>`.
- Behaviour (B2/B7): on `register`, `bus.register(handle)` + record the connection + (if `peers`) record `{handle,label,group}` in a peer registry; subscribe to `bus.onMessage` and, for each envelope whose `to` is a connected remote handle, drain via `bus.takeWhere` and write a `deliver` frame (blocking asks: the host calls `bus.ask` semantics — see below). On a client `send` frame → `bus.send(from, to, text, kind)`; if `expectsReply`, the host registers a pending mapping so the eventual `bus.reply`/local answer produces a `replied` frame back. On `reply` frame → `bus.reply(askId, text)`. On `list` → answer a `peers` frame from `listPeersFor(group, self)`. On `bye`/socket close → `bus.unregister(handle)`, drop peer entry, remove connection. Server `unref()`; permanent `error` sink; POSIX stale-socket reclaim before `listen` (port comtac `embedded.ts:103-114`, minus the 12-attempt election — the supervisor is the sole host).

- [ ] **Step 1: Write failing tests (loopback, real `InProcessBus`, fake `net`).** Inject a fake `net` whose `createServer`/`connect` are a paired in-memory duplex so the test needs no real socket. Cases: (a) a registered remote handle receives a `deliver` frame when the supervisor `bus.send`s to it; (b) a client `send` frame lands in the supervisor's bus inbox (`bus.take(supervisor)`); (c) a client `send{expectsReply}` → supervisor `bus.reply(askId,…)` → the client gets a `replied` frame; (d) `list` returns the peer registry via a `peers` frame; (e) socket close unregisters the handle (`bus.participants()` no longer lists it). If a faithful fake `net` is too heavy, implement the host over an injected minimal transport interface (`{listen, onConnection}` + a connection object with `write`/`onData`/`onClose`/`destroy`) and unit-test THAT; then Task 7's integration test exercises the real socket. Choose one and state it in the report.

- [ ] **Step 2–5:** fail → implement → pass → typecheck → commit (`feat(broker): host relay bridging wire frames into the in-process bus`).

---

### Task 4: `client.ts` — the child-side broker client

**Files:**
- Create: `src/bus/broker/client.ts`
- Create: `test/unit/bus/broker/client.test.ts`
- Reference: comtac `broker/client.ts` (connect, register, reconnect backoff 250ms–5s, reply correlation, clean disconnect) — slimmed to the B6 frames; DROP presence/list-timeout-roster/reconnect-storm extras not needed for a per-session child that lives < the run.

**Interfaces:**
- Produces: `export interface BrokerClient { register(): Promise<void>; send(to, kind, text): void; ask(to, kind, text, signal?): Promise<string>; reply(askId, text): void; list(): Promise<Array<{handle,label}>>; onDeliver(cb): void; onSteer(cb): void; close(): void }` and `export function makeBrokerClient(deps: {endpoint, handle, label?, group?, peers?: boolean, net?}): BrokerClient`.
- `ask` correlates a `send{expectsReply,msgId}` to a `replied{askId===msgId}` with the 10-minute cap (mirror `bus.ask`); honours an `AbortSignal`. `onDeliver`/`onSteer` fire on inbound `deliver`/`steer` frames. Same transport-injection choice as Task 3.

- [ ] **Step 1–6:** tests (connect+register handshake; send frame shape; ask resolves on a matching `replied`; ask rejects on abort and on timeout via an injected clock or a tiny cap; onDeliver/onSteer dispatch; close sends `bye`) → fail → implement → pass → typecheck → commit (`feat(broker): child-side broker client with reply correlation`).

---

### Task 5: `src/bridge.ts` — child-mode extension + factory dispatch

**Files:**
- Create: `src/bridge.ts`
- Modify: `src/extension.ts` (the ExtensionFactory: when `PI_PERSONA_BUS` is set, delegate to the bridge and return early — BEFORE any persona/tool wiring)
- Create: `test/unit/bridge.test.ts`
- Reference: comtac `child-bridge.ts` (env reading) + its `index.ts` inbound-surfacing (`pi.sendMessage` follow-up) + pi-persona `src/bus/contact.ts` (fence + tool shape) + `src/core/fence.ts`.

**Interfaces:**
- Produces: `export function isBridgeMode(env = process.env): boolean` (`!!env.PI_PERSONA_BUS`); `export function installBridge(pi, ctx, deps?): void` — connects a `BrokerClient` for `PI_PERSONA_HANDLE` to `PI_PERSONA_BUS`, registers `contact_supervisor` + `contact_peer` bound to the client (reuse the EXISTING tool factories where they take a transport-agnostic `send/ask/list`; if they are bus-bound today, add a thin adapter here — do NOT rewrite the tools), surfaces `onDeliver` frames as fenced+attributed follow-ups via `pi.sendMessage` (fence with `fenceUntrusted`, attribution OUTSIDE the fence, exactly like the in-process bridge), surfaces `onSteer` frames as a supervisor-attributed follow-up, and `close()`s on `session_shutdown`.
- Factory dispatch in `extension.ts`: at the very top of the factory, `if (isBridgeMode()) { /* register only the bridge on session_start */ return }` — the fork-bomb guard (`PI_PERSONA_DISABLE=1`) already prevents the full surface; this adds the connected bridge on top.

- [ ] **Step 1: Write failing tests** with a fake `pi` (records `registerTool`/`sendMessage`/`on`) and a fake `BrokerClient` (inject via `deps`): `isBridgeMode` true iff `PI_PERSONA_BUS` set; `installBridge` registers exactly `contact_supervisor` + `contact_peer`; an `onDeliver` frame produces a `pi.sendMessage` follow-up that CONTAINS the fenced payload with attribution outside the fence; `session_shutdown` calls `client.close()`.
- [ ] **Step 2–6:** fail → implement → pass → typecheck → full suite (the existing extension tests must still pass — bridge mode is only entered under the env var, which tests do not set) → commit (`feat(broker): child-mode bridge extension + factory dispatch`).

---

### Task 6: engine adapter wiring (env + handle + steer frame)

**Files:**
- Modify: `src/engine/adapter.ts` and/or `src/engine/child.ts` (whichever owns spawn env + the `AgentResult`/`onSteerable` seam)
- Modify: `src/engine/inproc.ts` NONE (in-process already has the bridge) — confirm untouched.
- Test: `test/unit/engine/adapter.test.ts` (extend)
- Reference: how `child.ts` builds `env` (today `PI_PERSONA_DISABLE`/`PI_PERSONA_CHILD`) and how `adapter.ts` maps the child run to `AgentResult`.

**Interfaces:**
- When the broker is ON (a `deps.broker?: { endpoint: string; register(info): void; unregister(handle): void; steerFrame(handle, text): void }` is passed by `buildEngine`): the adapter mints `handle = \`${agent}#${seq}\``, passes `PI_PERSONA_BUS=<endpoint>`, `PI_PERSONA_HANDLE=<handle>` (and, when `spec.peers`, `PI_PERSONA_PEERS=1`) in the child env, calls `deps.broker.register({handle, label, group, peers})` before spawn and `unregister(handle)` on settle, and implements `onSteerable((text) => deps.broker.steerFrame(handle, text))`. When the broker dep is absent, env + behaviour are EXACTLY as today (the default-OFF pin).
- Produces: `EngineAdapterDeps.broker?` (optional) — its concrete value is created in Task 7.

- [ ] **Step 1: Write failing tests** — with a fake spawn (the adapter already injects `resolveInvocation`): (a) broker absent ⇒ child env has NO `PI_PERSONA_BUS`/`PI_PERSONA_HANDLE` (default-OFF regression pin); (b) broker present ⇒ env carries both, `register` called before spawn with the minted handle, `unregister` on settle; (c) `onSteerable` handle routes to `deps.broker.steerFrame` with that handle. Assert against the fake spawn's captured env and a spy broker.
- [ ] **Step 2–6:** fail → implement → pass → typecheck → full suite → commit (`feat(broker): child-engine env + handle + steer-frame wiring`).

---

### Task 7: extension flag, lazy host, teardown, integration test, docs

**Files:**
- Modify: `src/extension.ts` (`PI_PERSONA_BROKER` flag via the existing config reader; lazy `startBrokerHost` on first child-engine build; pass `deps.broker` to the child adapter; `close()` on `session_shutdown`; `/doctor` line: endpoint + `connectedHandles()`)
- Create: `test/integration/broker.test.ts` (real socket/pipe round-trip; Windows-gated with the repo's existing skip pattern if flaky)
- Modify: `AGENTS.md`, `README.md`
- Reference: how `config` env flags are read today (e.g. `PI_PERSONA_PEEK_MS`, `PI_PERSONA_SEED`), how `buildEngine` builds the child adapter, the `session_shutdown` hook.

- [ ] **Step 1: Integration test (write first, expect skip/fail without the wiring).** Over a REAL endpoint: start a host on an `InProcessBus`, connect a real `client`, register, `client.send` → assert it lands in the bus; supervisor `bus.send` to the handle → assert the client's `onDeliver` fires; a `steerFrame` → assert `onSteer` fires; `close()` → handle unregistered. Gate with the platform skip if it proves flaky on Windows named pipes, and say so in the report.
- [ ] **Step 2: Wire the flag + lazy host + teardown** in `extension.ts`. `PI_PERSONA_BROKER` OFF ⇒ `deps.broker` is never created and the child adapter path is byte-identical to today. Build the host lazily (first child-engine spawn when the flag is on), reusing `ctx.sessionManager` session id for `brokerEndpoint`. Provide the host's `register/unregister/steerFrame` + a `listPeersFor` closure sharing the SAME per-engine peer-scoping rule as in-process.
- [ ] **Step 3: `/doctor`** — add one line (endpoint + connected child count) when the flag is on.
- [ ] **Step 4: Docs.**
  - AGENTS.md engine bullet: the broker is opt-in (`PI_PERSONA_BROKER=1`), session-scoped, relays into the in-process bus so the supervisor side is unchanged; it gives child-process runs `contact_supervisor`/`contact_peer` + **steer** (closing the child-engine steer gap); worktree legs become steerable/communicating. Update the "Boundaries / deferred" section: the cross-process broker is **no longer deferred** (keep the legacy-repo path warning).
  - README: one line under the comm/engine docs (opt-in, what it unlocks).
- [ ] **Step 5: Full verification** — `npm run typecheck` clean; `npm test` 0 fail, 1 (or 2, if the broker integration test is Windows-gated) intentional skip — document the skip count change in the report.
- [ ] **Step 6: Commit** (`feat(broker): opt-in cross-process broker — flag, lazy host, teardown, docs`).

- [ ] **Step 7 (manual, flagged to the user — not run by the executor): live drive.**

```bash
PI_PERSONA_BROKER=1 PI_PERSONA_ENGINE=child npm run drive -- --persona elite --model claude-pro-max-native/claude-haiku-4-5 "delegate a scout to summarise README.md, then steer it mid-run to focus on the install section"
```

Expected: `[pi-persona] engine=child`, the child connects to the broker, a `contact_supervisor` progress note reaches the supervisor, and a steer is delivered as a follow-up. Spends tokens — human-run.

## Notes for the executor

- Tasks 1–4 are pure/port work — READ the named comtac files and adapt; the source IS the reference implementation. Do not invent a new wire format.
- Tasks 5–7 are integration — the hard constraint is that DEFAULT-OFF changes nothing; the byte-identical-when-off pins in Tasks 5/6/7 are the most important tests in this plan.
- If any task balloons past its file list (especially the fake-transport decision in Tasks 3/4), STOP and report DONE_WITH_CONCERNS rather than restructure the seam unilaterally.
