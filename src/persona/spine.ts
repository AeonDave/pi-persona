/**
 * The spine — the shared behavioral layer injected between Pi's base prompt and the
 * persona body (docs/SPINE.md). This module owns SOURCE resolution only: which files, if
 * any, supply the layer. Composition lives in `persona.ts` (supervisor turns) and in
 * the engines (delegated legs).
 *
 * Two texts, not one: the supervisor gets `spine.md`, a delegated leg gets `spine.worker.md`.
 * They are different prompts doing different jobs — the supervisor text tells its reader to
 * confirm irreversible actions with the user, and a leg runs headless (`pi -p --no-session`)
 * with no user to confirm with, so that rule would make it stall or hand the question back as
 * its deliverable. Two SELECTORS for the same reason: whether each text helps is a separate
 * question, and the A/B in docs/SPINE.md needs the arms that turn one on without the other.
 *
 * Pure over an injected reader, mirroring `resolveConfig`'s injected env, so the whole
 * precedence table is unit-testable without touching a disk.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Size ceiling for a spine file. The layer is prepended to EVERY supervisor turn AND every
 *  delegated leg, so a mistyped path aimed at a log, a binary, or a big JSON would silently
 *  inflate every request — multiplied by the fanout width. 64 KiB is orders of magnitude past
 *  any hand-written behavioral layer (the bundled ones are ~2 KiB) and well short of a file
 *  worth paying for on every turn. Past it we degrade like every other bad input: a warning
 *  and no spine. */
export const MAX_SPINE_BYTES = 64 * 1024;

/** The outcome of one read attempt. The three cases are kept apart because they send a user to
 *  three different places: permissions, content, and the size of the file they pointed at. */
export type SpineRead = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "oversize"; bytes: number };

/** Reads a file, or reports why it yielded nothing usable. */
export type SpineReader = (path: string) => SpineRead;

export interface SpineSources {
	/** `config.spine` — the SUPERVISOR selector: `""` (off), `"on"`, or an explicit path. */
	selector: string;
	/** `config.spineLegs` — the same grammar for the delegated legs. A separate selector because
	 *  the two texts are separable decisions and the A/B in docs/SPINE.md has to isolate them;
	 *  `config` has already applied the "follows `selector` unless set" default, so by the time
	 *  it arrives here it is just another selector. */
	workerSelector: string;
	/** `<persona data dir>/spine.md` — the user's own copy, which shadows the bundled one. */
	userPath: string;
	/** The `prompts/spine.md` shipped with the package. */
	bundledPath: string;
	/** `<persona data dir>/spine.worker.md` — the user's own copy of the delegated-leg text. */
	workerUserPath: string;
	/** The `prompts/spine.worker.md` shipped with the package. */
	workerBundledPath: string;
	read: SpineReader;
}

export interface ResolvedSpine {
	/** The supervisor layer text, trimmed. Absent ⇒ no spine on supervisor turns. */
	text?: string;
	/** Which file supplied it (diagnostics / `/doctor`). */
	source?: string;
	/** The delegated-leg layer text, trimmed. Absent ⇒ legs run without one; they are never
	 *  given the supervisor text as a stand-in (see the module header). */
	worker?: string;
	workerSource?: string;
	/** Degradation notice: a spine was asked for and something did not supply one. The
	 *  session continues without it — a missing prompt file is never a hard failure. */
	warning?: string;
}

/** The bundled supervisor spine that ships with the package. Derived from THIS module's own
 *  URL, so it resolves identically from a checkout and from an installed `node_modules/pi-persona`
 *  (where `files: ["prompts", …]` puts `prompts/` next to `src/`). */
export function bundledSpinePath(moduleUrl: string = import.meta.url): string {
	return bundledPromptPath("spine.md", moduleUrl);
}

/** The bundled worker variant — the text a delegated leg gets. */
export function bundledWorkerSpinePath(moduleUrl: string = import.meta.url): string {
	return bundledPromptPath("spine.worker.md", moduleUrl);
}

function bundledPromptPath(file: string, moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..", "prompts", file);
}

/** The two filesystem calls the production reader makes, behind a seam. It exists so the ORDER
 *  can be witnessed: reading first and measuring the resulting string refuses exactly the same
 *  files, so the refusal on its own proves nothing about what was loaded to reach it. */
export interface SpineFs {
	/** Byte size of the file at `path`; throws if it isn't there or can't be stat'd. */
	size: (path: string) => number;
	/** The file's UTF-8 contents. */
	text: (path: string) => string;
}

const NODE_FS: SpineFs = { size: (path) => statSync(path).size, text: (path) => readFileSync(path, "utf8") };

/** The production reader: a missing/unreadable file is "no content", and an oversize one is
 *  refused on its `stat` so its bytes never enter the process at all. `fs` is defaulted — no
 *  caller passes it — so this stays a plain {@link SpineReader} to everything downstream. */
