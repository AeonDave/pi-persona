import assert from "node:assert/strict";
import { test } from "node:test";

import { registerExocomTools } from "../../../src/tools/exocom.ts";

function mockPi() {
	const tools = new Map<string, any>();
	return { pi: { registerTool: (t: any) => tools.set(t.name, t) } as never, tools };
}
const stubPlane = (over: any = {}) => ({
	listPeers: () => [{ name: "dev", persona: "dev", model: "m", context_pct: 10, purpose: "", displayName: "dev" }],
	send: async (target: string) => ({ msg_id: `to-${target}` }),
	...over,
});

test("registers exocom_list + exocom_send", () => {
	const m = mockPi();
	registerExocomTools(m.pi, () => stubPlane() as never);
	assert.ok(m.tools.has("exocom_list"));
	assert.ok(m.tools.has("exocom_send"));
});

test("exocom_send returns the msg_id from the plane", async () => {
	const m = mockPi();
	registerExocomTools(m.pi, () => stubPlane() as never);
	const r = await m.tools.get("exocom_send").execute("c", { target: "dev", message: "hi" }, undefined, undefined, {});
	assert.equal((r.details as any).msg_id, "to-dev");
	assert.match(r.content[0].text, /dev/);
		assert.match(r.content[0].text, /msg_id=to-dev/, "the model-visible tool result exposes the reply correlation id");
		assert.match(r.content[0].text, /received and queued by dev/, "transport ACK is acceptance, not a read receipt");
		assert.match(r.content[0].text, /reply arrives automatically as \[exocom_received\] — do not poll exocom_list/);
});

test("exocom_list renders the peers", async () => {
	const m = mockPi();
	registerExocomTools(m.pi, () => stubPlane() as never);
	const r = await m.tools.get("exocom_list").execute("c", {}, undefined, undefined, {});
		assert.equal(r.content[0].text, "Exocom presence only (1 peers; not a message inbox)\n- dev · dev · m · ctx 10%\nUse target exactly as shown.");
	assert.doesNotMatch(r.content[0].text, /purpose|peer-message/, "default roster omits prose metadata and fences");
});

test("exocom_send target:'*' broadcasts to every peer, best-effort (one failure doesn't abort the rest)", async () => {
	const m = mockPi();
	const sent: string[] = [];
	const plane = stubPlane({
		listPeers: () => [
			{ name: "dev", persona: "dev", model: "m", context_pct: 10, purpose: "", displayName: "dev" },
			{ name: "elite", persona: "elite", model: "m", context_pct: 5, purpose: "", displayName: "elite" },
		],
		send: async (target: string) => {
			sent.push(target);
			if (target === "elite") throw new Error(`exocom: unknown peer "elite"`);
			return { msg_id: `to-${target}` };
		},
	});
	registerExocomTools(m.pi, () => plane as never);
	const r = await m.tools.get("exocom_send").execute("c", { target: "*", message: "hi all" }, undefined, undefined, {});
	assert.deepEqual(sent.sort(), ["dev", "elite"], "send was attempted for every peer");
	assert.deepEqual((r.details as any).msg_ids, ["to-dev"]);
	assert.equal((r.details as any).failed.length, 1);
	assert.equal((r.details as any).failed[0].target, "elite");
	assert.match(r.content[0].text, /2 peers/);
		assert.match(r.content[0].text, /received and queued by 1\/2 peers/);
		assert.match(r.content[0].text, /replies arrive automatically as \[exocom_received\] — do not poll exocom_list/);
});

// Two LIVE peers can share the same raw `.name` (session_id-keyed registry, PartA) — the
// broadcast loop must target each by its OWN, unique `displayName` ("elite"/"elite#2"), not the
// shared `.name`, or both iterations resolve to the SAME peer (one gets it twice, the other never).
test("exocom_send target:'*' hits each DISTINCT same-named peer once, addressed by its own displayName", async () => {
	const m = mockPi();
	const sent: string[] = [];
	const plane = stubPlane({
		listPeers: () => [
			{ name: "elite", persona: "elite", model: "m", context_pct: 10, purpose: "", displayName: "elite" },
			{ name: "elite", persona: "elite", model: "m", context_pct: 5, purpose: "", displayName: "elite#2" },
		],
		send: async (target: string) => {
			sent.push(target);
			return { msg_id: `to-${target}` };
		},
	});
	registerExocomTools(m.pi, () => plane as never);
	const r = await m.tools.get("exocom_send").execute("c", { target: "*", message: "hi all" }, undefined, undefined, {});
	assert.deepEqual(sent.sort(), ["elite", "elite#2"], "each same-named peer is targeted by its OWN displayName — never the shared name twice");
	assert.deepEqual((r.details as any).msg_ids.sort(), ["to-elite", "to-elite#2"]);
	assert.equal((r.details as any).failed.length, 0);
});

// I3: a `canUseBus` downgrade nulls the plane out from under these tools (extension.ts's
// `stopExocom`) — the getter must make that revocation REAL, not cosmetic. Both tools fail
// closed instead of quietly staying callable (which would let a deny-listed persona keep
// messaging peers after the bus capability was revoked).
test("exocom_send fails closed once the accessor reports the plane gone (downgrade)", async () => {
	const m = mockPi();
	registerExocomTools(m.pi, () => undefined);
	await assert.rejects(
		() => m.tools.get("exocom_send").execute("c", { target: "dev", message: "hi" }, undefined, undefined, {}),
		/exocom is not active/,
	);
});

test("exocom_list fails closed once the accessor reports the plane gone (downgrade)", async () => {
	const m = mockPi();
	registerExocomTools(m.pi, () => undefined);
	await assert.rejects(() => m.tools.get("exocom_list").execute("c", {}, undefined, undefined, {}), /exocom is not active/);
});

test("exocom_send re-enables the instant the accessor's plane comes back (re-upgrade)", async () => {
	const m = mockPi();
	let plane: ReturnType<typeof stubPlane> | undefined;
	registerExocomTools(m.pi, () => plane as never);
	await assert.rejects(() => m.tools.get("exocom_send").execute("c", { target: "dev", message: "hi" }, undefined, undefined, {}));
	plane = stubPlane();
	const r = await m.tools.get("exocom_send").execute("c", { target: "dev", message: "hi" }, undefined, undefined, {});
	assert.equal((r.details as any).msg_id, "to-dev");
});

test("exocom_name applies the model's free-choice call-sign via onRename", async () => {
	const m = mockPi();
	let current = "orion";
	registerExocomTools(m.pi, () => stubPlane() as never, (raw) => {
		current = raw.trim();
		return current;
	});
	const r = await m.tools.get("exocom_name").execute("c", { name: "  nightowl " }, undefined, undefined, {});
	assert.equal((r.details as any).name, "nightowl", "onRename's applied name is returned");
	assert.match(r.content[0].text, /nightowl/);
	assert.equal(current, "nightowl", "the rename callback actually ran");
});

test("exocom_name fails closed when exocom is inactive", async () => {
	const m = mockPi();
	registerExocomTools(m.pi, () => undefined, () => "x");
	await assert.rejects(
		() => m.tools.get("exocom_name").execute("c", { name: "z" }, undefined, undefined, {}),
		/exocom is not active/,
	);
});
