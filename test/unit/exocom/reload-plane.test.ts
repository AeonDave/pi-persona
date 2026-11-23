import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExocomPlane } from "../../../src/exocom/plane.ts";
import { endpoint } from "../../../src/exocom/paths.ts";
import { deleteRegistryFile } from "../../helpers/exocom-registry.ts";
import type { ExocomMessage } from "../../../src/exocom/envelope.ts";

test("reload restores authenticated reply target and original hop count", async () => {
	const keeper = setInterval(() => {}, 60_000);
	const dir = await mkdtemp(join(tmpdir(), "exocom-reload-plane-"));
	const hash = "reload-test";
	const inboxA: ExocomMessage[] = [];
	const inboxB: ExocomMessage[] = [];
	const make = (name: string, inbox: ExocomMessage[]) => new ExocomPlane({
		agentDir: dir, hash,
		identity: { session_id: name, name, persona: "", purpose: "", color: "#36F9F6", model: "m", endpoint: endpoint(dir, hash, name, process.platform), cwd: dir },
		getCard: () => ({ name, persona: "", model: "m", context_pct: 0, inbox: 0 }),
		onInbound: (msg) => { inbox.push(msg); return { accepted: true }; },
	});
	const a = make("sender", inboxA);
	let b = make("receiver", inboxB);
	try {
		await a.start(); await b.start();
		const first = await a.send("receiver", "one");
		const senderTarget = b.replyTargetFor(b.listPeers().find((p) => p.session_id === "sender")!);
		const second = await b.send(senderTarget, "two", first.msg_id);
		const receiverTarget = a.replyTargetFor(a.listPeers().find((p) => p.session_id === "receiver")!);
		const third = await a.send(receiverTarget, "three", second.msg_id);
		assert.equal(inboxB.at(-1)?.hops, 2);
		const saved = b.getInboundContext("sender", third.msg_id);
		assert.ok(saved);
		await b.stop();
		b = make("receiver", inboxB);
		await b.start();
		assert.equal(b.restoreInboundContext(saved), true);
		await assert.rejects(() => b.send("wrong@000000000000000000000000", "misdirected", third.msg_id), /does not match the authenticated sender/);
		deleteRegistryFile(dir, hash, "sender");
		await b.send(senderTarget, "four", third.msg_id);
		assert.equal(inboxA.at(-1)?.hops, 3);
		assert.equal(inboxA.at(-1)?.in_reply_to, third.msg_id);
	} finally {
		await b.stop(); await a.stop(); clearInterval(keeper);
		await rm(dir, { recursive: true, force: true });
	}
});
