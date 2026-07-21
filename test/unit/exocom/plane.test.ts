import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { endpoint } from "../../../src/exocom/paths.ts";
import { ExocomPlane } from "../../../src/exocom/plane.ts";
import { registryEntryFixture, writeEntry } from "../../../src/exocom/registry.ts";
import type { ExocomMessage } from "../../../src/exocom/envelope.ts";

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "exo-plane-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

let seq = 0;

// Cross-platform endpoint (POSIX socket file / Windows named pipe via `paths.endpoint`) —
// this box is win32, so building it via `endpoint()` (rather than hardcoding a `.sock` path
// and skipping) exercises the real transport here instead of skipping it.
function planeFor(name: string, inbox: (m: ExocomMessage) => void) {
	const session_id = `sid-${name}-${process.pid}-${seq++}`;
	return new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id, name, persona: name, purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", session_id, process.platform), cwd: "/",
		},
		getCard: () => ({ name, persona: name, model: "m", context_pct: 0, inbox: 0 }),
		onInbound: (m) => inbox(m),
	});
}

test("a message from one plane lands as inbound on another; list shows the peer", async () => {
	const got: ExocomMessage[] = [];
	const a = planeFor("elite", () => {});
	const b = planeFor("dev", (m) => got.push(m));
	await a.start();
	await b.start();
	try {
		assert.ok(a.listPeers().some((p) => p.name === "dev"), "a sees b");
		const { msg_id } = await a.send("dev", "audit src/auth");
		assert.match(msg_id, /.+/);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(got.length, 1);
		assert.equal(got[0]?.text, "audit src/auth");
		assert.equal(got[0]?.from_name, "elite");
	} finally { await a.stop(); await b.stop(); }
});

test("an oversize message spills to an artifact and sends {preview,path} inline (R3)", async () => {
	const got: ExocomMessage[] = [];
	const a = planeFor("elite", () => {});
	const b = planeFor("dev", (m) => got.push(m));
	await a.start();
	await b.start();
	try {
		const big = "x".repeat(20_000);
		await a.send("dev", big);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(got.length, 1);
		const payload = JSON.parse(got[0]?.text ?? "{}") as { preview: string; path: string };
		assert.ok(payload.path.endsWith(".txt"));
		assert.ok(payload.preview.length > 0 && payload.preview.length < big.length);
		assert.equal(readFileSync(payload.path, "utf8"), big, "artifact holds the full text");
	} finally { await a.stop(); await b.stop(); }
});

test("send to an unknown peer rejects instead of hanging", async () => {
	const a = planeFor("elite", () => {});
	await a.start();
	try {
		await assert.rejects(() => a.send("ghost", "hi"), /unknown peer/);
	} finally { await a.stop(); }
});

test("hops increments across a correlated reply (nextHops wiring)", async () => {
	const inboundAtB: ExocomMessage[] = [];
	const inboundAtA: ExocomMessage[] = [];
	const a = planeFor("elite", (m) => inboundAtA.push(m));
	const b = planeFor("dev", (m) => inboundAtB.push(m));
	await a.start();
	await b.start();
	try {
		const { msg_id } = await a.send("dev", "audit please");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(inboundAtB[0]?.hops, 0);
		await b.send("elite", "done", msg_id);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(inboundAtA[0]?.hops, 1, "reply increments hops from the message it answers");
		assert.equal(inboundAtA[0]?.in_reply_to, msg_id);
	} finally { await a.stop(); await b.stop(); }
});

// The ONE real risk in the session_id-keyed refactor: listPeers()'s display-name dedupe and
// send()'s target resolution must go through the SAME helper, or the numbering shown by
// exocom_list could silently diverge from what exocom_send actually resolves.
test("same name, distinct session_id: listPeers() shows displayNames elite/elite#2; .name stays 'elite' on both", async () => {
	const a = planeFor("elite", () => {});
	const b = planeFor("elite", () => {});
	await a.start();
	await b.start();
	try {
		const bFromA = a.listPeers().find((p) => p.name === "elite");
		const aFromB = b.listPeers().find((p) => p.name === "elite");
		assert.ok(bFromA && aFromB, "each sees the other despite the shared name");
		assert.notEqual(bFromA?.session_id, aFromB?.session_id, "distinct session_id");
		assert.notEqual(bFromA?.endpoint, aFromB?.endpoint, "distinct endpoint");
		assert.equal(bFromA?.name, "elite", ".name is display-only and never mutated");
		assert.equal(aFromB?.name, "elite", ".name is display-only and never mutated");
		assert.notEqual(bFromA?.displayName, aFromB?.displayName, "the collision is disambiguated at display time");
		assert.deepEqual([bFromA?.displayName, aFromB?.displayName].sort(), ["elite", "elite#2"]);
	} finally { await a.stop(); await b.stop(); }
});

