import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, before, test } from "node:test";

// Keep the event loop ref'd for the whole file. The plane unrefs its server and
// accepted sockets (production: stdin/TUI keep pi alive; the listener must not).
// Without a ref'd handle the loop drains mid-await → node:test aborts with
// "Promise resolution is still pending but the event loop has already resolved"
// and cascades `cancelledByParent` to every later test. A ref'd keeper, cleared
// after all tests, holds the loop open so ack/grace timers fire.
const _loopKeeper = setInterval(() => {}, 60_000);
after(() => clearInterval(_loopKeeper));
import { endpoint, exocomRoot, registryPath } from "../../../src/exocom/paths.ts";
import { ARTIFACT_MAX_BYTES, ExocomPlane, type ExocomInboundResult } from "../../../src/exocom/plane.ts";
import { readAll, registryEntryFixture, removeEntry, sessionKey, writeEntry, type RegistryEntry } from "../../../src/exocom/registry.ts";
import { frameSigningPayload, type ExocomBye, type ExocomMessage } from "../../../src/exocom/envelope.ts";
import { buildInboundDelivery } from "../../../src/exocom/inbound.ts";
import { SenderBudget, SeenMessages } from "../../../src/exocom/guards.ts";
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

/** Feed a signed message through a real Exocom socket while keeping its authored
 *  hop count/msg_id. `send()` intentionally starts new chains at zero, so the
 *  collision test needs this wire-level fixture. */
function signedPlaneMessage(plane: ExocomPlane, frame: ExocomMessage): ExocomMessage {
	const privateKey = (plane as unknown as { privateKey: KeyObject }).privateKey;
	return { ...frame, signature: cryptoSign(null, Buffer.from(frameSigningPayload(frame), "utf8"), privateKey).toString("base64") };
}

async function injectMessage(targetEndpoint: string, frame: ExocomMessage): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = net.connect(targetEndpoint);
		let settled = false;
		const timer = setTimeout(() => finish(), 500);
		timer.unref?.();
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error); else resolve();
		};
		socket.once("connect", () => socket.write(encodeFrame(frame), () => socket.end()));
		socket.once("error", (error) => finish(error));
		socket.once("close", () => finish());
	});
}

/** Like `injectMessage`, but hands back whatever the receiver wrote on the wire, so a test can
 *  tell an ACK from a NACK instead of inferring the verdict from an empty inbox. The receiver
 *  answers with a single frame and leaves the connection open, so this settles on the first chunk
 *  rather than waiting out the timeout on every verdict. */
function injectForReply(targetEndpoint: string, frame: ExocomMessage): Promise<string> {
	return new Promise((resolve) => {
		const socket = net.connect(targetEndpoint);
		let out = "";
		const finish = (): void => { clearTimeout(timer); socket.destroy(); resolve(out); };
		const timer = setTimeout(finish, 1_000);
		timer.unref?.();
		socket.once("connect", () => socket.write(encodeFrame(frame)));
		socket.on("data", (chunk) => { out += chunk.toString("utf8"); finish(); });
		socket.once("close", finish);
		socket.once("error", finish);
	});
}

async function injectMessages(targetEndpoint: string, frames: ExocomMessage[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = net.connect(targetEndpoint);
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error); else resolve();
		};
		const timer = setTimeout(() => { socket.destroy(); finish(); }, 2_000);
		timer.unref?.();
		socket.once("connect", () => socket.write(Buffer.concat(frames.map((frame) => encodeFrame(frame))), () => {
			setTimeout(() => socket.end(), 100).unref?.();
		}));
		socket.once("error", (error) => finish(error));
		socket.once("close", () => finish());
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

