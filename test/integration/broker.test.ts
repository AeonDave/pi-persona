import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import nodeNet from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

import { InProcessBus } from "../../src/bus/inproc.ts";
import { makeBrokerClient } from "../../src/bus/broker/client.ts";
import { encodeFrame } from "../../src/bus/broker/framing.ts";
import { type BrokerHost, startBrokerHost } from "../../src/bus/broker/host.ts";
import { brokerEndpoint } from "../../src/bus/broker/paths.ts";
import { preparePrivateEndpointDir } from "../../src/bus/endpoint.ts";
import { tryFileClaim } from "../../src/io/file-claim.ts";
import { SupervisorBroker } from "../../src/extension/broker-host.ts";
import { readFailure, type ReadReply, type ScopedReader } from "../../src/bus/result-reader.ts";

/** The supervisor side of a spawn: record the child and mint its one-shot token. */
function expectChild(host: BrokerHost, handle: string): string {
	const token = randomBytes(32).toString("hex");
	host.expect(handle, { token });
	return token;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

test("authenticated scoped result reads over REAL socket/pipe preserve maximum escaped pages and deny ungranted refs", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	preparePrivateEndpointDir(endpoint, "broker");
	const bus = new InProcessBus();
	const broker = new SupervisorBroker({ bus, supervisorHandle: "supervisor", warn: () => assert.fail("unexpected bind failure") });
	broker.ensure(endpoint);
	const ref = `result:${randomUUID()}`;
	let body = "";
	let revoked = 0;
	const reader: ScopedReader = { read: async (request) => request.ref !== ref ? readFailure("denied") : ({
		ok: true, ref, body, offset: 0, storedChars: body.length, originalChars: body.length,
		truncated: false, endOfStoredBody: true, status: "done", provenance: "result-output",
	}), revoke: () => { revoked++; } };
	const grant = await broker.prepareResultReader("reader", reader);
	const token = broker.adapterDeps(endpoint)!.register({ handle: "reader" });
	const client = makeBrokerClient({ endpoint, handle: "reader", token, readerToken: grant.token });
	const impersonator = makeBrokerClient({ endpoint, handle: "reader", token: "f".repeat(64) });
	try {
		await assert.rejects(impersonator.register(), /authentication/);
		assert.equal(grant.wasBound(), false);
		await client.register();
		assert.equal(grant.wasBound(), true);
		for (body of ["\0".repeat(16000), "\ud800".repeat(16000), "\"\\\n\r".repeat(4000), "😀".repeat(8000)]) {
			const result = await client.read({ ref, limit: 16000 });
			assert.ok(result.ok);
			assert.equal(result.body, body);
		}
		assert.deepEqual(await client.read({ ref: `result:${randomUUID()}` }), readFailure("denied"));
		grant.revoke();
		await waitFor(() => !broker.host?.connectedHandles().includes("reader"));
		assert.deepEqual(await client.read({ ref }), readFailure("unavailable"));
		assert.equal(revoked, 1);
	} finally { impersonator.close(); client.close(); await broker.close(); }
});

test("REAL reader cancellation reaches the callback; host close settles all pending reads", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	preparePrivateEndpointDir(endpoint, "broker");
	const host = await startBrokerHost({ endpoint, bus: new InProcessBus(), supervisorHandle: "supervisor" });
	const signals: AbortSignal[] = [];
	const resolvers: Array<(reply: ReadReply) => void> = [];
	const grant = await host.prepareResultReader("reader", { read: (_request, signal) => {
		signals.push(signal!); return new Promise((resolve) => { resolvers.push(resolve); });
	}, revoke: () => {} });
	const client = makeBrokerClient({ endpoint, handle: "reader", token: expectChild(host, "reader"), readerToken: grant.token });
	try {
		await client.register();
		const ref = `result:${randomUUID()}`;
		const ac = new AbortController();
		const first = client.read({ ref }, ac.signal);
		await waitFor(() => signals.length === 1);
		ac.abort();
		assert.deepEqual(await first, readFailure("cancelled"));
		await waitFor(() => signals[0]!.aborted);
		const second = client.read({ ref });
		await waitFor(() => signals.length === 2);
		await host.close();
		assert.deepEqual(await second, readFailure("unavailable"));
		assert.equal(signals[1]?.aborted, true);
		for (const resolve of resolvers) resolve(readFailure("denied"));
	} finally { client.close(); await host.close(); }
});

