import assert from "node:assert/strict";
import { test } from "node:test";

import { parseExocomArgv } from "../../../src/exocom/activation.ts";

test("parseExocomArgv keeps bare --exocom workspace-scoped", () => {
	assert.deepEqual(parseExocomArgv(["node", "pi", "--exocom"]), {});
});

test("parseExocomArgv reads the four-character Base62 join code from --exocom=<code>", () => {
	assert.deepEqual(parseExocomArgv(["node", "pi", "--exocom=Ab0T"]), { joinCode: "Ab0T" });
});

test("parseExocomArgv ignores message text after the option terminator", () => {
	assert.deepEqual(parseExocomArgv(["node", "pi", "--", "--exocom=Ab0T"]), {});
});

test("parseExocomArgv fails closed on malformed or conflicting explicit codes", () => {
	assert.match(parseExocomArgv(["node", "pi", "--exocom=abc"]).error ?? "", /exactly 4 Base62/i);
	assert.match(parseExocomArgv(["node", "pi", "--exocom="]).error ?? "", /exactly 4 Base62/i);
	assert.match(
		parseExocomArgv(["node", "pi", "--exocom=Ab0T", "--exocom=Z9xy"]).error ?? "",
		/conflicting/i,
	);
});

test("parseExocomArgv accepts repeated copies of the same explicit code", () => {
	assert.deepEqual(
		parseExocomArgv(["node", "pi", "--exocom=Ab0T", "--exocom=Ab0T"]),
		{ joinCode: "Ab0T" },
	);
});
