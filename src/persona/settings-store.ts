/** Canonical versioned settings store for global preferences, persona models, and last selection. */

import { randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import {
	closeSync,
	constants,
	copyFileSync,
	fsyncSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeSync,
	type BigIntStats,
} from "node:fs";
import { dirname } from "node:path";

import { PERSONA_SETTINGS, validatePreferences, type PersonaPreferences, type SettingId } from "../core/settings.ts";
import type { PersonaConfigStore } from "./config-store.ts";

export interface PersonaSettings {
	version: 1;
	preferences: PersonaPreferences;
	personas: PersonaConfigStore;
	lastPersona: string | null;
	/** Explicit lastPersona patch count; absent in older v1 files means zero. */
	selectionRevision?: number;
	[key: string]: unknown;
}

export interface PersonaSettingsPatch {
	preferences?: Partial<Record<SettingId, unknown | null>>;
	models?: Record<string, Record<string, string | null>>;
	lastPersona?: string | null;
}

export interface PersonaSettingsWriteIO {
	rename?: (from: string, to: string) => void;
	sleep?: (ms: number) => void;
	/** Exclusive lock-file open seam, useful for exercising transient platform errors. */
	openExclusiveLock?: (file: string) => number;
	acquireLock?: (file: string, sleep: (ms: number) => void) => () => void;
}

export interface PersonaSettingsMigrationOptions {
	legacyConfigFile: string;
	legacyStateFile: string;
}

export interface PersonaSettingsMigrationResult {
	settings: PersonaSettings;
	/** Legacy source paths successfully archived as `.migrated` files. */
	migrated: string[];
	warnings: string[];
}

const MAX_SETTINGS_BYTES = 1024 * 1024;
const RENAME_ATTEMPTS = 4;
const RENAME_BACKOFF_MS = 25;
const LOCK_ATTEMPTS = 80;
const LOCK_BACKOFF_MS = 25;
const STALE_LOCK_MS = 5 * 60 * 1000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

interface FileSnapshot {
	file: string;
	bytes: Buffer;
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function decodeJson(bytes: Buffer): string {
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function emptySettings(): PersonaSettings {
	return { version: 1, preferences: {}, personas: {}, lastPersona: null, selectionRevision: 0 };
}

function assertRegularSingleLink(file: string, stats: BigIntStats, maxLinks = 1n): void {
	if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink < 1n || stats.nlink > maxLinks) {
		throw new Error(`unsafe settings file (expected a regular single-link file): ${file}`);
	}
	if (stats.size > BigInt(MAX_SETTINGS_BYTES)) {
		throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes: ${file}`);
	}
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedFile(file: string, maxLinks = 1n): FileSnapshot | undefined {
	let pathBefore: BigIntStats;
	try {
		pathBefore = lstatSync(file, { bigint: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	assertRegularSingleLink(file, pathBefore, maxLinks);

	const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
	try {
		const before = fstatSync(fd, { bigint: true });
		assertRegularSingleLink(file, before, maxLinks);
		if (!sameIdentity(pathBefore, before)) throw new Error(`settings file changed while opening: ${file}`);

		const capacity = MAX_SETTINGS_BYTES + 1;
		const buffer = Buffer.allocUnsafe(capacity);
		let offset = 0;
		while (offset < capacity) {
			const count = readSync(fd, buffer, offset, capacity - offset, offset);
			if (count === 0) break;
			offset += count;
		}
		if (offset > MAX_SETTINGS_BYTES) throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes: ${file}`);

		const after = fstatSync(fd, { bigint: true });
		const pathAfter = lstatSync(file, { bigint: true });
		assertRegularSingleLink(file, after, maxLinks);
		if (!sameIdentity(before, after) || !sameIdentity(before, pathAfter)
			|| before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(offset) !== after.size) {
			throw new Error(`settings file changed while reading: ${file}`);
		}
		return {
			file,
			bytes: Buffer.from(buffer.subarray(0, offset)),
			dev: after.dev,
			ino: after.ino,
			size: after.size,
			mtimeNs: after.mtimeNs,
		};
	} finally {
		closeSync(fd);
	}
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size
		&& left.mtimeNs === right.mtimeNs && left.bytes.equals(right.bytes);
}

function validatePersonas(value: unknown): PersonaConfigStore {
	if (!isPlainObject(value)) throw new Error("invalid persona settings: personas must be an object");
	const personas: Record<string, unknown> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (!isPlainObject(raw)) throw new Error(`invalid persona settings: persona ${name} must be an object`);
		const config: Record<string, unknown> = { ...raw };
		if (Object.hasOwn(raw, "models")) {
			if (!isPlainObject(raw.models)) throw new Error(`invalid persona settings: models for ${name} must be an object`);
			const models: Record<string, unknown> = {};
			for (const [agent, model] of Object.entries(raw.models)) {
				if (typeof model !== "string") throw new Error(`invalid persona settings: model for ${name}/${agent} must be a string`);
				defineOwn(models, agent, model);
			}
			config.models = models;
		}
		defineOwn(personas, name, config);
	}
	return personas as unknown as PersonaConfigStore;
}

