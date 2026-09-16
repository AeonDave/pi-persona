/** Shared write-set overlap — used by delegate and the exocom work ledger. Pure. */
import { posix, win32 } from "node:path";

export interface WriteSetOwner {
	agent?: string;
	writeSet?: string[];
}

interface NormalizedWritePath {
	value: string;
	windows: boolean;
}

export function normalizeWritePath(raw: string): NormalizedWritePath {
	const trimmed = raw.trim();
	// Case-folding is decided PER PATH by its syntax, never by the host platform: a plan is
	// authored on one OS and may execute on another, so the overlap answer must not change
	// with the machine. Backslashes, a drive letter, or a UNC prefix mark a Windows path
	// (case-insensitive); plain slash-separated ownership names stay case-sensitive.
	const windows = trimmed.includes("\\") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
	const normalized = (windows ? win32.normalize(trimmed) : posix.normalize(trimmed)).replaceAll("\\", "/");
	const value = normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	return { value: windows ? value.toLowerCase() : value, windows };
}

export function pathsOverlap(a: NormalizedWritePath, b: NormalizedWritePath): boolean {
	const left = a.windows || b.windows ? a.value.toLowerCase() : a.value;
	const right = a.windows || b.windows ? b.value.toLowerCase() : b.value;
	const isAncestor = (parent: string, child: string): boolean => {
		if (parent === "/") return child.startsWith("/");
		if (parent === ".") return !child.startsWith("/");
		return child.startsWith(`${parent}/`);
	};
	return left === right || isAncestor(left, right) || isAncestor(right, left);
}

export interface WriteSetOverlap {
	firstIndex: number;
	secondIndex: number;
	firstPath: string;
	secondPath: string;
}

/** Find equal/ancestor-descendant write-set collisions in deterministic owner/path order. */
export function findWriteSetOverlaps(tasks: readonly WriteSetOwner[]): WriteSetOverlap[] {
	const overlaps: WriteSetOverlap[] = [];
	for (let i = 0; i < tasks.length; i++) {
		const first = tasks[i];
		if (!first) continue;
		for (let j = i + 1; j < tasks.length; j++) {
			const second = tasks[j];
			if (!second) continue;
			for (const firstPath of first.writeSet ?? []) {
				if (!firstPath.trim()) continue;
				for (const secondPath of second.writeSet ?? []) {
					if (!secondPath.trim()) continue;
					if (pathsOverlap(normalizeWritePath(firstPath), normalizeWritePath(secondPath))) {
						overlaps.push({ firstIndex: i, secondIndex: j, firstPath, secondPath });
					}
				}
			}
		}
	}
	return overlaps;
}

/** Undefined when the path is a repository-relative ownership name; otherwise a reason. */
export function writeSetPathError(path: string): string | undefined {
	if (typeof path !== "string" || !path.trim()) return "empty writeSet path";
	const raw = path.trim();
	const slash = raw.replaceAll("\\", "/");
	const normalized = posix.normalize(slash);
	if (posix.isAbsolute(slash) || win32.isAbsolute(raw) || normalized === ".." || normalized.startsWith("../")) {
		return 'outside the repository-relative ownership namespace; use "." for the repository root';
	}
	return undefined;
}

/** Return an actionable error for a parallel write-set collision; undefined means safe to spawn.
 *  Lives here (not in `tools/delegate.ts`) so a strategy can call it without importing a tool
 *  module — `delegate.ts` re-exports it unchanged for its own call sites. */
export function validateParallelWriteSets(tasks: readonly WriteSetOwner[]): string | undefined {
	for (const [index, task] of tasks.entries()) {
		for (const path of task.writeSet ?? []) {
			const err = writeSetPathError(path);
			if (!err) continue;
			if (err.startsWith("empty")) {
				return `delegate: task[${index}] ("${task.agent}") has an empty writeSet path; remove it or provide a repository-relative path.`;
			}
			return `delegate: task[${index}] ("${task.agent}") writeSet path "${path}" is ${err}.`;
		}
	}
	const overlap = findWriteSetOverlaps(tasks)[0];
	if (!overlap) return undefined;
	const first = tasks[overlap.firstIndex];
	const second = tasks[overlap.secondIndex];
	return (
		`delegate: parallel writeSet overlap between task[${overlap.firstIndex}] ("${first?.agent ?? "?"}") ` +
		`path "${overlap.firstPath}" and task[${overlap.secondIndex}] ("${second?.agent ?? "?"}") ` +
		`path "${overlap.secondPath}". Split the paths, serialize these tasks, or remove the overlap before spawning.`
	);
}
