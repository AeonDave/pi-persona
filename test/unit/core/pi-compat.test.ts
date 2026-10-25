import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_PI_VERSION, installedPiVersion, satisfiesFloor } from "../../../src/core/pi-compat.ts";

test("satisfiesFloor compares major.minor.patch and ignores prerelease tags", () => {
	assert.equal(satisfiesFloor("1.0.1", "1.0.0"), true);
	assert.equal(satisfiesFloor("1.0.0", "1.0.0"), true);
	assert.equal(satisfiesFloor("0.99.9", "1.0.0"), false);
	assert.equal(satisfiesFloor("2.0.0-beta.1", "1.0.0"), true);
	assert.equal(satisfiesFloor("garbage", "1.0.0"), false);
});

test("installedPiVersion reads the host package version without throwing", () => {
	const v = installedPiVersion();
	assert.ok(v === undefined || /^\d+\.\d+\.\d+/.test(v));
	assert.equal(satisfiesFloor("1.3.999", MIN_PI_VERSION), false, "historical Pi host lines are not supported");
});

test("the supported host target matches all four pinned Pi development packages", () => {
	const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { devDependencies: Record<string, string> };
	for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) {
		assert.equal(pkg.devDependencies[`@earendil-works/${name}`], MIN_PI_VERSION, name);
	}
});

test("installedPiVersion returns the real semver when the host package is on disk", (t) => {
	// The current host exports its ESM import entry; resolve through that export condition.
	const pkgPath = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
	if (!existsSync(pkgPath)) {
		t.skip("`@earendil-works/pi-coding-agent` is not installed in this checkout");
		return;
	}
	const expected = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
	assert.equal(installedPiVersion(), expected);
});