function parseSettings(bytes: Buffer, file: string): PersonaSettings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeJson(bytes)) as unknown;
	} catch {
		throw new Error(`invalid JSON in persona settings file: ${file}`);
	}
	if (!isPlainObject(parsed)) throw new Error(`invalid persona settings file (expected an object): ${file}`);
	if (parsed.version !== 1) throw new Error(`unsupported persona settings version in ${file}`);
	if (!Object.hasOwn(parsed, "preferences")) throw new Error(`invalid persona settings: missing preferences in ${file}`);
	if (!Object.hasOwn(parsed, "personas")) throw new Error(`invalid persona settings: missing personas in ${file}`);
	if (!Object.hasOwn(parsed, "lastPersona")) throw new Error(`invalid persona settings: missing lastPersona in ${file}`);
	const preferences = validatePreferences(parsed.preferences);
	const personas = validatePersonas(parsed.personas);
	const lastPersona = parsed.lastPersona;
	if (lastPersona !== null && (typeof lastPersona !== "string" || lastPersona.length === 0)) {
		throw new Error(`invalid persona settings: lastPersona must be a non-empty string or null in ${file}`);
	}
	const selectionRevision = Object.hasOwn(parsed, "selectionRevision") ? parsed.selectionRevision : 0;
	if (typeof selectionRevision !== "number" || !Number.isSafeInteger(selectionRevision) || selectionRevision < 0) {
		throw new Error(`invalid persona settings: selectionRevision must be a non-negative safe integer in ${file}`);
	}
	return {
		...parsed,
		version: 1,
		preferences,
		personas,
		lastPersona,
		selectionRevision,
	} as PersonaSettings;
}

function readExistingSettings(file: string): PersonaSettings | undefined {
	const snapshot = readBoundedFile(file);
	return snapshot ? parseSettings(snapshot.bytes, file) : undefined;
}

/** Read the canonical file. Missing means defaults; every other invalid or unsafe state throws. */
export function readPersonaSettings(file: string): PersonaSettings {
	return readExistingSettings(file) ?? emptySettings();
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeOwnedLock(lock: string, fd: number, identity: BigIntStats): void {
	try {
		closeSync(fd);
	} finally {
		try {
			const current = lstatSync(lock, { bigint: true });
			if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1n && sameIdentity(identity, current)) unlinkSync(lock);
		} catch {
			/* A replaced or externally removed lock is not ours to remove. */
		}
	}
}

function acquireFileLock(
	file: string,
	sleep: (ms: number) => void,
	openExclusiveLock: (file: string) => number = (lock) => openSync(lock, "wx", 0o600),
): () => void {
	const lock = `${file}.lock`;
	let lastOpenError: string | undefined;
	for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
		let fd: number;
		try {
			fd = openExclusiveLock(lock);
		} catch (error) {
			const code = errorCode(error);
			if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
			lastOpenError = code;
			if (code === "EEXIST") {
				try {
					const current = lstatSync(lock, { bigint: true });
					if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1n
						&& Date.now() - Number(current.mtimeMs) > STALE_LOCK_MS) {
						const confirmed = lstatSync(lock, { bigint: true });
						if (sameIdentity(current, confirmed) && confirmed.isFile() && confirmed.nlink === 1n) unlinkSync(lock);
					}
				} catch {
					/* Lock disappeared or is unsafe; retain it and keep the wait bounded. */
				}
			}
			if (attempt < LOCK_ATTEMPTS) {
				sleep(LOCK_BACKOFF_MS);
				continue;
			}
			throw new Error(`timed out acquiring persona settings lock: ${lock} (last open error: ${lastOpenError})`);
		}
		const identity = fstatSync(fd, { bigint: true });
		try {
			writeSync(fd, `${process.pid}\n${randomBytes(8).toString("hex")}\n`, null, "utf8");
		} catch (error) {
			removeOwnedLock(lock, fd, identity);
			throw error;
		}
		return () => removeOwnedLock(lock, fd, identity);
	}
	throw new Error(`timed out acquiring persona settings lock: ${lock}`);
}

