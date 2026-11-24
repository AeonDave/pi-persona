import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

export function regularPath(path: string): boolean {
	let current = parse(path).root;
	for (const part of path.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
		current = join(current, part);
		try { if (lstatSync(current).isSymbolicLink()) return false; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	return true;
}

/** The OS resolves junctions and on-disk casing. Pi can assign a path before its first flush. */
function canonicalSessionFile(path: string): string {
	const missing: string[] = [];
	let current = resolve(path);
	for (;;) {
		try { return join(realpathSync.native(current), ...missing.reverse()); }
		catch (error) {
			const parent = dirname(current);
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
			missing.push(basename(current));
			current = parent;
		}
	}
}

export function nativeSessionStorage(sessionFile: string | undefined, sessionId: string): { file: string; owner: string; directory: string } | undefined {
	if (!sessionFile || !isAbsolute(sessionFile) || !sessionId) return undefined;
	const file = canonicalSessionFile(sessionFile);
	const stat = statSync(file, { throwIfNoEntry: false });
	if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Shared session storage requires a regular session file with a single link");
	const owner = createHash("sha256").update(`${file}\0${sessionId}`).digest("hex");
	return { file, owner, directory: join(dirname(file), "persona-workers", owner) };
}

export function prepareSessionStorage(directory: string): boolean {
	if (!regularPath(directory)) return false;
	mkdirSync(directory, { recursive: true });
	return regularPath(directory) && statSync(directory).isDirectory();
}
