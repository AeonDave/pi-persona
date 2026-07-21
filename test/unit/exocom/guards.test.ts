import assert from "node:assert/strict";
import { test } from "node:test";
import { SeenMessages, SenderBudget } from "../../../src/exocom/guards.ts";

test("SenderBudget caps by count and bytes per rolling window", () => {
	let t = 1000;
	const b = new SenderBudget({ windowMs: 1000, maxMsgs: 2, maxBytes: 100, now: () => t });
	assert.equal(b.allow("a", 10), true);
	assert.equal(b.allow("a", 10), true);
	assert.equal(b.allow("a", 10), false, "3rd in window ⇒ over count");
	t = 2001; // window elapsed
	assert.equal(b.allow("a", 10), true, "count resets after the window");
	assert.equal(b.allow("b", 200), false, "over the byte cap in one shot");
	assert.equal(b.allow("a", 10), true, "other sender unaffected");
});

test("SeenMessages dedups (sender,msg_id) within TTL", () => {
	let t = 0;
	const s = new SeenMessages({ ttlMs: 100, now: () => t });
	assert.equal(s.seenBefore("a", "m1"), false);
	assert.equal(s.seenBefore("a", "m1"), true, "same again ⇒ seen");
	assert.equal(s.seenBefore("a", "m2"), false, "different id");
	t = 101;
	assert.equal(s.seenBefore("a", "m1"), false, "expired ⇒ not seen");
});

test("SeenMessages key is unambiguous — crafted (sender,msg_id) pairs don't alias", () => {
	// sender (from_session) and msg_id are self-reported by the peer; with a space separator
	// ("a" + " " + "b c") and ("a b" + " " + "c") both collapse to "a b c". The \x1f separator
	// keeps them distinct, so neither is wrongly treated as a duplicate of the other.
	const s = new SeenMessages({ ttlMs: 1000, now: () => 0 });
	assert.equal(s.seenBefore("a", "b c"), false);
	assert.equal(s.seenBefore("a b", "c"), false, "distinct pair — not aliased to the first");
});
