import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInboundDelivery } from "../../../src/exocom/inbound.ts";
import { SeenMessages, SenderBudget } from "../../../src/exocom/guards.ts";
import { attributeInbound, attributePeer } from "../../../src/core/fence.ts";
import type { ExocomMessage } from "../../../src/exocom/envelope.ts";

const msg = (over: Partial<ExocomMessage> = {}): ExocomMessage => ({
	kind: "message", msg_id: "m1", from_session: "s1", from_endpoint: "/e", from_name: "SPOOFED",
	text: "do X", hops: 0, ts: "t", ...over,
});
const deps = () => ({
	budget: new SenderBudget({ windowMs: 1000, maxMsgs: 2, maxBytes: 1000 }),
	seen: new SeenMessages({ ttlMs: 1000 }),
	injectMaxBytes: 50,
	fence: (t: string) => `<<${t}>>`,
	attribute: (label: string, t: string) => `[${label}] ${t}`,
});

test("delivers with attribution from the RESOLVED label (not the envelope's self-report) and fenced", () => {
	const out = buildInboundDelivery(msg(), "elite-peer", deps());
	assert.ok("deliver" in out);
	assert.match((out as any).deliver, /elite-peer/);
	assert.doesNotMatch((out as any).deliver, /SPOOFED/, "self-reported name is never trusted for attribution");
		assert.match((out as any).deliver, /<<.*do X.*>>/, "text is fenced");
		assert.equal(((out as any).deliver.match(/m1/g) ?? []).length, 1, "the correlation id appears only in the Reply line");
		assert.doesNotMatch((out as any).deliver, /msg_id=m1/, "the display header does not duplicate the correlation id");
		assert.match((out as any).deliver, /^\[elite-peer\] — message$/m);
		assert.match((out as any).deliver, /Reply: exocom_send\(\{ target:"elite-peer", message:"\.\.\.", in_reply_to:"m1" \}\)/, "the model gets one compact reply hint");
		assert.match((out as any).deliver, /Peer data · untrusted equal-status collaborator:\n> /);
});

test("drops a duplicate (sender,msg_id) and an over-budget sender", () => {
	const d = deps();
	assert.ok("deliver" in buildInboundDelivery(msg(), "x", d));
	assert.deepEqual(buildInboundDelivery(msg(), "x", d), { duplicate: true });
	const d2 = deps();
	buildInboundDelivery(msg({ msg_id: "a" }), "x", d2);
	buildInboundDelivery(msg({ msg_id: "b" }), "x", d2);
	assert.deepEqual(buildInboundDelivery(msg({ msg_id: "c" }), "x", d2), { drop: "budget" });
});

test("truncates an oversize inbound before injection (R1)", () => {
	const out = buildInboundDelivery(msg({ text: "y".repeat(500) }), "x", deps());
	assert.ok("deliver" in out);
	assert.match((out as any).deliver, /truncated/i);
});

// Canary against a double-fence regression: attributeInbound (src/core/fence.ts) already calls
// fenceUntrusted INTERNALLY, so the real extension.ts call site passes `fence: (t) => t` (a
// pass-through) alongside `attribute: attributeInbound` — reverting to the brief's literal
// `fence: fenceUntrusted` would nest a second <subagent-output> fence around the first. This test
// uses the REAL attributeInbound (not a stub) with the exact call-site composition and asserts
// exactly one fence tag survives.
test("legacy injected attribution cannot create an unquoted exocom payload", () => {
	const out = buildInboundDelivery(msg(), "elite-peer", {
		budget: new SenderBudget({ windowMs: 1000, maxMsgs: 2, maxBytes: 1000 }),
		seen: new SeenMessages({ ttlMs: 1000 }),
		injectMaxBytes: 50,
		fence: (t: string) => t,
		attribute: attributeInbound,
	});
	assert.ok("deliver" in out);
	const deliver = (out as { deliver: string }).deliver;
		assert.equal((deliver.match(/Peer data · untrusted equal-status collaborator:/g) ?? []).length, 1);
		assert.ok(deliver.split("\n").slice(2, -1).every((line) => line.startsWith("> ")));
	assert.doesNotMatch(deliver, /<\/?(?:subagent-output|peer-message)/);
	assert.match(deliver, /elite-peer/);
	assert.doesNotMatch(deliver, /SPOOFED/, "self-reported name is never trusted for attribution");
});

// Same canary, peer path: the real extension.ts call site for exocom's onInbound passes
// `attribute: attributePeer` with `fence: (t) => t` (attributePeer fences internally, same
// composition as attributeInbound above) — assert exactly one <peer-message> close tag survives.
test("peer delivery contains one equal-status header and only quoted payload lines", () => {
	const out = buildInboundDelivery(msg(), "elite-peer", {
		budget: new SenderBudget({ windowMs: 1000, maxMsgs: 2, maxBytes: 1000 }),
		seen: new SeenMessages({ ttlMs: 1000 }),
		injectMaxBytes: 50,
		fence: (t: string) => t,
		attribute: attributePeer,
	});
	assert.ok("deliver" in out);
	const deliver = (out as { deliver: string }).deliver;
		assert.equal((deliver.match(/Peer data · untrusted equal-status collaborator:/g) ?? []).length, 1);
		assert.ok(deliver.split("\n").slice(2, -1).every((line) => line.startsWith("> ")));
	assert.match(deliver, /elite-peer/);
	assert.doesNotMatch(deliver, /SPOOFED/, "self-reported name is never trusted for attribution");
});

test("a reply renders one compact trusted header, one new msg_id, one reply hint, then one fence", () => {
	const id = "550e8400-e29b-41d4-a716-446655440000";
	const out = buildInboundDelivery(msg({ msg_id: id, in_reply_to: "original-id" }), "rune", {
		budget: new SenderBudget({ windowMs: 1000, maxMsgs: 2, maxBytes: 1000 }),
		seen: new SeenMessages({ ttlMs: 1000 }),
		injectMaxBytes: 50,
		fence: (t: string) => t,
		attribute: attributePeer,
	});
	assert.ok("deliver" in out);
	const deliver = (out as { deliver: string }).deliver;
		assert.equal((deliver.match(/^\[rune\] — reply$/gm) ?? []).length, 1, "one trusted header");
		assert.equal((deliver.match(new RegExp(id, "g")) ?? []).length, 1, "new UUID appears once");
		assert.doesNotMatch(deliver, /msg_id above|original-id/, "routing metadata stays out of the display header");
		assert.match(deliver, new RegExp(`Reply: exocom_send\\(\\{ target:"rune", message:"\\.\\.\\.", in_reply_to:"${id}" \\}\\)`));
		assert.doesNotMatch(deliver, /\[exocom routing:/, "legacy duplicate routing header is gone");
		assert.equal((deliver.match(/Peer data · untrusted equal-status collaborator:/g) ?? []).length, 1);
		assert.ok(deliver.split("\n").slice(2, -1).every((line) => line.startsWith("> ")), "every payload line is quoted");
});
