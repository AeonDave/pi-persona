import assert from "node:assert/strict";
import { test } from "node:test";

import {
	IDENTITY_ENTRY_CUSTOM_TYPE,
	MAX_IDENTITY_NAME_CHARS,
	findStoredIdentity,
	isReservedIdentityName,
	provisionalIdentityName,
	sanitizeIdentityName,
} from "../../../src/core/session-identity.ts";

test("provisional identity is derived from the last alphanumeric session id", () => {
	assert.equal(provisionalIdentityName("session-0000-ABcdEF12"), "pi-ABcdEF12");
	assert.equal(provisionalIdentityName("short"), "pi-short");
	assert.match(provisionalIdentityName("!@#$%^&*()"), /^pi-[A-Za-z0-9]+$/);
});

test("identity names are bounded safe labels and reject generic or reserved names", () => {
	assert.equal(MAX_IDENTITY_NAME_CHARS, 32);
	assert.equal(sanitizeIdentityName("  Blue Sky  "), "Blue-Sky");
	assert.equal(sanitizeIdentityName("\u001b[31mred\u001b[0m"), "red");
	assert.equal(sanitizeIdentityName("   "), undefined);
	assert.equal(sanitizeIdentityName("🙂"), undefined);
	assert.equal(isReservedIdentityName("Supervisor", ["reviewer"]), true);
	assert.equal(isReservedIdentityName("REVIEWER", ["reviewer"]), true);
	assert.equal(isReservedIdentityName("blue", ["reviewer"]), false);
	assert.equal(sanitizeIdentityName("reviewer", ["reviewer"]), undefined);
	assert.equal(sanitizeIdentityName("a".repeat(80)), "a".repeat(MAX_IDENTITY_NAME_CHARS));
});

test("stored identity is restored only from a matching custom entry and session id", () => {
	const entries = [
		{ type: "custom", customType: IDENTITY_ENTRY_CUSTOM_TYPE, data: { version: 1, sessionId: "fork-a", name: "wrong" } },
		{ type: "custom", customType: IDENTITY_ENTRY_CUSTOM_TYPE, data: { version: 1, sessionId: "session-a", name: "First" } },
		{ type: "custom", customType: IDENTITY_ENTRY_CUSTOM_TYPE, data: { version: 1, sessionId: "session-a", name: "Second" } },
		{ type: "custom", customType: "other", data: { version: 1, sessionId: "session-a", name: "ignored" } },
	];
	assert.equal(findStoredIdentity(entries, "session-a"), "Second");
	assert.equal(findStoredIdentity(entries, "fork-a"), "wrong");
	assert.equal(findStoredIdentity(entries, "missing"), undefined);
});