test("resolvePeer canonicalizes the public session-pinned target to the registry session id", async () => {
	const a = planeFor("resolver-a", () => {});
	const b = planeFor("resolver-b", () => {});
	await a.start();
	await b.start();
	try {
		const listed = a.listPeers().find((peer) => peer.name === "resolver-b");
		assert.ok(listed, "the public roster exposes the peer");
		assert.equal(a.resolvePeer(listed.target).session_id, listed.session_id);
		assert.equal(a.resolvePeer(listed.displayName).session_id, listed.session_id, "display targets retain existing routing compatibility");
		assert.throws(() => a.resolvePeer("missing@0123456789abcdef01234567"), /unknown qualified target/i);
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("an oversize message spills to an artifact and sends {preview,path,size} inline (R3)", async () => {
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
		const payload = JSON.parse(got[0]?.text ?? "{}") as { kind: string; preview: string; path: string; size: number };
		assert.equal(payload.kind, "exocom_artifact");
		assert.ok(payload.path.endsWith(".txt"));
		assert.ok(payload.preview.length > 0 && payload.preview.length < big.length);
		assert.equal(payload.size, Buffer.byteLength(big, "utf8"));
		assert.equal(readFileSync(payload.path, "utf8"), big, "artifact holds the full text");
	} finally { await a.stop(); await b.stop(); }
});

test("humanDisplayLabelFor dedupes equal names without changing qualified reply routing", async () => {
	const a = planeFor("twin", () => {});
	const b = planeFor("twin", () => {});
	const viewer = planeFor("viewer", () => {});
	await a.start();
	await b.start();
	await viewer.start();
	try {
		const twins = viewer.listPeers().filter((p) => p.name === "twin");
		assert.equal(twins.length, 2);
		const labels = twins.map((p) => viewer.humanDisplayLabelFor(p)).sort();
		assert.deepEqual(labels, ["twin", "twin#2"]);
		assert.ok(twins.every((p) => /^twin@[a-f0-9]{24}$/.test(viewer.replyTargetFor(p))));
	} finally {
		await a.stop();
		await b.stop();
		await viewer.stop();
	}
});

// EXOCOM.ARTIFACT_TTL_MS exists so a DELIVERED spill outlives the sender: the receiver only got
// {preview,path,size} on the wire and reads `path` on a later idle-gated turn, often after the sender
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
		const aEntry = b.listPeers().find((p) => p.name === "elite")!;
		await b.send(b.replyTargetFor(aEntry), "done", msg_id);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(inboundAtA[0]?.hops, 1, "reply increments hops from the message it answers");
		assert.equal(inboundAtA[0]?.in_reply_to, msg_id);
	} finally { await a.stop(); await b.stop(); }
});

test("a cached reply id cannot be redirected to another live peer", async () => {
	const decoyInbox: ExocomMessage[] = [];
	const a = planeFor("reply-source", () => {});
	const b = planeFor("reply-owner", () => {});
	const decoy = planeFor("reply-decoy", (m) => decoyInbox.push(m));
	await a.start();
	await b.start();
	await decoy.start();
	try {
		const { msg_id } = await a.send("reply-owner", "original");
		await assert.rejects(
			() => b.send("reply-decoy", "misdirected", msg_id),
			/reply target .* does not match the authenticated sender/,
		);
		assert.equal(decoyInbox.length, 0, "the wrong live peer never receives the correlated reply");
	} finally {
		await a.stop();
		await b.stop();
		await decoy.stop();
	}
});

test("an evicted qualified reply target cannot fall through to a raw-name decoy", async () => {
	const decoyInbox: ExocomMessage[] = [];
	const source = planeFor("eviction-source", () => {});
	const receiver = planeFor("eviction-receiver", () => {});
	await source.start();
	await receiver.start();
	let decoy: ExocomPlane | undefined;
	try {
		const sourceEntry = receiver.listPeers().find((p) => p.name === "eviction-source")!;
		const receiverEntry = readAll(dir, "h").find((p) => p.name === "eviction-receiver")!;
		const { msg_id: oldMsgId } = await source.send("eviction-receiver", "original");
		const oldTarget = receiver.replyTargetFor(sourceEntry);
		const filler = Array.from({ length: 1_024 }, (_, i) => signedPlaneMessage(source, {
			kind: "message", msg_id: `eviction-${i}`, from_session: sourceEntry.session_id,
			from_endpoint: sourceEntry.endpoint, from_name: sourceEntry.name, text: "filler", hops: 0,
			ts: new Date().toISOString(),
		}));
		await injectMessages(receiverEntry.endpoint, filler);
		removeEntry(dir, "h", sourceEntry.session_id);

		const decoySession = `sid-eviction-decoy-${process.pid}-${seq++}`;
		decoy = new ExocomPlane({
			agentDir: dir, hash: "h",
			identity: {
				session_id: decoySession, name: oldTarget, persona: "decoy", purpose: "", color: "#36F9F6", model: "m",
				endpoint: endpoint(dir, "h", decoySession, process.platform), cwd: "/",
			},
			getCard: () => ({ name: oldTarget, persona: "decoy", model: "m", context_pct: 0, inbox: 0 }),
			onInbound: (m) => { decoyInbox.push(m); return { accepted: true }; },
		});
		await decoy.start();

		await assert.rejects(
			() => receiver.send(oldTarget, "late reply", oldMsgId),
			/reply target .* does not match|unknown (?:qualified )?peer|unknown qualified reply target/,
			"an evicted qualified reply must not resolve through a raw display name",
		);
		assert.equal(decoyInbox.length, 0, "the decoy never receives the evicted sender's reply");
	} finally {
		await source.stop();
		await receiver.stop();
		await decoy?.stop();
	}
});

