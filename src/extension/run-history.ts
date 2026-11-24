import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { findStoredRuns, RUNS_ENTRY_CUSTOM_TYPE, type RunsEntry } from "../core/session-runs.ts";
import { waitForFileClaim } from "../io/file-claim.ts";
import { scanNativeCustomEntries, type NativeCustomEntry } from "../io/native-history.ts";
import { nativeSessionStorage } from "../io/session-storage.ts";

const RUN_HISTORY_TYPES = new Set([RUNS_ENTRY_CUSTOM_TYPE]);

/** Serialize restore acknowledgements and shutdown loss with other live owners of the same file. */
export function withCurrentRunHistory(manager: ExtensionContext["sessionManager"], update: (stored: RunsEntry | undefined) => void): void {
	const sessionId = manager.getSessionId();
	const storage = nativeSessionStorage(manager.getSessionFile(), sessionId);
	if (!storage) {
		update(findStoredRuns(manager.getEntries(), sessionId));
		return;
	}
	const release = waitForFileClaim(dirname(storage.file), `restore-${storage.owner}`);
	if (!release) throw new Error("Another activation is updating the owning session's run history");
	try {
		const entries: NativeCustomEntry[] = [];
		const cursor = scanNativeCustomEntries(storage.file, sessionId, RUN_HISTORY_TYPES, (entry) => { entries.push(entry); });
		update(findStoredRuns(cursor ? entries : manager.getEntries(), sessionId));
	} finally { release(); }
}
