import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { InProcessBus } from "../../src/bus/inproc.ts";
import { makeBrokerClient } from "../../src/bus/broker/client.ts";
import { startBrokerHost } from "../../src/bus/broker/host.ts";
import { brokerEndpoint } from "../../src/bus/broker/paths.ts";

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