test("reply hop history is scoped by sender, even when two peers reuse a msg_id", async () => {
	const inboundAtA: ExocomMessage[] = [];
	const a = planeFor("hop-a", (m) => inboundAtA.push(m));
	const b = planeFor("hop-b", () => {});
	const receiver = planeFor("hop-receiver", () => {});
	await a.start();
	await b.start();
	await receiver.start();
	try {
		const aEntry = receiver.listPeers().find((p) => p.name === "hop-a")!;
		const bEntry = receiver.listPeers().find((p) => p.name === "hop-b")!;
		const receiverEntry = readAll(dir, "h").find((p) => p.name === "hop-receiver")!;
		const sharedMsgId = "shared-hop-id";
		const common = {
			kind: "message" as const, msg_id: sharedMsgId, text: "same id from different senders",
			ts: new Date().toISOString(),
		};
		const fromA: ExocomMessage = signedPlaneMessage(a, {
			...common, from_session: aEntry.session_id, from_endpoint: aEntry.endpoint, from_name: "hop-a", hops: EXOCOM.MAX_HOPS,
		});
		const fromB: ExocomMessage = signedPlaneMessage(b, {
			...common, from_session: bEntry.session_id, from_endpoint: bEntry.endpoint, from_name: "hop-b", hops: 0,
		});

		// Both are real authenticated deliveries into the same receiver. The second
		// frame must not overwrite the first sender's hop history.
		await injectMessage(receiverEntry.endpoint, fromA);
		await injectMessage(receiverEntry.endpoint, fromB);
		await receiver.send(receiver.replyTargetFor(aEntry), "reply to A", sharedMsgId);

		const reply = inboundAtA[0];
		assert.equal(reply?.in_reply_to, sharedMsgId);
		assert.equal(reply?.hops, EXOCOM.MAX_HOPS + 1, "A's MAX hop count survives B's same-id message");
		const guarded = buildInboundDelivery(reply!, "hop-receiver", {
			budget: new SenderBudget({ windowMs: EXOCOM.SENDER_WINDOW_MS, maxMsgs: EXOCOM.SENDER_MAX_MSGS, maxBytes: EXOCOM.SENDER_MAX_BYTES }),
			seen: new SeenMessages({ ttlMs: EXOCOM.SEEN_TTL_MS }),
			injectMaxBytes: EXOCOM.INJECT_MAX_BYTES,
		});
		assert.deepEqual(guarded, { drop: "hops" }, "the normal inbound guard rejects the over-cap reply");
	} finally {
		await a.stop();
		await b.stop();
		await receiver.stop();
	}
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

// A display name is recomputed from the CURRENT live set on every call, so it is not a stable
// address: a peer that joins or leaves between the roster and the send can inherit the label.
// Ordinary sends must therefore be able to address the session-pinned token — and a peer that
// registers that token as its own free-choice name (`exocom_name` reserves nothing, and
// normalizePeerName keeps `@`) must not be able to intercept it.
test("a plain send resolves the session-pinned target, which a name-squatting peer cannot claim", async () => {
	const pinnedInbox: ExocomMessage[] = [];
	const squatterInbox: ExocomMessage[] = [];
	const pinned = planeFor("lyra", (m) => pinnedInbox.push(m));
	const sender = planeFor("token-sender", () => {});
	await pinned.start();
	await sender.start();
	let squatter: ExocomPlane | undefined;
	try {
		const token = sender.listPeers().find((p) => p.name === "lyra")!.target;
		assert.match(token, /^lyra@[a-f0-9]{24}$/, "the roster exposes a routable session token");
		const squatterSession = `sid-squatter-${process.pid}-${seq++}`;
		squatter = new ExocomPlane({
			agentDir: dir, hash: "h",
			identity: {
				session_id: squatterSession, name: token, persona: "squatter", purpose: "", color: "#36F9F6", model: "m",
				endpoint: endpoint(dir, "h", squatterSession, process.platform), cwd: "/",
			},
			getCard: () => ({ name: token, persona: "squatter", model: "m", context_pct: 0, inbox: 0 }),
			onInbound: (m) => { squatterInbox.push(m); return { accepted: true }; },
		});
		await squatter.start();
		await sender.send(token, "SECRET-FOR-LYRA");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(pinnedInbox.length, 1, "the pinned session received the message");
		assert.equal(squatterInbox.length, 0, "the peer holding that string as a display name never sees it");
	} finally {
		await pinned.stop();
		await sender.stop();
		await squatter?.stop();
	}
});

// The plain-send twin of "an evicted qualified reply target cannot fall through to a raw-name
// decoy": once the session a token names is gone, the send fails — it never degrades into a
// display-name lookup that a successor peer can answer.
test("a plain send to a departed session fails loudly instead of falling through to a raw-name decoy", async () => {
	const decoyInbox: ExocomMessage[] = [];
	const original = planeFor("orion", () => {});
	const sender = planeFor("churn-sender", () => {});
	await original.start();
	await sender.start();
	const token = sender.listPeers().find((p) => p.name === "orion")!.target;
	await original.stop();
	const decoySession = `sid-churn-decoy-${process.pid}-${seq++}`;
	const decoy = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: decoySession, name: token, persona: "decoy", purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", decoySession, process.platform), cwd: "/",
		},
		getCard: () => ({ name: token, persona: "decoy", model: "m", context_pct: 0, inbox: 0 }),
		onInbound: (m) => { decoyInbox.push(m); return { accepted: true }; },
	});
	await decoy.start();
	try {
		await assert.rejects(() => sender.send(token, "SECRET-FOR-THE-FIRST-ORION"), /unknown qualified target/);
		assert.equal(decoyInbox.length, 0, "a message addressed to the departed session is never handed to a peer that adopted its token as a name");
	} finally {
		await decoy.stop();
		await sender.stop();
	}
});

