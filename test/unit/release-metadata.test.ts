import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

test("release metadata stays aligned", () => {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { name: string; version: string };
	const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")) as {
		name: string;
		version: string;
		packages: Record<string, { name?: string; version?: string }>;
	};
	const readme = readFileSync(new URL("README.md", root), "utf8");
	const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8");

	assert.equal(pkg.name, "@aeondave/pi-persona");
	assert.equal(lock.name, pkg.name, "package-lock top-level name must match package.json");
	assert.equal(lock.packages[""]?.name, pkg.name, "package-lock root package name must match package.json");
	assert.ok(readme.includes(`pi install npm:${pkg.name}`));
	assert.ok(readme.includes(`pi install npm:${pkg.name}@${pkg.version}`));
	assert.equal(lock.version, pkg.version, "package-lock top-level version must match package.json");
	assert.equal(lock.packages[""]?.version, pkg.version, "package-lock root package version must match package.json");
	assert.match(readme, new RegExp(`pi-persona@v${pkg.version.replaceAll(".", "\\.")}`));
	assert.match(changelog, new RegExp(`^## \\[${pkg.version.replaceAll(".", "\\.")}\\]`, "m"));
});

test("Pi supplies host packages through peer dependencies without runtime copies", () => {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
		peerDependencies: Record<string, string>;
		devDependencies: Record<string, string>;
		dependencies?: Record<string, string>;
	};
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core",
		"@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(pkg.peerDependencies[name], "*", `${name} is supplied by Pi`);
		assert.equal(pkg.dependencies?.[name], undefined, `do not install a second runtime copy of ${name}`);
		assert.ok(pkg.devDependencies[name], `${name} remains available for development and tests`);
	}
});

test("npm publication is public and explicitly allowlists documentation and artwork", () => {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
		publishConfig: { access: string };
		repository: { type: string; url: string };
		files: string[];
		pi: { image: string; video: string };
	};
	assert.equal(pkg.publishConfig?.access, "public");
	assert.equal(pkg.repository?.url, "git+https://github.com/AeonDave/pi-persona.git");
	for (const [url, asset] of [[pkg.pi.image, "assets/banner.png"], [pkg.pi.video, "assets/demo1.mp4"]]) {
		assert.ok(url && asset);
		assert.equal(new URL(url).protocol, "https:");
		assert.ok(url.endsWith(`/${asset}`));
		assert.ok(pkg.files.includes(asset));
		assert.ok(readFileSync(new URL(asset, root)).length > 0);
	}
	for (const path of ["src", "personas", "agents", "prompts", "flows", "contracts", "presets", "teams.yaml",
		"docs/ARCHITECTURE.md", "docs/REFERENCE.md", "assets/banner.png", "assets/workflow.png", "CHANGELOG.md", "SECURITY.md", "LICENSE"]) {
		assert.ok(pkg.files.includes(path), `publish required resource: ${path}`);
	}
	for (const path of pkg.files) {
		assert.doesNotMatch(path, /^(?:docs|assets)\/?$|\*|reddit-post|banner-options|^scripts(?:\/|$)/,
			"drafts, alternative artwork and development harnesses must not enter npm artifacts");
	}
});