test("send() resolves a deduped displayName (e.g. elite#2) through the SAME helper listPeers() uses", async () => {
	const gotA: ExocomMessage[] = [];
	const gotB: ExocomMessage[] = [];
	const sessA = `sid-elite-a-${process.pid}-${seq++}`;
	const sessB = `sid-elite-b-${process.pid}-${seq++}`;
	const mk = (session_id: string, onMsg: (m: ExocomMessage) => void) =>
		new ExocomPlane({
			agentDir: dir, hash: "h",
			identity: {
				session_id, name: "elite", persona: "elite", purpose: "", color: "#36F9F6", model: "m",
				endpoint: endpoint(dir, "h", session_id, process.platform), cwd: "/",
			},
			getCard: () => ({ name: "elite", persona: "elite", model: "m", context_pct: 0, inbox: 0 }),
			onInbound: (m) => onMsg(m),
		});
	const a = mk(sessA, (m) => gotA.push(m));
	const b = mk(sessB, (m) => gotB.push(m));
	const c = planeFor("judge", () => {});
	await a.start();
	await b.start();
	await c.start();
	try {
		const second = c.listPeers().find((p) => p.displayName === "elite#2");
		assert.ok(second, "one of the two same-named peers is numbered elite#2 (ordered by session_id)");
		const expectA = second?.session_id === sessA;
		await c.send("elite#2", "hi #2");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(gotA.length, expectA ? 1 : 0, "the RIGHT peer receives it, not just any same-named one");
		assert.equal(gotB.length, expectA ? 0 : 1, "the RIGHT peer receives it, not just any same-named one");
	} finally { await a.stop(); await b.stop(); await c.stop(); }
});

test("stop() removes the registry entry so the peer disappears from others' listPeers", async () => {
	const a = planeFor("elite", () => {});
	const b = planeFor("dev", () => {});
	await a.start();
	await b.start();
	assert.ok(b.listPeers().some((p) => p.name === "elite"));
	await a.stop();
	assert.ok(!b.listPeers().some((p) => p.name === "elite"), "elite gone after stop()");
	await b.stop();
});

test("send()/inbound bump VIEWER-CENTRIC per-peer counters, not a global self-report", async () => {
	const a = planeFor("elite", () => {});
	const b = planeFor("dev", () => {});
	await a.start();
	await b.start();
	try {
		const bSeenFromA = a.listPeers().find((p) => p.name === "dev")!;
		const aSeenFromB = b.listPeers().find((p) => p.name === "elite")!;
		assert.equal(a.sentToPeer(bSeenFromA.session_id), 0);
		assert.equal(a.receivedFromPeer(bSeenFromA.session_id), 0);
		assert.equal(b.sentToPeer(aSeenFromB.session_id), 0);
		assert.equal(b.receivedFromPeer(aSeenFromB.session_id), 0);
		await a.send("dev", "hi");
		await new Promise((r) => setTimeout(r, 100));
		// From A's side: A sent TO dev, never received FROM dev.
		assert.equal(a.sentToPeer(bSeenFromA.session_id), 1, "sender's per-peer sent bumps only once the ack settles");
		assert.equal(a.receivedFromPeer(bSeenFromA.session_id), 0);
		// From B's side: B received FROM elite, never sent TO elite — the inverse of A's view.
		assert.equal(b.receivedFromPeer(aSeenFromB.session_id), 1, "receiver's per-peer received bumps for an inbound message frame");
		assert.equal(b.sentToPeer(aSeenFromB.session_id), 0);
	} finally { await a.stop(); await b.stop(); }
});

test("send() rejects on ack-timeout instead of hanging when a peer accepts but never acks", async () => {
	// A raw peer that accepts the connection and silently swallows the frame — simulates a
	// frozen/wedged process, distinct from a connect-time ECONNREFUSED/ENOENT (R4).
	const frozenSession = `sid-frozen-${process.pid}-${seq++}`;
	const frozenEndpoint = endpoint(dir, "h", frozenSession, process.platform);
	const frozenServer = net.createServer((socket) => {
		socket.on("data", () => { /* never acks */ });
	});
	await new Promise<void>((resolve) => frozenServer.listen(frozenEndpoint, resolve));
	writeEntry(dir, "h", registryEntryFixture({
		session_id: frozenSession, name: "frozen", pid: process.pid, endpoint: frozenEndpoint,
		heartbeat_at: new Date().toISOString(),
	}));

	const senderSession = `sid-elite2-${process.pid}-${seq++}`;
	const sender = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: senderSession, name: "elite2", persona: "elite2", purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", senderSession, process.platform), cwd: "/",
		},
		getCard: () => ({ name: "elite2", persona: "elite2", model: "m", context_pct: 0, inbox: 0 }),
		onInbound: () => {},
		ackTimeoutMs: 80,
	});
	await sender.start();
	try {
		await assert.rejects(() => sender.send("frozen", "hi"), /ack timeout/);
	} finally {
		await sender.stop();
		await new Promise<void>((resolve) => frozenServer.close(() => resolve()));
	}
});
