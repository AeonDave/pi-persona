import { createHash } from "node:crypto";
import { closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { regularPath } from "../io/session-storage.ts";

const MAX_REJECTION_BYTES = 256 * 1024;
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

function sameFile(a: Stats, b: Stats): boolean {
	return b.isFile() && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino;
}

function unchanged(a: Stats, b: Stats): boolean {
	return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isAbortedPrompt(existing: Buffer, appended: Buffer): boolean {
	if (existing.at(-1) !== 10 || appended.at(-1) !== 10) return false;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const preceding = existing.subarray(existing.lastIndexOf(10, existing.length - 2) + 1, -1);
	let parentId = object(JSON.parse(decoder.decode(preceding)))?.id;
	if (typeof parentId !== "string") return false;
	const rows = decoder.decode(appended).slice(0, -1).split("\n");
	if (rows.length !== 2 && rows.length !== 3) return false;
	const roles = rows.length === 3 ? ["system", "user", "assistant"] : ["user", "assistant"];
	const seen = new Set([parentId]);
	for (const [index, row] of rows.entries()) {
		const entry = object(JSON.parse(row));
		const message = object(entry?.message);
		if (entry?.type !== "message" || entry.parentId !== parentId || typeof entry.id !== "string" || seen.has(entry.id) || !message || message.role !== roles[index]) return false;
		parentId = entry.id;
		seen.add(entry.id);
		if (message.role === "system" && typeof message.content !== "string") return false;
		if (message.role === "user") {
			if (!Array.isArray(message.content) || message.content.length !== 1) return false;
			const content = object(message.content[0]);
			if (content?.type !== "text" || typeof content.text !== "string") return false;
		}
		if (message.role === "assistant") {
			const usage = object(message.usage);
			const cost = object(usage?.cost);
			return message.stopReason === "aborted" && Array.isArray(message.content) && message.content.length === 0
				&& USAGE_FIELDS.every((field) => usage?.[field] === 0)
				&& ["input", "output", "cacheRead", "cacheWrite", "total"].every((field) => cost?.[field] === 0);
		}
	}
	return false;
}

/** Restore only the Pi entries emitted for a witnessed first-start rejection after the writer exited. */
export function restoreRejectedResume(file: string, baseline: Stats, digest: string): boolean {
	try {
		if (!regularPath(file)) return false;
		const atPath = lstatSync(file);
		if (!sameFile(baseline, atPath) || atPath.size < baseline.size || atPath.size - baseline.size > MAX_REJECTION_BYTES) return false;
		const fd = openSync(file, "r+");
		try {
			if (!unchanged(atPath, fstatSync(fd))) return false;
			const bytes = Buffer.alloc(atPath.size);
			let offset = 0;
			while (offset < bytes.length) {
				const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
				if (read === 0) return false;
				offset += read;
			}
			const existing = bytes.subarray(0, baseline.size);
			if (createHash("sha256").update(existing).digest("hex") !== digest) return false;
			if (!unchanged(atPath, fstatSync(fd)) || !unchanged(atPath, lstatSync(file))) return false;
			if (bytes.length === existing.length) return true;
			if (!isAbortedPrompt(existing, bytes.subarray(existing.length))) return false;
			if (!unchanged(atPath, fstatSync(fd)) || !unchanged(atPath, lstatSync(file))) return false;
			ftruncateSync(fd, baseline.size);
			return true;
		} finally { closeSync(fd); }
	} catch { return false; }
}
