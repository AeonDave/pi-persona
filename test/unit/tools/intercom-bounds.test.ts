import assert from "node:assert/strict";
import { test } from "node:test";

import { formatInbox, MAX_INBOX_BATCH_CHARS, MAX_INBOX_MESSAGE_CHARS } from "../../../src/tools/intercom.ts";
import type { Envelope } from "../../../src/bus/inproc.ts";

function message(index: number, text: string): Envelope {
	return {
		id: `ask-${index}`,
		from: `worker-${index}`,
		to: "supervisor",
		kind: "decision",
		text,
		expectsReply: true,
	};
}

test("formatInbox bounds one large body with head/tail and omission count", () => {
	const body = `HEAD-${"x".repeat(MAX_INBOX_MESSAGE_CHARS * 4)}-TAIL`;
	const rendered = formatInbox([message(1, body)]);

	assert.ok(rendered.length <= MAX_INBOX_BATCH_CHARS);
	assert.match(rendered, /worker-1/);
	assert.match(rendered, /reply with id ask-1/);
	assert.match(rendered, /HEAD-/);
	assert.match(rendered, /TAIL/);
	assert.match(rendered, /characters omitted/);
});

test("formatInbox shares the batch budget so later reply ids remain visible", () => {
	const messages = Array.from({ length: 80 }, (_, index) => message(index, "y".repeat(MAX_INBOX_MESSAGE_CHARS * 3)));
	const rendered = formatInbox(messages);

	assert.ok(rendered.length <= MAX_INBOX_BATCH_CHARS);
	for (const index of [0, 1, 40, 79]) {
		assert.match(rendered, new RegExp(`worker-${index}`));
		assert.match(rendered, new RegExp(`ask-${index}`));
	}
});
