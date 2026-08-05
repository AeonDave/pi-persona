import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { endpoint, exocomRoot, registryPath } from "../../../src/exocom/paths.ts";
import { ExocomPlane, type ExocomInboundResult } from "../../../src/exocom/plane.ts";
import { readAll, registryEntryFixture, removeEntry, sessionKey, writeEntry, type RegistryEntry } from "../../../src/exocom/registry.ts";
import { frameSigningPayload, type ExocomBye, type ExocomMessage } from "../../../src/exocom/envelope.ts";
import { EXOCOM } from "../../../src/exocom/limits.ts";
import { createFrameReader, encodeFrame } from "../../../src/bus/broker/framing.ts";

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "exo-plane-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

let seq = 0;

// Cross-platform endpoint (POSIX socket file / Windows named pipe via `paths.endpoint`) —
// this box is win32, so building it via `endpoint()` (rather than hardcoding a `.sock` path
// and skipping) exercises the real transport here instead of skipping it.
function planeFor(name: string, inbox: (m: ExocomMessage) => void, decide?: (m: ExocomMessage) => ExocomInboundResult) {
	const session_id = `sid-${name}-${process.pid}-${seq++}`;
	return new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id, name, persona: name, purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", session_id, process.platform), cwd: "/",
		},
		getCard: () => ({ name, persona: name, model: "m", context_pct: 0, inbox: 0 }),
		onInbound: (m) => {
			const disposition = decide?.(m) ?? { accepted: true };
			if (disposition.accepted && disposition.duplicate !== true) inbox(m);
			return disposition;
		},
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

// EXOCOM.ARTIFACT_TTL_MS exists so a DELIVERED spill outlives the sender: the receiver only got
// {preview,path} on the wire and reads `path` on a later idle-gated turn, often after the sender
// has quit. Only a spill whose send never landed is the sender's to reap.
test("a delivered artifact survives the sender's stop()", async () => {
	const got: ExocomMessage[] = [];
	const a = planeFor("spill-sender", () => {});
	const b = planeFor("spill-reader", (m) => got.push(m));
	await a.start();
	await b.start();
	try {
		await a.send("spill-reader", "z".repeat(20_000));
		await new Promise((r) => setTimeout(r, 100));
		const payload = JSON.parse(got[0]?.text ?? "{}") as { path: string };
		await a.stop();
		assert.equal(readFileSync(payload.path, "utf8").length, 20_000, "the receiver can still read the handed-off artifact");
	} finally { await a.stop(); await b.stop(); }
});

