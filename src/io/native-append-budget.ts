import { dirname } from "node:path";
import { waitForFileClaim } from "./file-claim.ts";
import { scanNativeCustomEntries, type NativeHistoryCursor } from "./native-history.ts";
import { nativeSessionStorage, regularPath } from "./session-storage.ts";

export interface NativeAppendBudgetOptions {
	customType: string;
	maxEntries: number;
	maxBytes: number;
	cost(data: unknown): number;
}

/** Exact per-file native entry accounting shared by independently opened Pi supervisors. */
export class NativeAppendBudget {
	private readonly sessionFile: string;
	private readonly sessionId: string;
	private readonly options: NativeAppendBudgetOptions;
	private readonly types: ReadonlySet<string>;
	private cursor: NativeHistoryCursor | undefined;
	private count = 0;
	private bytes = 0;

	constructor(sessionFile: string, sessionId: string, options: NativeAppendBudgetOptions) {
		this.sessionFile = sessionFile;
		this.sessionId = sessionId;
		this.options = options;
		this.types = new Set([options.customType]);
	}

	/** False means the transaction did not append because the owning file's quota was reached. */
	append(cost: number, write: () => void): boolean {
		const storage = nativeSessionStorage(this.sessionFile, this.sessionId);
		if (!storage || !regularPath(dirname(storage.file))) throw new Error("Native archive storage directory is unsafe");
		const release = waitForFileClaim(dirname(storage.file), `archive-${storage.owner}-${this.options.customType}`);
		if (!release) throw new Error("This session is appending another archive entry");
		try {
			let count = this.count;
			let bytes = this.bytes;
			const cursor = scanNativeCustomEntries(storage.file, this.sessionId, this.types, ({ data }) => {
				const size = this.options.cost(data);
				if (!Number.isSafeInteger(size) || size < 0) throw new Error("Native archive entry size is unavailable");
				count++;
				bytes = Math.min(this.options.maxBytes + 1, bytes + size);
			}, this.cursor);
			this.cursor = cursor;
			this.count = count;
			this.bytes = bytes;
			if (count >= this.options.maxEntries || bytes + cost > this.options.maxBytes) return false;
			// Publish the cursor only through pre-append EOF. A callback that throws after
			// writing is accounted for from the physical record on the next transaction.
			write();
			return true;
		} finally { release(); }
	}
}
