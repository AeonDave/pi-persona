import { test } from "node:test";
import assert from "node:assert/strict";

import { EXOCOM_WAIT_MAX_MS, waitMatches, waitNoticeMatchesAskId, waitTimeoutMs } from "../../../src/exocom/wait.ts";

test("waitTimeoutMs defaults to the cap and clamps to (0, cap]", () => {
	assert.equal(EXOCOM_WAIT_MAX_MS, 600_000);
	assert.equal(waitTimeoutMs(undefined), 600_000);
	assert.equal(waitTimeoutMs(Number.NaN), 600_000);
	assert.equal(waitTimeoutMs(0), 1);
	assert.equal(waitTimeoutMs(-12), 1);
	assert.equal(waitTimeoutMs(5_000), 5_000);
	assert.equal(waitTimeoutMs(700_000), 600_000);
	assert.equal(waitTimeoutMs(600_000), 600_000);
});

test("waitMatches joins on work_key and optional ask_id", () => {
	assert.equal(waitMatches({ work_key: "wk" }, { work_key: "wk", ask_id: "a1" }), true);
	assert.equal(waitMatches({ work_key: "wk", ask_id: "a1" }, { work_key: "wk", ask_id: "a1" }), true);
	assert.equal(waitMatches({ work_key: "wk", ask_id: "a1" }, { work_key: "wk", ask_id: "a2" }), false);
	assert.equal(waitMatches({ work_key: "wk", ask_id: "a1" }, { work_key: "other", ask_id: "a1" }), false);
	assert.equal(waitMatches({ work_key: "wk" }, { work_key: "other" }), false);
});

test("waitNoticeMatchesAskId matches exact trusted metadata, never prefixes or peer prose", () => {
	assert.equal(waitNoticeMatchesAskId("[pi-persona] exocom answer · work_key=wk ask_id=a1 ok=true", "a1"), true);
	assert.equal(waitNoticeMatchesAskId("[pi-persona] exocom wait timed out after 1ms · work_key=wk ask_id=a1", "a1"), true);
	assert.equal(waitNoticeMatchesAskId("[exocom-pending-ask]\nask_id=a1 work_key=wk from_session=peer", "a1"), true);
	assert.equal(waitNoticeMatchesAskId("[pi-persona] exocom answer · work_key=wk ask_id=a1 ok=true", "a"), false);
	assert.equal(
		waitNoticeMatchesAskId("[peer] — message\nPeer message (untrusted data):\n> ask_id=a1", "a1"),
		false,
		"untrusted message bodies cannot cause notifier cleanup",
	);
});
