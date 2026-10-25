import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFailure, type ReadReply, type ScopedReader } from "../../../../src/bus/result-reader.ts";

import { InProcessBus } from "../../../../src/bus/inproc.ts";
import { startBrokerHost, type BrokerHost } from "../../../../src/bus/broker/host.ts";
import { createFrameReader, encodeFrame } from "../../../../src/bus/broker/framing.ts";
import type { Frame } from "../../../../src/bus/broker/messages.ts";

/**
 * Fake `net`: no real socket/pipe. `createServer()` returns one in-memory `FakeServer`;
 * a "client" is a linked pair of `FakeSocket`s (writes on one side arrive as `data` on
 * the other; `destroy()` cascades to the peer, mirroring a real TCP close). This is the
 * transport-injection seam `startBrokerHost`'s `net` param exists for — the same fake
 * shape is cast through `unknown` to `typeof import("node:net")` at the injection site,
 * since host.ts only ever calls `createServer` on it (a real cross-socket/pipe run is
 * Task 7's integration test).
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

class FakeServer extends EventEmitter {
	listen(_endpoint: string, cb?: () => void): this {
		queueMicrotask(() => {
			this.emit("listening");
			cb?.();
		});
		return this;
	}
	unref(): this {
		return this;
	}
	close(cb?: () => void): this {
		queueMicrotask(() => cb?.());
		return this;
	}
}

function fakeNet(): { net: typeof import("node:net"); server: FakeServer } {
	const server = new FakeServer();
	const net = { createServer: () => server } as unknown as typeof import("node:net");
	return { net, server };
}

/** Attach a client-side socket: a frame writer + a decoded-frame collector. */
function wireClient(socket: FakeSocket): { send: (f: Frame) => void; frames: Frame[] } {
	const frames: Frame[] = [];
	socket.on(
		"data",
		createFrameReader(
			(raw) => frames.push(raw as Frame),
			() => assert.fail("client frame reader errored"),
		),
	);
	return { send: (f: Frame) => socket.write(encodeFrame(f)), frames };
}

/** Drive the fake server to "accept" a new client connection; returns the wired client. */
function connectClient(server: FakeServer): { client: FakeSocket; send: (f: Frame) => void; frames: Frame[] } {
	const [client, serverSide] = socketPair();
	server.emit("connection", serverSide);
	const { send, frames } = wireClient(client);
	return { client, send, frames };
}

/** A server-side socket whose `end()` does NOT close synchronously — a real socket's FIN/close
 *  is asynchronous, which is exactly what opens the window between the `bye` cleanup and the
 *  eventual `close` event. */
class LingeringSocket extends FakeSocket {
	override end(): void {
		/* the test decides when this socket actually closes */
	}
}

/** Same as `connectClient`, but the host's side of the pair lingers after `end()`. */
function connectLingeringClient(server: FakeServer): { serverSide: LingeringSocket; send: (f: Frame) => void; frames: Frame[] } {
	const client = new FakeSocket();
	const serverSide = new LingeringSocket();
	client.link(serverSide);
	serverSide.link(client);
	server.emit("connection", serverSide);
	const { send, frames } = wireClient(client);
	return { serverSide, send, frames };
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 1));
	}
}

async function startHost(bus: InProcessBus, extra: Partial<Parameters<typeof startBrokerHost>[0]> = {}): Promise<{ host: BrokerHost; server: FakeServer }> {
	const { net, server } = fakeNet();
	const host = await startBrokerHost({ bus, supervisorHandle: "supervisor", endpoint: "/fake/endpoint.sock", net, ...extra });
	return { host, server };
}

const resultRef = `result:${randomUUID()}`;
const page = (body = "ok"): ReadReply => ({ ok: true, ref: resultRef, body, offset: 0,
	storedChars: body.length, originalChars: body.length, truncated: false, endOfStoredBody: true,
	status: "done", provenance: "result-output" });
function reader(read: ScopedReader["read"] = async () => page()) {
	let revoked = 0;
	return { read, revoke: () => { revoked++; }, revocations: () => revoked };
}
const tick = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

