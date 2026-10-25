import { test } from "node:test";
import assert from "node:assert/strict";

import { constrainedTurnAllows } from "../../../src/exocom/gate.ts";

test("inbound constrained turn permits identity metadata, settlement, and read tools", () => {
	for (const name of ["exocom_name", "exocom_answer", "exocom_decline", "exocom_status", "read", "grep", "find", "ls"]) {
		assert.equal(constrainedTurnAllows(name), true, name);
	}
	for (const name of ["exocom_send", "exocom_claim", "exocom_ask", "exocom_wait", "exocom_release", "delegate", "bash", "write", "edit", ""]) {
		assert.equal(constrainedTurnAllows(name), false, name);
	}
});

test("pending asks allow only explicit read actions of collaboration tools", () => {
	for (const [name, action] of [["exocom_task", "list"], ["exocom_publish", "read"], ["exocom_profile", "get"]]) {
		assert.equal(constrainedTurnAllows(name!, { action }), true);
		assert.equal(constrainedTurnAllows(name!), false);
	}
	for (const [name, action] of [["exocom_task", "take"], ["exocom_task", "create"], ["exocom_publish", "publish"], ["exocom_profile", "set"], ["exocom_profile", "clear"]]) {
		assert.equal(constrainedTurnAllows(name!, { action }), false);
	}
});
