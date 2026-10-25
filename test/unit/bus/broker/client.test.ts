import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { makeBrokerClient, type BrokerClient } from "../../../../src/bus/broker/client.ts";
import { createFrameReader, encodeFrame } from "../../../../src/bus/broker/framing.ts";
import type { Frame } from "../../../../src/bus/broker/messages.ts";
import { readFailure } from "../../../../src/bus/result-reader.ts";

/**
 * Fake `net`: the client-side half of the same in-memory socket-pair fake used by
 * `host.test.ts` — a `connect()` call returns a `FakeSocket` linked to a `FakeSocket` the
 * test drives as "the host". This is the transport-injection seam `makeBrokerClient`'s
 * `net` param exists for (mirrors `StartBrokerHostDeps.net`); a real socket/pipe round
 * trip is Task 7's integration test.
 */
class FakeSocket extends EventEmitter {
	destroyed = false;
	private peer: FakeSocket | undefined;
	link(peer: FakeSocket): void {
		this.peer = peer;
	}
	write(data: Buffer): boolean {
		if (!this.destroyed) this.peer?.emit("data", data);
		return true;
	}
	end(): void {
		this.destroy();
	}
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("close");
		this.peer?.destroy();
	}
}

function socketPair(): [FakeSocket, FakeSocket] {
	const a = new FakeSocket();
	const b = new FakeSocket();
	a.link(b);
	b.link(a);
	return [a, b];
}

/** A fake `net` whose every `connect()` call succeeds immediately, linking the returned
 *  client socket to a `hostSide` the test can drive like `host.test.ts` drives its `FakeServer`. */
function fakeNet(): { net: typeof import("node:net"); hostSide: FakeSocket } {
	const [client, hostSide] = socketPair();
	const net = {
		connect: (_path: string) => {
			queueMicrotask(() => client.emit("connect"));
			return client as unknown as import("node:net").Socket;
		},
	} as unknown as typeof import("node:net");
	return { net, hostSide };
}

/** A fake `net` whose first `failCount` `connect()` calls fail (ECONNREFUSED-style, on a
 *  FRESH socket pair each time, matching real `net.connect`), then succeed — exercises
 *  `register`'s capped exponential-backoff retry (Components spec: "connect with capped
 *  exponential backoff" is `client.ts`'s own job, not a caller's wrapper). */
function flakyFakeNet(failCount: number, onHostSide: (hostSide: FakeSocket, attemptNo: number) => void): { net: typeof import("node:net"); attempts: { count: number } } {
	const attempts = { count: 0 };
	const net = {
		connect: (_path: string) => {
			attempts.count += 1;
			const thisAttempt = attempts.count;
			const [client, hostSide] = socketPair();
			// Wire the caller's listener onto `hostSide` SYNCHRONOUSLY, before returning —
			// the eventual `connect`/`error` emit (and, on success, the client's `register`
			// write) happens via microtask hops that all resolve before any `setTimeout`
			// poll fires, so a listener attached AFTER polling detects success would miss it.
			onHostSide(hostSide, thisAttempt);
			queueMicrotask(() => {
				if (thisAttempt <= failCount) client.emit("error", new Error("ECONNREFUSED"));
				else client.emit("connect");
			});
			return client as unknown as import("node:net").Socket;
		},
	} as unknown as typeof import("node:net");
	return { net, attempts };
}

/** Wire the fake host side: a frame writer + a decoded-frame collector, mirroring
 *  `host.test.ts`'s `wireClient` from the opposite direction. */
function wireHost(socket: FakeSocket): { send: (f: Frame) => void; frames: Frame[] } {
	const frames: Frame[] = [];
	socket.on(
		"data",
		createFrameReader(
			(raw) => frames.push(raw as Frame),
			() => assert.fail("fake host frame reader errored"),
		),
	);
	return { send: (f: Frame) => socket.write(encodeFrame(f)), frames };
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 1));
	}
}

/** Connect + register a client against a fresh fake host, replying `registered` as soon
 *  as the `register` frame arrives. */