test("reader handles require their one-shot secret; sibling, impersonation and replay fail without leaking it", async () => {
	const { host, server } = await startHost(new InProcessBus());
	try {
		const r = reader();
		const grant = await host.prepareResultReader("reader", r);
		assert.match(grant.token, /^[a-f0-9]{64}$/);
		const other = await host.prepareResultReader("sibling", reader());
		for (const token of [undefined, other.token, "a".repeat(64)]) {
			const bad = connectClient(server);
			bad.send({ t: "register", handle: "reader", ...(token ? { readerToken: token } : {}) });
			assert.equal(bad.frames.some((f) => f.t === "registered"), false);
			assert.equal(JSON.stringify(bad.frames).includes(grant.token), false);
			bad.client.destroy();
		}
		assert.equal(grant.wasBound(), false);
		const good = connectClient(server);
		good.send({ t: "register", handle: "reader", readerToken: grant.token });
		assert.deepEqual(good.frames[0], { t: "registered", handle: "reader", readerToken: grant.token });
		assert.equal(grant.wasBound(), true);
		good.client.destroy();
		assert.equal(r.revocations(), 1);
		const replay = connectClient(server);
		replay.send({ t: "register", handle: "reader", readerToken: grant.token });
		assert.equal(replay.frames.some((f) => f.t === "registered"), false);
		grant.revoke();
		assert.equal(r.revocations(), 1);
	} finally { await host.close(); }
});

test("a rejected supplied token cannot reuse its socket as an ordinary registration", async () => {
	const { host, server } = await startHost(new InProcessBus());
	try {
		const c = connectClient(server);
		c.send({ t: "register", handle: "intruder", readerToken: "a".repeat(64) });
		c.send({ t: "register", handle: "intruder" });
		assert.equal(c.frames.some((f) => f.t === "registered"), false);
		assert.equal(c.client.destroyed, true);
	} finally { await host.close(); }
});

test("completed read ids cannot replay and sibling cancellation cannot touch another reader", async () => {
	const { host, server } = await startHost(new InProcessBus());
	try {
		let calls = 0;
		let signal: AbortSignal | undefined;
		let finish!: (value: ReadReply) => void;
		const grant = await host.prepareResultReader("reader", reader((_r, s) => {
			calls++; signal = s; return new Promise((resolve) => { finish = resolve; });
		}));
		const c = connectClient(server);
		c.send({ t: "register", handle: "reader", readerToken: grant.token });
		const sibling = connectClient(server);
		sibling.send({ t: "register", handle: "sibling" });
		const reqId = randomUUID();
		c.send({ t: "result_read", reqId, ref: resultRef });
		await tick();
		sibling.send({ t: "result_read_cancel", reqId });
		assert.equal(signal?.aborted, false);
		finish(page());
		await tick();
		c.send({ t: "result_read", reqId, ref: resultRef });
		assert.deepEqual(c.frames.at(-1), { t: "result_read_reply", reqId, result: readFailure("protocol") });
		assert.equal(calls, 1);
	} finally { await host.close(); }
});

test("host rejects oversized or metadata-bearing reader callbacks instead of serializing them", async () => {
	for (const value of [{ ...page(), summary: { task: "SECRET" } }, page("x".repeat(16001))]) {
		const { host, server } = await startHost(new InProcessBus());
		try {
			const grant = await host.prepareResultReader("reader", reader(async () => value));
			const c = connectClient(server);
			c.send({ t: "register", handle: "reader", readerToken: grant.token });
			const reqId = randomUUID();
			c.send({ t: "result_read", reqId, ref: resultRef, limit: 16000 });
			await tick();
			assert.deepEqual(c.frames.at(-1), { t: "result_read_reply", reqId, result: readFailure("protocol") });
		} finally { await host.close(); }
	}
});

test("ungranted refs reach only the parent's scoped reader and return its fixed denial", async () => {
	const { host, server } = await startHost(new InProcessBus());
	try {
		const grant = await host.prepareResultReader("reader", reader(async (request) =>
			request.ref === resultRef ? page() : readFailure("denied")));
		const c = connectClient(server);
		c.send({ t: "register", handle: "reader", readerToken: grant.token });
		const id = randomUUID();
		c.send({ t: "result_read", reqId: id, ref: `result:${randomUUID()}` });
		await tick();
		assert.deepEqual(c.frames.at(-1), { t: "result_read_reply", reqId: id, result: readFailure("denied") });
		const ordinary = connectClient(server);
		ordinary.send({ t: "register", handle: "ordinary" });
		ordinary.send({ t: "result_read", reqId: id, ref: resultRef });
		assert.deepEqual(ordinary.frames.at(-1), { t: "result_read_reply", reqId: id, result: readFailure("denied") });
	} finally { await host.close(); }
});

