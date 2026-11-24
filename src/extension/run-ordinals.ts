import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { MAX_ISSUED_RUN } from "../core/session-runs.ts";
import { waitForFileClaim } from "../io/file-claim.ts";
import { nativeSessionStorage, prepareSessionStorage } from "../io/session-storage.ts";

function readWatermark(file: string): number {
	try {
		const info = lstatSync(file);
		if (!info.isFile() || info.nlink !== 1 || info.size > 11) throw new Error("Unsafe run id watermark");
		const text = readFileSync(file, "utf8");
		if (!/^[1-9]\d{0,9}\n$/.test(text) || Number(text) > MAX_ISSUED_RUN) throw new Error("Invalid run id watermark");
		return Number(text);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

/** A constant-size, per-file reservation prevents two live native managers reusing an ordinal. */
export function nativeRunOrdinals(sessionFile: string | undefined, sessionId: string): ((minimum: number, count: number) => number) | undefined {
	if (!sessionFile || !isAbsolute(sessionFile) || !sessionId) return undefined;
	return (minimum, count) => {
		const { directory } = nativeSessionStorage(sessionFile, sessionId)!;
		if (!prepareSessionStorage(directory)) throw new Error("Run id storage directory is unsafe");
		const release = waitForFileClaim(directory, "run-ordinal");
		if (!release) throw new Error("This session is reserving another run id; retry the launch");
		try {
			const file = join(directory, "run-ordinal");
			const first = Math.max(minimum, readWatermark(file) + 1);
			const last = first + count - 1;
			if (last > MAX_ISSUED_RUN) throw new Error("Session run id limit exhausted");
			const temp = join(directory, `run-ordinal-${randomUUID()}.tmp`);
			try {
				writeFileSync(temp, `${last}\n`, { flag: "wx", mode: 0o600 });
				renameSync(temp, file);
			} finally { try { unlinkSync(temp); } catch { /* renamed or absent */ } }
			return first;
		} finally { release(); }
	};
}
