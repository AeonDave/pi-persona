/**
 * Persona persistence — remember the last explicitly-selected persona and restore
 * it on the next start. Mirrors pi-subagents-persona: the state file lives in the
 * global persona folder (`<agentDir>/persona/state.json`); session-start restore
 * only READS it, only user gestures (f8 / /persona) write it. Best-effort: any
 * I/O failure is swallowed (persistence must never break a session).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function readLastPersona(stateFile: string): string | undefined {
	try {
		const data = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as { lastPersona?: unknown };
		return typeof data.lastPersona === "string" && data.lastPersona ? data.lastPersona : undefined;
	} catch {
		return undefined;
	}
}

export function writeLastPersona(stateFile: string, name: string | undefined): void {
	try {
		fs.mkdirSync(path.dirname(stateFile), { recursive: true });
		fs.writeFileSync(stateFile, `${JSON.stringify({ lastPersona: name ?? null }, null, 2)}\n`);
	} catch {
		/* best-effort */
	}
}
