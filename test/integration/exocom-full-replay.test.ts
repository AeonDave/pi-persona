import assert from "node:assert/strict";
import { sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFrameReader, encodeFrame } from "../../src/bus/broker/framing.ts";
import { frameSigningPayload, type ExocomFrame, type ExocomMessage } from "../../src/exocom/envelope.ts";
import { installExocom, type ExocomHost } from "../../src/exocom/install.ts";
import { endpoint } from "../../src/exocom/paths.ts";
import { ExocomPlane } from "../../src/exocom/plane.ts";
import { EXOCOM_INBOX_MAX } from "../../src/extension/shared.ts";

function exchange(target: string, frame: ExocomMessage): Promise<ExocomFrame> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(target);
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("no reply")); }, 5000);
		socket.once("connect", () => socket.write(encodeFrame(frame)));
		socket.on("data", createFrameReader((reply) => { clearTimeout(timer); socket.destroy(); resolve(reply as ExocomFrame); }, reject));
		socket.once("error", reject);
	});
}

test("an authenticated duplicate is acknowledged even when the inbox is full", { timeout: 30000 }, async () => {
	const keeper = setInterval(() => {}, 60_000);
	const dir = await mkdtemp(join(tmpdir(), "exo-full-replay-"));
	const receiverId = "receiver-full";
	const ctx = { cwd: dir, hasUI: true, sessionManager: { getSessionId: () => receiverId }, isIdle: () => false, getContextUsage: () => undefined,
		ui: { notify() {}, setWidget() {}, setStatus() {} } } as unknown as ExtensionContext;
	const pi = { getFlag: () => false, registerTool() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {} } as unknown as ExtensionAPI;
	const host = { pi, identity: { chosen: true, name: "receiver" }, config: { exocom: true }, controller: {}, lastCtx: ctx, disposed: false,
		canDeliverNotifications: () => false, delegationNudge: { reset() {} }, exocomArgs: {}, userAgentDir: () => dir } as unknown as ExocomHost;
	const installed = installExocom(pi, host);
	const senders: ExocomPlane[] = [];
	const realNow = Date.now;
	let clockOffset = 0;
	Date.now = () => realNow() + clockOffset;
	try {
		await installed.reconcile(ctx);
		assert.ok(installed.plane);
		const hash = installed.scope!.scopeWorkspaceId;
		for (let n = 0; n < 4; n++) {
			const session_id = `sender-${n}`;
			const plane = new ExocomPlane({ agentDir: dir, hash, identity: { session_id, name: session_id, persona: "", purpose: "", color: "#36F9F6", model: "m", endpoint: endpoint(dir, hash, session_id, process.platform), cwd: dir },
				getCard: () => ({ name: session_id, persona: "", model: "m", context_pct: 0, inbox: 0 }), onInbound: () => ({ accepted: true }) });
			await plane.start(); senders.push(plane);
		}
		const source = senders[0]!;
		const receiver = source.listPeers().find((peer) => peer.session_id === receiverId)!;
		const frame: ExocomMessage = { kind: "message", msg_id: "replay-id", from_session: "sender-0", from_endpoint: endpoint(dir, hash, "sender-0", process.platform), from_name: "sender-0", text: "first", hops: 0, ts: new Date().toISOString() };
		const privateKey = (source as unknown as { privateKey: KeyObject }).privateKey;
		frame.signature = sign(null, Buffer.from(frameSigningPayload(frame)), privateKey).toString("base64");
		assert.equal((await exchange(receiver.endpoint, frame)).kind, "ack");
		for (let i = 0; i < EXOCOM_INBOX_MAX - 1; i++) await senders[(i + 1) % 3]!.send(receiver.target, `fill-${i}`);
		assert.equal(installed.notifier?.peekPending().length, EXOCOM_INBOX_MAX);
		assert.equal((await exchange(receiver.endpoint, frame)).kind, "ack", "replay of a previously accepted id must not be rejected as a new arrival");
		assert.equal(installed.notifier?.peekPending().length, EXOCOM_INBOX_MAX);
		installed.notifier?.discard((item) => item.receipt?.id !== "replay-id");
		try {
			clockOffset = 301_000;
			assert.equal((await exchange(receiver.endpoint, frame)).kind, "ack");
			assert.equal(installed.notifier?.peekPending().length, 1, "a still-pending postcard is deduplicated after the seen TTL expires");
		} finally { clockOffset = 0; }
		// Hold shutdown before its socket closes: no newly accepted message may be lost
		// when normal teardown cancels the notifier after this await.
		installed.notifier?.cancel();
		let releaseStop!: () => void;
		let enteredStop!: () => void;
		const stopped = new Promise<void>((resolve) => { enteredStop = resolve; });
		const release = new Promise<void>((resolve) => { releaseStop = resolve; });
		const originalStop = installed.plane.stop.bind(installed.plane);
		installed.plane.stop = async () => { enteredStop(); await release; await originalStop(); };
		const { signature: _signature, ...unsigned } = frame;
		const duringStop: ExocomMessage = { ...unsigned, msg_id: "during-stop", from_session: "sender-3", from_endpoint: endpoint(dir, hash, "sender-3", process.platform), from_name: "sender-3" };
		const shutdownKey = (senders[3] as unknown as { privateKey: KeyObject }).privateKey;
		duringStop.signature = sign(null, Buffer.from(frameSigningPayload(duringStop)), shutdownKey).toString("base64");
		(host as { disposed: boolean }).disposed = true;
		assert.equal((await exchange(receiver.endpoint, duringStop)).kind, "nack", "disposed host refuses traffic even while teardown is queued");
		(host as { disposed: boolean }).disposed = false;
		const stopping = installed.stop();
		await stopped;
		try {
			assert.equal((await exchange(receiver.endpoint, duringStop)).kind, "nack", "teardown refuses new ingress before closing the socket");
		} finally { releaseStop(); await stopping; }
	} finally {
		Date.now = realNow;
		for (const sender of senders) await sender.stop();
		await installed.stop(); clearInterval(keeper);
		await rm(dir, { recursive: true, force: true });
	}
});