// A delivered spill is nobody's to reap until its TTL runs out, and the sweep that enforces that
// TTL only fires on a plane start or the next spill — so the LAST session to use exocom in a
// workspace is the one that has to close the loop, or expired payloads sit there forever.
test("stop() reclaims expired artifacts while leaving a handed-off one for its reader", async () => {
	const got: ExocomMessage[] = [];
	const a = planeFor("ttl-sender", () => {});
	const b = planeFor("ttl-reader", (m) => got.push(m));
	await a.start();
	await b.start();
	try {
		await a.send("ttl-reader", "w".repeat(20_000));
		await new Promise((r) => setTimeout(r, 100));
		const fresh = (JSON.parse(got[0]?.text ?? "{}") as { path: string }).path;

		// An artifact an earlier session handed off and nothing has swept since.
		const expired = join(exocomRoot(dir, "h"), "artifacts", `${randomUUID()}.txt`);
		writeFileSync(expired, "an old payload");
		const aged = (Date.now() - EXOCOM.ARTIFACT_TTL_MS - 60_000) / 1000;
		utimesSync(expired, aged, aged);

		await a.stop();
		assert.equal(existsSync(expired), false, "the expired payload is reclaimed on the way out");
		assert.equal(existsSync(fresh), true, "…while one still inside its TTL is left for the receiver's later turn");
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
			onInbound: (m) => { onMsg(m); return { accepted: true }; },
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
		onInbound: () => ({ accepted: true }),
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

test("send() requires a correlated ACK and rejects invalid signature/session bindings", async () => {
	type ReplyMode = "wrong-id" | "bad-signature" | "bad-session";
	let mode: ReplyMode = "wrong-id";
	const rawSession = `sid-raw-auth-${process.pid}-${seq++}`;
	const rawEndpoint = endpoint(dir, "h", rawSession, process.platform);
	const rawServer = net.createServer((socket) => {
		socket.on("data", createFrameReader(
			(raw) => {
				const incoming = raw as { msg_id?: unknown };
				if (typeof incoming.msg_id !== "string") return;
				const reply = mode === "wrong-id"
					? { kind: "ack", msg_id: "different-message" }
					: { kind: "ack", msg_id: incoming.msg_id, from_session: mode === "bad-session" ? "forged-session" : rawSession, signature: "ZmFrZQ==" };
				socket.write(encodeFrame(reply));
			},
			() => socket.destroy(),
		));
	});
	await new Promise<void>((resolve) => rawServer.listen(rawEndpoint, resolve));
	const advertise = () => writeEntry(dir, "h", registryEntryFixture({
		session_id: rawSession, name: "raw-auth", pid: process.pid, endpoint: rawEndpoint,
		heartbeat_at: new Date().toISOString(), public_key: "cHVi",
	}));
	advertise();
	const sender = planeFor("auth-sender", () => {});
	await sender.start();
	try {
		await assert.rejects(() => sender.send("raw-auth", "one"), /unexpected reply frame/, "wrong ACK msg_id is not success");
		mode = "bad-signature";
		advertise();
		await assert.rejects(() => sender.send("raw-auth", "two"), /unauthenticated ack/, "invalid signature is rejected");
		mode = "bad-session";
		advertise();
		await assert.rejects(() => sender.send("raw-auth", "three"), /unauthenticated ack/, "ACK session must match the registry binding");
	} finally {
		await sender.stop();
		await new Promise<void>((resolve) => rawServer.close(() => resolve()));
	}
});

// An entry can be evicted while its instance is very much alive (a peer's transient send error,
// or a >STALE_AFTER_MS stall making every peer prune it). The next heartbeat then RE-CREATES the
// file, and writeEntry's preserve-from-disk step has nothing to preserve from — so the key must
// come from the plane itself, or the instance stays unauthenticable for the rest of the session.
test("heartbeat re-registration after entry loss keeps this instance authenticable", async () => {
	const got: ExocomMessage[] = [];
	const a = planeFor("key-sender", () => {});
	const b = planeFor("key-loser", (m) => got.push(m));
	await a.start();
	await b.start();
	try {
		const bEntry = a.listPeers().find((p) => p.name === "key-loser")!;
		removeEntry(dir, "h", bEntry.session_id);
		b.heartbeat(registryEntryFixture({
			session_id: bEntry.session_id, name: "key-loser", pid: process.pid, endpoint: bEntry.endpoint,
			heartbeat_at: new Date().toISOString(),
		}));
		await a.send("key-loser", "still authenticable");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(got.length, 1);
	} finally { await a.stop(); await b.stop(); }
});

// `bye` is the one frame that decides ANOTHER entry's fate, so the receiver resolves the claimed
// sender in the registry and checks the signature against the key stored there. Departure is also
// what keeps the pool from filling with entries only the 120s stale sweep would clear.
test("a peer's own signed bye retires its entry and refreshes the pool; a forged one cannot", async () => {
	let poolChanges = 0;
	const receiverSession = `sid-bye-recv-${process.pid}-${seq++}`;
	const receiverEndpoint = endpoint(dir, "h", receiverSession, process.platform);
	const receiver = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: receiverSession, name: "bye-receiver", persona: "", purpose: "", color: "#36F9F6", model: "m",
			endpoint: receiverEndpoint, cwd: "/",
		},
		getCard: () => ({ name: "bye-receiver", persona: "", model: "m", context_pct: 0, inbox: 0 }),
		onInbound: () => ({ accepted: true }),
		onPoolChange: () => { poolChanges += 1; },
	});
	await receiver.start();

	const leaverSession = `sid-bye-leaver-${process.pid}-${seq++}`;
	const leaverKeys = generateKeyPairSync("ed25519");
	const leaver = registryEntryFixture({
		session_id: leaverSession, name: "leaver", pid: process.pid,
		endpoint: endpoint(dir, "h", leaverSession, process.platform),
		heartbeat_at: new Date().toISOString(),
		public_key: leaverKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	});
	const leaverFile = registryPath(dir, "h", sessionKey(leaverSession));

	const sayBye = async (key: KeyObject): Promise<void> => {
		const unsigned: ExocomBye = { kind: "bye", from_session: leaverSession, from_endpoint: leaver.endpoint };
		const frame: ExocomBye = { ...unsigned, signature: cryptoSign(null, Buffer.from(frameSigningPayload(unsigned), "utf8"), key).toString("base64") };
		await new Promise<void>((resolve) => {
			const s = net.connect(receiverEndpoint);
			s.once("connect", () => s.write(encodeFrame(frame), () => s.end()));
			s.once("close", () => resolve());
			s.once("error", () => resolve());
		});
		await new Promise((r) => setTimeout(r, 100));
	};

	try {
		writeEntry(dir, "h", leaver);
		await sayBye(generateKeyPairSync("ed25519").privateKey);
		assert.equal(existsSync(leaverFile), true, "a bye signed by anyone else must not evict the peer it names");
		assert.equal(poolChanges, 0, "…and must not even be reported as a pool change");

		await sayBye(leaverKeys.privateKey);
		assert.equal(existsSync(leaverFile), false, "the peer's own signed bye retires its entry");
		assert.equal(poolChanges, 1, "…and refreshes the pool at once instead of waiting for the stale sweep");
	} finally {
		removeEntry(dir, "h", leaverSession);
		await receiver.stop();
	}
});