function normalizePatch(value: unknown): {
	preferences?: Partial<Record<SettingId, unknown | null>>;
	models?: Record<string, Record<string, string | null>>;
	lastPersonaPresent: boolean;
	lastPersona?: string | null;
} {
	if (!isPlainObject(value)) throw new Error("invalid persona settings patch: expected an object");
	for (const key of Object.keys(value)) {
		if (key !== "preferences" && key !== "models" && key !== "lastPersona") {
			throw new Error(`unknown persona settings patch field: ${key}`);
		}
	}
	const result: {
		preferences?: Partial<Record<SettingId, unknown | null>>;
		models?: Record<string, Record<string, string | null>>;
		lastPersonaPresent: boolean;
		lastPersona?: string | null;
	} = { lastPersonaPresent: Object.hasOwn(value, "lastPersona") };
	if (Object.hasOwn(value, "preferences")) {
		if (!isPlainObject(value.preferences)) throw new Error("invalid persona settings patch: preferences must be an object");
		const preferences: Partial<Record<SettingId, unknown | null>> = {};
		for (const [key, item] of Object.entries(value.preferences)) {
			if (item === null) {
				if (!isSettingId(key)) throw new Error(`unknown persona preference: ${key}`);
				Object.defineProperty(preferences, key, { value: null, enumerable: true, configurable: true, writable: true });
			} else {
				const validated = validatePreferences({ [key]: item });
				Object.defineProperty(preferences, key, { value: validated[key as SettingId], enumerable: true, configurable: true, writable: true });
			}
		}
		result.preferences = preferences;
	}
	if (Object.hasOwn(value, "models")) {
		if (!isPlainObject(value.models)) throw new Error("invalid persona settings patch: models must be an object");
		const models: Record<string, Record<string, string | null>> = {};
		for (const [persona, rawModels] of Object.entries(value.models)) {
			if (!isPlainObject(rawModels)) throw new Error(`invalid model patch for ${persona}: expected an object`);
			const entries: Record<string, string | null> = {};
			for (const [agent, model] of Object.entries(rawModels)) {
				if (model !== null && typeof model !== "string") throw new Error(`invalid model patch for ${persona}/${agent}: expected a string or null`);
				defineOwn(entries, agent, model);
			}
			defineOwn(models, persona, entries);
		}
		result.models = models;
	}
	if (result.lastPersonaPresent) {
		const lastPersona = value.lastPersona;
		if (lastPersona !== null && (typeof lastPersona !== "string" || lastPersona.length === 0)) {
			throw new Error("invalid lastPersona patch: expected a non-empty string or null");
		}
		result.lastPersona = lastPersona;
	}
	return result;
}

function isSettingId(value: string): value is SettingId {
	return PERSONA_SETTINGS.some((setting) => setting.id === value);
}

function cloneSettings(settings: PersonaSettings): PersonaSettings {
	return {
		...settings,
		preferences: validatePreferences(settings.preferences),
		personas: { ...settings.personas },
	};
}

function applyPatch(settings: PersonaSettings, patch: ReturnType<typeof normalizePatch>): PersonaSettings {
	const next = cloneSettings(settings);
	if (patch.preferences) {
		const preferences = next.preferences as Record<string, unknown>;
		for (const [key, value] of Object.entries(patch.preferences)) {
			if (value === null) delete preferences[key];
			else defineOwn(preferences, key, value);
		}
	}
	if (patch.models) {
		const personas = next.personas as unknown as Record<string, unknown>;
		for (const [persona, changes] of Object.entries(patch.models)) {
			const oldConfig = Object.hasOwn(personas, persona) && isPlainObject(personas[persona])
				? personas[persona] as Record<string, unknown>
				: {};
			const config: Record<string, unknown> = { ...oldConfig };
			const models: Record<string, unknown> = isPlainObject(oldConfig.models) ? { ...oldConfig.models } : {};
			for (const [agent, model] of Object.entries(changes)) {
				if (model === null) delete models[agent];
				else defineOwn(models, agent, model);
			}
			if (Object.keys(models).length > 0) config.models = models;
			else delete config.models;
			defineOwn(personas, persona, config);
		}
	}
	if (patch.lastPersonaPresent) {
		const revision = next.selectionRevision ?? 0;
		if (revision >= Number.MAX_SAFE_INTEGER) {
			throw new Error("invalid persona settings: selectionRevision cannot be incremented beyond the safe integer range");
		}
		next.lastPersona = patch.lastPersona ?? null;
		next.selectionRevision = revision + 1;
	}
	return next;
}