// A spill descriptor asks the receiver to read a file: `Full payload: <path>` goes to its model
// (exocom/inbound.ts). Both the path and the declared size are peer-authored, so the receiver
// verifies them against local ground truth before the claim can become an instruction.
test("an artifact claim is honoured only when the payload on disk is this workspace's own spill for that message", async () => {
	const got: ExocomMessage[] = [];
	const sender = planeFor("artifact-claimer", () => {});
	const reader = planeFor("artifact-reader", (m) => got.push(m));
	await sender.start();
	await reader.start();
	try {
		const senderEntry = readAll(dir, "h").find((p) => p.name === "artifact-claimer")!;
		const readerEntry = readAll(dir, "h").find((p) => p.name === "artifact-reader")!;
		const artifactsDir = join(exocomRoot(dir, "h"), "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		// Every claim below has a REAL spill of the declared shape sitting at the expected path, so
		// each guard is the only thing standing between the forged field and the receiver.
		const claim = (msgId: string, over: { path?: string; size?: number } = {}): ExocomMessage => {
			const spill = join(artifactsDir, `${msgId}.txt`);
			writeFileSync(spill, "y".repeat(20_000));
			return signedPlaneMessage(sender, {
				kind: "message", msg_id: msgId, from_session: senderEntry.session_id, from_endpoint: senderEntry.endpoint,
				from_name: "artifact-claimer", hops: 0, ts: new Date().toISOString(),
				text: JSON.stringify({ kind: "exocom_artifact", preview: "preview", path: over.path ?? spill, size: over.size ?? 20_000 }),
			});
		};
		const elsewhere = join(dir, `not-an-artifact-${seq++}.txt`);
		writeFileSync(elsewhere, "s".repeat(20_000));

		await injectMessage(readerEntry.endpoint, claim(randomUUID(), { path: elsewhere }));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(got.length, 0, "the receiver is never asked to read a peer-chosen path");

		await injectMessage(readerEntry.endpoint, claim(randomUUID(), { size: 1 }));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(got.length, 0, "a peer cannot under-declare what the payload it points at costs");

		const honest = randomUUID();
		await injectMessage(readerEntry.endpoint, claim(honest));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(got.length, 1, "an honest spill still lands");
		assert.equal(got[0]?.msg_id, honest);
		const delivered = JSON.parse(got[0]?.text ?? "{}") as { path?: string };
		assert.match(delivered.path ?? "", /received[/\\]/, "the model is pointed at a snapshot, not the sender-mutable spill");
		assert.equal(readFileSync(delivered.path!, "utf8").length, 20_000);
	} finally { await sender.stop(); await reader.stop(); }
});

// The two guards the test above does NOT isolate: a descriptor may name the receiver's own
// expected path and still be a lie about what is there. Both were reachable with the guard
// removed and no test noticed, so each claim below leaves exactly one of them standing.
test("a spill claim naming the right path is still refused when nothing on disk backs it", async () => {
	const got: ExocomMessage[] = [];
	const sender = planeFor("phantom-claimer", () => {});
	const reader = planeFor("phantom-reader", (m) => got.push(m));
	await sender.start();
	await reader.start();
	try {
		const senderEntry = readAll(dir, "h").find((p) => p.name === "phantom-claimer")!;
		const readerEntry = readAll(dir, "h").find((p) => p.name === "phantom-reader")!;
		const artifactsDir = join(exocomRoot(dir, "h"), "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const claim = (msgId: string, size: number): ExocomMessage => signedPlaneMessage(sender, {
			kind: "message", msg_id: msgId, from_session: senderEntry.session_id, from_endpoint: senderEntry.endpoint,
			from_name: "phantom-claimer", hops: 0, ts: new Date().toISOString(),
			text: JSON.stringify({ kind: "exocom_artifact", preview: "preview", path: join(artifactsDir, `${msgId}.txt`), size }),
		});

		// No file at all: the size is un-inlinable and self-consistent, so only the existence
		// check stands between "Full payload: <path>" and a model told to read a missing file.
		const phantom = randomUUID();
		const phantomReply = await injectForReply(readerEntry.endpoint, claim(phantom, 20_000));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(got.length, 0, "a descriptor for a file that does not exist is never delivered");
		assert.match(phantomReply, /"kind":"nack"/, "and the sender is told, rather than silently succeeding");

		// A real file at the real path, honestly declared — but small enough that `payloadFor` would
		// have inlined it. Only a payload that could not travel inline may travel as an artifact;
		// otherwise the artifact channel becomes a way to route ordinary text past the inject budget.
		const inlineable = randomUUID();
		writeFileSync(join(artifactsDir, `${inlineable}.txt`), "z".repeat(5_000));
		await injectForReply(readerEntry.endpoint, claim(inlineable, 5_000));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(got.length, 0, "a payload that fits the inline budget is not an artifact");

		// Same shape, one byte over the inline budget: delivered.
		const genuine = randomUUID();
		writeFileSync(join(artifactsDir, `${genuine}.txt`), "z".repeat(EXOCOM.INLINE_MAX_BYTES + 1));
		await injectForReply(readerEntry.endpoint, claim(genuine, EXOCOM.INLINE_MAX_BYTES + 1));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(got.length, 1, "the guard rejects only what could have been inlined");
		assert.equal(got[0]?.msg_id, genuine);
	} finally { await sender.stop(); await reader.stop(); }
});

