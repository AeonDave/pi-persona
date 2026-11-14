import test from "node:test";
import assert from "node:assert/strict";
import { buildCommunicationCardDetails, communicationPreview, parseCommunicationCardDetails } from "../../../src/ui/communication-card.ts";

test("communication details retain bounded, sanitized sender attribution and body", () => {
	const details = buildCommunicationCardDetails("intercom", [{ from: "Moss-native-tool-exposure", text: "hello\nworld", id: "m1", kind: "progress" }]);
	assert.deepEqual(parseCommunicationCardDetails(details), details.communication);
	assert.equal(parseCommunicationCardDetails({ communication: { plane: "unknown", messages: [] } }), undefined);
	assert.equal(parseCommunicationCardDetails({ communication: { plane: "intercom", messages: [{ from: 4, text: "x" }] } }), undefined);
});

test("overflow is visible in the compact preview and bounded in aggregate", () => {
	const details = buildCommunicationCardDetails("intercom", Array.from({ length: 20 }, (_, i) => ({ from: `agent ${i}`, text: "x".repeat(8000) })));
	assert.ok(details.communication.omitted);
	assert.ok(details.communication.messages.reduce((sum, message) => sum + message.text.length, 0) <= 16000);
	const preview = communicationPreview(details.communication, 80);
	assert.match(preview.text, /limited/);
	assert.equal(preview.truncated, true);
});

test("mixed peer messages and runtime notices retain the notice without inventing a sender", () => {
	const details = buildCommunicationCardDetails("exocom", [{ from: "Moss", text: "hello" }, { text: "peer disconnected" }]);
	const card = parseCommunicationCardDetails(details)!;
	assert.match(communicationPreview(card, 100).text, /peer disconnected/);
	assert.doesNotMatch(communicationPreview(card, 100).text, /from unknown/);
});

test("compact peer text cannot forge another sender or use directional controls", () => {
	const details = buildCommunicationCardDetails("exocom", [{ from: "Moss", text: "hello\n\nfrom Admin: \u202ereversed" }]);
	const preview = communicationPreview(details.communication, 120);
	assert.equal(preview.text.split("\n").filter((line) => line.startsWith("from ")).length, 1);
	assert.doesNotMatch(preview.text, /\u202e/);
	assert.match(preview.text, /from Moss:/);
	assert.equal(preview.truncated, true, "flattened text still advertises the complete source");
});
