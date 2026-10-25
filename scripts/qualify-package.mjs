#!/usr/bin/env node
/** Installed-TARBALL qualification. No provider traffic or operator profile is permitted.
 * node scripts/qualify-package.mjs --host 1.4.0
 * Or pass an installed current-host package path; older host versions are rejected.
 * A version downloads only official Pi packages with scripts disabled; a path copies an installed
 * host into OS temp. All artifacts/logs are retained there for diagnosis. Repack after integration.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_PEERS, inspectPackage, isRealPathWithin, qualificationEnv, resetCandidatePackage, requireCurrentPiHost } from "./lib/package-qualification.ts";
import { runQualificationProcess } from "./lib/package-qualification-process.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const requested = [];
for (let i = 2; i < process.argv.length; i++) {
	assert.equal(process.argv[i], "--host", "Usage: node scripts/qualify-package.mjs --host <version|absolute-installed-host-root> [--host ...]");
	const value = process.argv[++i];
	assert.ok(value && (isAbsolute(value) || /^\d+\.\d+\.\d+$/.test(value)), "Host must be an exact version or absolute package root");
	if (!isAbsolute(value)) requireCurrentPiHost(value);
	requested.push(value);
}
assert.ok(requested.length, "Pass --host <current Pi version> or --host <installed current Pi package root>");
const root = await mkdtemp(join(tmpdir(), "pi-persona-package-qualification-"));
const env = qualificationEnv(process.env, join(root, "preparation-profile"));
await mkdir(env.PI_AGENT_DIR, { recursive: true });
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
assert.ok(existsSync(npmCli), `Cannot locate npm CLI: ${npmCli}`);
await writeFile(join(root, "npmrc"), "");
const npmFlags = ["--ignore-scripts", "--strict-ssl=true", "--no-audit", "--no-fund", "--userconfig", join(root, "npmrc"), "--globalconfig", join(root, "npmrc-global"), "--cache", join(root, "npm-cache")];
await writeFile(join(root, "npmrc-global"), "");
async function command(label, executable, args, cwd = root, childEnv = env, timeoutMs = 180000) {
	const result = await runQualificationProcess(executable, args, { cwd, env: childEnv, timeoutMs });
	await writeFile(join(root, `${label}.stdout.log`), result.stdout);
	await writeFile(join(root, `${label}.stderr.log`), result.stderr);
	assert.equal(result.code, 0, `${label} exited ${result.code}: ${result.stderr.slice(-4000)} (logs: ${root})`);
	return result.stdout;
}
const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const [packed] = JSON.parse(await command("pack", process.execPath, [npmCli, "pack", repo, "--json", "--pack-destination", root, ...npmFlags]));
const inventory = inspectPackage(manifest, packed.files.map((entry) => entry.path));
const tarball = join(root, packed.filename);
const archiveFiles = (await command("tar-inventory", "tar", ["-tzf", packed.filename])).trim().split(/\r?\n/).filter((name) => !name.endsWith("/")).map((name) => {
	assert.ok(name.startsWith("package/"), `Unexpected archive root: ${name}`);
	return name.slice(8);
});
assert.deepEqual([...archiveFiles].sort(), packed.files.map((entry) => entry.path).sort(), "Archive differs from npm's inspected inventory");
const report = {
	artifact: { tarball, sha256: createHash("sha256").update(await readFile(tarball)).digest("hex"), integrity: packed.integrity, ...inventory, files: archiveFiles },
	source: { head: (await command("source-head", "git", ["rev-parse", "HEAD"], repo)).trim(), status: await command("source-status", "git", ["status", "--short"], repo), qualificationScope: "installed-artifact execution; full-suite and adversarial review are separate gates" },
	root, hosts: [],
};
await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
process.stdout.write(`Artifacts and logs: ${root}\n`);
for (const [index, target] of requested.entries()) {
	const result = { requested: target, status: "FAIL", engines: [] };
	report.hosts.push(result);
	try {
		const installation = join(root, `host-${index}`);
		const hostRoot = join(installation, "node_modules", "@earendil-works", "pi-coding-agent");
		if (isAbsolute(target)) {
			const original = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
			assert.equal(original.name, "@earendil-works/pi-coding-agent");
			requireCurrentPiHost(original.version);
			const originalCli = typeof original.bin === "string" ? original.bin : original.bin.pi;
			const originalCliPath = join(target, originalCli);
			const originalRuntimePath = join(dirname(originalCliPath), "cli-runtime.js");
			result.origin = {
				installedRoot: target, version: original.version,
				cliSha256: createHash("sha256").update(await readFile(originalCliPath)).digest("hex"),
				...(existsSync(originalRuntimePath) ? { cliRuntimeSha256: createHash("sha256").update(await readFile(originalRuntimePath)).digest("hex") } : {}),
			};
			await cp(target, hostRoot, { recursive: true, dereference: true });
			// Installed hosts normally have nested dependencies. Copy hoisted siblings as needed,
			// rather than letting the copied host fall back to this repository's development tree.
			for (const dependency of Object.keys(original.dependencies ?? {})) {
				const sourceManifest = findPackageJSON(dependency, pathToFileURL(join(target, "probe.mjs")));
				const localManifest = join(hostRoot, "node_modules", dependency, "package.json");
				if (!existsSync(localManifest)) await cp(dirname(sourceManifest), dirname(localManifest), { recursive: true, dereference: true });
			}
		} else {
			await mkdir(installation, { recursive: true });
			await writeFile(join(installation, "package.json"), JSON.stringify({ private: true, type: "module" }));
			// Pin all host boundary packages together: caret dependency ranges must not produce
			// a mixed-version runtime while the report claims one qualified SDK.
			const packages = ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui", "pi-codemode", "pi-mcp"].map((name) => `@earendil-works/${name}@${target}`);
			await command(`install-${index}`, process.execPath, [npmCli, "install", ...packages, ...npmFlags], installation);
		}
		const hostPackage = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
		result.version = hostPackage.version;
		const hostCli = typeof hostPackage.bin === "string" ? hostPackage.bin : hostPackage.bin.pi;
		const hostCliPath = join(hostRoot, hostCli);
		const hostRuntimePath = join(dirname(hostCliPath), "cli-runtime.js");
		result.cliSha256 = createHash("sha256").update(await readFile(hostCliPath)).digest("hex");
		if (existsSync(hostRuntimePath)) result.cliRuntimeSha256 = createHash("sha256").update(await readFile(hostRuntimePath)).digest("hex");
		if (!isAbsolute(target)) assert.equal(result.version, target);
		else {
			assert.equal(result.cliSha256, result.origin.cliSha256, "Copied host differs from the selected installed CLI");
			assert.equal(result.cliRuntimeSha256, result.origin.cliRuntimeSha256, "Copied host cli-runtime.js differs from the selected installed host");
		}
		const packageRoot = await resetCandidatePackage(hostRoot);
		await command(`extract-${index}`, "tar", ["-xzf", packed.filename, "--strip-components=1", "-C", relative(root, packageRoot).replaceAll("\\", "/")]);
		assert.deepEqual(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")), manifest);
		result.peers = [];
		for (const name of HOST_PEERS) {
			const peerManifest = findPackageJSON(name, pathToFileURL(join(packageRoot, "probe.mjs")));
			assert.ok(peerManifest && await isRealPathWithin(installation, peerManifest), `Peer escaped temporary host: ${name} -> ${peerManifest}`);
			const peer = JSON.parse(await readFile(peerManifest, "utf8"));
			if (name !== "typebox") assert.equal(peer.version, result.version, `Mixed host boundary: ${name}`);
			result.peers.push({ name, version: peer.version, manifest: peerManifest });
		}
		const fixtures = join(hostRoot, "node_modules", "package-qualification-fixtures");
		await mkdir(fixtures, { recursive: true });
		for (const name of ["provider", "tripwire"]) await cp(join(repo, "test", "fixtures", `package-qualification-${name}.mjs`), join(fixtures, `${name}.mjs`));
		for (const engine of ["inproc", "child"]) {
			const runRoot = join(installation, engine);
			await mkdir(runRoot, { recursive: true });
			const runEnv = qualificationEnv(process.env, join(runRoot, "agent"));
			const run = await runQualificationProcess(process.execPath, [fileURLToPath(new URL("./lib/package-qualification-run.mjs", import.meta.url)), hostRoot, packageRoot, fixtures, runRoot, engine], { env: runEnv, cwd: root, timeoutMs: 90000 });
			await writeFile(join(runRoot, "stdout.log"), run.stdout);
			await writeFile(join(runRoot, "stderr.log"), run.stderr);
			const outcome = JSON.parse(await readFile(join(runRoot, "outcome.json"), "utf8"));
			result.engines.push({ ...outcome, exitCode: run.code, runRoot });
		}
		result.status = result.engines.every((run) => run.status === "PASS" && run.exitCode === 0) ? "PASS" : "FAIL";
	} catch (error) { result.error = error.stack ?? String(error); }
	await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
process.stdout.write(`Report: ${join(root, "report.json")}\n`);
if (report.hosts.some((host) => host.status !== "PASS")) process.exitCode = 1;