test("reader pending requests cap at eight; duplicates fail and cancel the original", async () => {
	const signals: AbortSignal[] = [];
	const { host, server } = await startHost(new InProcessBus());
	try {
		const grant = await host.prepareResultReader("reader", reader(async (_r, signal) => {
			signals.push(signal!); return new Promise(() => {});
		}));
		const c = connectClient(server);
		c.send({ t: "register", handle: "reader", readerToken: grant.token });
		const ids = Array.from({ length: 8 }, () => randomUUID());
		for (const reqId of ids) c.send({ t: "result_read", reqId, ref: resultRef });
		await tick();
		assert.equal(signals.length, 8);
		const excess = randomUUID();
		c.send({ t: "result_read", reqId: excess, ref: resultRef });
		assert.deepEqual(c.frames.at(-1), { t: "result_read_reply", reqId: excess, result: readFailure("busy") });
		c.send({ t: "result_read", reqId: ids[0]!, ref: resultRef });
		assert.deepEqual(c.frames.at(-1), { t: "result_read_reply", reqId: ids[0]!, result: readFailure("protocol") });
		assert.equal(signals[0]?.aborted, true);
		assert.equal(signals.length, 8);
	} finally { await host.close(); }
});

test("cancel, abort, forget, disconnect and host close abort pending reads and discard late replies", async () => {
	for (const action of ["cancel", "abort", "forget", "disconnect", "close"] as const) {
		const { host, server } = await startHost(new InProcessBus());
		const ac = new AbortController();
		let finish!: (value: ReadReply) => void;
		let signal: AbortSignal | undefined;
		const r = reader((_r, s) => { signal = s; return new Promise((resolve) => { finish = resolve; }); });
		const grant = await host.prepareResultReader("reader", r, ac.signal);
		const c = connectClient(server);
		c.send({ t: "register", handle: "reader", readerToken: grant.token });
		const reqId = randomUUID();
		c.send({ t: "result_read", reqId, ref: resultRef });
		await tick();
		if (action === "cancel") c.send({ t: "result_read_cancel", reqId });
		if (action === "abort") ac.abort();
		if (action === "forget") host.forget("reader");
		if (action === "disconnect") c.client.destroy();
		if (action === "close") await host.close();
		assert.equal(signal?.aborted, true, action);
		finish(page("must not arrive"));
		await tick();
		assert.equal(c.frames.some((f) => f.t === "result_read_reply" && f.result.ok), false, action);
		await host.close();
		assert.equal(r.revocations(), 1, action);
	}
});

test("host enforces its own ten-second read deadline even if the callback ignores cancellation", async (t) => {
	const { host, server } = await startHost(new InProcessBus());
	try {
		let signal: AbortSignal | undefined;
		const grant = await host.prepareResultReader("reader", reader(async (_r, s) => {
			signal = s; return new Promise(() => {});
		}));
		const c = connectClient(server);
		c.send({ t: "register", handle: "reader", readerToken: grant.token });
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const reqId = randomUUID();
		c.send({ t: "result_read", reqId, ref: resultRef });
		await Promise.resolve();
		t.mock.timers.tick(10000);
		assert.equal(signal?.aborted, true);
		assert.deepEqual(c.frames.at(-1), { t: "result_read_reply", reqId, result: readFailure("timeout") });
	} finally { t.mock.timers.reset(); await host.close(); }
});

test("a late old socket close cannot revoke a replacement result grant", async () => {
	const { host, server } = await startHost(new InProcessBus());
	try {
		const first = await host.prepareResultReader("reader", reader());
		const old = connectLingeringClient(server);
		old.send({ t: "register", handle: "reader", readerToken: first.token });
		old.send({ t: "bye" });
		const replacement = reader();
		const next = await host.prepareResultReader("reader", replacement);
		const c = connectClient(server);
		c.send({ t: "register", handle: "reader", readerToken: next.token });
		old.serverSide.destroy();
		first.revoke();
		assert.equal(replacement.revocations(), 0);
		c.send({ t: "result_read", reqId: randomUUID(), ref: resultRef });
		await tick();
		assert.equal(c.frames.some((f) => f.t === "result_read_reply" && f.result.ok), true);
	} finally { await host.close(); }
});

