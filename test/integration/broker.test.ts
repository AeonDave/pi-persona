import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { InProcessBus } from "../../src/bus/inproc.ts";
import { makeBrokerClient } from "../../src/bus/broker/client.ts";
import { startBrokerHost } from "../../src/bus/broker/host.ts";
import { brokerEndpoint } from "../../src/bus/broker/paths.ts";
import { listPeersForGroup } from "../../src/extension.ts";

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

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
