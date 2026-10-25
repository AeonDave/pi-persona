import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeExocomProfile } from "../../../src/exocom/profile.ts";

test("an absent or empty profile stays absent rather than claiming availability", () => {
	assert.equal(normalizeExocomProfile(undefined), undefined);
	assert.equal(normalizeExocomProfile({}), undefined);
	assert.equal(normalizeExocomProfile({ capabilities: ["  "] }), undefined);
});

test("profile normalization keeps availability optional and bounds self-reported capabilities", () => {
	const profile = normalizeExocomProfile({
		availability: "busy",
		capabilities: [" TypeScript ", "Rust", "Python", "Go", "C#", "Java", "SQL", "Bash", "ignored"],
	});
	assert.deepEqual(profile, {
		availability: "busy",
		capabilities: ["TypeScript", "Rust", "Python", "Go", "C#", "Java", "SQL", "Bash"],
	});
	assert.deepEqual(normalizeExocomProfile({ capabilities: ["research"] }), { capabilities: ["research"] });
	assert.equal(normalizeExocomProfile({ availability: "unknown", capabilities: [] }), undefined);
});

test("profile labels are flattened, safe, and at most 48 characters", () => {
	const label = `Rust\n<admin>\u001b[31m${"x".repeat(64)}`;
	const profile = normalizeExocomProfile({ capabilities: [label] });
	assert.ok(profile);
	assert.equal(profile.capabilities[0], `Rust admin [31m${"x".repeat(33)}`);
	assert.ok(profile.capabilities[0]!.length <= 48);
	assert.doesNotMatch(profile.capabilities[0]!, /[<>\u001b\n]/);
});
