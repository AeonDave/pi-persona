import assert from "node:assert/strict";
import { test } from "node:test";

import { boundContactMessage } from "../../../src/bus/contact.ts";
import { MAX_MESSAGE_CHARS } from "../../../src/bus/inproc.ts";

test("contact_supervisor message body is bounded with head/tail and omission count", () => {
	const body = `HEAD-${"z".repeat(MAX_MESSAGE_CHARS * 3)}-TAIL`;
	const bounded = boundContactMessage(body);

	assert.ok(bounded.length <= MAX_MESSAGE_CHARS);
	assert.match(bounded, /HEAD-/);
	assert.match(bounded, /TAIL/);
	assert.match(bounded, /characters omitted/);
	assert.match(bounded, /send the remaining detail in smaller contact_supervisor messages/i);
	assert.doesNotMatch(bounded, /result\/id lookup/i);
});