async function connectedClient(deps: Partial<Parameters<typeof makeBrokerClient>[0]> = {}): Promise<{
	client: BrokerClient;
	host: { send: (f: Frame) => void; frames: Frame[] };
	hostSide: FakeSocket;
}> {
	const { net, hostSide } = fakeNet();
	const host = wireHost(hostSide);
	const client = makeBrokerClient({ endpoint: "/fake/endpoint.sock", handle: "child#1", net, ...deps });
	const registerPromise = client.register();
	await waitFor(() => host.frames.some((f) => f.t === "register"));
	host.send({ t: "registered", handle: "child#1", ...(deps.readerToken ? { readerToken: deps.readerToken } : {}) });
	await registerPromise;
	return { client, host, hostSide };
}

const readerToken = "a".repeat(64);
const ref = "result:12345678-1234-1234-1234-123456789abc";
const result = { ok: true, ref, body: "😀", offset: 0, storedChars: 2, originalChars: 2,
	truncated: false, endOfStoredBody: true, status: "done", provenance: "result-output" } as const;

test("authenticated client reads correlate without deliver/steer notifications", async () => {
	const { client, host } = await connectedClient({ readerToken });
	try {
		client.onDeliver(() => assert.fail("read must not wake"));
		client.onSteer(() => assert.fail("read must not steer"));
		const pending = client.read({ ref, limit: 2 });
		const request = host.frames.at(-1);
		assert.ok(request?.t === "result_read");
		host.send({ t: "result_read_reply", reqId: request.reqId, result });
		assert.deepEqual(await pending, result);
		assert.equal((host.frames[0] as { readerToken?: string }).readerToken, readerToken);
	} finally { client.close(); }
});

test("read fails closed before grant/registration, after disconnect and for invalid inputs", async () => {
	const plain = await connectedClient();
	assert.deepEqual(await plain.client.read({ ref }), readFailure("denied"));
	plain.client.close();
	const { client, host, hostSide } = await connectedClient({ readerToken });
	try {
		const before = host.frames.length;
		assert.deepEqual(await client.read({ ref, limit: 1 }), readFailure("invalid"));
		assert.equal(host.frames.length, before);
		hostSide.destroy();
		assert.deepEqual(await client.read({ ref }), readFailure("unavailable"));
	} finally { client.close(); }
});

test("read cancellation, timeout and close settle promptly and discard late replies", async (t) => {
	for (const action of ["cancel", "timeout", "close", "disconnect"] as const) {
		const { client, host, hostSide } = await connectedClient({ readerToken });
		try {
			const ac = new AbortController();
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const pending = client.read({ ref }, ac.signal);
			const request = host.frames.at(-1);
			assert.ok(request?.t === "result_read");
			if (action === "cancel") ac.abort();
			if (action === "timeout") t.mock.timers.tick(10000);
			if (action === "close") client.close();
			if (action === "disconnect") hostSide.destroy();
			assert.deepEqual(await pending, readFailure(action === "cancel" ? "cancelled" : action === "timeout" ? "timeout" : "unavailable"));
			if (action === "cancel" || action === "timeout") assert.ok(host.frames.some((f) => f.t === "result_read_cancel" && f.reqId === request.reqId));
			host.send({ t: "result_read_reply", reqId: request.reqId, result });
		} finally { t.mock.timers.reset(); client.close(); }
	}
});

test("reader enforces max eight pending, pre-abort is inert, slots are released on completion", async () => {
	const { client, host } = await connectedClient({ readerToken });
	try {
		const before = host.frames.length;
		assert.deepEqual(await client.read({ ref }, AbortSignal.abort()), readFailure("cancelled"));
		assert.equal(host.frames.length, before);
		const pending = Array.from({ length: 8 }, () => client.read({ ref }));
		assert.deepEqual(await client.read({ ref }), readFailure("busy"));
		const request = host.frames.at(-1);
		assert.ok(request?.t === "result_read");
		host.send({ t: "result_read_reply", reqId: request.reqId, result });
		assert.deepEqual(await pending.at(-1), result);
		const next = client.read({ ref });
		client.close();
		await Promise.all([...pending, next]);
	} finally { client.close(); }
});