export function readSpineFile(path: string, fs: SpineFs = NODE_FS): SpineRead {
	try {
		const bytes = fs.size(path);
		if (bytes > MAX_SPINE_BYTES) return { kind: "oversize", bytes };
		return { kind: "ok", text: fs.text(path) };
	} catch {
		return { kind: "missing" };
	}
}

/** One of the two roles the layer is resolved for, reduced to what the resolution actually needs. */
interface SpineRole {
	selector: string;
	/** `on` candidates in precedence order — the user's own copy shadows the bundled default,
	 *  the precedence every other pi-persona resource follows. */
	candidates: string[];
	/** The file name to say out loud when neither candidate is there. */
	file: string;
	/** What is lost when this role ends up without a layer — the two roles lose different things. */
	consequence: string;
}

interface ResolvedRole {
	/** The text and the file it came from, together — a role either has both or has neither. */
	found?: { text: string; source: string };
	/** Every candidate that WAS there and still could not be used, plus a note when the role is
	 *  left with nothing at all. Collected rather than thrown: no prompt file is a hard failure. */
	problems: string[];
}

/** Resolve which files supply the spine. See the table in docs/SPINE.md. */
export function resolveSpine(sources: SpineSources): ResolvedSpine {
	const { selector, workerSelector, userPath, bundledPath, workerUserPath, workerBundledPath, read } = sources;
	const supervisor = resolveRole(
		{ selector, candidates: [userPath, bundledPath], file: "spine.md", consequence: "continuing without one" },
		read,
	);
	// The default wiring points BOTH roles at the same explicit path (the legs follow the
	// supervisor selector unless set), and that is one decision: resolving it twice would stat and
	// slurp the file twice and answer one mistyped path with two warnings. `on` is not shared —
	// there the two roles name different files by design.
	const legs =
		workerSelector === selector && selector !== "" && selector !== "on"
			? supervisor
			: resolveRole(
					{ selector: workerSelector, candidates: [workerUserPath, workerBundledPath], file: "spine.worker.md", consequence: "delegated legs continue without one" },
					read,
				);

	const out: ResolvedSpine = {};
	if (supervisor.found) {
		out.text = supervisor.found.text;
		out.source = supervisor.found.source;
	}
	if (legs.found) {
		out.worker = legs.found.text;
		out.workerSource = legs.found.source;
	}
	const problems = legs === supervisor ? supervisor.problems : [...supervisor.problems, ...legs.problems];
	if (problems.length > 0) out.warning = `spine: ${problems.join("; ")}`;
	return out;
}

/** Resolve one role's source. Off reads nothing at all, so the disabled path cannot even fail. */
function resolveRole(role: SpineRole, read: SpineReader): ResolvedRole {
	const { selector, candidates, file, consequence } = role;
	if (selector === "") return { problems: [] };
	if (selector === "on") {
		const { found, problems } = firstUsable(read, candidates);
		if (found) return { found, problems };
		problems.push(`no ${file} found (looked in ${candidates.join(" and ")}) — ${consequence}`);
		return { problems };
	}
	// An explicit path is a deliberate choice: it never falls back to another file, because
	// silently running a DIFFERENT behavioral layer than the one asked for is worse than none.
	const explicit = read(selector);
	const usable = usableText(explicit);
	if (!usable) return { problems: [`${unusableReason(selector, explicit)} — ${consequence}`] };
	return { found: { text: usable, source: selector }, problems: [] };
}

/** The first candidate that yields usable text, plus a note for every candidate that WAS there
 *  and still could not be used — an empty or oversize file the user meant to be read is worth
 *  saying out loud, whereas a candidate that simply isn't there is the normal case. */
function firstUsable(read: SpineReader, candidates: string[]): { found?: { text: string; source: string }; problems: string[] } {
	const problems: string[] = [];
	for (const path of candidates) {
		const attempt = read(path);
		if (attempt.kind === "missing") continue;
		const text = usableText(attempt);
		if (text) return { found: { text, source: path }, problems };
		problems.push(`${unusableReason(path, attempt)} — skipped`);
	}
	return { problems };
}

/** An empty (or whitespace-only) file has nothing to inject — treat it as absent. */
function usableText(attempt: SpineRead): string | undefined {
	if (attempt.kind !== "ok") return undefined;
	const text = attempt.text.trim();
	return text ? text : undefined;
}

/** Why a candidate yielded nothing — stated without a consequence, so each caller can attach
 *  its own ("continuing without one" for the single explicit file, "skipped" for a candidate
 *  the search moves past). */
function unusableReason(path: string, attempt: SpineRead): string {
	if (attempt.kind === "missing") return `cannot read ${path}`;
	if (attempt.kind === "oversize") return `${path} is ${attempt.bytes} bytes, over the ${MAX_SPINE_BYTES}-byte limit`;
	return `${path} is empty`;
}