test("a duplicate broker fails reader preparation and leaves the incumbent reachable", async (t) => {
	const endpoint = brokerEndpoint(randomUUID());
	preparePrivateEndpointDir(endpoint, "broker");
	const bus = new InProcessBus();
	bus.register("supervisor");
	const host = await startBrokerHost({ endpoint, bus, supervisorHandle: "supervisor" });
	const client = makeBrokerClient({ endpoint, handle: "child", token: expectChild(host, "child") });
	const otherBus = new InProcessBus();
	const subscribe = otherBus.onMessage.bind(otherBus);
	let activeSubscriptions = 0;
	t.mock.method(otherBus, "onMessage", (listener: Parameters<InProcessBus["onMessage"]>[0]) => {
		activeSubscriptions++;
		const unsubscribe = subscribe(listener);
		return () => { unsubscribe(); activeSubscriptions--; };
	});
	const other = new SupervisorBroker({ bus: otherBus, supervisorHandle: "supervisor", warn: () => {} });
	try {
		other.ensure(endpoint);
		let revoked = false;
		await assert.rejects(other.prepareResultReader("reader", { read: async () => assert.fail("no read"), revoke: () => { revoked = true; } }), /preparation/);
		assert.equal(revoked, true);
		await other.close();
		// A separately resumed Pi process sees the same production endpoint.
		const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
			import { startBrokerHost } from "./src/bus/broker/host.ts";
			import { InProcessBus } from "./src/bus/inproc.ts";
			try {
				const host = await startBrokerHost({ endpoint: process.argv[1], supervisorHandle: "supervisor", bus: new InProcessBus() });
				await host.close();
			} catch (error) { console.log(error.message); }
		`, endpoint], { windowsHide: true, timeout: 10_000 });
		assert.match(stdout, /EADDRINUSE/);
		assert.deepEqual(host.connectedHandles(), []);
		await client.register();
		assert.equal(await client.send("supervisor", "progress", "incumbent still reachable"), true);
		assert.equal(bus.take("supervisor")[0]?.text, "incumbent still reachable");
		assert.equal(activeSubscriptions, 0, "the rejected host retained no subscription to its own bus");
	} finally { client.close(); await other.close(); await host.close(); }
});

if (process.platform !== "win32") {
	test("only one process may reclaim an orphaned Unix socket at a time", async () => {
		const endpoint = brokerEndpoint(randomUUID());
		preparePrivateEndpointDir(endpoint, "broker");
		execFileSync(process.execPath, ["-e",
			'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', endpoint],
		{ timeout: 10_000 });
		const start = () => startBrokerHost({ endpoint, bus: new InProcessBus(), supervisorHandle: "supervisor" });
		const release = tryFileClaim(dirname(endpoint), basename(endpoint))!;
		let host: BrokerHost | undefined;
		try {
			try {
				await assert.rejects(async () => { host = await start(); }, /EADDRINUSE/);
				assert.ok(statSync(endpoint).isSocket());
			} finally { release(); }
			host = await start();
			const client = makeBrokerClient({ endpoint, handle: "worker", token: expectChild(host, "worker") });
			try { await client.register(); } finally { client.close(); }
		} finally { await host?.close(); rmSync(endpoint, { force: true }); }
	});

	test("broker bind preserves a regular file at the Unix socket path", async () => {
		const endpoint = brokerEndpoint(randomUUID());
		preparePrivateEndpointDir(endpoint, "broker");
		writeFileSync(endpoint, "occupied by a regular file", { flag: "wx" });
		let unexpected: BrokerHost | undefined;
		try {
			await assert.rejects(async () => {
				unexpected = await startBrokerHost({ endpoint, bus: new InProcessBus(), supervisorHandle: "supervisor" });
			}, /EADDRINUSE/);
			assert.equal(readFileSync(endpoint, "utf8"), "occupied by a regular file");
		} finally { await unexpected?.close(); rmSync(endpoint, { force: true }); }
	});
}

test("closing a broker preserves the successor listener at its released endpoint", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	preparePrivateEndpointDir(endpoint, "broker");
	const successor = nodeNet.createServer((socket) => socket.end("successor"));
	const net = {
		...nodeNet,
		createServer() {
			const server = nodeNet.createServer();
			// Bind the successor as soon as the OS releases the endpoint, before host.close() returns.
			server.once("close", () => successor.listen(endpoint));
			return server;
		},
	};
	const host = await startBrokerHost({ endpoint, bus: new InProcessBus(), supervisorHandle: "supervisor", net });
	try {
		const rebound = once(successor, "listening");
		await host.close();
		await rebound;
		const socket = nodeNet.connect(endpoint);
		try {
			const [data] = await once(socket, "data");
			assert.equal(data.toString(), "successor");
		} finally { socket.destroy(); }
	} finally {
		await host.close();
		if (successor.listening) await new Promise<void>((resolve) => successor.close(() => resolve()));
	}
});

// A REAL socket/pipe round-trip (host.test.ts/client.test.ts both use an in-memory fake `net`
// — the transport-injection seam — so THIS is the only place the real cross-process wire is
// exercised end to end). A per-run random session id keeps concurrent test runs collision-free.
test("broker round-trip over a REAL socket/pipe: register, send, deliver, steer, close", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	preparePrivateEndpointDir(endpoint, "broker");

	const bus = new InProcessBus();
	bus.register("supervisor");
	const host = await startBrokerHost({ bus, supervisorHandle: "supervisor", endpoint });
	const client = makeBrokerClient({ endpoint, handle: "child#1", token: expectChild(host, "child#1") });
	try {
		await client.register();
		assert.ok(bus.participants().includes("child#1"), "register proxies bus.register on the host's local bus");

		client.send("supervisor", "progress", "on my way");
		await waitFor(() => bus.hasPending("supervisor"));
		const [env] = bus.take("supervisor");
		assert.equal(env?.from, "child#1");
		assert.equal(env?.text, "on my way");

		const delivered: string[] = [];
		client.onDeliver((evt) => delivered.push(evt.text));
		bus.send("supervisor", "child#1", "keep going");
		await waitFor(() => delivered.length > 0);
		assert.deepEqual(delivered, ["keep going"]);

		const steered: string[] = [];
		client.onSteer((text) => steered.push(text));
		assert.equal(host.steer("child#1", "focus on the install section"), true);
		await waitFor(() => steered.length > 0);
		assert.deepEqual(steered, ["focus on the install section"]);
	} finally {
		client.close();
		await waitFor(() => !bus.participants().includes("child#1"));
		await host.close();
	}
});

test("REAL one-way receipts distinguish bus admission from a full or missing inbox", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	preparePrivateEndpointDir(endpoint, "broker");
	const bus = new InProcessBus({ maxInbox: 1 });
	bus.register("supervisor");
	const host = await startBrokerHost({ bus, supervisorHandle: "supervisor", endpoint });
	const client = makeBrokerClient({ endpoint, handle: "child", token: expectChild(host, "child") });
	const ac = new AbortController();
	let ask: Promise<unknown> | undefined;
	try {
		await client.register();
		assert.equal(await client.send("supervisor", "progress", "accepted"), true);
		assert.equal(bus.take("supervisor")[0]?.text, "accepted");
		ask = bus.ask("other", "supervisor", "pending decision", { signal: ac.signal }).catch(() => {});
		assert.equal(bus.send("other", "supervisor", "full"), false);
		assert.equal(await client.send("supervisor", "progress", "full"), false);
		assert.equal(await client.send("absent", "progress", "missing"), false);
		assert.equal(bus.pending("supervisor")[0]?.text, "pending decision", "the receipt cannot evict an outstanding ask");
		ac.abort();
		await ask;
		assert.equal(await client.send("supervisor", "decision", "one-way unresolved choice"), true);
		assert.equal(bus.pending("supervisor")[0]?.expectsReply, false, "admission does not create a blocking obligation or authorize the choice");
	} finally { ac.abort(); await ask; client.close(); await host.close(); }
});

test("broker ask cancellation over a REAL socket/pipe settles the host-side ask", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	preparePrivateEndpointDir(endpoint, "broker");

	const bus = new InProcessBus();
	bus.register("supervisor");
	const host = await startBrokerHost({ bus, supervisorHandle: "supervisor", endpoint });
	const client = makeBrokerClient({ endpoint, handle: "child#cancel", token: expectChild(host, "child#cancel") });
	try {
		await client.register();
		const ac = new AbortController();
		const pending = client.ask("supervisor", "decision", "cancel me", ac.signal);
		await waitFor(() => bus.pending("supervisor").some((env) => env.expectsReply));
		ac.abort();
		await assert.rejects(() => pending, /abort/);
		await waitFor(() => !bus.pending("supervisor").some((env) => env.expectsReply));
	} finally {
		client.close();
		await waitFor(() => !bus.participants().includes("child#cancel"));
		await host.close();
	}
});

// ── contact_peer roster scoping (spec B7): the roster is what the supervisor recorded at
// spawn (`SupervisorBroker` → `host.expect`), scoped to the caller's own run; nothing the
// child sends on the wire can widen it. ─────────────────────────────────────────────────

test("broker `list` over a REAL socket/pipe: two peer-enabled clients in the same group see each other; a concurrent second group doesn't leak", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	const bus = new InProcessBus();
	bus.register("supervisor");
	const broker = new SupervisorBroker({ bus, supervisorHandle: "supervisor", warn: () => assert.fail("unexpected bind failure") });
	const deps = broker.adapterDeps(endpoint)!;
	const tokenA = deps.register({ handle: "scout#1", label: "scout#1", group: "run-a", peers: true });
	const tokenB = deps.register({ handle: "reviewer#2", label: "reviewer#2 (SECURITY)", group: "run-a", peers: true });
	const tokenC = deps.register({ handle: "scout#3", label: "scout#3", group: "run-b", peers: true });
	const clientA = makeBrokerClient({ endpoint, handle: "scout#1", token: tokenA });
	const clientB = makeBrokerClient({ endpoint, handle: "reviewer#2", token: tokenB });
	const clientC = makeBrokerClient({ endpoint, handle: "scout#3", token: tokenC });
	try {
		await Promise.all([clientA.register(), clientB.register(), clientC.register()]);
		assert.deepEqual(await clientA.list(), [{ handle: "reviewer#2", label: "reviewer#2 (SECURITY)" }], "scout#1 sees only its own-group peer");
		assert.deepEqual(await clientB.list(), [{ handle: "scout#1", label: "scout#1" }], "reviewer#2 sees only its own-group peer");
		assert.deepEqual(await clientC.list(), [], "the concurrent second group's sole member sees no cross-group leak");
		assert.equal(await clientA.send("scout#3", "progress", "cross-run"), false, "the host refuses a cross-run send");
		assert.equal(await clientA.send("reviewer#2", "progress", "same run"), true);
	} finally {
		clientA.close();
		clientB.close();
		clientC.close();
		await broker.close();
	}
});

/** A raw wire client: the frames it receives and whether the host closed it. */
function rawClient(endpoint: string) {
	const socket = nodeNet.connect(endpoint);
	const state = { closed: false, data: "" };
	socket.on("data", (chunk) => { state.data += chunk.toString("utf8"); });
	socket.on("error", () => {});
	socket.on("close", () => { state.closed = true; });
	const ready = new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	return { socket, state, ready };
}

test("REAL registration needs the supervisor's token: a squatter is cut off and the real child still connects", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	preparePrivateEndpointDir(endpoint, "broker");
	const bus = new InProcessBus();
	bus.register("supervisor");
	const host = await startBrokerHost({ bus, supervisorHandle: "supervisor", endpoint });
	const token = expectChild(host, "child#1");
	const squatter = rawClient(endpoint);
	const client = makeBrokerClient({ endpoint, handle: "child#1", token });
	try {
		await squatter.ready;
		squatter.socket.write(encodeFrame({ t: "register", handle: "child#1", token: "f".repeat(64) }));
		await waitFor(() => squatter.state.closed);
		assert.match(squatter.state.data, /authentication failed/);
		assert.equal(bus.participants().includes("child#1"), false);
		await client.register();
		assert.deepEqual(host.connectedHandles(), ["child#1"]);
	} finally { squatter.socket.destroy(); client.close(); await host.close(); }
});

test("REAL client frames over 64 KiB close the connection even from a registered client", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	preparePrivateEndpointDir(endpoint, "broker");
	const host = await startBrokerHost({ bus: new InProcessBus(), supervisorHandle: "supervisor", endpoint });
	const token = expectChild(host, "child#1");
	const raw = rawClient(endpoint);
	try {
		await raw.ready;
		raw.socket.write(encodeFrame({ t: "register", handle: "child#1", token }));
		await waitFor(() => raw.state.data.includes("registered"));
		// Well-formed JSON of a known type; an invalid frame alone would leave a registered socket open,
		// so only the frame-size cap can close it.
		raw.socket.write(encodeFrame({ t: "send", to: "supervisor", kind: "progress", text: "x".repeat(70 * 1024), msgId: randomUUID(), expectsReply: false }));
		await waitFor(() => raw.state.closed);
	} finally { raw.socket.destroy(); await host.close(); }
});

test("the REAL endpoint lives in a private directory under the temp dir (POSIX) or a named pipe (Windows)", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	const broker = new SupervisorBroker({ bus: new InProcessBus(), supervisorHandle: "supervisor", warn: () => assert.fail("unexpected bind failure") });
	try {
		broker.ensure(endpoint);
		await waitFor(() => broker.host !== undefined);
		if (process.platform === "win32") {
			assert.match(endpoint, /^\\\\\.\\pipe\\pi-persona-/);
		} else {
			assert.equal(dirname(dirname(endpoint)), tmpdir());
			assert.equal(statSync(dirname(endpoint)).mode & 0o777, 0o700);
			assert.equal(statSync(endpoint).mode & 0o777, 0o600);
		}
	} finally { await broker.close(); }
});