test("mismatched or missing reader acknowledgement rejects instead of downgrading", async () => {
	for (const ack of [undefined, "b".repeat(64)]) {
		const { net, hostSide } = fakeNet();
		const host = wireHost(hostSide);
		const client = makeBrokerClient({ endpoint: "/fake", handle: "child", readerToken, net });
		const registration = client.register();
		await waitFor(() => host.frames.length === 1);
		host.send({ t: "registered", handle: "child", ...(ack ? { readerToken: ack } : {}) });
		await assert.rejects(registration, /reader.*protocol/i);
		assert.deepEqual(await client.read({ ref }), readFailure("unavailable"));
		client.close();
	}
});

test("malformed reply and wrong page correlation fail closed without raw payload errors", async () => {
	for (const patch of [{ task: "SECRET" }, { offset: 1 }, { body: "x".repeat(16001) }]) {
		const { client, host, hostSide } = await connectedClient({ readerToken });
		try {
			const pending = client.read({ ref });
			const request = host.frames.at(-1);
			assert.ok(request?.t === "result_read");
			hostSide.write(encodeFrame({ t: "result_read_reply", reqId: request.reqId, result: { ...result, ...patch } }));
			assert.deepEqual(await pending, readFailure("protocol"));
		} finally { client.close(); }
	}
});

test("reader handshake has a deadline and cannot reconnect/replay", async (t) => {
	const { net, hostSide } = fakeNet();
	const host = wireHost(hostSide);
	const client = makeBrokerClient({ endpoint: "/fake", handle: "child", readerToken, net });
	try {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pending = client.register();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		assert.ok(host.frames.length);
		const rejection = assert.rejects(pending, /reader.*deadline/i);
		t.mock.timers.tick(10000);
		await rejection;
		await assert.rejects(client.register(), /register|closed/i);
	} finally { t.mock.timers.reset(); client.close(); }
});

test("register connects and completes the register/registered handshake", async () => {
	const { client, host } = await connectedClient({ label: "coder", group: "g1", peers: true });
	try {
		const registerFrame = host.frames.find((f) => f.t === "register");
		assert.ok(registerFrame && registerFrame.t === "register");
		assert.equal(registerFrame.handle, "child#1");
		assert.equal(registerFrame.label, "coder");
		assert.equal(registerFrame.group, "g1");
		assert.equal(registerFrame.peers, true);
	} finally {
		client.close();
	}
});

test("register rejects when the host answers with an error frame", async () => {
	const { net, hostSide } = fakeNet();
	const host = wireHost(hostSide);
	const client = makeBrokerClient({ endpoint: "/fake/endpoint.sock", handle: "supervisor", net });
	const registerPromise = client.register();
	await waitFor(() => host.frames.some((f) => f.t === "register"));
	host.send({ t: "error", reason: "reserved handle" });
	await assert.rejects(() => registerPromise, /reserved handle/);
	client.close();
});

test("register retries the connect with capped exponential backoff, then succeeds", async () => {
	const hosts: Array<{ attemptNo: number; frames: Frame[]; send: (f: Frame) => void }> = [];
	const { net, attempts } = flakyFakeNet(2, (hostSide, attemptNo) => {
		hosts.push({ attemptNo, ...wireHost(hostSide) });
	});
	const client = makeBrokerClient({ endpoint: "/fake/endpoint.sock", handle: "child#1", net });
	try {
		const registerPromise = client.register();
		await waitFor(() => hosts.some((h) => h.frames.some((f) => f.t === "register")), 5000);
		const host = hosts[hosts.length - 1]!;
		host.send({ t: "registered", handle: "child#1" });
		await registerPromise;
		assert.equal(attempts.count, 3);
		assert.equal(host.attemptNo, 3);
	} finally {
		client.close();
	}
});

