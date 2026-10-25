import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { InProcessBus } from "../../src/bus/inproc.ts";
import { makeBrokerClient } from "../../src/bus/broker/client.ts";
import { startBrokerHost } from "../../src/bus/broker/host.ts";
import { brokerEndpoint } from "../../src/bus/broker/paths.ts";
import { listPeersForGroup, SupervisorBroker } from "../../src/extension/broker-host.ts";
import { readFailure, type ReadReply, type ScopedReader } from "../../src/bus/result-reader.ts";

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

test("authenticated scoped result reads over REAL socket/pipe preserve maximum escaped pages and deny ungranted refs", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true });
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
	const client = makeBrokerClient({ endpoint, handle: "reader", readerToken: grant.token });
	const impersonator = makeBrokerClient({ endpoint, handle: "reader" });
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
	if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true });
	const host = await startBrokerHost({ endpoint, bus: new InProcessBus(), supervisorHandle: "supervisor" });
	const signals: AbortSignal[] = [];
	const resolvers: Array<(reply: ReadReply) => void> = [];
	const grant = await host.prepareResultReader("reader", { read: (_request, signal) => {
		signals.push(signal!); return new Promise((resolve) => { resolvers.push(resolve); });
	}, revoke: () => {} });
	const client = makeBrokerClient({ endpoint, handle: "reader", readerToken: grant.token });
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

test("REAL bind collision fails reader preparation before any child registration", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true });
	const host = await startBrokerHost({ endpoint, bus: new InProcessBus(), supervisorHandle: "supervisor" });
	const other = new SupervisorBroker({ bus: new InProcessBus(), supervisorHandle: "supervisor", warn: () => {} });
	try {
		other.ensure(endpoint);
		let revoked = false;
		await assert.rejects(other.prepareResultReader("reader", { read: async () => assert.fail("no read"), revoke: () => { revoked = true; } }), /preparation/);
		assert.equal(revoked, true);
		assert.deepEqual(host.connectedHandles(), []);
	} finally { await other.close(); await host.close(); }
});

// A REAL socket/pipe round-trip (host.test.ts/client.test.ts both use an in-memory fake `net`
// — the transport-injection seam — so THIS is the only place the real cross-process wire is
// exercised end to end). A per-run random session id keeps concurrent test runs collision-free.
test("broker round-trip over a REAL socket/pipe: register, send, deliver, steer, close", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	// POSIX sockets are filesystem paths — the directory must exist before `listen()` (Windows
	// named pipes are not filesystem-backed, so this is a no-op there in spirit; skipped outright).
	if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true });

	const bus = new InProcessBus();
	bus.register("supervisor");
	const host = await startBrokerHost({ bus, supervisorHandle: "supervisor", endpoint });
	const client = makeBrokerClient({ endpoint, handle: "child#1" });
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
	if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true });
	const bus = new InProcessBus({ maxInbox: 1 });
	bus.register("supervisor");
	const host = await startBrokerHost({ bus, supervisorHandle: "supervisor", endpoint });
	const client = makeBrokerClient({ endpoint, handle: "child" });
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
	if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true });

	const bus = new InProcessBus();
	bus.register("supervisor");
	const host = await startBrokerHost({ bus, supervisorHandle: "supervisor", endpoint });
	const client = makeBrokerClient({ endpoint, handle: "child#cancel" });
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

// ── contact_peer roster scoping (spec B7) — regression coverage for the extension.ts
// `listPeersFor` closure, which must derive scope from `self`'s OWN recorded group (the
// wire's `group` frame field is always unset per spec B6, so scoping by it directly —
// either the host's own default, or a naive echo of the wire value — either always comes
// back empty or leaks every concurrent run's peers into one flat list). ─────────────────