test("preparation refuses occupied/reserved handles and pre-aborted or closed lifetimes", async () => {
	const bus = new InProcessBus();
	const { host, server } = await startHost(bus);
	try {
		await host.prepareResultReader("reserved", reader());
		await assert.rejects(host.prepareResultReader("reserved", reader()));
		host.expect("already-expected");
		await assert.rejects(host.prepareResultReader("already-expected", reader()));
		const c = connectClient(server);
		c.send({ t: "register", handle: "occupied" });
		await assert.rejects(host.prepareResultReader("occupied", reader()));
		bus.register("local");
		await assert.rejects(host.prepareResultReader("local", reader()));
		await assert.rejects(host.prepareResultReader("supervisor", reader()));
		const r = reader();
		await assert.rejects(host.prepareResultReader("aborted", r, AbortSignal.abort()));
		assert.equal(r.revocations(), 1);
	} finally { await host.close(); }
	await assert.rejects(host.prepareResultReader("closed", reader()));
});

test("malformed reader frames and callback failures cannot echo secrets or metadata", async () => {
	const { host, server } = await startHost(new InProcessBus());
	try {
		const grant = await host.prepareResultReader("reader", reader(async () => { throw new Error("secret-path"); }));
		const c = connectClient(server);
		c.send({ t: "register", handle: "reader", readerToken: grant.token });
		c.send({ t: "result_read", reqId: randomUUID(), ref: resultRef });
		await tick();
		assert.equal(JSON.stringify(c.frames.slice(1)).includes("secret-path"), false);
		const malformed = connectClient(server);
		const data = Buffer.from(`{"t":"register", "readerToken":"${grant.token}" BROKEN`);
		const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
		malformed.client.write(Buffer.concat([header, data]));
		assert.equal(JSON.stringify(malformed.frames).includes(grant.token), false);
		const badShape = connectClient(server);
		badShape.client.write(encodeFrame({ t: "result_read", reqId: randomUUID(), ref: resultRef, path: "secret-path" }));
		assert.equal(JSON.stringify(badShape.frames).includes("secret-path"), false);
	} finally { await host.close(); }
});

test("a registered remote handle receives a deliver frame when the supervisor bus.sends to it", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const { send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "registered"));

		bus.send("supervisor", "child#1", "keep going");
		await waitFor(() => frames.some((f) => f.t === "deliver"));

		const deliver = frames.find((f) => f.t === "deliver");
		assert.ok(deliver && deliver.t === "deliver");
		assert.equal(deliver.from, "supervisor");
		assert.equal(deliver.text, "keep going");
		assert.equal(deliver.expectsReply, false);
	} finally {
		await host.close();
	}
});

test("a client send frame lands in the supervisor's bus inbox", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const { send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "registered"));

		send({ t: "send", to: "supervisor", kind: "progress", text: "halfway there", msgId: "m1", expectsReply: false });
		await waitFor(() => bus.hasPending("supervisor"));

		const [env] = bus.take("supervisor");
		assert.equal(env?.from, "child#1");
		assert.equal(env?.text, "halfway there");
		assert.equal(env?.expectsReply, false);
	} finally {
		await host.close();
	}
});

test("a client send{expectsReply} resolves via bus.reply and the client gets a replied frame", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const { send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "registered"));

		send({ t: "send", to: "supervisor", kind: "decision", text: "left or right?", msgId: "m1", expectsReply: true });
		await waitFor(() => bus.hasPending("supervisor"));

		const [env] = bus.take("supervisor");
		assert.ok(env);
		assert.equal(env?.expectsReply, true);
		assert.equal(bus.reply(env!.id, "left"), true);

		await waitFor(() => frames.some((f) => f.t === "replied"));
		const replied = frames.find((f) => f.t === "replied");
		assert.ok(replied && replied.t === "replied");
		assert.equal(replied.askId, "m1");
		assert.equal(replied.text, "left");
	} finally {
		await host.close();
	}
});

test("a synchronous bus.ask rejection is correlated to the originating client ask", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const { send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "registered"));

		send({ t: "send", to: "nobody", kind: "decision", text: "?", msgId: "m-unknown", expectsReply: true });
		await waitFor(() => frames.some((f) => f.t === "error" && f.msgId === "m-unknown"));
		const error = frames.find((f) => f.t === "error" && f.msgId === "m-unknown");
		assert.ok(error && error.t === "error");
		assert.match(error.reason, /unknown peer/);
	} finally {
		await host.close();
	}
});

