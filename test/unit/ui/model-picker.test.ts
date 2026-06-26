import { test } from "node:test";
import assert from "node:assert/strict";

import { filterModels, orderModelRefs, visibleWindow } from "../../../src/ui/model-picker.ts";

test("filterModels: case-insensitive substring, order preserved, empty query returns all", () => {
	const opts = ["anthropic/claude-sonnet-4-6", "openrouter/owl-alpha", "openrouter/qwen-3"];
	assert.deepEqual(filterModels(opts, ""), opts);
	assert.deepEqual(filterModels(opts, "  "), opts, "whitespace-only query returns all");
	assert.deepEqual(filterModels(opts, "OWL"), ["openrouter/owl-alpha"]);
	assert.deepEqual(filterModels(opts, "openrouter"), ["openrouter/owl-alpha", "openrouter/qwen-3"]);
	assert.deepEqual(filterModels(opts, "zzz"), []);
});

test("visibleWindow: keeps the selected row inside the viewport with minimal scroll", () => {
	const size = 5;
	const total = 20;
	// Short lists never scroll.
	assert.equal(visibleWindow(3, size, 4, 0), 0);
	// Selecting within the current window keeps the scroll.
	assert.equal(visibleWindow(2, size, total, 0), 0);
	// Selecting below the window pushes scroll down so the row is the last visible.
	assert.equal(visibleWindow(7, size, total, 0), 3, "7 - 5 + 1 = 3");
	// Selecting above the window pulls scroll up to the row.
	assert.equal(visibleWindow(2, size, total, 6), 2);
	// Never scrolls past the end.
	assert.equal(visibleWindow(19, size, total, 0), 15, "max scroll = total - size");
	// Never negative.
	assert.equal(visibleWindow(0, size, total, 0), 0);
});

test("orderModelRefs: session provider first (then alphabetical), originals untouched", () => {
	const refs = ["openrouter/owl-alpha", "anthropic/sonnet", "bedrock/nova", "anthropic/haiku"];
	const ordered = orderModelRefs(refs, "anthropic");
	assert.deepEqual(ordered, ["anthropic/haiku", "anthropic/sonnet", "bedrock/nova", "openrouter/owl-alpha"]);
	// pure: input array not mutated
	assert.equal(refs[0], "openrouter/owl-alpha");
	// no session provider → plain alphabetical
	assert.deepEqual(orderModelRefs(["b/x", "a/y"], undefined), ["a/y", "b/x"]);
});
