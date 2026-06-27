/**
 * Flow journal (v0.5) — JSONL resume. Each completed phase appends one line; on a later
 * run the journal is read back into a resume map (phase id → output) so done phases are
 * skipped. Lines whose `hash` doesn't match the current `flow@hash` are ignored (the flow
 * changed), and a phase recorded `ok:false` is NOT resumed (it re-runs). `parseJournal`
 * is pure (tested); the read/write helpers are thin `fs` glue.
 */

import * as fs from "node:fs";

import { emptyUsage } from "../engine/stream.ts";
import type { FlowJournalEntry, ResumedResult } from "./flow-run.ts";

/** Fold a JSONL journal into a resume map for the given `flow@hash`. Later lines win, so a
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
		if (e.hash !== hash || typeof e.phase !== "string") continue;
		if (e.ok) {
			const prior = out[e.phase];
			out[e.phase] = { agent: e.phase, output: e.output ?? "", usage: emptyUsage(), ok: true };
			// Preserve an approval from either this line or an earlier line for the same phase.
			if (e.gateApproved || prior?.gateApproved) out[e.phase]!.gateApproved = true;
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

/** An appending writer — one JSONL line per completed phase. Best-effort. */
export function journalWriter(path: string): (entry: FlowJournalEntry) => void {
	return (entry) => {
		try {
			fs.appendFileSync(path, `${JSON.stringify(entry)}\n`);
		} catch {
			/* best effort — journaling must never break a run */
		}
	};
}