// The path constraint pins a NAME, and a name is not a file: a link left at that name makes any
// local file look like this workspace's own spill, and nothing else in the system bounds what a
// peer can point the receiver's model at (`isExocomFrame` does not bound the message text, and the
// per-sender window deliberately charges only what crossed the wire).
test("a spill claim is refused when the file at the expected path is a link or exceeds the artifact ceiling", async () => {
	const got: ExocomMessage[] = [];
	const sender = planeFor("link-claimer", () => {});
	const reader = planeFor("link-reader", (m) => got.push(m));
	await sender.start();
	await reader.start();
	try {
		const senderEntry = readAll(dir, "h").find((p) => p.name === "link-claimer")!;
		const readerEntry = readAll(dir, "h").find((p) => p.name === "link-reader")!;
		const artifactsDir = join(exocomRoot(dir, "h"), "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const claim = (msgId: string, size: number): ExocomMessage => signedPlaneMessage(sender, {
			kind: "message", msg_id: msgId, from_session: senderEntry.session_id, from_endpoint: senderEntry.endpoint,
			from_name: "link-claimer", hops: 0, ts: new Date().toISOString(),
			text: JSON.stringify({ kind: "exocom_artifact", preview: "preview", path: join(artifactsDir, `${msgId}.txt`), size }),
		});

		// A file this workspace never spilled, given the receiver's expected spill name by a second
		// hard link. Every declared field is honest about the bytes at that path.
		const outside = join(dir, `outside-payload-${seq++}.txt`);
		writeFileSync(outside, "S".repeat(20_000));
		const hardLinked = randomUUID();
		linkSync(outside, join(artifactsDir, `${hardLinked}.txt`));
		const hardReply = await injectForReply(readerEntry.endpoint, claim(hardLinked, 20_000));
		assert.equal(got.length, 0, "a second name for a file we never wrote is not this workspace's spill");
		assert.match(hardReply, /"kind":"nack".*linked/, "and the sender is told why");

		// Same trick through a symlink — pointed at a file of its own, so nothing but refusing to
		// follow the link stands in the way: every check that follows would pass on the TARGET's
		// bytes. Windows only creates a symlink unprivileged with Developer Mode on, so this half
		// stands down where the platform refuses rather than failing for an unrelated reason.
		const symlinkTarget = join(dir, `outside-payload-${seq++}.txt`);
		writeFileSync(symlinkTarget, "S".repeat(20_000));
		const symlinked = randomUUID();
		let symlinkable = true;
		try { symlinkSync(symlinkTarget, join(artifactsDir, `${symlinked}.txt`)); } catch { symlinkable = false; }
		if (symlinkable) {
			const symReply = await injectForReply(readerEntry.endpoint, claim(symlinked, 20_000));
			assert.equal(got.length, 0, "…and the verification never follows a link out of the artifacts directory");
			assert.match(symReply, /"kind":"nack".*not a regular file/, "the link is refused for what it is, not for its size");
		}

		// An honest, unlinked spill that is simply unbounded: `exocom_send` caps a message at
		// 1,000,000 characters, so no legitimate sender reaches this — but a peer writing the file
		// directly would otherwise have the receiver advertise `Full payload:` for a file of any size.
		const huge = randomUUID();
		writeFileSync(join(artifactsDir, `${huge}.txt`), Buffer.alloc(ARTIFACT_MAX_BYTES + 1, 0x7a));
		const hugeReply = await injectForReply(readerEntry.endpoint, claim(huge, ARTIFACT_MAX_BYTES + 1));
		assert.equal(got.length, 0, "a payload no budget covers is not delivered");
		assert.match(hugeReply, /"kind":"nack".*ceiling/);

		// The control: same shape, a real spill of its own, delivered.
		const honest = randomUUID();
		writeFileSync(join(artifactsDir, `${honest}.txt`), "z".repeat(20_000));
		await injectForReply(readerEntry.endpoint, claim(honest, 20_000));
		assert.equal(got.length, 1, "an ordinary spill still lands");
		assert.equal(got[0]?.msg_id, honest);
	} finally { await sender.stop(); await reader.stop(); }
});

