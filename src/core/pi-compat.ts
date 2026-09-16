import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest Pi this extension is written against. 0.83 made `message_update` delta-only (src/engine/stream.ts);
 *  older hosts are feature-detected where cheap but are not supported. Keep in sync with package.json. */
export const MIN_PI_VERSION = "0.83.0";

function parse(v: string): [number, number, number] | undefined {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function satisfiesFloor(version: string, floor: string): boolean {
	const a = parse(version), b = parse(floor);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) { if (a[i]! !== b[i]!) return a[i]! > b[i]!; }
	return true;
}

function resolveHostEntry(): string | undefined {
	// The host package is ESM-only (no CJS `main`), so `createRequire(...).resolve` throws
	// ERR_PACKAGE_PATH_NOT_EXPORTED for it — `import.meta.resolve` is tried first because it
	// follows an `exports` map with no `main`/`require` condition. `createRequire` stays as a
	// fallback for any host build that does publish one.
	try {
		return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	} catch { /* fall through */ }
	try {
		return createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
	} catch { /* unresolved host */ }
	return undefined;
}

/** Best-effort: the host's package.json is not in its `exports` map, so resolve the entry and read the file. */
export function installedPiVersion(): string | undefined {
	const entry = resolveHostEntry();
	if (!entry) return undefined;
	let dir = dirname(entry);
	for (let i = 0; i < 6; i++) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
			if (pkg.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string") return pkg.version;
		} catch { /* climb */ }
		dir = dirname(dir);
	}
	return undefined;
}