test("send confirms host admission by exact message id, without waiting for an answer", async () => {
	const { client, host } = await connectedClient();
	try {
		let settled = false;
		const receipt = client.send("supervisor", "progress", "halfway there").then((value) => { settled = true; return value; });
		await waitFor(() => host.frames.some((f) => f.t === "send"));
		const sendFrame = host.frames.find((f) => f.t === "send");
		assert.ok(sendFrame && sendFrame.t === "send");
		assert.equal(sendFrame.to, "supervisor");
		assert.equal(sendFrame.kind, "progress");
		assert.equal(sendFrame.text, "halfway there");
		assert.equal(sendFrame.expectsReply, false);
		assert.equal(typeof sendFrame.msgId, "string");
		assert.ok(sendFrame.msgId.length > 0);
		host.send({ t: "sent", msgId: "12345678-1234-1234-1234-123456789abc", delivered: true });
		await Promise.resolve();
		assert.equal(settled, false, "a socket write or unrelated acknowledgement is not delivery evidence");
		host.send({ t: "sent", msgId: sendFrame.msgId, delivered: true });
		assert.equal(await receipt, true);
		const rejected = client.send("supervisor", "progress", "full inbox");
		const next = host.frames.filter((f) => f.t === "send").at(-1)!;
		assert.ok(next.t === "send");
		host.send({ t: "sent", msgId: next.msgId, delivered: false });
		assert.equal(await rejected, false);
	} finally {
		client.close();
	}
});

test("send cancellation, host error, disconnect and missing receipt never become delivery", async (t) => {
	const { client, host, hostSide } = await connectedClient();
	try {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pre = AbortSignal.abort();
		assert.equal(await client.send("supervisor", "progress", "pre", pre), false);
		assert.equal(host.frames.filter((f) => f.t === "send").length, 0);
		const ac = new AbortController();
		const cancelled = client.send("supervisor", "progress", "cancel", ac.signal);
		ac.abort();
		assert.equal(await cancelled, false);
		const error = client.send("supervisor", "progress", "error");
		const frame = host.frames.filter((f) => f.t === "send").at(-1)!;
		assert.ok(frame.t === "send");
		host.send({ t: "error", msgId: frame.msgId, reason: "send unavailable" });
		assert.equal(await error, false);
		const timeout = client.send("supervisor", "progress", "timeout");
		t.mock.timers.tick(10_000);
		assert.equal(await timeout, false);
		const lost = client.send("supervisor", "progress", "lost");
		hostSide.destroy();
		assert.equal(await lost, false);
		assert.equal(await client.send("supervisor", "progress", "offline"), false);
		assert.equal(host.frames.filter((f) => f.t === "send").length, 4, "no aborted/offline replay");
	} finally { client.close(); t.mock.timers.reset(); }
});

test("pending send receipts are bounded and close settles every admitted request", async () => {
	const { client, host } = await connectedClient();
	try {
		const pending = Array.from({ length: 64 }, () => client.send("supervisor", "progress", "status"));
		assert.equal(await client.send("supervisor", "progress", "overflow"), false);
		assert.equal(host.frames.filter((f) => f.t === "send").length, 64);
		client.close();
		assert.deepEqual(await Promise.all(pending), Array(64).fill(false));
		assert.equal(await client.send("supervisor", "progress", "closed"), false);
	} finally { client.close(); }
});

test("ask resolves when a replied frame with a matching askId arrives", async () => {
	const { client, host } = await connectedClient();
	try {
		const askPromise = client.ask("supervisor", "decision", "left or right?");
		await waitFor(() => host.frames.some((f) => f.t === "send" && f.expectsReply === true));
		const sendFrame = host.frames.find((f) => f.t === "send" && f.expectsReply === true);
		assert.ok(sendFrame && sendFrame.t === "send");
		host.send({ t: "replied", askId: sendFrame.msgId, text: "left" });
		assert.equal(await askPromise, "left");
	} finally {
		client.close();
	}
});

test("ask rejects immediately when the signal is already aborted", async () => {
	const { client } = await connectedClient();
	try {
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(() => client.ask("supervisor", "decision", "?", ac.signal), /abort/);
	} finally {
		client.close();
	}
});