// Peers share one registry — that agentDir+hash pair IS the registry both sides read — but each
// reaches it through its own PI_AGENT_DIR, which may differ in case (Windows) or carry relative
// segments. A byte-exact comparison would NACK every large message between two such peers.
test("a spill claim is honoured when the peer spells the very same file a different way", async () => {
	const got: ExocomMessage[] = [];
	const sender = planeFor("spelling-claimer", () => {});
	const reader = planeFor("spelling-reader", (m) => got.push(m));
	await sender.start();
	await reader.start();
	try {
		const senderEntry = readAll(dir, "h").find((p) => p.name === "spelling-claimer")!;
		const readerEntry = readAll(dir, "h").find((p) => p.name === "spelling-reader")!;
		const artifactsDir = join(exocomRoot(dir, "h"), "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const claim = (msgId: string, path: string): ExocomMessage => signedPlaneMessage(sender, {
			kind: "message", msg_id: msgId, from_session: senderEntry.session_id, from_endpoint: senderEntry.endpoint,
			from_name: "spelling-claimer", hops: 0, ts: new Date().toISOString(),
			text: JSON.stringify({ kind: "exocom_artifact", preview: "preview", path, size: 20_000 }),
		});
		const spill = (msgId: string): string => {
			const path = join(artifactsDir, `${msgId}.txt`);
			writeFileSync(path, "y".repeat(20_000));
			return path;
		};

		const relative = randomUUID();
		spill(relative);
		// Not `join(...)`: it would normalize the detour away before the plane ever saw it.
		await injectForReply(readerEntry.endpoint, claim(relative, `${artifactsDir}${sep}..${sep}artifacts${sep}${relative}.txt`));
		assert.equal(got.length, 1, "a relative detour through the same directory is the same spill");
		assert.equal(got[0]?.msg_id, relative);

		if (process.platform === "win32") {
			const cased = randomUUID();
			spill(cased);
			await injectForReply(readerEntry.endpoint, claim(cased, join(artifactsDir, `${cased}.txt`).toUpperCase()));
			assert.equal(got.length, 2, "on a case-insensitive filesystem, a differently cased path is the same spill");
			assert.equal(got[1]?.msg_id, cased);
		}
	} finally { await sender.stop(); await reader.stop(); }
});

// The artifacts directory is shared by every peer in the workspace, and the capacity sweep runs on
// any peer's start, stop or next spill. A sweep landing between a sender's write and the receiver's
// verification turns a benign race into a hard, lossy send failure ("artifact payload is missing").
test("the capacity sweep leaves spills that may still be in flight alone", async () => {
	const artifactsDir = join(exocomRoot(dir, "h"), "artifacts");
	mkdirSync(artifactsDir, { recursive: true });
	const burst = Array.from({ length: EXOCOM.ARTIFACT_MAX_FILES + 20 }, () => join(artifactsDir, `${randomUUID()}.txt`));
	for (const path of burst) writeFileSync(path, "b");
	const sweeper = planeFor("sweeper", () => {});
	try {
		await sweeper.start(); // start() sweeps, exactly as a peer joining mid-conversation would
		assert.deepEqual(burst.filter((path) => !existsSync(path)), [], "no just-written payload was reaped out from under its receiver");
	} finally {
		await sweeper.stop();
		for (const path of burst) { try { unlinkSync(path); } catch { /* already reaped */ } }
	}
});

