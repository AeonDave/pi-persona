/**
 * Seeding the bundled defaults into the user's Pi agent dir, so a user can edit/extend them
 * and the supervisor always runs the user's copies (they shadow the builtin by discovery
 * precedence). `force` overwrites existing files — that is the "restore originals" command;
 * non-force keeps user edits (first run / pulling in new defaults).
 *
 * Layout mirrors discovery: personas + agents live together under `<user>/agents` (classified
 * by `persona: true`), teams in `<user>/teams.yaml`, the spine pair flat in `<user>` (bundled
 * under `prompts/`, but that is where `resolveSpine` looks), and flows/contracts/presets in
 * their own `<user>/<kind>` dirs. Should a persona and an agent ever share a name, in one folder
 * only one file can win, so the PERSONA owns it and the colliding builtin agent still loads.
 *
 * Pure over node:fs (no Pi imports), so the copy/skip logic is unit-tested with temp dirs.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SPINE_FILES = ["spine.md", "spine.worker.md"] as const;
type SpineFile = (typeof SPINE_FILES)[number];

/** Exact bytes shipped in v1.8.0 and copied by `/persona seed`. v1.8.1 rewrote both prompts, but
 *  `on` prefers the seeded user file, so those pristine copies otherwise shadow the rewrite forever.
 *  Detection is deliberately read-only: a single user edit changes the digest and is preserved,
 *  while an exact legacy copy can be bypassed by resolution without risking a concurrent edit. */
const LEGACY_SPINE_SHA256: Readonly<Record<SpineFile, string>> = {
	"spine.md": "36c304f0bf9bf1114342cde8cd638adec004a6a50415e17d23c90c82e2394b7b",
	"spine.worker.md": "33dbe81db24602f208a23957c88e638aff1bad38c4038b7356350c75d898f936",
};
const LEGACY_SPINE_SIZE: Readonly<Record<SpineFile, number>> = {
	"spine.md": 2714,
	"spine.worker.md": 1436,
};

export interface SpineLegacySelection {
	supervisor: boolean;
	worker: boolean;
}

export interface SpineLegacyResult {
	/** Exact pristine v1.8.0 user files. Callers may skip these as resolution candidates. */
	legacy: string[];
	warnings: string[];
}

/** The small portion of `fs.Stats` needed to reject links and revalidate an opened file. */
export interface SpineLegacyStat {
	dev: number;
	ino: number;
	nlink: number;
	size: number;
	isFile(): boolean;
}

/** Per-activation filesystem seam. Production leaves it empty; tests can prove rejected files are
 *  never opened/read and that the content read is bounded without replacing process-wide `node:fs`. */
export interface SpineLegacyIO {
	lstat?: (path: string) => SpineLegacyStat;
	open?: (path: string) => number;
	fstat?: (fd: number) => SpineLegacyStat;
	/** Read at most `maxBytes` from offset zero. */
	read?: (fd: number, maxBytes: number) => Buffer;
	close?: (fd: number) => void;
}

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

interface ResolvedSpineLegacyIO {
	lstat(path: string): SpineLegacyStat;
	open(path: string): number;
	fstat(fd: number): SpineLegacyStat;
	read(fd: number, maxBytes: number): Buffer;
	close(fd: number): void;
}

/** Read through a descriptor into a fixed allocation. A file that grows after `fstat` can fill at
 * most expected-size + one byte, which is enough to reject it without ever loading the growth. */
function readBounded(fd: number, maxBytes: number): Buffer {
	const buffer = Buffer.alloc(maxBytes);
	let offset = 0;
	while (offset < maxBytes) {
		const read = readSync(fd, buffer, offset, maxBytes - offset, offset);
		if (read === 0) break;
		offset += read;
	}
	return buffer.subarray(0, offset);
}

function resolveLegacyIO(io: SpineLegacyIO): ResolvedSpineLegacyIO {
	return {
		lstat: io.lstat ?? lstatSync,
		open: io.open ?? ((path) => openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))),
		fstat: io.fstat ?? fstatSync,
		read: io.read ?? readBounded,
		close: io.close ?? closeSync,
	};
}