test("ask rejects when the signal aborts before a reply arrives", async () => {
	const { client } = await connectedClient();
	try {
		const ac = new AbortController();
		const askPromise = client.ask("supervisor", "decision", "?", ac.signal);
		await new Promise((resolve) => setImmediate(resolve));
		ac.abort();
		await assert.rejects(() => askPromise, /abort/);
	} finally {
		client.close();
	}
});

test("ask abort sends a cancel frame for its own request", async () => {
	const { client, host } = await connectedClient();
	try {
		const ac = new AbortController();
		const askPromise = client.ask("supervisor", "decision", "?", ac.signal);
		await waitFor(() => host.frames.some((f) => f.t === "send" && f.expectsReply === true));
		const send = host.frames.find((f) => f.t === "send" && f.expectsReply === true);
		assert.ok(send && send.t === "send");
		ac.abort();
		await assert.rejects(() => askPromise, /abort/);
		await waitFor(() => host.frames.some((f) => f.t === "cancel"));
		const cancel = host.frames.find((f) => f.t === "cancel");
		assert.ok(cancel && cancel.t === "cancel");
		assert.equal(cancel.msgId, send.msgId, "abort cancels only the originating ask");
	} finally {
		client.close();
	}
});

test("a correlated host error rejects the matching ask immediately", async () => {
	const { client, host } = await connectedClient();
	try {
		const askPromise = client.ask("supervisor", "decision", "?");
		await waitFor(() => host.frames.some((f) => f.t === "send" && f.expectsReply === true));
		const send = host.frames.find((f) => f.t === "send" && f.expectsReply === true);
		assert.ok(send && send.t === "send");
		host.send({ t: "error", reason: "inbox full: ask was not delivered", msgId: send.msgId });
		await assert.rejects(() => askPromise, /inbox full/);
	} finally {
		client.close();
	}
});

test("ask times out after the 10-minute cap using mocked timers", async (t) => {
	// Connect with REAL timers first (`connectedClient`'s own `waitFor` polls via
	// `setTimeout`); only then fake the clock so `ask`'s 10-minute cap can be ticked
	// instantly instead of actually waiting.
	const { client } = await connectedClient();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const askPromise = client.ask("supervisor", "decision", "?");
		const assertion = assert.rejects(() => askPromise, /timeout/);
		t.mock.timers.tick(600_000);
		await assertion;
	} finally {
		t.mock.timers.reset();
		client.close();
	}
});

test("onDeliver dispatches inbound deliver frames", async () => {
	const { client, host } = await connectedClient();
	try {
		const received: Array<{ from: string; kind: string; text: string }> = [];
		client.onDeliver((evt) => received.push({ from: evt.from, kind: evt.kind, text: evt.text }));
		host.send({ t: "deliver", from: "supervisor", kind: "progress", text: "keep going", msgId: "m1", expectsReply: false });
		await waitFor(() => received.length > 0);
		assert.deepEqual(received[0], { from: "supervisor", kind: "progress", text: "keep going" });
	} finally {
		client.close();
	}
});

test("onSteer dispatches inbound steer frames", async () => {
	const { client, host } = await connectedClient();
	try {
		const received: string[] = [];
		client.onSteer((text) => received.push(text));
		host.send({ t: "steer", text: "stop and check tests" });
		await waitFor(() => received.length > 0);
		assert.deepEqual(received, ["stop and check tests"]);
	} finally {
		client.close();
	}
});

test("reply writes a reply frame carrying the askId", async () => {
	const { client, host } = await connectedClient();
	try {
		client.reply("m1", "go right");
		await waitFor(() => host.frames.some((f) => f.t === "reply"));
		const replyFrame = host.frames.find((f) => f.t === "reply");
		assert.ok(replyFrame && replyFrame.t === "reply");
		assert.equal(replyFrame.askId, "m1");
		assert.equal(replyFrame.text, "go right");
	} finally {
		client.close();
	}
});

