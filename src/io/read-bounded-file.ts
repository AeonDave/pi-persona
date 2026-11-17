import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Read a regular file without blocking on POSIX FIFOs, and recheck a growing file against the byte cap. */
export async function readBoundedRegularFile(path: string, options: { label: string; maxBytes: number; limitLabel: string }, signal?: AbortSignal): Promise<Buffer> {
	const checkCancelled = (): void => { if (signal?.aborted) throw new Error(`${options.label} cancelled`); };
	checkCancelled();
	const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
	try {
		checkCancelled();
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error(`${options.label} accepts regular files only`);
		const tooLarge = (): never => { throw new Error(`${options.label} input exceeds ${options.limitLabel}`); };
		if (stat.size > options.maxBytes) tooLarge();
		const bytes = Buffer.allocUnsafe(options.maxBytes + 1);
		let length = 0;
		while (length < bytes.length) {
			checkCancelled();
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > options.maxBytes) tooLarge();
		checkCancelled();
		return bytes.subarray(0, length);
	} finally { await handle.close(); }
}
