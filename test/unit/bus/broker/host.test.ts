import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

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
