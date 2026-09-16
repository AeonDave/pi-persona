import assert from "node:assert/strict";
import { test } from "node:test";

import type { LedgerState } from "../../../src/exocom/ledger.ts";
import { formatLedgerStatus } from "../../../src/exocom/status.ts";

test("formatLedgerStatus lists own and peer claims, asks each way, with labels and ages; empty ledger says so", () => {
	const now = Date.parse("2026-09-01T00:10:00Z");
	const state: LedgerState = {
		claims: [
			{ work_key: "wk1", from_session: "me", from_name: "orion", write_set: ["src/a.ts"], slice: "alpha", msg_id: "m1", ts: "2026-09-01T00:00:00Z" },
			{ work_key: "wk2", from_session: "peer", from_name: "vega", write_set: ["src/b.ts", "src/c.ts"], slice: "beta", msg_id: "m2", ts: "2026-09-01T00:05:00Z" },
		],
		asks: [
			{ ask_id: "a1", work_key: "wk2", from_session: "peer", from_name: "vega", to_session: "me", question: "overlap?", msg_id: "m3", ts: "2026-09-01T00:09:00Z" },
		],
		answers: [],
		askIds: ["a1"],
		seen: [],
	};
	const text = formatLedgerStatus(state, "me", (s) => (s === "peer" ? "vega#2" : undefined), now);
	assert.match(text, /your claims:\n• alpha · src\/a\.ts · 10m/);
	assert.match(text, /peer claims:\n• vega#2 · beta · src\/b\.ts, src\/c\.ts · 5m/);
	assert.match(text, /asks waiting for you:\n• vega#2 · wk2 · a1 · "overlap\?" · 1m/);
	assert.match(text, /your open asks:\n\(none\)/);
	assert.equal(
		formatLedgerStatus({ claims: [], asks: [], answers: [], askIds: [], seen: [] }, "me", () => undefined, now),
		"nothing claimed or pending",
	);
});

test("formatLedgerStatus bounds each section at 20 rows", () => {
	const now = Date.parse("2026-09-01T00:10:00Z");
	const claims = Array.from({ length: 25 }, (_, i) => ({
		work_key: `wk${i}`,
		from_session: "peer",
		from_name: "vega",
		write_set: [`src/f${i}.ts`],
		slice: `slice-${i}`,
		msg_id: `m${i}`,
		ts: new Date(now - (25 - i) * 1_000).toISOString(),
	}));
	const state: LedgerState = { claims, asks: [], answers: [], askIds: [], seen: [] };
	const text = formatLedgerStatus(state, "me", () => "vega", now);
	assert.match(text, /… \+5 more/);
	const peerSection = (text.split("peer claims:\n")[1] ?? "").split("\n\n")[0] ?? "";
	assert.equal(peerSection.split("\n").length, 21, "20 rows plus the “… +N more” line");
});