interface SpineFingerprint {
	dev: number;
	ino: number;
	nlink: number;
	size: number;
}

type Inspection =
	| { kind: "legacy" }
	| { kind: "skip" }
	| { kind: "warning"; detail: string };

function fingerprint(stat: SpineLegacyStat): SpineFingerprint {
	return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size };
}

function sameFingerprint(left: SpineFingerprint, right: SpineFingerprint): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size;
}

function safeLegacyShape(stat: SpineLegacyStat, expectedSize: number): boolean {
	return stat.isFile() && stat.nlink === 1 && stat.size === expectedSize;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Inspect through an opened descriptor. The user-controlled path is never read until both lstat
 *  and fstat establish a single-link regular file of the exact known legacy size. */
function inspectLegacy(path: string, file: SpineFile, io: ResolvedSpineLegacyIO): Inspection {
	let before: SpineLegacyStat;
	try {
		before = io.lstat(path);
	} catch {
		return { kind: "skip" };
	}
	if (!safeLegacyShape(before, LEGACY_SPINE_SIZE[file])) return { kind: "skip" };

	let fd: number;
	try {
		fd = io.open(path);
	} catch (error) {
		return { kind: "warning", detail: `open failed: ${errorText(error)}` };
	}
	try {
		const opened = io.fstat(fd);
		if (!safeLegacyShape(opened, LEGACY_SPINE_SIZE[file])) return { kind: "skip" };
		if (!sameFingerprint(fingerprint(before), fingerprint(opened))) return { kind: "skip" };
		const bytes = io.read(fd, LEGACY_SPINE_SIZE[file] + 1);
		if (bytes.byteLength !== LEGACY_SPINE_SIZE[file]) return { kind: "skip" };
		const after = io.fstat(fd);
		if (!safeLegacyShape(after, LEGACY_SPINE_SIZE[file])) return { kind: "skip" };
		if (!sameFingerprint(fingerprint(opened), fingerprint(after))) return { kind: "skip" };
		if (createHash("sha256").update(bytes).digest("hex") !== LEGACY_SPINE_SHA256[file]) return { kind: "skip" };
		return { kind: "legacy" };
	} catch (error) {
		return { kind: "warning", detail: `inspection failed: ${errorText(error)}` };
	} finally {
		try {
			io.close(fd);
		} catch {
			// The descriptor has no further use; a close error cannot change the classification.
		}
	}
}

/** Find exact, pristine v1.8.0 seeded spine files already present in `userDir` without writing.
 * The extension uses the result to fall through to the current bundled prompt for selector `on`.
 * `/persona restore` remains the explicit, user-authorized operation that updates bytes on disk. */
export function inspectLegacySeededSpines(
	userDir: string,
	selection: SpineLegacySelection,
	ioOverrides: SpineLegacyIO = {},
): SpineLegacyResult {
	const result: SpineLegacyResult = { legacy: [], warnings: [] };
	const io = resolveLegacyIO(ioOverrides);
	for (const file of SPINE_FILES) {
		if (file === "spine.md" ? !selection.supervisor : !selection.worker) continue;
		const path = join(userDir, file);
		const inspection = inspectLegacy(path, file, io);
		if (inspection.kind === "legacy") result.legacy.push(path);
		else if (inspection.kind === "warning") result.warnings.push(`spine legacy inspection warning: ${path}: ${inspection.detail}`);
	}
	return result;
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

	// The spine pair (docs/SPINE.md) — bundled under `prompts/`, seeded FLAT into the data dir,
	// because that is where `PI_PERSONA_SPINE=on` looks for the user's own copy. Without this the
	// documented "your own copy shadows the bundled one" precedence has no gesture that creates
	// the copy, and a user would have to know the two filenames and write them by hand.
	for (const f of SPINE_FILES) {
		const src = join(bundledDir, "prompts", f);
		const dst = join(userDir, f);
		if (existsSync(src)) place(src, dst);
	}

	// teams.yaml — a single merged file.
	const teamsSrc = join(bundledDir, "teams.yaml");
	if (existsSync(teamsSrc)) place(teamsSrc, join(userDir, "teams.yaml"));

	return { copied, skipped };
}
