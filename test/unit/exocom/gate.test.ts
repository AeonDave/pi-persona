import { test } from "node:test";
import assert from "node:assert/strict";

import { constrainedTurnAllows } from "../../../src/exocom/gate.ts";

test("inbound constrained turn is deny-wins except answer/decline and read tools", () => {
	for (const name of ["exocom_answer", "exocom_decline", "read", "grep", "find", "ls"]) {
		assert.equal(constrainedTurnAllows(name), true, name);
	}
	for (const name of ["exocom_send", "exocom_claim", "exocom_ask", "exocom_wait", "exocom_release", "delegate", "bash", "write", "edit", ""]) {
		assert.equal(constrainedTurnAllows(name), false, name);
	}
});
