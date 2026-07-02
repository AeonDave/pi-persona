import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { makeBrokerClient, type BrokerClient } from "../../../../src/bus/broker/client.ts";
import { createFrameReader, encodeFrame } from "../../../../src/bus/broker/framing.ts";
import type { Frame } from "../../../../src/bus/broker/messages.ts";

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
}> {
	const { net, hostSide } = fakeNet();
	const host = wireHost(hostSide);
	const client = makeBrokerClient({ endpoint: "/fake/endpoint.sock", handle: "child#1", net, ...deps });
	const registerPromise = client.register();
	await waitFor(() => host.frames.some((f) => f.t === "register"));
	host.send({ t: "registered", handle: "child#1" });
	await registerPromise;
	return { client, host };
}

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

test("send writes a well-formed send frame with expectsReply false", async () => {
	const { client, host } = await connectedClient();
	try {
		client.send("supervisor", "progress", "halfway there");
		await waitFor(() => host.frames.some((f) => f.t === "send"));
		const sendFrame = host.frames.find((f) => f.t === "send");
		assert.ok(sendFrame && sendFrame.t === "send");
		assert.equal(sendFrame.to, "supervisor");
		assert.equal(sendFrame.kind, "progress");
		assert.equal(sendFrame.text, "halfway there");
		assert.equal(sendFrame.expectsReply, false);
		assert.equal(typeof sendFrame.msgId, "string");
		assert.ok(sendFrame.msgId.length > 0);
	} finally {
		client.close();
	}
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
		ac.abort();
		await assert.rejects(() => askPromise, /abort/);
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

test("close during an in-flight initial connect rejects register() and destroys the dialing socket instead of completing the handshake", async () => {
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

	const registerPromise = client.register();
	client.close(); // synchronous — runs before the queued "connect" microtask fires

	await assert.rejects(() => registerPromise, /closed/);
	// Give the queued "connect" (and, if the bug were present, the subsequent
	// register/registered handshake) a chance to play out.
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(clientSocket.destroyed, true, "the dialing socket must be destroyed, not leaked live");
	assert.ok(!host.frames.some((f) => f.t === "register"), "must not complete a register handshake on a closed client");
});

test("close is idempotent and rejects still-pending asks", async () => {
	const { client } = await connectedClient();
	const askPromise = client.ask("supervisor", "decision", "?");
	client.close();
	client.close(); // must not throw
	await assert.rejects(() => askPromise);
});
