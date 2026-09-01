import { test } from "node:test";
import assert from "node:assert/strict";

import { looksLikeProviderError } from "../../../src/engine/errors.ts";

test("recognizes provider-side rejections/outages", () => {
	for (const text of [
		"Error: 429 rate limit exceeded",
		"Request failed: 503 Service Unavailable",
		"invalid_api_key provided",
		"401 Unauthorized",
		"The model is overloaded, please try again later",
		"model_not_supported: claude-x",
		"This model does not exist on this provider",
		"socket hang up",
		"fetch failed",
		"insufficient credits on this key",
	]) {
		assert.equal(looksLikeProviderError(text), true, JSON.stringify(text));
	}
});

test("does not brand agent-side failures as provider errors (a wrong reroute burns tokens)", () => {
	for (const text of [
		"agent aborted",
		"agent timed out — no output for 300000ms",
		"tool execution failed: permission denied",
		"contract default failed: missing required field: result",
		"unknown agent (not found in registry)",
		"ENOENT: no such file or directory",
		"Cannot read properties of undefined (reading 'x')",
	]) {
		assert.equal(looksLikeProviderError(text), false, JSON.stringify(text));
	}
});