test("a full supervisor inbox returns a correlated ask error instead of stranding the client", async () => {
	const bus = new InProcessBus({ maxInbox: 1 });
	bus.register("supervisor");
	const blockerAbort = new AbortController();
	const blocker = bus.ask("local", "supervisor", "already occupied", { signal: blockerAbort.signal });
	const { host, server } = await startHost(bus);
	try {
		const { send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "registered"));
		send({ t: "send", to: "supervisor", kind: "decision", text: "?", msgId: "m-full", expectsReply: true });
		await waitFor(() => frames.some((f) => f.t === "error" && f.msgId === "m-full"));
		const error = frames.find((f) => f.t === "error" && f.msgId === "m-full");
		assert.ok(error && error.t === "error");
		assert.match(error.reason, /inbox full/);
	} finally {
		blockerAbort.abort();
		await assert.rejects(() => blocker, /abort/);
		await host.close();
	}
});

test("cancel aborts only the pending ask owned by that registered connection", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const first = connectClient(server);
		first.send({ t: "register", handle: "child#1" });
		await waitFor(() => first.frames.some((f) => f.t === "registered"));
		const second = connectClient(server);
		second.send({ t: "register", handle: "child#2" });
		await waitFor(() => second.frames.some((f) => f.t === "registered"));

		first.send({ t: "send", to: "supervisor", kind: "decision", text: "continue?", msgId: "m-owned", expectsReply: true });
		await waitFor(() => bus.pending("supervisor").some((env) => env.expectsReply));
		second.send({ t: "cancel", msgId: "m-owned" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(bus.pending("supervisor").some((env) => env.expectsReply), true, "a different connection cannot cancel the ask");
		const ask = bus.pending("supervisor").find((env) => env.expectsReply);
		assert.ok(ask);
		assert.equal(bus.reply(ask.id, "yes"), true);
		await waitFor(() => first.frames.some((f) => f.t === "replied" && f.askId === "m-owned"));
		assert.equal(second.frames.some((f) => f.t === "error" && f.msgId === "m-owned"), false);

		first.send({ t: "send", to: "supervisor", kind: "decision", text: "cancel me", msgId: "m-cancel", expectsReply: true });
		await waitFor(() => bus.pending("supervisor").some((env) => env.expectsReply));
		first.send({ t: "cancel", msgId: "m-cancel" });
		await waitFor(() => first.frames.some((f) => f.t === "error" && f.msgId === "m-cancel"));
		assert.equal(bus.pending("supervisor").some((env) => env.expectsReply), false, "the owning connection cancels its ask");
	} finally {
		await host.close();
	}
});

test("list returns the peer registry via a peers frame, scoped to the caller's group", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const a = connectClient(server);
		a.send({ t: "register", handle: "coder#1", label: "coder", group: "g1", peers: true });
		await waitFor(() => a.frames.some((f) => f.t === "registered"));

		const b = connectClient(server);
		b.send({ t: "register", handle: "reviewer#1", label: "reviewer", group: "g1", peers: true });
		await waitFor(() => b.frames.some((f) => f.t === "registered"));

		// Different group — must not show up in g1's roster.
		const c = connectClient(server);
		c.send({ t: "register", handle: "other#1", label: "other", group: "g2", peers: true });
		await waitFor(() => c.frames.some((f) => f.t === "registered"));

		a.send({ t: "list", reqId: "r1" });
		await waitFor(() => a.frames.some((f) => f.t === "peers"));

		const peers = a.frames.find((f) => f.t === "peers");
		assert.ok(peers && peers.t === "peers");
		assert.equal(peers.reqId, "r1");
		assert.deepEqual(peers.peers, [{ handle: "reviewer#1", label: "reviewer" }]);
	} finally {
		await host.close();
	}
});

test("socket close unregisters the handle from the bus", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const { client, send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "registered"));
		assert.ok(bus.participants().includes("child#1"));

		client.destroy();
		await waitFor(() => !bus.participants().includes("child#1"));
		assert.ok(host.connectedHandles().every((h) => h !== "child#1"));
	} finally {
		await host.close();
	}
});

test("a client cannot register as the reserved supervisor handle", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const { send, frames } = connectClient(server);
		send({ t: "register", handle: "supervisor" });
		await waitFor(() => frames.some((f) => f.t === "error"));
		assert.ok(!host.connectedHandles().includes("supervisor"));
	} finally {
		await host.close();
	}
});

