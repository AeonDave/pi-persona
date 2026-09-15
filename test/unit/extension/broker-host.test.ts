import { test } from "node:test";
import assert from "node:assert/strict";

import type { BrokerHost } from "../../../src/bus/broker/host.ts";
import { InProcessBus } from "../../../src/bus/inproc.ts";
import { SupervisorBroker } from "../../../src/extension/broker-host.ts";

function fakeHost(endpoint: string) {
	const expected: string[] = [];
	const steers: Array<[string, string]> = [];
	const host: BrokerHost = {
		endpoint,
		close: async () => {},
		connectedHandles: () => [],
		steer: (h, t) => { steers.push([h, t]); return true; },
		expect: (h) => { expected.push(h); },
		forget: () => {},
	};
	return { host, expected, steers };
}

function make(start: () => Promise<BrokerHost>) {
	const warnings: string[] = [];
	let starts = 0;
	const broker = new SupervisorBroker({
		bus: new InProcessBus(),
		supervisorHandle: "supervisor",
		startHost: async () => { starts++; return start(); },
		warn: (m) => warnings.push(m),
	});
	return { broker, warnings, starts: () => starts };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("a failed host start warns the user once, withholds the endpoint from children, and reports in doctor", async () => {
	const { broker, warnings, starts } = make(async () => { throw new Error("broker host: failed to listen on /x (EADDRINUSE)"); });
	const first = broker.adapterDeps("/x");
	await settle();
	assert.ok(first, "the first build cannot know yet — it gets the endpoint");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /child-agent bus unavailable — .*EADDRINUSE/);
	assert.match(warnings[0] ?? "", /without live steer/);
	assert.equal(broker.adapterDeps("/x"), undefined, "while failed, children spawn without a bus endpoint");
	await settle();
	assert.equal(starts(), 2, "the next build retries the start");
	assert.equal(warnings.length, 1, "one warning per failure streak");
	assert.match(broker.doctorLine(), /broker: on — failed — .*EADDRINUSE/);
});

test("a successful start after a failure clears the error and hands the endpoint out again", async () => {
	let fail = true;
	const { host, expected } = fakeHost("/x");
	const { broker } = make(async () => { if (fail) throw new Error("EACCES"); return host; });
	broker.adapterDeps("/x");
	await settle();
	fail = false;
	broker.adapterDeps("/x"); // retries; still withheld this build
	await settle();
	assert.equal(broker.error, undefined);
	const deps = broker.adapterDeps("/x");
	assert.ok(deps);
	deps.register({ handle: "child#1" });
	assert.deepEqual(expected, ["child#1"]);
	assert.match(broker.doctorLine(), /endpoint \/x/);
});

test("steers queued before the host is up are flushed on start and refused once the start failed", async () => {
	let release!: (h: BrokerHost) => void;
	const pending = new Promise<BrokerHost>((r) => { release = r; });
	const { host, steers } = fakeHost("/x");
	const { broker } = make(() => pending);
	const deps = broker.adapterDeps("/x");
	assert.ok(deps);
	deps.register({ handle: "child#1" });
	assert.equal(deps.steerFrame("child#1", "go left"), true, "buffered while starting");
	assert.equal(deps.steerFrame("nobody", "x"), false, "never expected → refused");
	release(host);
	await settle();
	assert.deepEqual(steers, [["child#1", "go left"]]);
});

test("close tears the host down and forgets the peers", async () => {
	let closed = 0;
	const { host } = fakeHost("/x");
	host.close = async () => { closed++; };
	const { broker } = make(async () => host);
	const deps = broker.adapterDeps("/x");
	deps?.register({ handle: "child#1", peers: true, label: "coder", group: "g" });
	await settle();
	assert.equal(broker.peers.size, 1);
	await broker.close();
	assert.equal(closed, 1);
	assert.equal(broker.peers.size, 0);
	assert.equal(broker.host, undefined);
});
