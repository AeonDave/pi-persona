import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export interface NativeCustomEntry {
	id?: string;
	type: "custom";
	customType: string;
	data: unknown;
}

export interface NativeHistoryCursor {
	offset: number;
	device: number;
	inode: number;
}

/** Read selected entries through the captured EOF without repairing a peer's file. */
export function scanNativeCustomEntries(file: string, sessionId: string, customTypes: ReadonlySet<string>,
	visit: (entry: NativeCustomEntry) => void, cursor?: NativeHistoryCursor): NativeHistoryCursor | undefined {
	let fd: number;
	try { fd = openSync(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)); }
	catch (error) {
		if (!cursor && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || (cursor && (stat.dev !== cursor.device || stat.ino !== cursor.inode || stat.size < cursor.offset))) {
			throw new Error("Native session file identity changed");
		}
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let offset = cursor?.offset ?? 0;
		let partial: Buffer[] = [];
		let checkedOwner = cursor !== undefined;
		const readLine = (line: string) => {
			if (!line.trim()) return;
			let entry: { type?: string; id?: unknown; customType?: unknown };
			try { entry = JSON.parse(line) as typeof entry; }
			catch (error) {
				// Pi repairs an interrupted tail by adding a newline and skips invalid complete
				// lines when loading. A current unterminated line is still rejected below.
				if (checkedOwner) return;
				throw error;
			}
			if (!checkedOwner) {
				if (entry?.type !== "session" || entry.id !== sessionId) throw new Error("Native session file ownership changed");
				checkedOwner = true;
				return;
			}
			if (entry?.type === "custom" && typeof entry.customType === "string" && customTypes.has(entry.customType)) {
				visit(entry as NativeCustomEntry);
			}
		};
		while (offset < stat.size) {
			const size = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
			if (size === 0) throw new Error("Native session file changed while reading");
			offset += size;
			const chunk = buffer.subarray(0, size);
			let start = 0;
			let end = chunk.indexOf(10);
			while (end !== -1) {
				const line = chunk.subarray(start, end);
				readLine((partial.length > 0 ? Buffer.concat([...partial, line]) : line).toString("utf8"));
				partial = [];
				start = end + 1;
				end = chunk.indexOf(10, start);
			}
			if (start < size) partial.push(Buffer.from(chunk.subarray(start)));
		}
		if (!checkedOwner || partial.length > 0) throw new Error("Native session file is incomplete");
		return { offset, device: stat.dev, inode: stat.ino };
	} finally { closeSync(fd); }
}
