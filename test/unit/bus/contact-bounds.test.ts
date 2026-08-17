import assert from "node:assert/strict";
import { test } from "node:test";

import { boundContactMessage, MAX_CONTACT_MESSAGE_CHARS } from "../../../src/bus/contact.ts";

test("contact_supervisor message body is bounded with head/tail and omission count", () => {
	const body = `HEAD-${"z".repeat(MAX_CONTACT_MESSAGE_CHARS * 3)}-TAIL`;
	const bounded = boundContactMessage(body);

	assert.ok(bounded.length <= MAX_CONTACT_MESSAGE_CHARS);
	assert.match(bounded, /HEAD-/);
	assert.match(bounded, /TAIL/);
	assert.match(bounded, /characters omitted/);
	assert.match(bounded, /send the remaining detail in smaller contact_supervisor messages/i);
	assert.doesNotMatch(bounded, /result\/id lookup/i);
});
