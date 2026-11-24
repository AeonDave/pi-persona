/**
 * Flow journal (v0.5) — JSONL resume. Each completed phase appends one line; on a later
 * run the journal is read back into a resume map (phase id → output) so done phases are
 * skipped. Lines whose `hash` doesn't match the current run hash (`flowRunHash`: flow + task +
 * cwd) are ignored (another flow version, task or project), and a phase recorded `ok:false` is
 * NOT resumed (it re-runs). `parseJournal`
 * and the filename derivation are pure (tested); the read/write helpers are thin `fs` glue.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname } from "node:path";

import { emptyUsage } from "../engine/stream.ts";
import { tryFileClaim, waitForFileClaim } from "../io/file-claim.ts";
import { flowHash, type FlowSpec } from "./flow.ts";
import type { FlowJournalEntry, ResumedResult } from "./flow-run.ts";

/** What no filename component can carry on both OSes: separators (which would write outside the
 *  flows dir), the characters Windows reserves, and control characters. A flow NAME is free to
 *  contain any of them — it is the flow's identity — but the helpers below swallow fs errors, so a
 *  name carried into the path verbatim would kill resume in silence. */
const PATH_HOSTILE = /[/\\<>:"|?*\x00-\x1f]/g;

/** The journal file for a flow, named `<encoded name>.<flow@hash>.journal.jsonl`.
 *
 *  The name half is for the human reading the flows dir, so it stays as close to the flow's own
 *  name as a filename can be; the `flow@hash` half is what actually keeps journals apart, since
 *  it covers the whole spec (the name included). Two names that encode alike — `ci:quick` and
 *  `ci?quick` — are therefore still two different specs with two different hashes and two
 *  different files, and so is a name long enough to be truncated here. Runs of ONE flow on another
 *  task or project share this file, and a truncated hash could collide: either way every LINE
 *  carries the full run hash (`flowRunHash`), so a resume reads only its own. */
export function journalFileName(spec: FlowSpec): string {
	return `${encodeFlowName(spec.name)}.${flowHash(spec).slice(0, 8)}.journal.jsonl`;
}

type FlowJournalOwnership = { status: "owned"; release: () => void } | { status: "busy" | "unavailable" };

/** Claim the run identity before consulting its checkpoints, including previously saved files. */
export function claimFlowJournal(directory: string, hash: string): FlowJournalOwnership {
	try {
		fs.mkdirSync(directory, { recursive: true });
		const release = tryFileClaim(directory, `flow-${hash}`);
		return release ? { status: "owned", release } : { status: "busy" };
	} catch { return { status: "unavailable" }; }
}

/** A flow name reduced to something a filesystem will accept: hostile characters replaced,
 *  leading dots dropped (they'd make the journal hidden, and `..` is worth never spelling at
 *  all), and capped — the hash and the suffix still have to fit under the ~255-byte name limit. */
function encodeFlowName(name: string): string {
	const encoded = name.replace(PATH_HOSTILE, "-").replace(/^[.\s]+/, "").slice(0, 64).trim();
	return encoded || "flow";
}

/** Fold a JSONL journal into a resume map for the given run hash. Later lines win, so a
 *  phase that failed then succeeded ends up resumed; a phase still failed is left to re-run.
 *  A `gateApproved` line marks a checkpoint already approved so a resume doesn't re-prompt. */
export function parseJournal(content: string, hash: string): Record<string, ResumedResult> {
	const out: Record<string, ResumedResult> = {};
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let e: FlowJournalEntry;
		try {
			e = JSON.parse(line) as FlowJournalEntry;
		} catch {
			continue;
		}
		// A line can parse cleanly yet not be an entry (`null`, a scalar) — dereferencing it here
		// would abort the whole fold, and readJournal's blanket catch would drop every phase.
		if (!e || typeof e !== "object") continue;
		if (e.hash !== hash || typeof e.phase !== "string") continue;
		if (e.ok) {
			out[e.phase] = {
				agent: e.phase, output: e.output ?? "", usage: emptyUsage(), ok: true,
				...(e.gateApproved === true ? { gateApproved: true } : {}),
				...(typeof e.resultRef === "string" ? { resultRef: e.resultRef } : {}),
				...(e.resultVersion === 1 ? { resultVersion: 1 as const } :
					e.resultRef !== undefined || e.resultVersion !== undefined
						? { refUnavailable: "unsupported or missing archived result journal version" } : {}),
			};
		} else delete out[e.phase];
	}
	return out;
}

/** Read a journal file into a resume map, or `{}` if it's absent/unreadable. */
export function readJournal(path: string, hash: string): Record<string, ResumedResult> {
	try {
		return parseJournal(fs.readFileSync(path, "utf8"), hash);
	} catch {
		return {};
	}
}

/** Appends and cleanup share one short claim across all task hashes in this file. */
function updateJournal(path: string, write: () => void): boolean {
	// Marker names need room for their owner's PID and nonce even with a long Unicode flow name.
	const name = createHash("sha256").update(basename(path)).digest("hex");
	try {
		const release = waitForFileClaim(dirname(path), `journal-${name}`, 1000);
		if (!release) return false;
		try { write(); return true; } finally { release(); }
	} catch {
		return false;
	}
}

/** A finished run leaves the file: drop ITS lines (unreadable ones too), keep every other run's
 *  resumable progress, and remove the file once nothing is left. Best-effort. */
export function clearJournal(path: string, hash: string): boolean {
	return updateJournal(path, () => {
		let content: string;
		try { content = fs.readFileSync(path, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const others = content.split("\n").filter((line) => {
			try {
				const e = JSON.parse(line) as FlowJournalEntry | null;
				return !!e && typeof e === "object" && e.hash !== hash;
			} catch {
				return false;
			}
		});
		if (others.length === 0) fs.rmSync(path, { force: true });
		else replaceFile(path, `${others.join("\n")}\n`);
	});
}

/** Write a sibling temp file and rename it over `path`, so a crash mid-rewrite cannot leave
 *  another run's progress truncated. */
function replaceFile(path: string, content: string): void {
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		fs.writeFileSync(tmp, content);
		fs.renameSync(tmp, path);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

/** Does the file end inside a line — a fragment a crash left mid-append? */
function endsMidLine(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = fs.openSync(path, "r");
		const { size } = fs.fstatSync(fd);
		if (size === 0) return false;
		const last = Buffer.alloc(1);
		fs.readSync(fd, last, 0, 1, size - 1);
		return last[0] !== 0x0a;
	} catch {
		return false; // absent: the append creates it
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** An appending writer — one JSONL line per completed phase. Best-effort. An entry always
 *  starts on its own line: appended to an unterminated fragment, it would fail to parse along
 *  with it, and its completed phase would silently re-run on resume. */
export function journalWriter(path: string): (entry: FlowJournalEntry) => boolean {
	return (entry) => updateJournal(path, () => {
		fs.appendFileSync(path, `${endsMidLine(path) ? "\n" : ""}${JSON.stringify(entry)}\n`);
	});
}
