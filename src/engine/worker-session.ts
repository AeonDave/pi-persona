import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";

/** Private runtime-owned transcript path; never accepted from a model-facing tool. */
export interface WorkerSession {
	file: string;
	resume: boolean;
	/** Persist the child writer before it can outlive its supervisor. */
	setExternalWriter?: (state: "launching" | number) => void;
}

const MAX_SESSION_BYTES = 8 * 1024 * 1024;

/** Discard only a quiescent fresh attempt's private transcript before provider retry. */
export async function resetFreshWorkerSession(session: WorkerSession): Promise<boolean> {
	if (session.resume || !isAbsolute(session.file)) return false;
	const dir = dirname(session.file), owner = basename(dir);
	if (basename(dirname(dir)) !== "persona-workers" || !/^[a-f0-9]{64}$/i.test(owner)
		|| !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i.test(basename(session.file))) return false;
	try {
		let ancestor = parse(dir).root;
		for (const part of dir.slice(ancestor.length).split(/[\\/]+/).filter(Boolean)) {
			ancestor = join(ancestor, part);
			const item = await lstat(ancestor);
			if (!item.isDirectory() || item.isSymbolicLink()) return false;
		}
		let stat;
		try { stat = await lstat(session.file); }
		catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
		if (!stat.isFile() || stat.isSymbolicLink()) return false;
		const again = await lstat(session.file);
		if (again.ino !== stat.ino || again.dev !== stat.dev || again.size !== stat.size || again.mtimeMs !== stat.mtimeMs) return false;
		await unlink(session.file);
		return true;
	} catch { return false; }
}

/** Check the exact target before Pi can silently create an absent resume or open an old fresh run. */
export async function validateWorkerSession(session: WorkerSession, cwd: string): Promise<void> {
	if (!isAbsolute(session.file)) throw new Error("Worker session path must be absolute");
	let stat;
	try { stat = await lstat(session.file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !session.resume) return;
		throw error;
	}
	if (!session.resume) throw new Error("Fresh worker session already exists");
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_SESSION_BYTES) {
		throw new Error("Worker session is not a bounded regular file");
	}
	const handle = await open(session.file, constants.O_RDONLY);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) {
			throw new Error("Worker session changed during validation");
		}
		const buffer = Buffer.alloc(opened.size + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
			if (!read.bytesRead) break;
			bytes += read.bytesRead;
		}
		if (bytes !== opened.size) throw new Error("Worker session changed during validation");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
		const lines = text.split("\n");
		if (lines.at(-1) !== "") throw new Error("Worker session has an incomplete final entry");
		lines.pop();
		const entries: unknown[] = lines.map((line) => JSON.parse(line));
		const header = entries[0] as Record<string, unknown> | undefined;
		const samePath = (a: string, b: string): boolean => {
			const first = normalize(resolve(a));
			const second = normalize(resolve(b));
			return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
		};
		if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id ||
			typeof header.version !== "number" || typeof header.cwd !== "string" || !isAbsolute(header.cwd) || !samePath(header.cwd, cwd)) {
			throw new Error("Worker session header or working directory is invalid");
		}
		let lastMessage: Record<string, unknown> | undefined;
		for (const entry of entries.slice(1)) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid worker session entry");
			const row = entry as Record<string, unknown>;
			if (typeof row.type !== "string") throw new Error("Invalid worker session entry");
			if (row.type === "message") {
				if (!row.message || typeof row.message !== "object" || Array.isArray(row.message)) throw new Error("Invalid worker session message");
				lastMessage = row.message as Record<string, unknown>;
			}
		}
		if (lastMessage?.role !== "assistant" || lastMessage.stopReason !== "stop") {
			throw new Error("Worker session does not end in a successful assistant completion");
		}
	} finally { await handle.close(); }
}
