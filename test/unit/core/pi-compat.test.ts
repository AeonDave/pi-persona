import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_PI_VERSION, installedPiVersion, satisfiesFloor } from "../../../src/core/pi-compat.ts";

test("satisfiesFloor compares major.minor.patch and ignores prerelease tags", () => {
	assert.equal(satisfiesFloor("0.84.2", "0.83.0"), true);
	assert.equal(satisfiesFloor("0.83.0", "0.83.0"), true);
	assert.equal(satisfiesFloor("0.82.9", "0.83.0"), false);
	assert.equal(satisfiesFloor("1.0.0-beta.1", "0.83.0"), true);
	assert.equal(satisfiesFloor("garbage", "0.83.0"), false);
});

test("installedPiVersion reads the host package version without throwing", () => {
	const v = installedPiVersion();
	assert.ok(v === undefined || /^\d+\.\d+\.\d+/.test(v));
	assert.equal(MIN_PI_VERSION, "0.83.0");
});
