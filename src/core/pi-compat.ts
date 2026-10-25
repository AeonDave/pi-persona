import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** API baseline of the current stable Pi target. Update with the four pinned development
 * packages and qualify the installed artifact; historical host releases are not maintained.
 * Keep README.md aligned. Host peers remain "*" because Pi supplies them through its loader. */
export const MIN_PI_VERSION = "1.4.0";

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
	// The current host exposes its entry through the ESM import condition.
	try {
		return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
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
