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
});

test("drops a duplicate (sender,msg_id) and an over-budget sender", () => {
	const d = deps();
	assert.ok("deliver" in buildInboundDelivery(msg(), "x", d));
	assert.deepEqual(buildInboundDelivery(msg(), "x", d), { drop: "dup" });
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
test("the real call-site composition (fence passthrough + real attributeInbound) fences exactly once", () => {
	const out = buildInboundDelivery(msg(), "elite-peer", {
		budget: new SenderBudget({ windowMs: 1000, maxMsgs: 2, maxBytes: 1000 }),
		seen: new SeenMessages({ ttlMs: 1000 }),
		injectMaxBytes: 50,
		fence: (t: string) => t,
		attribute: attributeInbound,
	});
	assert.ok("deliver" in out);
	const deliver = (out as { deliver: string }).deliver;
	// The CLOSING tag is the unambiguous count: fenceUntrusted's own trailing explanatory
	// sentence also mentions the literal opening tag as prose ("Text inside <subagent-output>
	// is produced by..."), so counting "<subagent-output" would double-count even a single,
	// correct fencing. "</subagent-output>" never appears in that prose.
	const closes = deliver.match(/<\/subagent-output>/g) ?? [];
	assert.equal(closes.length, 1, "exactly one fence close tag — a double-fence regression would produce 2");
	assert.match(deliver, /elite-peer/);
	assert.doesNotMatch(deliver, /SPOOFED/, "self-reported name is never trusted for attribution");
});

// Same canary, peer path: the real extension.ts call site for exocom's onInbound passes
// `attribute: attributePeer` with `fence: (t) => t` (attributePeer fences internally, same
// composition as attributeInbound above) — assert exactly one <peer-message> close tag survives.
test("the real call-site composition (fence passthrough + real attributePeer) fences exactly once", () => {
	const out = buildInboundDelivery(msg(), "elite-peer", {
		budget: new SenderBudget({ windowMs: 1000, maxMsgs: 2, maxBytes: 1000 }),
		seen: new SeenMessages({ ttlMs: 1000 }),
		injectMaxBytes: 50,
		fence: (t: string) => t,
		attribute: attributePeer,
	});
	assert.ok("deliver" in out);
	const deliver = (out as { deliver: string }).deliver;
	const closes = deliver.match(/<\/peer-message>/g) ?? [];
	assert.equal(closes.length, 1, "exactly one fence close tag — a double-fence regression would produce 2");
	assert.match(deliver, /elite-peer/);
	assert.doesNotMatch(deliver, /SPOOFED/, "self-reported name is never trusted for attribution");
});
