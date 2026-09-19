import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

test("release metadata stays aligned", () => {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string };
	const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")) as {
		version: string;
		packages: Record<string, { version?: string }>;
	};
	const readme = readFileSync(new URL("README.md", root), "utf8");
	const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8");

	assert.equal(lock.version, pkg.version, "package-lock top-level version must match package.json");
	assert.equal(lock.packages[""]?.version, pkg.version, "package-lock root package version must match package.json");
	assert.match(readme, new RegExp(`pi-persona@v${pkg.version.replaceAll(".", "\\.")}`));
	assert.match(changelog, new RegExp(`^## \\[${pkg.version.replaceAll(".", "\\.")}\\]`, "m"));
});