test("list resolves with the peers frame's roster", async () => {
	const { client, host } = await connectedClient();
	try {
		const listPromise = client.list();
		await waitFor(() => host.frames.some((f) => f.t === "list"));
		const listFrame = host.frames.find((f) => f.t === "list");
		assert.ok(listFrame && listFrame.t === "list");
		host.send({ t: "peers", reqId: listFrame.reqId, peers: [{ handle: "reviewer#1", label: "reviewer" }] });
		assert.deepEqual(await listPromise, [{ handle: "reviewer#1", label: "reviewer" }]);
	} finally {
		client.close();
	}
});

test("a disconnected client rejects pending ask and list requests promptly", { timeout: 1000 }, async () => {
	const { client, host, hostSide } = await connectedClient();
	const askPromise = client.ask("supervisor", "decision", "continue?");
	await waitFor(() => host.frames.some((f) => f.t === "send" && f.expectsReply === true));
	const listPromise = client.list();
	await waitFor(() => host.frames.some((f) => f.t === "list"));
	// The host-side close is the failure signal: both pending operations must settle without
	// waiting for the ask's ten-minute cap or leaving a list promise forever pending.
	hostSide.destroy();
	await assert.rejects(() => askPromise, /connection closed|broker/i);
	await assert.rejects(() => listPromise, /connection closed|broker/i);
	client.close();
});

test("list rejects at its cap and clears its pending request", async (t) => {
	const { client } = await connectedClient();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const listPromise = client.list();
		let rejection = "";
		void listPromise.catch((error: unknown) => { rejection = error instanceof Error ? error.message : String(error); });
		t.mock.timers.tick(9_999);
		await Promise.resolve();
		assert.equal(rejection, "", "a healthy local round-trip gets the full short window");
		t.mock.timers.tick(1);
		await Promise.resolve();
		assert.match(rejection, /list timeout after 10000ms/);
	} finally {
		t.mock.timers.reset();
		client.close();
	}
});

test("close sends a bye frame and disposes the socket", async () => {
	const { client, host } = await connectedClient();
	client.close();
	await waitFor(() => host.frames.some((f) => f.t === "bye"));
	assert.ok(host.frames.some((f) => f.t === "bye"));
});

test("close during a pending register (connected, awaiting registered) rejects it instead of hanging", async () => {
	const { net, hostSide } = fakeNet();
	wireHost(hostSide); // don't reply — leave the handshake pending
	const client = makeBrokerClient({ endpoint: "/fake/endpoint.sock", handle: "child#1", net });
	const registerPromise = client.register();
	await new Promise((r) => setTimeout(r, 5)); // let the connect settle
	client.close();
	await assert.rejects(() => registerPromise, /closed/);
});

test("close during an in-flight initial connect rejects register() and destroys the dialing socket instead of completing the handshake", async (t) => {
	// Unlike `fakeNet()`, capture the client-side socket directly so we can assert it was
	// destroyed rather than left connected — this is the race from the review finding:
	// `close()` runs while `connectOnce()`'s "connect" event is still only queued, i.e.
	// BEFORE `register()` has assigned `socket` or `registerSettle`, so close()'s own
	// teardown (lines ~296-311) has nothing to act on.
	const [clientSocket, hostSide] = socketPair();
	const host = wireHost(hostSide);
	const net = {
		connect: (_path: string) => {
			queueMicrotask(() => clientSocket.emit("connect"));
			return clientSocket as unknown as import("node:net").Socket;
		},
	} as unknown as typeof import("node:net");
	const client = makeBrokerClient({ endpoint: "/fake/endpoint.sock", handle: "child#1", net });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const outcomes: unknown[] = [];
		const registerPromise = client.register();
		void registerPromise.catch((error: unknown) => { outcomes.push(error); });
		client.close(); // synchronous — runs before the queued "connect" microtask fires
		await new Promise<void>((resolve) => setImmediate(resolve));
		const outcome = outcomes[0];
		assert.ok(outcome instanceof Error && /closed/.test(outcome.message), "local cancellation must settle without advancing the retry clock");
		await assert.rejects(() => registerPromise, /closed/);
		assert.equal(clientSocket.destroyed, true, "the dialing socket must be destroyed, not leaked live");
		assert.ok(!host.frames.some((f) => f.t === "register"), "must not complete a register handshake on a closed client");
	} finally {
		client.close();
		t.mock.timers.tick(60_000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		t.mock.timers.reset();
	}
});

