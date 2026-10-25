/** Supervisor-facing terminal receipts and the shared fenced page projection. No lifecycle effects. */
import { fenceUntrusted } from "../core/fence.ts";
import { readFailure, type ReadReply, type ScopedReader } from "../bus/result-reader.ts";
import { RESULT_MAX_BODY_CHARS, RESULT_READ_DEFAULT, RESULT_READ_MAX, type ArchiveFailure, type ResultPage, type ResultReadRequest,
	type ResultStorage, type SaveOutcome, type TerminalStatus } from "./types.ts";
import type { StoredBodyPage } from "./record.ts";

export interface ResultReceipt {
	ref?: string;
	storage?: ResultStorage;
	truncated?: boolean;
	warning?: string;
}

export function resultReceipt(outcome: SaveOutcome): ResultReceipt {
	if (!outcome.ok) return { warning: `Terminal report not archived (${outcome.reason}).` };
	return {
		ref: outcome.ref, storage: outcome.storage, truncated: outcome.summary.truncated,
		...(outcome.warnings.length > 0 ? { warning: `Terminal storage: ${outcome.warnings.join(", ")}.` } : {}),
	};
}

export function resultReceiptHint(receipt: ResultReceipt | undefined): string {
	if (!receipt) return "";
	const reference = receipt.ref
		? `${receipt.ref} · ${receipt.storage === "session-entry" ? "native session entry accepted (not an fsync guarantee)" : "memory-only; runtime-only, not durable"}. Read with intercom { action:"result", ref:"${receipt.ref}" }.`
		: "";
	return [reference, receipt.truncated ? "Saved report truncated by archive limits." : "", receipt.warning ?? ""].filter(Boolean).join(" ");
}

/** Live reports are not restricted to archive body retention; paging still obeys the same UTF-16 contract. */
export function pageLiveResult(body: string, offset = 0, limit = RESULT_READ_DEFAULT): StoredBodyPage | undefined {
	const splitsPair = (at: number): boolean => at > 0 && at < body.length
		&& /[\uD800-\uDBFF]/.test(body[at - 1]!) && /[\uDC00-\uDFFF]/.test(body[at]!);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > body.length || splitsPair(offset)
		|| !Number.isInteger(limit) || limit < 2 || limit > RESULT_READ_MAX) return undefined;
	let end = Math.min(body.length, offset + limit);
	if (splitsPair(end)) end--;
	return { body: body.slice(offset, end), offset, endOfStoredBody: end === body.length, ...(end < body.length ? { nextOffset: end } : {}) };
}

/** Metadata is caller-owned; report and diagnostic text are always independently fenced. */
export function projectResultPage(page: StoredBodyPage, error?: string): string {
	const cause = error ? `\nFailure detail:\n${fenceUntrusted(error.slice(0, 2048))}` : "";
	const next = page.nextOffset === undefined ? "end of stored body" : `next offset: ${page.nextOffset}`;
	return `Page offset ${page.offset}; ${page.body.length} UTF-16 units; ${next}.${cause}\n${page.body === "(no output)" ? page.body : fenceUntrusted(page.body)}`;
}

// ── reference handoff (flow reference mode): scoped reads over the terminal archive ──

/** The narrow archive face a leg's reader needs — `TerminalResultArchive` satisfies it
 *  structurally. Readers never own, hydrate or mutate archive state; they page through it. */
export interface ResultArchiveView {
	read(request: ResultReadRequest): ResultPage;
}

/** An archive failure reason mapped onto the reader wire's closed error vocabulary. */
function readFailureFor(reason: ArchiveFailure["reason"]): ReadReply {
	switch (reason) {
		case "invalid":
			return readFailure("invalid");
		case "busy":
			return readFailure("busy");
		default:
			// missing / ambiguous / corrupt / conflict / quota — every identity or durability
			// problem reads to the child as "the ref is not readable here".
			return readFailure("unavailable");
	}
}

/** A scoped reader over the owning session's archive, granted an EXPLICIT ref set (the
 *  direct upstream phase needs of THIS leg — nothing else). Owner/capability rechecks at
 *  call time are the root's job (the adapter closure); revocation is one-way and final.
 *  Reads page the archive's already-stored body; they never rebill, collect live runs, or
 *  wake anything. Projection/fencing stays the tool's job (`tools/read-result.ts`). */
export interface ScopedResultReader extends ScopedReader {
	/** Refs that are not durably readable (missing, unreadable, or memory-only). Empty = healthy. */
	preflight(): { missing: string[] };
}

export function makeScopedResultReader(view: ResultArchiveView, granted: readonly string[]): ScopedResultReader {
	const refs = new Set(granted);
	let revoked = false;
	const page = (request: ResultReadRequest): ReadReply => {
		const result = view.read(request);
		if (!result.ok) return readFailureFor(result.reason);
		const s = result.summary;
		const end = result.offset + result.body.length;
		return {
			ok: true, ref: s.ref, body: result.body, offset: result.offset,
			...(end < s.storedChars ? { nextOffset: end } : {}),
			storedChars: s.storedChars, originalChars: s.originalChars, truncated: s.truncated,
			endOfStoredBody: result.endOfStoredBody, status: s.status, provenance: s.provenance,
		};
	};
	return {
		async read(request, signal): Promise<ReadReply> {
			if (revoked) return readFailure("revoked");
			if (signal?.aborted) return readFailure("cancelled");
			if (!refs.has(request.ref)) return readFailure("denied");
			return page(request);
		},
		revoke(): void {
			revoked = true;
		},
		preflight(): { missing: string[] } {
			// Reference handoff is a DURABILITY contract: a memory-only record is not a receipt
			// a later process (or a resumed run) could read back, so it does not pass preflight.
			const missing: string[] = [];
			for (const ref of refs) {
				const result = view.read({ ref, offset: 0, limit: 2 });
				if (!result.ok || result.summary.storage !== "session-entry") missing.push(ref);
			}
			return { missing };
		},
	};
}

/** The full stored body of an archived result, paged out to the archive's own ceiling. Used
 *  by a reference-mode RESUME to rebuild a done phase's output from the archive (contract 2). */
export function readArchivedBody(view: ResultArchiveView, ref: string):
	| { ok: true; body: string; status: TerminalStatus; truncated: boolean }
	| { ok: false; error: string } {
	let offset = 0;
	let body = "";
	let status: TerminalStatus | undefined;
	let truncated = false;
	while (true) {
		const page = view.read({ ref, offset, limit: RESULT_READ_MAX });
		if (!page.ok) return { ok: false, error: `${page.reason}: ${page.message}` };
		status = page.summary.status;
		truncated = page.summary.truncated;
		body += page.body;
		if (page.endOfStoredBody || page.nextOffset === undefined) break;
		if (page.nextOffset <= offset || body.length >= RESULT_MAX_BODY_CHARS) {
			return { ok: false, error: `archive paging did not advance past offset ${page.nextOffset}` };
		}
		offset = page.nextOffset;
	}
	if (status === undefined) return { ok: false, error: "archive returned no status" };
	return { ok: true, body, status, truncated };
}