test("a second connection cannot take over an already-registered handle", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const a = connectClient(server);
		a.send({ t: "register", handle: "child#1" });
		await waitFor(() => a.frames.some((f) => f.t === "registered"));

		const b = connectClient(server);
		b.send({ t: "register", handle: "child#1" });
		await waitFor(() => b.frames.some((f) => f.t === "error"));
		assert.ok(!b.frames.some((f) => f.t === "registered"));

		// The intruder going away must not tear down the live registration it collided with.
		b.client.destroy();
		await waitFor(() => host.connectedHandles().length === 1);
		assert.ok(bus.participants().includes("child#1"));
		bus.send("supervisor", "child#1", "still routed");
		await waitFor(() => a.frames.some((f) => f.t === "deliver"));
	} finally {
		await host.close();
	}
});

test("a second register on one socket is rejected instead of leaking the first handle", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const { client, send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "registered"));

		send({ t: "register", handle: "child#2" });
		await waitFor(() => frames.some((f) => f.t === "error"));
		assert.ok(!bus.participants().includes("child#2"));

		client.destroy();
		await waitFor(() => host.connectedHandles().length === 0);
		assert.ok(!bus.participants().includes("child#1"), "the first handle is not left behind");
	} finally {
		await host.close();
	}
});

test("a socket that already said bye cannot unregister the handle a later connection claimed", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const a = connectLingeringClient(server);
		a.send({ t: "register", handle: "child#1" });
		await waitFor(() => a.frames.some((f) => f.t === "registered"));

		// `bye` releases the handle immediately, but the socket's own `close` comes later —
		// `handle` stays set on this connection, so its belated cleanup must not fire blind.
		a.send({ t: "bye" });
		await waitFor(() => host.connectedHandles().length === 0);

		const b = connectClient(server);
		b.send({ t: "register", handle: "child#1" });
		await waitFor(() => b.frames.some((f) => f.t === "registered"));

		a.serverSide.destroy(); // the departed socket finally closes
		await new Promise((r) => setTimeout(r, 5));

		assert.deepEqual(host.connectedHandles(), ["child#1"], "the new owner keeps the handle");
		assert.ok(bus.participants().includes("child#1"));
		bus.send("supervisor", "child#1", "still routed");
		await waitFor(() => b.frames.some((f) => f.t === "deliver"));
	} finally {
		await host.close();
	}
});

test("steer writes a steer frame directly to the connected handle (not via the bus)", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		const { send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "registered"));

		assert.equal(host.steer("child#1", "focus on the install section"), true);
		await waitFor(() => frames.some((f) => f.t === "steer"));
		const steer = frames.find((f) => f.t === "steer");
		assert.ok(steer && steer.t === "steer");
		assert.equal(steer.text, "focus on the install section");
		assert.ok(!bus.hasPending("supervisor"), "steer bypasses the bus entirely");
	} finally {
		await host.close();
	}
});

test("steer on an unconnected handle is a harmless no-op (returns false)", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host } = await startHost(bus);
	try {
		assert.equal(host.steer("nobody-here", "x"), false);
	} finally {
		await host.close();
	}
});

test("steer to an expect()ed handle buffers until register, then flushes", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		host.expect("child#1");
		assert.equal(host.steer("child#1", "focus on tests"), true, "spawn→connect is delivered, not lost");
		const { send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "steer"));
		const steer = frames.find((f) => f.t === "steer");
		assert.ok(steer && steer.t === "steer");
		assert.equal(steer.text, "focus on tests");
	} finally {
		await host.close();
	}
});

test("forget() drops a buffered steer so a failed spawn is not reported as delivered later", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	try {
		host.expect("child#1");
		assert.equal(host.steer("child#1", "stale"), true);
		host.forget("child#1");
		assert.equal(host.steer("child#1", "again"), false);
		const { send, frames } = connectClient(server);
		send({ t: "register", handle: "child#1" });
		await waitFor(() => frames.some((f) => f.t === "registered"));
		assert.equal(frames.some((f) => f.t === "steer"), false);
	} finally {
		await host.close();
	}
});

test("close() is idempotent and unregisters all still-connected handles", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const { host, server } = await startHost(bus);
	const { send, frames } = connectClient(server);
	send({ t: "register", handle: "child#1" });
	await waitFor(() => frames.some((f) => f.t === "registered"));

	await host.close();
	assert.ok(!bus.participants().includes("child#1"));
	await host.close(); // must not throw
});
