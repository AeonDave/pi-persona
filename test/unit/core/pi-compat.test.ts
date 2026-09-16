import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

test("installedPiVersion returns the real semver when the host package is on disk", (t) => {
	// `@earendil-works/pi-coding-agent` is ESM-only (no `main`), so resolution must go through
	// `import.meta.resolve` rather than `createRequire(...).resolve`, which throws
	// ERR_PACKAGE_PATH_NOT_EXPORTED for a package with no CJS entry.
	const pkgPath = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
	if (!existsSync(pkgPath)) {
		t.skip("`@earendil-works/pi-coding-agent` is not installed in this checkout");
		return;
	}
	const expected = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
	assert.equal(installedPiVersion(), expected);
});