function writeAll(fd: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function removeTemp(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		/* The temp may already have been renamed or removed by cleanup. */
	}
}

function removeLinkIfIdentity(file: string, snapshot: FileSnapshot): void {
	try {
		const current = lstatSync(file, { bigint: true });
		if (current.isFile() && !current.isSymbolicLink() && current.dev === snapshot.dev && current.ino === snapshot.ino) {
			unlinkSync(file);
		}
	} catch {
		/* A changed or already removed archive path is not ours to remove. */
	}
}

function atomicWrite(file: string, payload: string, io: PersonaSettingsWriteIO, expectMissing: boolean): void {
	const contents = Buffer.from(payload, "utf8");
	if (contents.byteLength > MAX_SETTINGS_BYTES) {
		throw new Error(`persona settings update exceeds ${MAX_SETTINGS_BYTES} bytes`);
	}
	const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeAll(fd, contents);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		if (expectMissing) {
			// Exclusive same-volume link makes first creation atomic without replacing a racing file.
			linkSync(temporary, file);
			return;
		}
		const rename = io.rename ?? renameSync;
		const sleep = io.sleep ?? sleepSync;
		for (let attempt = 1; ; attempt++) {
			try {
				rename(temporary, file);
				return;
			} catch (error) {
				const code = errorCode(error);
				if (attempt < RENAME_ATTEMPTS && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
					sleep(RENAME_BACKOFF_MS * attempt);
					continue;
				}
				throw error;
			}
		}
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* Preserve the write failure. */ }
		}
		removeTemp(temporary);
	}
}

/** Patch known fields under one cross-process lock and atomically replace the canonical file. */
export function patchPersonaSettings(
	file: string,
	patchInput: PersonaSettingsPatch,
	io: PersonaSettingsWriteIO = {},
): PersonaSettings {
	const patch = normalizePatch(patchInput);
	mkdirSync(dirname(file), { recursive: true });
	const sleep = io.sleep ?? sleepSync;
	const release = io.acquireLock
		? io.acquireLock(file, sleep)
		: acquireFileLock(file, sleep, io.openExclusiveLock);
	try {
		const existing = readExistingSettings(file);
		const current = existing ?? emptySettings();
		if (!patch.preferences && !patch.models && !patch.lastPersonaPresent) return current;
		const updated = applyPatch(current, patch);
		atomicWrite(file, `${JSON.stringify(updated, null, 2)}\n`, io, !existing);
		return updated;
	} finally {
		release();
	}
}

function parseLegacyConfig(snapshot: FileSnapshot): PersonaConfigStore {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeJson(snapshot.bytes)) as unknown;
	} catch {
		throw new Error(`invalid JSON in legacy config: ${snapshot.file}`);
	}
	if (!isPlainObject(parsed)) throw new Error(`invalid legacy persona config: ${snapshot.file}`);
	return validatePersonas(parsed);
}

function parseLegacyState(snapshot: FileSnapshot): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeJson(snapshot.bytes)) as unknown;
	} catch {
		throw new Error(`invalid JSON in legacy state: ${snapshot.file}`);
	}
	if (!isPlainObject(parsed)) throw new Error(`invalid legacy persona state: ${snapshot.file}`);
	if (!Object.hasOwn(parsed, "lastPersona") || parsed.lastPersona === null || parsed.lastPersona === "") return null;
	if (typeof parsed.lastPersona !== "string") throw new Error(`invalid lastPersona in legacy state: ${snapshot.file}`);
	return parsed.lastPersona;
}

interface LegacySnapshots {
	configSnapshot?: FileSnapshot;
	stateSnapshot?: FileSnapshot;
	personas: PersonaConfigStore;
	lastPersona: string | null;
	warnings: string[];
}

function readLegacySnapshots(options: PersonaSettingsMigrationOptions): LegacySnapshots {
	const result: LegacySnapshots = { personas: {}, lastPersona: null, warnings: [] };
	try {
		const snapshot = readBoundedFile(options.legacyConfigFile);
		if (snapshot) {
			result.configSnapshot = snapshot;
			result.personas = parseLegacyConfig(snapshot);
		}
	} catch (error) {
		result.warnings.push(`Skipped legacy config ${options.legacyConfigFile}: ${error instanceof Error ? error.message : String(error)}`);
		delete result.configSnapshot;
	}
	try {
		const snapshot = readBoundedFile(options.legacyStateFile);
		if (snapshot) {
			result.stateSnapshot = snapshot;
			result.lastPersona = parseLegacyState(snapshot);
		}
	} catch (error) {
		result.warnings.push(`Skipped legacy state ${options.legacyStateFile}: ${error instanceof Error ? error.message : String(error)}`);
		delete result.stateSnapshot;
	}
	return result;
}

