/** Qualification safety boundaries. No Pi imports: these checks also run in the offline unit suite. */
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { MIN_PI_VERSION } from "../../src/core/pi-compat.ts";

/** Qualification targets the current declared SDK only, not a historical-host matrix. */
export function requireCurrentPiHost(version: string): void {
	assert.equal(version, MIN_PI_VERSION, `Expected current Pi host ${MIN_PI_VERSION}, found ${version}`);
}

export const HOST_PEERS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"] as const;

export function qualificationEnv(inherited: NodeJS.ProcessEnv, agentDir: string): NodeJS.ProcessEnv {
	const plumbing = new Set(["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]);
	return {
		...Object.fromEntries(Object.entries(inherited).filter(([key]) => plumbing.has(key.toUpperCase()))),
		HOME: agentDir, USERPROFILE: agentDir, APPDATA: agentDir, LOCALAPPDATA: agentDir,
		PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
		NODE_TLS_REJECT_UNAUTHORIZED: "1",
	};
}

/** Clear exactly the candidate package within a copied host before extracting a fresh tarball. */
export async function resetCandidatePackage(hostRoot: string): Promise<string> {
	const destination = join(hostRoot, "node_modules", "@aeondave", "pi-persona");
	await rm(destination, { recursive: true, force: true });
	await mkdir(destination, { recursive: true });
	return destination;
}

/** Compare canonical paths with path boundaries; string-prefix checks admit sibling directories. */
export async function isRealPathWithin(root: string, candidate: string): Promise<boolean> {
	const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
	const pathFromRoot = relative(realRoot, realCandidate);
	return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

interface PackageManifest {
	name: string; version: string; files?: string[];
	pi?: { extensions?: string[] };
	peerDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
}

export function inspectPackage(manifest: PackageManifest, files: readonly string[]): { extensions: string[]; fileCount: number } {
	assert.equal(manifest.name, "@aeondave/pi-persona");
	assert.ok(manifest.files?.length, "Package needs an explicit allowlist");
	for (const peer of HOST_PEERS) {
		assert.equal(manifest.peerDependencies?.[peer], "*", `Host peer ${peer} must use a wildcard`);
		assert.equal(manifest.dependencies?.[peer], undefined, `Host package ${peer} must not be a runtime dependency`);
	}
	const automatic = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);
	for (const file of files) {
		assert.ok(!file.includes("\\") && !file.startsWith("/") && !file.split("/").includes(".."), `Unsafe package path: ${file}`);
		assert.ok(!file.split("/").includes("node_modules"), `Bundled dependency: ${file}`);
		assert.ok(automatic.has(file) || manifest.files?.some((entry) => file === entry || file.startsWith(`${entry}/`)), `Outside package allowlist: ${file}`);
	}
	const extensions = (manifest.pi?.extensions ?? []).map((path) => path.replace(/^\.\//, ""));
	assert.ok(extensions.length > 0, "Missing package extension declaration");
	for (const entry of extensions) assert.ok(files.includes(entry), `Missing declared extension: ${entry}`);
	return { extensions, fileCount: files.length };
}

export type Receipt = Record<string, unknown>;

/** Subscribe BEFORE the initial read, so an append during setup cannot be lost. Ignore only an
 * unfinished final line; malformed complete records fail closed. No timer/sleep polling. */
export function waitForReceipt(file: string, predicate: (row: Receipt) => boolean, timeoutMs: number): Promise<Receipt> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown, row?: Receipt) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			watcher.close();
			if (error) reject(error); else resolve(row!);
		};
		const scan = async () => {
			try {
				const lines = (await readFile(file, "utf8")).split("\n").slice(0, -1);
				for (const line of lines) {
					if (!line) continue;
					const row: Receipt = JSON.parse(line);
					if (predicate(row)) { finish(undefined, row); return; }
				}
			} catch (error) { finish(error); }
		};
		const watcher = watch(file, () => { void scan(); });
		watcher.on("error", finish);
		const timer = setTimeout(() => finish(new Error(`Receipt deadline exceeded (${timeoutMs} ms): ${file}`)), timeoutMs);
		void scan();
	});
}