test("close interrupts an existing initial-connect backoff without waiting for the retry clock or redialing", async (t) => {
	const { net, attempts } = flakyFakeNet(1, () => {});
	const client = makeBrokerClient({ endpoint: "/fake/endpoint.sock", handle: "child#1", net });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const outcomes: unknown[] = [];
		const registerPromise = client.register();
		void registerPromise.catch((error: unknown) => { outcomes.push(error); });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(attempts.count, 1, "the failed dial is waiting for its frozen retry delay");
		assert.equal(outcomes.length, 0);
		client.close();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const outcome = outcomes[0];
		assert.ok(outcome instanceof Error && /closed/.test(outcome.message), "close must interrupt an already scheduled backoff");
		await assert.rejects(() => registerPromise, /closed/);
		t.mock.timers.tick(60_000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(attempts.count, 1, "a closed client can never retry the dial");
	} finally {
		client.close();
		t.mock.timers.tick(60_000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		t.mock.timers.reset();
	}
});

// A never-settling register() is the defect itself, so this one needs its own deadline —
// without it a regression hangs the file instead of failing it.
test("register rejects when the host drops the connection mid-handshake", { timeout: 5000 }, async () => {
	const { net, hostSide } = fakeNet();
	const host = wireHost(hostSide);
	const client = makeBrokerClient({ endpoint: "/fake/endpoint.sock", handle: "child#1", net });
	const registerPromise = client.register();
	await waitFor(() => host.frames.some((f) => f.t === "register"));
	hostSide.destroy(); // host teardown/crash after accept, before `registered`
	await assert.rejects(() => registerPromise, /closed/);
	client.close();
});

test("a throwing onDeliver listener does not poison the frame reader", async () => {
	const { client, host } = await connectedClient();
	try {
		const seen: string[] = [];
		client.onDeliver(() => {
			throw new Error("listener blew up");
		});
		client.onDeliver((evt) => seen.push(evt.text));
		host.send({ t: "deliver", from: "supervisor", kind: "progress", text: "first", msgId: "m1", expectsReply: false });
		host.send({ t: "deliver", from: "supervisor", kind: "progress", text: "second", msgId: "m2", expectsReply: false });
		await waitFor(() => seen.length === 2);
		assert.deepEqual(seen, ["first", "second"]);
	} finally {
		client.close();
	}
});

test("a throwing onSteer listener does not poison the frame reader", async () => {
	const { client, host } = await connectedClient();
	try {
		const seen: string[] = [];
		client.onSteer(() => {
			throw new Error("listener blew up");
		});
		client.onSteer((text) => seen.push(text));
		host.send({ t: "steer", text: "first" });
		host.send({ t: "steer", text: "second" });
		await waitFor(() => seen.length === 2);
		assert.deepEqual(seen, ["first", "second"]);
	} finally {
		client.close();
	}
});

test("close is idempotent and rejects still-pending asks", async () => {
	const { client } = await connectedClient();
	const askPromise = client.ask("supervisor", "decision", "?");
	client.close();
	client.close(); // must not throw
	await assert.rejects(() => askPromise);
});

test("a fresh ask or list after a host-side drop rejects at once instead of waiting for the ten-minute cap", { timeout: 1000 }, async () => {
	const { client, hostSide } = await connectedClient();
	let closes = 0;
	client.onClose(() => closes++);
	hostSide.destroy();
	await waitFor(() => closes === 1);
	await assert.rejects(() => client.ask("supervisor", "decision", "still there?"), /connection closed/);
	await assert.rejects(() => client.list(), /connection closed/);
	client.close();
});
