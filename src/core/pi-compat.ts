import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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

/** Best-effort: the host's package.json is not in its `exports` map, so resolve the entry and read the file. */
export function installedPiVersion(): string | undefined {
	try {
		const entry = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
		let dir = dirname(entry);
		for (let i = 0; i < 6; i++) {
			try {
				const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
				if (pkg.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string") return pkg.version;
			} catch { /* climb */ }
			dir = dirname(dir);
		}
	} catch { /* unresolved host */ }
	return undefined;
}