function archiveUnchanged(snapshot: FileSnapshot): boolean {
	const backup = `${snapshot.file}.migrated`;
	const staging = `${backup}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	const current = readBoundedFile(snapshot.file);
	if (!current || !sameSnapshot(snapshot, current)) throw new Error(`legacy source changed before archive: ${snapshot.file}`);
	let fd: number | undefined;
	let archiveIdentity: { dev: bigint; ino: bigint } | undefined;
	try {
		fd = openSync(staging, "wx", 0o600);
		writeAll(fd, snapshot.bytes);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		// COPYFILE_EXCL is portable across filesystems that do not support hard links.
		copyFileSync(staging, backup, constants.COPYFILE_EXCL);
		const archivedPath = lstatSync(backup, { bigint: true });
		archiveIdentity = { dev: archivedPath.dev, ino: archivedPath.ino };
		if (!archivedPath.isFile() || archivedPath.isSymbolicLink() || archivedPath.nlink !== 1n) {
			throw new Error(`migration archive is not a regular single-link file: ${backup}`);
		}
	} catch (error) {
		if (archiveIdentity) removeLinkIfIdentity(backup, { ...snapshot, ...archiveIdentity });
		if (errorCode(error) === "EEXIST") throw new Error(`migration archive already exists: ${backup}`);
		throw new Error(`could not archive legacy source ${snapshot.file}: ${String(error)}`);
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* Preserve the archive failure. */ }
		}
		removeTemp(staging);
	}
	try {
		const archived = readBoundedFile(backup);
		const source = readBoundedFile(snapshot.file);
		if (!archiveIdentity || !archived || archived.dev !== archiveIdentity.dev || archived.ino !== archiveIdentity.ino
			|| archived.size !== snapshot.size || !archived.bytes.equals(snapshot.bytes)
			|| !source || !sameSnapshot(snapshot, source)) {
			throw new Error(`legacy source changed during archive: ${snapshot.file}`);
		}
		unlinkSync(snapshot.file);
		return true;
	} catch (error) {
		if (archiveIdentity) removeLinkIfIdentity(backup, { ...snapshot, ...archiveIdentity });
		throw error;
	}
}

/** Import the legacy model/state files only when no canonical settings file exists. */
export function migratePersonaSettings(
	file: string,
	options: PersonaSettingsMigrationOptions,
	io: PersonaSettingsWriteIO = {},
): PersonaSettingsMigrationResult {
	const initiallyExisting = readExistingSettings(file);
	if (initiallyExisting) return { settings: initiallyExisting, migrated: [], warnings: [] };
	const preflight = readLegacySnapshots(options);
	if (!preflight.configSnapshot && !preflight.stateSnapshot) {
		const raced = readExistingSettings(file);
		return { settings: raced ?? emptySettings(), migrated: [], warnings: preflight.warnings };
	}
	mkdirSync(dirname(file), { recursive: true });
	const sleep = io.sleep ?? sleepSync;
	const release = io.acquireLock
		? io.acquireLock(file, sleep)
		: acquireFileLock(file, sleep, io.openExclusiveLock);
	try {
		const existing = readExistingSettings(file);
		if (existing) return { settings: existing, migrated: [], warnings: [] };

		const legacy = readLegacySnapshots(options);
		const { configSnapshot, stateSnapshot, personas, lastPersona, warnings } = legacy;
		if (!configSnapshot && !stateSnapshot) return { settings: emptySettings(), migrated: [], warnings };

		const settings: PersonaSettings = { version: 1, preferences: {}, personas, lastPersona, selectionRevision: 0 };
		try {
			atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`, io, true);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			const raced = readExistingSettings(file);
			if (!raced) throw error;
			return { settings: raced, migrated: [], warnings: [] };
		}

		const migrated: string[] = [];
		for (const snapshot of [configSnapshot, stateSnapshot]) {
			if (!snapshot) continue;
			try {
				if (archiveUnchanged(snapshot)) migrated.push(snapshot.file);
			} catch (error) {
				warnings.push(`Kept legacy source ${snapshot.file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { settings, migrated, warnings };
	} finally {
		release();
	}
}
