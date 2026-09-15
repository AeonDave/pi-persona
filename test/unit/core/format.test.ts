import { test } from "node:test";
import assert from "node:assert/strict";

import { compactTokens } from "../../../src/core/format.ts";

test("compactTokens compacts thousands and millions", () => {
	assert.equal(compactTokens(999), "999");
	assert.equal(compactTokens(164_005), "164k");
	assert.equal(compactTokens(1_234_567), "1.2M");
	assert.equal(compactTokens(2_000_000), "2M");
});
