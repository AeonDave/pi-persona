import assert from "node:assert/strict";
import { test } from "node:test";
import { peerClaimFor, WriteWarnings, writeWarningKey, WRITE_TOOLS } from "../../../src/exocom/write-guard.ts";
import type { LedgerClaim } from "../../../src/exocom/ledger.ts";

test("peerClaimFor finds the peer claim whose write_set contains or is contained by the path, never the session's own", () => {
	const claims: LedgerClaim[] = [
		{ work_key: "wk", from_session: "peer", from_name: "vega", write_set: ["src/"], slice: "s", msg_id: "m1", ts: "2026-09-01T00:00:00Z" },
		{ work_key: "wk2", from_session: "me", from_name: "orion", write_set: ["docs/"], slice: "d", msg_id: "m2", ts: "2026-09-01T00:00:00Z" },
	];
	assert.equal(peerClaimFor("src/a.ts", claims, "me")?.msg_id, "m1");
	assert.equal(peerClaimFor("docs/x.md", claims, "me"), undefined);
	assert.equal(peerClaimFor("README.md", claims, "me"), undefined);
});

test("WriteWarnings remembers a key once", () => {
	const w = new WriteWarnings();
	assert.equal(w.seen("k"), false);
	w.remember("k");
	assert.equal(w.seen("k"), true);
});

test("WriteWarnings.clear forgets remembered keys", () => {
	const w = new WriteWarnings();
	w.remember("k");
	w.clear();
	assert.equal(w.seen("k"), false);
});

test("writeWarningKey composes the claim's msg_id with the normalized path", () => {
	const claim: LedgerClaim = { work_key: "wk", from_session: "peer", from_name: "vega", write_set: ["src/"], slice: "s", msg_id: "m1", ts: "2026-09-01T00:00:00Z" };
	assert.equal(writeWarningKey(claim, "src/a.ts"), "m1|src/a.ts");
	// Same claim, differently-spelled path that normalizes the same ⇒ same key (one warning per path).
	assert.equal(writeWarningKey(claim, "./src/a.ts"), "m1|src/a.ts");
});

test("WRITE_TOOLS covers exactly write and edit", () => {
	assert.equal(WRITE_TOOLS.has("write"), true);
	assert.equal(WRITE_TOOLS.has("edit"), true);
	assert.equal(WRITE_TOOLS.has("read"), false);
});
