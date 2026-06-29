/**
 * Seeding the bundled defaults into the user's Pi agent dir, so a user can edit/extend them
 * and the supervisor always runs the user's copies (they shadow the builtin by discovery
 * precedence). `force` overwrites existing files — that is the "restore originals" command;
 * non-force keeps user edits (first run / pulling in new defaults).
 *
 * Layout mirrors discovery: personas + agents live together under `<user>/agents` (classified
 * by `persona: true`), teams in `<user>/teams.yaml`, and flows/contracts/presets in their own
 * `<user>/<kind>` dirs. A persona and an agent may share a name (e.g. `reviewer`); in one folder
 * only one file can win, so the PERSONA owns it and the colliding builtin agent still loads.
 *
 * Pure over node:fs (no Pi imports), so the copy/skip logic is unit-tested with temp dirs.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SeedResult {
	/** Absolute paths written. */
	copied: string[];
	/** Absolute paths left untouched (already existed, or a persona owned a colliding name). */
	skipped: string[];
}

function listByExt(dir: string, ext: string): string[] {
	try {
		return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext));
	} catch {
		return []; // a bundled asset folder may be absent — that is fine
	}
}

/** Copy the bundled defaults under `bundledDir` into `userDir`. Returns what changed. */
export function seedDefaults(bundledDir: string, userDir: string, force: boolean): SeedResult {
	const copied: string[] = [];
	const skipped: string[] = [];
	const place = (src: string, dst: string): void => {
		if (!force && existsSync(dst)) {
			skipped.push(dst);
			return;
		}
		mkdirSync(dirname(dst), { recursive: true });
		copyFileSync(src, dst);
		copied.push(dst);
	};

	// personas + agents share <user>/agents. Seed personas first and let them OWN a shared name;
	// the builtin agent of that name still loads (it is just not seeded into the user dir).
	const personaFiles = listByExt(join(bundledDir, "personas"), ".md");
	const ownedByPersona = new Set(personaFiles);
	for (const f of personaFiles) place(join(bundledDir, "personas", f), join(userDir, "agents", f));
	for (const f of listByExt(join(bundledDir, "agents"), ".md")) {
		if (ownedByPersona.has(f)) {
			skipped.push(join(userDir, "agents", f));
			continue;
		}
		place(join(bundledDir, "agents", f), join(userDir, "agents", f));
	}

	// flows / contracts / presets → their own user dirs.
	for (const [sub, ext] of [
		["flows", ".flow.json"],
		["contracts", ".contract.json"],
		["presets", ".preset.json"],
	] as const) {
		for (const f of listByExt(join(bundledDir, sub), ext)) place(join(bundledDir, sub, f), join(userDir, sub, f));
	}

	// teams.yaml — a single merged file.
	const teamsSrc = join(bundledDir, "teams.yaml");
	if (existsSync(teamsSrc)) place(teamsSrc, join(userDir, "teams.yaml"));

	return { copied, skipped };
}
