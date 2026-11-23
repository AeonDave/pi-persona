import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_PENDING_STEERS, type BrokerHost, type ExpectedChild } from "../../../src/bus/broker/host.ts";
import { InProcessBus } from "../../../src/bus/inproc.ts";
import { SupervisorBroker } from "../../../src/extension/broker-host.ts";
import { readFailure, type ScopedReader } from "../../../src/bus/result-reader.ts";

function fakeHost(endpoint: string) {
	const expected: Array<[string, ExpectedChild]> = [];
	const steers: Array<[string, string]> = [];
	const host: BrokerHost = {
		endpoint,
		close: async () => {},
		connectedHandles: () => [],
		steer: (h, t) => { steers.push([h, t]); return true; },
		expect: (h, info) => { expected.push([h, info]); },
		forget: () => {},
		prepareResultReader: async (_handle, reader) => ({ token: "a".repeat(64), revoke: () => reader.revoke(), wasBound: () => false }),
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

function scopedReader() {
	let revoked = 0;
	const reader: ScopedReader = { read: async () => readFailure("denied"), revoke: () => { revoked++; } };
	return { reader, revocations: () => revoked };
}

test("brokered worker preserves supervisor-assigned sender name through child registration", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const broker = new SupervisorBroker({ bus, supervisorHandle: "supervisor", startHost: async () => fakeHost("/x").host, warn: () => {} });
	const deps = broker.adapterDeps("/x")!;
	deps.register({ handle: "operator#7", label: "Moss" });
	bus.register("operator#7"); // real broker host's client-registration step
	assert.equal(bus.send("operator#7", "supervisor", "hello"), true);
	deps.unregister("operator#7");
	const message = bus.take("supervisor")[0];
	assert.equal(message?.from, "operator#7");
	assert.equal(message?.fromLabel, "Moss");
	await broker.close();
});

test("reader preflight awaits readiness; bind failure cannot return a false preparation", async () => {
	let resolve!: (host: BrokerHost) => void;
	const { broker } = make(() => new Promise((r) => { resolve = r; }));
	broker.ensure("/x");
	let done = false;
	const r = scopedReader();
	const prepared = broker.prepareResultReader("child", r.reader).then((value) => { done = true; return value; });
	await Promise.resolve();
	assert.equal(done, false);
	resolve(fakeHost("/x").host);
	assert.equal((await prepared).wasBound(), false);
	await broker.close();
	const failed = make(async () => { throw new Error("SECRET bind failure"); });
	failed.broker.ensure("/x");
	const denied = scopedReader();
	await assert.rejects(failed.broker.prepareResultReader("child", denied.reader), /^Error: Result reader preparation failed\.$/);
	assert.equal(denied.revocations(), 1);
	await failed.broker.close();
});

test("reader preflight abort/owner close/deadline revoke immediately while bind is unresolved", async (t) => {
	for (const action of ["abort", "close", "timeout"] as const) {
		let resolve!: (host: BrokerHost) => void;
		const { broker } = make(() => new Promise((r) => { resolve = r; }));
		broker.ensure("/x");
		const r = scopedReader();
		const ac = new AbortController();
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pending = broker.prepareResultReader("child", r.reader, ac.signal);
		const assertion = assert.rejects(pending, /Result reader preparation/);
		let closing: Promise<void> | undefined;
		if (action === "abort") ac.abort();
		if (action === "close") closing = broker.close();
		if (action === "timeout") t.mock.timers.tick(10000);
		assert.equal(r.revocations(), 1, action);
		await assertion;
		let preparations = 0;
		const { host } = fakeHost("/x");
		host.prepareResultReader = async () => { preparations++; throw new Error("must not attach"); };
		resolve(host);
		await Promise.resolve(); await Promise.resolve();
		assert.equal(preparations, 0);
		await closing;
		await broker.close();
		t.mock.timers.reset();
	}
});

test("reader preflight without an ensured endpoint fails closed", async () => {
	const { broker } = make(async () => fakeHost("/x").host);
	await assert.rejects(broker.prepareResultReader("child", scopedReader().reader), /preparation/);
});

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
	assert.match(broker.doctorLine(), /^broker: failed — .*EADDRINUSE/, "spec §4.7: \"broker: failed — <reason>\", not the double-dash \"on — failed —\"");
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
	const token = deps.register({ handle: "child#1" });
	assert.deepEqual(expected, [["child#1", { token }]]);
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

test("steers buffered before the host is up obey the host's cap instead of being accepted and then dropped", async () => {
	let release!: (h: BrokerHost) => void;
	const pending = new Promise<BrokerHost>((r) => { release = r; });
	const { host, steers } = fakeHost("/x");
	const { broker } = make(() => pending);
	const deps = broker.adapterDeps("/x");
	assert.ok(deps);
	deps.register({ handle: "child#1" });
	const accepted = Array.from({ length: MAX_PENDING_STEERS + 4 }, (_, i) => deps.steerFrame("child#1", `steer ${i}`));
	assert.equal(accepted.filter(Boolean).length, MAX_PENDING_STEERS, "only what the host will deliver is reported as accepted");
	assert.deepEqual(accepted.slice(MAX_PENDING_STEERS), [false, false, false, false]);
	release(host);
	await settle();
	assert.equal(steers.length, MAX_PENDING_STEERS, "every accepted steer is replayed");
});

test("a start that fails after steers were buffered says how many were dropped", async () => {
	let reject!: (e: Error) => void;
	const pending = new Promise<BrokerHost>((_, r) => { reject = r; });
	const { broker, warnings } = make(() => pending);
	const deps = broker.adapterDeps("/x")!;
	deps.register({ handle: "child#1" });
	deps.steerFrame("child#1", "left"); deps.steerFrame("child#1", "right");
	reject(new Error("EADDRINUSE"));
	await settle();
	assert.match(warnings[0] ?? "", /2 queued steers? were dropped/);
});

test("close tears the host down and forgets what it expected", async () => {
	let closed = 0;
	const { host } = fakeHost("/x");
	host.close = async () => { closed++; };
	const { broker } = make(async () => host);
	const deps = broker.adapterDeps("/x");
	deps?.register({ handle: "child#1", peers: true, label: "coder", group: "g" });
	await settle();
	await broker.close();
	assert.equal(closed, 1);
	assert.equal(broker.host, undefined);
	const next = fakeHost("/x");
	const reopened = make(async () => next.host);
	reopened.broker.adapterDeps("/x");
	await settle();
	assert.deepEqual(next.expected, []);
});

test("register mints a distinct one-shot bus token per child and returns it", async () => {
	const { broker } = make(async () => fakeHost("/x").host);
	const deps = broker.adapterDeps("/x")!;
	const a = deps.register({ handle: "a#1" });
	const b = deps.register({ handle: "b#2" });
	assert.match(a, /^[0-9a-f]{64}$/);
	assert.match(b, /^[0-9a-f]{64}$/);
	assert.notEqual(a, b);
	await broker.close();
});

test("a registration made before the host is up is replayed with its token and roster record; a forgotten one is not", async () => {
	let release!: (h: BrokerHost) => void;
	const { host, expected } = fakeHost("/x");
	const { broker } = make(() => new Promise<BrokerHost>((r) => { release = r; }));
	const deps = broker.adapterDeps("/x")!;
	const token = deps.register({ handle: "coder#1", label: "Coder", group: "run", peers: true });
	deps.register({ handle: "gone#2" });
	deps.unregister("gone#2");
	release(host);
	await settle();
	assert.deepEqual(expected, [["coder#1", { token, label: "Coder", group: "run", peers: true }]]);
	await broker.close();
});

test("an unsafe socket directory is a normal start failure: warned once, children spawn bus-less", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-broker-test-"));
	try {
		const blocker = join(dir, "not-a-dir");
		writeFileSync(blocker, "");
		let starts = 0;
		const warnings: string[] = [];
		const broker = new SupervisorBroker({ bus: new InProcessBus(), supervisorHandle: "supervisor",
			startHost: async () => { starts++; return fakeHost("/x").host; }, warn: (m) => warnings.push(m) });
		broker.adapterDeps(join(blocker, "x.sock"));
		await settle();
		if (process.platform === "win32") {
			assert.equal(starts, 1, "named pipes have no socket directory to prepare");
			assert.deepEqual(warnings, []);
		} else {
			assert.equal(starts, 0, "the host never starts in an unsafe directory");
			assert.equal(warnings.length, 1);
			assert.match(warnings[0] ?? "", /child-agent bus unavailable/);
			assert.equal(broker.adapterDeps(join(blocker, "x.sock")), undefined);
		}
		await broker.close();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