// ── displayNameFor: the delivery path needs a name, not a registry sweep ─────────────────

test("displayNameFor matches listPeers()'s numbering without pruning the pool", async () => {
	const a = planeFor("twin", () => {});
	const b = planeFor("twin", () => {});
	const viewer = planeFor("name-viewer", () => {});
	await a.start();
	await b.start();
	await viewer.start();
	// A live-but-lapsed instance: its heartbeat has aged past the stale window, so `listPeers()`
	// would DELETE its entry — which is exactly what must not happen while resolving a name.
	const lapsedSession = `sid-lapsed-${process.pid}-${seq++}`;
	const lapsed = registryEntryFixture({
		session_id: lapsedSession, name: "lapsed", pid: process.pid,
		endpoint: endpoint(dir, "h", lapsedSession, process.platform),
		heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),
	});
	writeEntry(dir, "h", lapsed);
	const lapsedFile = registryPath(dir, "h", sessionKey(lapsedSession));
	try {
		const peers = viewer.listPeers().filter((p) => p.name === "twin");
		assert.equal(peers.length, 2, "both same-named peers are live");
		for (const p of peers) {
			assert.equal(viewer.displayNameFor(p), p.displayName, "the resolver agrees with the list's numbering");
		}
		assert.deepEqual(peers.map((p) => viewer.displayNameFor(p)).sort(), ["twin", "twin#2"]);

		writeEntry(dir, "h", lapsed); // listPeers() above already reaped it — put it back
		assert.equal(viewer.displayNameFor(lapsed), "lapsed", "an unlisted sender falls back to its own name");
		assert.ok(existsSync(lapsedFile), "resolving a name left the registry alone");
	} finally {
		removeEntry(dir, "h", lapsedSession);
		await a.stop();
		await b.stop();
		await viewer.stop();
	}
});

