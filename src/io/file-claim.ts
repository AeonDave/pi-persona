import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { join } from "node:path";
import { processState } from "./process-state.ts";

function absent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Fail-fast exclusive claim among cooperating local processes. Each contender publishes a
 * unique marker before checking for peers. A contender that arrives after the winner's check
 * sees the winner's marker until release. Dead markers can be removed by exact, never reused
 * name, so a late reclaimer cannot unlink its live successor's claim.
 */
export function tryFileClaim(directory: string, name: string): (() => void) | undefined {
	const prefix = `${name}.claim-`;
	const marker = `${prefix}${process.pid}-${randomUUID()}`;
	writeFileSync(join(directory, marker), "", { flag: "wx", mode: 0o600 });
	const release = () => { try { unlinkSync(join(directory, marker)); } catch { /* keep the claim if it cannot be removed safely */ } };
	let acquired = false;
	try {
		for (const other of readdirSync(directory)) {
			if (other === marker || !other.startsWith(prefix)) continue;
			const owner = /^(\d+)-[a-f0-9-]{36}$/.exec(other.slice(prefix.length));
			if (!owner || processState(Number(owner[1])) !== "dead") return undefined;
			try { unlinkSync(join(directory, other)); }
			catch (error) { if (!absent(error)) throw error; }
		}
		acquired = true;
		return release;
	} finally {
		if (!acquired) release();
	}
}

const claimWait = new Int32Array(new SharedArrayBuffer(4));

/** Bound synchronous contention in the few native append transactions that require progress. */
export function waitForFileClaim(directory: string, name: string, timeoutMs = 50): (() => void) | undefined {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const release = tryFileClaim(directory, name);
		if (release) return release;
		const left = deadline - performance.now();
		if (left <= 0) return undefined;
		Atomics.wait(claimWait, 0, 0, Math.min(left, randomInt(4, 21)));
	}
}