// A call-sign is the model's own free choice, so one can legitimately end in the same `@<24 hex>`
// shape a routing token does. Such a name still must not be answerable — a token names ONE session,
// and whoever holds that string as a label is not it (see the departed-session test above) — but
// refusing it silently leaves the model holding an address it has no way to repair.
test("a call-sign shaped like a session token is not answerable, and the refusal names the address that is", async () => {
	const inbox: ExocomMessage[] = [];
	const callSign = "quinn@0123456789abcdef01234567";
	// Built directly rather than through planeFor: a session_id is a token (registry.ts), so it
	// cannot carry the `@` this peer put in its freely chosen call-sign.
	const quinnSession = `sid-token-shaped-${process.pid}-${seq++}`;
	const quinn = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: quinnSession, name: callSign, persona: "quinn", purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", quinnSession, process.platform), cwd: "/",
		},
		getCard: () => ({ name: callSign, persona: "quinn", model: "m", context_pct: 0, inbox: 0 }),
		onInbound: (m) => { inbox.push(m); return { accepted: true }; },
	});
	const sender = planeFor("token-shaped-sender", () => {});
	await quinn.start();
	await sender.start();
	try {
		const peer = sender.listPeers().find((p) => p.name === callSign)!;
		assert.equal(peer.displayName, callSign, "the roster still shows the peer under its chosen call-sign");
		await assert.rejects(
			() => sender.send(callSign, "by name"),
			new RegExp(`unknown qualified target.*display name.*"${peer.target}"`),
			"the refusal hands back the address that peer does answer to",
		);
		assert.equal(inbox.length, 0, "a token-shaped string is never answered by whoever holds it as a label");
		await sender.send(peer.target, "by token");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(inbox.length, 1, "…and that address delivers");
	} finally { await quinn.stop(); await sender.stop(); }
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

test("a failed duplicate-session start does not remove the incumbent registry entry", async () => {
	const a = planeFor("incumbent", () => {});
	await a.start();
	const incumbent = readAll(dir, "h").find((p) => p.name === "incumbent")!;
	const failed = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: incumbent.session_id, name: "replacement", persona: "replacement", purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", `failed-${seq++}`, process.platform), cwd: "/",
		},
		getCard: () => { throw new Error("simulated metadata failure"); },
		onInbound: () => ({ accepted: true }),
	});
	try {
		await assert.rejects(() => failed.start(), /simulated metadata failure/);
		const stored = readAll(dir, "h").find((p) => p.session_id === incumbent.session_id);
		assert.equal(stored?.endpoint, incumbent.endpoint, "the failed start did not delete the incumbent");
		assert.equal(stored?.public_key, incumbent.public_key, "the incumbent authentication key survived");
	} finally {
		await failed.stop();
		await a.stop();
	}
});

test("an EADDRINUSE duplicate endpoint start does not remove the incumbent", async () => {
	const a = planeFor("same-endpoint-incumbent", () => {});
	await a.start();
	const incumbent = readAll(dir, "h").find((p) => p.name === "same-endpoint-incumbent")!;
	let duplicateCleanup = 0;
	const duplicate = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: incumbent.session_id, name: "same-endpoint-duplicate", persona: "same-endpoint-duplicate", purpose: "", color: "#36F9F6", model: "m",
			endpoint: incumbent.endpoint, cwd: "/",
		},
		getCard: () => ({ name: "same-endpoint-duplicate", persona: "same-endpoint-duplicate", model: "m", context_pct: 0, inbox: 0 }),
		onInbound: () => ({ accepted: true }),
		unlinkEndpoint: () => { duplicateCleanup += 1; },
	});
	try {
		await assert.rejects(() => duplicate.start(), /failed to listen|EADDRINUSE/);
		await duplicate.stop();
		assert.equal(duplicateCleanup, 0, "a failed bind never owns the incumbent endpoint");
		const probe = new ExocomPlane({
			agentDir: dir, hash: "h",
			identity: {
				session_id: `sid-same-endpoint-probe-${process.pid}-${seq++}`, name: "same-endpoint-probe", persona: "same-endpoint-probe", purpose: "", color: "#36F9F6", model: "m",
				endpoint: incumbent.endpoint, cwd: "/",
			},
			getCard: () => ({ name: "same-endpoint-probe", persona: "same-endpoint-probe", model: "m", context_pct: 0, inbox: 0 }),
			onInbound: () => ({ accepted: true }),
		});
		try {
			await assert.rejects(() => probe.start(), /failed to listen|EADDRINUSE/);
		} finally {
			await probe.stop();
		}
		const stored = readAll(dir, "h").find((p) => p.session_id === incumbent.session_id);
		assert.equal(stored?.endpoint, incumbent.endpoint, "the exact endpoint incumbent survived the failed bind");
		assert.equal(stored?.public_key, incumbent.public_key);
	} finally {
		await duplicate.stop();
		await a.stop();
	}
});