// The delivery path calls this while a frame is in flight, and plane.ts turns a throw from
// `onInbound` into a NACK — so a transient registry read error must never be able to reject a
// message the transport already authenticated.
test("an unreadable registry during name resolution does not turn delivery into a NACK", async () => {
	const got: string[] = [];
	let failPool = false;
	let receiver: ExocomPlane;
	const receiverSession = `sid-pool-fail-${process.pid}-${seq++}`;
	receiver = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: receiverSession, name: "pool-fail", persona: "pool-fail", purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", receiverSession, process.platform), cwd: "/",
		},
		getCard: () => ({ name: "pool-fail", persona: "pool-fail", model: "m", context_pct: 0, inbox: 0 }),
		readPool: (agentDir, hash): RegistryEntry[] => {
			if (failPool) throw Object.assign(new Error("EIO: registry unreadable"), { code: "EIO" });
			return readAll(agentDir, hash);
		},
		onInbound: (_m, fromEntry) => {
			// Mirrors extension.ts's reply-hint resolution, which runs on this very callback.
			failPool = true;
			try {
				got.push(receiver.displayNameFor(fromEntry!));
			} finally {
				failPool = false;
			}
			return { accepted: true };
		},
	});
	const sender = planeFor("pool-sender", () => {});
	await receiver.start();
	await sender.start();
	try {
		await sender.send("pool-fail", "still deliverable");
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(got, ["pool-sender"], "the hint fell back to the authenticated entry's own name");
	} finally { await sender.stop(); await receiver.stop(); }
});

test("an unreadable registry fails the sender lookup CLOSED instead of poisoning the connection", async () => {
	const deaf = `sid-pool-deaf-${process.pid}-${seq++}`;
	const receiver = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: deaf, name: "pool-deaf", persona: "pool-deaf", purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", deaf, process.platform), cwd: "/",
		},
		getCard: () => ({ name: "pool-deaf", persona: "pool-deaf", model: "m", context_pct: 0, inbox: 0 }),
		readPool: (): RegistryEntry[] => { throw Object.assign(new Error("EIO: registry unreadable"), { code: "EIO" }); },
		onInbound: () => ({ accepted: true }),
	});
	const sender = planeFor("deaf-sender", () => {});
	await receiver.start();
	await sender.start();
	try {
		// A signed NACK, not a destroyed socket — the latter reads as "unreachable" and would make
		// the sender evict a peer that is merely having a bad moment with its filesystem.
		await assert.rejects(() => sender.send("pool-deaf", "hi"), /rejected message: authentication failed/);
		assert.ok(readAll(dir, "h").some((e) => e.session_id === deaf), "the receiver's entry survived the failed send");
	} finally { await sender.stop(); await receiver.stop(); }
});

test("receiver NACKs a rejected delivery, while duplicate acceptance ACKs without recounting", async () => {
	const sender = planeFor("contract-sender", () => {});
	const rejected = planeFor("contract-rejected", () => {}, () => ({ accepted: false, reason: "budget" }));
	const duplicate = planeFor("contract-duplicate", () => {}, () => ({ accepted: true, duplicate: true }));
	await sender.start();
	await rejected.start();
	await duplicate.start();
	try {
		const senderFromRejected = rejected.listPeers().find((p) => p.name === "contract-sender")!;
		const senderFromDuplicate = duplicate.listPeers().find((p) => p.name === "contract-sender")!;
		await assert.rejects(() => sender.send("contract-rejected", "too much"), /rejected message: budget/, "drop becomes a signed NACK");
		assert.equal(rejected.receivedFromPeer(senderFromRejected.session_id), 0, "rejected frames are not counted");
		await sender.send("contract-duplicate", "retry");
		assert.equal(duplicate.receivedFromPeer(senderFromDuplicate.session_id), 0, "idempotent duplicate ACK does not recount");
	} finally {
		await sender.stop();
		await rejected.stop();
		await duplicate.stop();
	}
});
