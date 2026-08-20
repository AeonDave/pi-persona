/**
 * Per-persona configuration, indexed by persona name and persisted as one JSON
 * file in the global persona folder. Intentionally open-ended: a persona that
 * needs settings gets an entry, others don't. Two personas that share a strategy
 * keep independent configs. Today it carries per-agent model assignments (so an
 * ensemble like magi can run its cores on *different* models); more keys later.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface PersonaConfig {
	/** Roster agent name → provider-qualified model id (e.g. "claude-pro-max-native/claude-opus-4-8"). */
	models?: Record<string, string>;
}

export type PersonaConfigStore = Record<string, PersonaConfig>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the store. NOTE: this reader WRITES on one path — an unusable file is copied to
 * `${file}.bak` before the next save replaces it (once; an existing backup is never touched).
 */
export function readPersonaConfigs(file: string): PersonaConfigStore {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {}; // no config yet (the common case) or unreadable → start empty
	}
	try {
		const parsed: unknown = JSON.parse(text);
		// Valid JSON that isn't a config object is as unusable as unparseable text — and the next
		// save replaces it just the same, so it gets the same backup treatment.
		if (!isPlainObject(parsed)) throw new Error("not a config object");
		const store: PersonaConfigStore = {};
		for (const [name, cfg] of Object.entries(parsed)) {
			if (!isPlainObject(cfg)) continue;
			const entry: PersonaConfig = {};
			if (isPlainObject(cfg.models)) {
				const models: Record<string, string> = {};
				for (const [agent, model] of Object.entries(cfg.models)) {
					if (typeof model === "string") models[agent] = model;
				}
				entry.models = models;
			}
			store[name] = entry;
		}
		return store;
	} catch {
		// An unusable file is about to be overwritten by the next save; keep it beside the
		// config so the assignments stay recoverable instead of vanishing silently. `wx` makes
		// this the FIRST copy only: the underlying fault (a sync client, a failing disk) tends to
		// recur, and a second bad parse would otherwise overwrite the one copy that still had the
		// user's assignments in it.
		try {
			writeFileSync(`${file}.bak`, text, { encoding: "utf8", flag: "wx" });
		} catch {
			/* best effort — an existing backup, or an unwritable dir, must not stop the session */
		}
		return {};
	}
}

/** Injection seams for the rename retry below (tests drive it on any OS). */
export interface ConfigWriteIO {
	rename?: (from: string, to: string) => void;
	sleep?: (ms: number) => void;
	/** Test seam for the cross-process lock around the read/merge/write transaction. */
	acquireLock?: (file: string, sleep: (ms: number) => void) => () => void;
}

// A handle held by a virus scanner, a sync client or another pi instance mid-read is transient,
// so a few short waits usually win the race — 25+50+75 ms of backoff at worst, on a save.
const RENAME_ATTEMPTS = 4;
const RENAME_BACKOFF_MS = 25;
const LOCK_ATTEMPTS = 80;
const LOCK_BACKOFF_MS = 25;
const STALE_LOCK_MS = 5 * 60 * 1000;

function sleepSync(ms: number): void {
	// The whole store API is synchronous (this runs on a model assignment, not on a hot path),
	// so the backoff has to block; Atomics.wait is the standard synchronous sleep.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Acquire a small sidecar lock so two independent Pi processes cannot both read the same old
 * config and race their read-modify-write transactions. `wx` is the portable atomic primitive on
 * POSIX and Windows. A very old lock is treated as abandoned after a crashed process; active
 * writers renew no state because the critical section is synchronous and short. */
function acquireFileLock(file: string, sleep: (ms: number) => void): () => void {
	const lock = `${file}.lock`;
	for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
		try {
			const fd = openSync(lock, "wx");
			try {
				writeSync(fd, `${process.pid}\n`, null, "utf8");
			} catch (error) {
				try {
					closeSync(fd);
				} finally {
					try {
						unlinkSync(lock);
					} catch {
						/* best effort; retain the original write error */
					}
				}
				throw error;
			}
			return () => {
				try {
					closeSync(fd);
				} finally {
					try {
						unlinkSync(lock);
					} catch {
						/* another cleanup path or an external remover already won */
					}
				}
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
			} catch {
				/* It disappeared between stat/unlink; retry normally. */
			}
			if (attempt < LOCK_ATTEMPTS) {
				sleep(LOCK_BACKOFF_MS);
				continue;
			}
			throw new Error(`timed out acquiring persona config lock: ${lock}`);
		}
	}
	throw new Error(`timed out acquiring persona config lock: ${lock}`);
}

/**
 * MERGE `store` into the file (read-modify-write), then save it.
 *
 * A removal is NOT expressible: an assignment missing from `store` is preserved, not deleted.
 * The merge exists so a concurrent pi instance's save survives ours, and it cannot tell "the
 * user cleared this" from "this store was read before that was written" — a clearing gesture
 * would need its own delete-aware call.
 */
export function writePersonaConfigs(file: string, store: PersonaConfigStore, io: ConfigWriteIO = {}): void {
	mkdirSync(dirname(file), { recursive: true });
	const sleep = io.sleep ?? sleepSync;
	const release = (io.acquireLock ?? acquireFileLock)(file, sleep);
	try {
		// The caller holds a store read at session start; another pi instance in the same workspace
		// may have saved since. Re-read and merge so its work survives our whole-store write — down
		// to the agent, since two instances of the *same* persona assign different roster members.
		const merged: PersonaConfigStore = { ...readPersonaConfigs(file) };
		for (const [persona, cfg] of Object.entries(store)) {
			const prev = merged[persona];
			merged[persona] = prev ? { ...prev, ...cfg, models: { ...prev.models, ...cfg.models } } : cfg;
		}
		const payload = `${JSON.stringify(merged, null, 2)}\n`;
		// Temp file + same-volume rename, so a crash mid-write can never leave a truncated
		// config.json behind. That is atomic on POSIX; Windows is NOT the same — rename fails with
		// EPERM/EBUSY while ANY other handle holds the target open (Defender, a sync client, a second
		// pi instance mid-read), and the persona folder is an ordinary user directory where that is
		// routine. So a contended rename is retried, and then written in place: a non-atomic save
		// that lands beats an atomic one that loses the user's assignments every session.
		const tmp = `${file}.${process.pid}.tmp`;
		const rename = io.rename ?? renameSync;
		writeFileSync(tmp, payload, "utf8");
		for (let attempt = 1; ; attempt++) {
			try {
				rename(tmp, file);
				return;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (attempt < RENAME_ATTEMPTS && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
					sleep(RENAME_BACKOFF_MS * attempt);
					continue;
				}
				try {
					// The scratch file must not be left behind for every pid that ever tried, whether
					// the in-place write succeeds or throws (the caller still sees a real failure).
					writeFileSync(file, payload, "utf8");
				} finally {
					try {
						rmSync(tmp, { force: true });
					} catch {
						/* best effort */
					}
				}
				return;
			}
		}
	} finally {
		release();
	}
}

/** The model assignments for a persona (empty object when none configured). */
export function personaModels(store: PersonaConfigStore, persona: string): Record<string, string> {
	return store[persona]?.models ?? {};
}

/** Merge model assignments into a persona's config, returning a new store. */
export function withPersonaModels(
	store: PersonaConfigStore,
	persona: string,
	models: Record<string, string>,
): PersonaConfigStore {
	const prev = store[persona] ?? {};
	return { ...store, [persona]: { ...prev, models: { ...prev.models, ...models } } };
}
