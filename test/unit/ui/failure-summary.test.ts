import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { summarizeFailure } from "../../../src/ui/failure-summary.ts";

test("an account-unsupported model cause survives provider and runtime wrappers without naming the model", () => {
	const detail = "The 'any-future-model' model is not supported when using Codex with a ChatGPT account.";
	assert.equal(summarizeFailure(`[operator · openai/any-future-model +dyn(model)] OpenAI API error (400): 400 ${JSON.stringify({ detail })}`),
		"Model not supported by this ChatGPT account.");
});

test("JSON string causes are extracted from detail, message, nested error.message and string error", () => {
	for (const body of [
		{ detail: "Request rejected for this account." },
		{ message: "Request rejected for this account." },
		{ error: { message: "Request rejected for this account.", type: "invalid_request" } },
		{ error: "Request rejected for this account." },
	]) assert.equal(summarizeFailure(`Provider API error (400): ${JSON.stringify(body)}`), "Request rejected for this account.");
});

test("JSON scanning handles quoted braces, escaped quotes, and trailing diagnostics", () => {
	const detail = 'Invalid value "{candidate}" for this request.';
	assert.equal(summarizeFailure(`Provider rejected request: ${JSON.stringify({ detail })}\nrequest id: trace-123`), detail);
});

test("credit failures keep their provider cause instead of becoming unsupported-model claims", () => {
	const message = "This request requires more credits, or fewer max_tokens.";
	assert.equal(summarizeFailure(`[research · openrouter/provider/model] 402 ${JSON.stringify({ error: { message, code: 402 } })}`), message);
	assert.equal(summarizeFailure('402 {"error":{"type":"unsupported_model","message":"Insufficient credits."}}'), "Insufficient credits.");
});

test("plain provider failures remain faithful and only the runtime identity wrapper is omitted", () => {
	assert.equal(summarizeFailure("Provider error: authentication rejected."), "Provider error: authentication rejected.");
	assert.equal(summarizeFailure("[scout · provider/model] Connection reset by peer."), "Connection reset by peer.");
	assert.equal(summarizeFailure("[BLOCKED] Provider refused the request."), "[BLOCKED] Provider refused the request.");
	assert.equal(summarizeFailure("Model unsupported by this provider."), "Model unsupported by this provider.");
});

test("malformed JSON and unknown objects fall back to sanitized one-line diagnostic text", () => {
	assert.equal(summarizeFailure('\u001b[31mProvider failed:\u001b[0m\n400 {"detail": broken\r\n\u0000tail'), 'Provider failed: 400 {"detail": broken tail');
	assert.equal(summarizeFailure('400 {"code":"unknown_cause"}'), '400 {"code":"unknown_cause"}');
	assert.equal(summarizeFailure('400 {"detail":null,"error":{"message":7}}'), '400 {"detail":null,"error":{"message":7}}');
});

test("JSON-decoded terminal controls and newlines cannot repaint the summary", () => {
	assert.equal(summarizeFailure(JSON.stringify({ error: { message: "\u001b[2JRejected\nnext line\u0000" } })), "Rejected next line");
});

test("giant and wide failures remain bounded to 140 terminal columns", () => {
	for (const input of ["漢".repeat(100_000), "x".repeat(1_000_000), "{".repeat(100_000), JSON.stringify({ detail: "😀".repeat(100_000) })]) {
		const summary = summarizeFailure(input);
		assert.ok(visibleWidth(summary) <= 140, `summary occupied ${visibleWidth(summary)} columns`);
		assert.ok(summary.length <= 140);
		assert.doesNotMatch(summary, /[\r\n\u001b\u0000]/);
		assert.match(summary, /…$/);
	}
});