test("listPeersForGroup: two peers in the same group see each other; a caller with no brokerPeers entry gets an empty roster", () => {
	const brokerPeers = new Map<string, { label: string; group: string }>([
		["scout#1", { label: "scout#1", group: "run-a" }],
		["reviewer#2", { label: "reviewer#2 (SECURITY)", group: "run-a" }],
	]);
	assert.deepEqual(listPeersForGroup(brokerPeers, "scout#1"), [{ handle: "reviewer#2", label: "reviewer#2 (SECURITY)" }]);
	assert.deepEqual(listPeersForGroup(brokerPeers, "reviewer#2"), [{ handle: "scout#1", label: "scout#1" }]);
	// Not in `brokerPeers` at all (e.g. registered without `peers: true`) ⇒ empty, not a leak.
	assert.deepEqual(listPeersForGroup(brokerPeers, "ghost#9"), []);
});

test("listPeersForGroup: a concurrent second group never leaks into the first group's roster", () => {
	const brokerPeers = new Map<string, { label: string; group: string }>([
		["scout#1", { label: "scout#1", group: "run-a" }],
		["reviewer#2", { label: "reviewer#2", group: "run-a" }],
		["scout#3", { label: "scout#3", group: "run-b" }],
		["reviewer#4", { label: "reviewer#4", group: "run-b" }],
	]);
	assert.deepEqual(
		listPeersForGroup(brokerPeers, "scout#1").map((p) => p.handle),
		["reviewer#2"],
	);
	assert.deepEqual(
		listPeersForGroup(brokerPeers, "scout#3").map((p) => p.handle),
		["reviewer#4"],
	);
});

// The real cross-process wiring: `brokerPeers` is populated BEFORE spawn (mirroring
// `makeBrokerDeps`'s `register`, called pre-spawn in `adapter.ts`), then TWO real clients in
// the SAME group `list()` each other over the REAL socket/pipe, while a THIRD client in a
// concurrent second group never appears in either roster and sees none of theirs.
test("broker `list` over a REAL socket/pipe: two peer-enabled clients in the same group see each other; a concurrent second group doesn't leak", async () => {
	const endpoint = brokerEndpoint(randomUUID());
	if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true });

	const bus = new InProcessBus();
	bus.register("supervisor");
	const brokerPeers = new Map<string, { label: string; group: string }>();
	const host = await startBrokerHost({
		bus,
		supervisorHandle: "supervisor",
		endpoint,
		listPeersFor: (_group, self) => listPeersForGroup(brokerPeers, self),
	});

	// Same engine instance ("run-a"): scout#1 + reviewer#2, both opted into the roster.
	brokerPeers.set("scout#1", { label: "scout#1", group: "run-a" });
	brokerPeers.set("reviewer#2", { label: "reviewer#2 (SECURITY)", group: "run-a" });
	// A concurrent, unrelated run ("run-b") sharing the ONE host — must never leak either way.
	brokerPeers.set("scout#3", { label: "scout#3", group: "run-b" });

	const clientA = makeBrokerClient({ endpoint, handle: "scout#1", group: "run-a", peers: true });
	const clientB = makeBrokerClient({ endpoint, handle: "reviewer#2", group: "run-a", peers: true });
	const clientC = makeBrokerClient({ endpoint, handle: "scout#3", group: "run-b", peers: true });
	try {
		await Promise.all([clientA.register(), clientB.register(), clientC.register()]);

		const rosterA = await clientA.list();
		assert.deepEqual(rosterA, [{ handle: "reviewer#2", label: "reviewer#2 (SECURITY)" }], "scout#1 sees only its own-group peer");

		const rosterB = await clientB.list();
		assert.deepEqual(rosterB, [{ handle: "scout#1", label: "scout#1" }], "reviewer#2 sees only its own-group peer");

		const rosterC = await clientC.list();
		assert.deepEqual(rosterC, [], "the concurrent second group's sole member sees no cross-group leak");
	} finally {
		clientA.close();
		clientB.close();
		clientC.close();
		await waitFor(() => !bus.participants().includes("scout#1") && !bus.participants().includes("reviewer#2") && !bus.participants().includes("scout#3"));
		await host.close();
	}
});