test("an old plane cannot remove a replacement that owns its session slot", async () => {
	const a = planeFor("original-owner", () => {});
	await a.start();
	const incumbent = readAll(dir, "h").find((p) => p.name === "original-owner")!;
	const b = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: incumbent.session_id, name: "replacement-owner", persona: "replacement-owner", purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", `replacement-${seq++}`, process.platform), cwd: "/",
		},
		getCard: () => ({ name: "replacement-owner", persona: "replacement-owner", model: "m", context_pct: 0, inbox: 0 }),
		onInbound: () => ({ accepted: true }),
	});
	await b.start();
	try {
		const replacement = readAll(dir, "h").find((p) => p.session_id === incumbent.session_id)!;
		assert.notEqual(replacement.endpoint, incumbent.endpoint);
		await a.stop();
		const stored = readAll(dir, "h").find((p) => p.session_id === incumbent.session_id);
		assert.equal(stored?.endpoint, replacement.endpoint, "the old plane stop left the replacement registered");
		assert.equal(stored?.public_key, replacement.public_key);
	} finally {
		await b.stop();
	}
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

// ── replyTargetFor: the delivery path needs a stable route, not a display name ────────────

test("replyTargetFor is stable and independent of listPeers() display numbering", async () => {
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
			assert.match(viewer.replyTargetFor(p), /^twin@[a-f0-9]{24}$/, "the reply target is stable and routable");
			assert.equal(viewer.displayNameFor(p), viewer.replyTargetFor(p), "the compatibility alias matches the stable target");
		}
		assert.deepEqual(peers.map((p) => p.displayName).sort(), ["twin", "twin#2"], "human display names remain deduped in the live roster");

		writeEntry(dir, "h", lapsed); // listPeers() above already reaped it — put it back
		assert.match(viewer.displayNameFor(lapsed), /^lapsed@[a-f0-9]{24}$/, "an unlisted sender gets a routable qualified target");
		assert.ok(existsSync(lapsedFile), "resolving a name left the registry alone");
	} finally {
		removeEntry(dir, "h", lapsedSession);
		await a.stop();
		await b.stop();
		await viewer.stop();
	}
});

test("qualified stale targets stay within the exocom_send schema budget for long identities", async () => {
	const viewer = planeFor("long-target-viewer", () => {});
	await viewer.start();
	const longSession = "s".repeat(128);
	const longName = "n".repeat(48);
	const stale = registryEntryFixture({
		session_id: longSession, name: longName, pid: process.pid, endpoint: "/long-target",
		heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),
	});
	writeEntry(dir, "h", stale);
	try {
		const target = viewer.replyTargetFor(stale);
		assert.ok(target.length <= 80, "the qualified target fits exocom_send's schema");
		assert.match(target, new RegExp(`^${longName}@[a-f0-9]{24}$`));
	} finally {
		removeEntry(dir, "h", longSession);
		await viewer.stop();
	}
});

test("a reply to an authenticated stale sender uses a qualified target, not its live same-name twin", async () => {
	const aInbox: ExocomMessage[] = [];
	const bInbox: ExocomMessage[] = [];
	const a = planeFor("twin", (m) => aInbox.push(m));
	const b = planeFor("twin", (m) => bInbox.push(m));
	let replyTarget = "";
	let receiver: ExocomPlane;
	const receiverSession = `sid-stale-receiver-${process.pid}-${seq++}`;
	receiver = new ExocomPlane({
		agentDir: dir, hash: "h",
		identity: {
			session_id: receiverSession, name: "stale-receiver", persona: "stale-receiver", purpose: "", color: "#36F9F6", model: "m",
			endpoint: endpoint(dir, "h", receiverSession, process.platform), cwd: "/",
		},
		getCard: () => ({ name: "stale-receiver", persona: "stale-receiver", model: "m", context_pct: 0, inbox: 0 }),
		onInbound: (_m, fromEntry) => {
			assert.ok(fromEntry, "the sender was authenticated before it became stale");
			writeEntry(dir, "h", { ...fromEntry!, heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString() });
			replyTarget = receiver.replyTargetFor(fromEntry!);
			removeEntry(dir, "h", fromEntry!.session_id);
			return { accepted: true };
		},
	});
	await a.start();
	await b.start();
	await receiver.start();
	try {
		const { msg_id } = await a.send("stale-receiver", "question from A");
		assert.match(replyTarget, /^twin@/, "stale replies use a session-qualified target");
		assert.notEqual(replyTarget, "twin", "the raw shared display name is not used");
		await receiver.send(replyTarget, "answer to A", msg_id);
		assert.equal(aInbox.length, 1, "the stale sender received the reply");
		assert.equal(bInbox.length, 0, "the live same-name twin did not receive it");
	} finally {
		await a.stop();
		await b.stop();
		await receiver.stop();
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
				got.push(receiver.replyTargetFor(fromEntry!));
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
		assert.match(got[0] ?? "", /^pool-sender@/, "the hint uses a routable qualified target");
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
