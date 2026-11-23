/**
 * Structured return contracts — the substrate that makes voting/judging
 * mechanical (reducers read fields generically) and that is PINNED per run.
 *
 * Pure module (Node stdlib only, no Pi imports). A contract is a small typed
 * schema; `pinContract` freezes a `name@hash` for a run so hot-reloading a
 * contract file never changes an in-flight run (guardrails I3).
 */

import { createHash } from "node:crypto";

import { CONTRACT_LIMITS, clipContractText, contractPath } from "./contract-data.ts";
import { type ContractDef, type FieldSpec, validateContractDefinition } from "./contract-schema.ts";
import { validateContractValue, type ValidationResult } from "./contract-value.ts";

export { CONTRACT_LIMITS } from "./contract-data.ts";
export { type ContractDef, type ContractParse, type FieldSpec, type FieldType, parseContract } from "./contract-schema.ts";
export type { ValidationResult } from "./contract-value.ts";

export interface PinnedContract {
	name: string;
	hash: string;
	def: ContractDef;
}

/** The default result, evidence and learning fields, plus fields for voting and review. */
export const DEFAULT_CONTRACT: ContractDef = {
	name: "default",
	fields: {
		result: { type: "string", required: true },
		output: { type: "string" },
		evidence: { type: "string" },
		learnings: { type: "string" },
		vote: { type: "string" },
		confidence: { type: "number", min: 0, max: 1 },
		stance: { type: "enum", values: ["approve", "reject", "revise"] },
		dissent: { type: "string" },
	},
};

/** Does this text parse as JSON? The only honest test of a candidate. */
function parses(candidate: string): boolean {
	if (candidate.length === 0) return false;
	try {
		JSON.parse(candidate);
		return true;
	} catch {
		return false;
	}
}

/**
 * Every fenced code block in the text, last one first. The contract asks for the JSON at
 * the END ("prose before it is fine, nothing after it"), so the last fence is the answer
 * and any earlier fence is quoted evidence in the report.
 */
function fencedBlocks(s: string): string[] {
	const out: string[] = [];
	const re = /```[^\n`]*\n([\s\S]*?)```/g;
	let m = re.exec(s);
	while (m !== null) {
		if (m[1] !== undefined) out.push(m[1].trim());
		m = re.exec(s);
	}
	return out.reverse();
}

/**
 * Scan backwards from one closer for a BALANCED object/array: walk from `close` to its
 * matching opener, tracking string state so a brace inside a string value never miscounts.
 * This is what survives prose that itself contains braces (a report quoting code or a
 * `${…}`), where a naive first-`{` scan slices from the prose and yields garbage.
 */
function balancedFrom(s: string, close: number): string | undefined {
	const open = s[close] === "}" ? "{" : "[";
	const shut = s[close];
	let depth = 0;
	let inString = false;
	let escaped = false;
	// Walk backwards. `escaped` needs a forward look: a quote is literal when preceded by an
	// ODD number of backslashes, so count them rather than tracking a single flag.
	for (let i = close; i >= 0; i--) {
		const ch = s[i];
		if (ch === '"') {
			let backslashes = 0;
			for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
			escaped = backslashes % 2 === 1;
			if (!escaped) inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === shut) depth++;
		else if (ch === open) {
			depth--;
			if (depth === 0) return s.slice(i, close + 1);
		}
	}
	return undefined;
}

/** Every backwards scan spends this budget, even when it finds no new candidate. */
const MAX_JSON_SCAN_ATTEMPTS = 64;

/**
 * Every balanced object/array in the text, walking closers RIGHT-TO-LEFT (the contract
 * asks for the answer at the end). One candidate per closer is not enough: trailing prose
 * like "option [2]" or "Done {thanks}." yields a slice that parses (or mis-slices into
 * prose) and must not shadow the real answer object sitting behind it.
 */
function* balancedFromEnd(s: string): Generator<string> {
	const seen = new Set<string>();
	let attempts = 0;
	for (let close = s.length - 1; close >= 0 && attempts < MAX_JSON_SCAN_ATTEMPTS; close--) {
		const ch = s[close];
		if (ch !== "}" && ch !== "]") continue;
		attempts++;
		const slice = balancedFrom(s, close);
		if (slice !== undefined) {
			if (!seen.has(slice)) {
				seen.add(slice);
				yield slice;
			}
			// A parseable enclosing object/array owns its nested data. Those excerpts are
			// not separate answers, even when the enclosing answer fails its contract.
			if (parses(slice)) close -= slice.length - 1;
		}
	}
}

/**
 * All JSON candidates of a reply, most-specific first, deduped: the whole text, each
 * fenced block last-first (plus the balanced objects inside a fence that holds prose
 * around the JSON), then every balanced object/array of the whole text right-to-left,
 * and finally the legacy outermost slice (error shaping only — it may not parse).
 */
function* jsonCandidates(text: string): Generator<string> {
	const seen = new Set<string>();
	const emit = function* (c: string | undefined): Generator<string> {
		if (c !== undefined && c.length > 0 && !seen.has(c)) {
			seen.add(c);
			yield c;
		}
	};
	const s = text.trim();
	yield* emit(s);
	for (const block of fencedBlocks(s)) {
		yield* emit(block);
		yield* balancedFromEnd(block);
	}
	yield* balancedFromEnd(s);
	// Legacy fallback: outermost slice. If nothing parsed, this only shapes the error.
	const starts = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
	if (starts.length > 0) {
		const start = Math.min(...starts);
		const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
		if (end > start) yield* emit(s.slice(start, end + 1));
	}
}

/**
 * Pull a JSON candidate out of an LLM reply before parsing. Models very often wrap
 * structured output in a ```json fence or surround it with prose ("Here you go: {…}"),
 * which makes a raw `JSON.parse` throw and silently fails the whole contract (the magi
 * bug: every member's vote excluded as "invalid output").
 *
 * Candidates are tried most-specific first and the FIRST ONE THAT ACTUALLY PARSES wins,
 * so a heuristic can never win by producing confident garbage — with one refinement:
 * contracts always want a JSON OBJECT, so among parseable candidates an object beats an
 * array/scalar (trailing prose like "option [2]" parses as JSON but can never be the
 * answer; the real object behind it is).
 *   1. the whole text (already-clean JSON);
 *   2. each fenced block, last fence first (the contract puts the answer last, so an
 *      earlier fence is quoted evidence);
 *   3. every balanced object/array scanned backwards, string-aware, right-to-left.
 * Falls back to the legacy outermost-slice so genuinely-malformed output still fails
 * parsing naturally with the same shape of error as before.
 *
 * Regressions this closes: a report whose PROSE contains a brace (quoted code, a `${…}`)
 * followed by the fenced answer; and a correct answer followed by prose carrying its own
 * bracketed token ("I picked option [2]"), which used to shadow the real object and fail
 * a leg whose work was correct ("contract <name> failed: output was not valid JSON").
 */
export function extractJsonCandidate(text: string): string {
	let firstParseable: string | undefined;
	for (const candidate of jsonCandidates(text)) {
		if (!parses(candidate)) continue;
		if (candidate.startsWith("{")) return candidate;
		firstParseable ??= candidate;
	}
	if (firstParseable !== undefined) return firstParseable;
	// Nothing parsed: return the last (legacy outermost-slice) candidate if it exists,
	// else the trimmed text — both only shape the downstream parse error.
	let last: string | undefined;
	for (const candidate of jsonCandidates(text)) last = candidate;
	return last ?? text.trim();
}

/** One human-readable ballot line for a field: `- vote (string, required, one of: a | b)`. */
function fieldLine(name: string, spec: FieldSpec): string {
	const parts: string[] = [spec.type];
	if (spec.required) parts.push("required");
	if (spec.type === "enum" && spec.values) parts.push(`one of: ${spec.values.join(" | ")}`);
	if (spec.min !== undefined && spec.max !== undefined) parts.push(`${spec.min}..${spec.max}`);
	else if (spec.min !== undefined) parts.push(`>= ${spec.min}`);
	else if (spec.max !== undefined) parts.push(`<= ${spec.max}`);
	if (spec.minLength !== undefined) parts.push(`min ${spec.minLength} chars`);
	if (spec.type === "array") {
		if (spec.minItems !== undefined) parts.push(`min ${spec.minItems} items`);
		if (spec.maxItems !== undefined) parts.push(`max ${spec.maxItems} items`);
	}
	return `- ${name} (${parts.join(", ")})`;
}

function* fieldLines(name: string, spec: FieldSpec): Generator<string> {
	yield fieldLine(name, spec);
	if (spec.type === "object") {
		for (const [key, child] of Object.entries(spec.fields!)) yield* fieldLines(contractPath(name, key), child);
	} else if (spec.type === "array") yield* fieldLines(`${name}[]`, spec.items!);
}

function admittedContract(def: ContractDef): ContractDef {
	const parsed = validateContractDefinition(def);
	if (!parsed.ok) throw new Error(`invalid contract: ${parsed.error}`);
	return parsed.def;
}

/**
 * The task preamble that tells a member HOW to satisfy `outputContract` — derived
 * mechanically from the (pinned) def and appended by BOTH engine backends whenever a
 * spec carries a contract. Without this, only agents whose own .md hand-writes the JSON
 * format (e.g. the MAGI cores) could be convened by a voting strategy; a generic
 * executor would answer in prose and be quarantined as an invalid output. Live-drive
 * verified: debate over two bare `operator`s fails exactly that way without it.
 */
export function contractInstructions(def: ContractDef): string {
	admittedContract(def);
	const lines = [
		`--- output contract (${def.name}) ---`,
		"End your FINAL answer with a single JSON object (prose before it is fine, nothing after it) with these fields:",
		...Object.entries(def.fields).flatMap(([n, s]) => [...fieldLines(contractPath("", n), s)]),
		"The object is parsed mechanically. Include every required field; omit fields you have nothing for.",
	];
	if (Object.values(def.fields).some((field) => field.type === "array" || field.type === "object")) lines.push("Paths with [] describe each array item; nested paths describe fields inside that object. Required item fields apply to every item.");
	if (def.fields.vote) {
		// Vote hygiene (the MAGI cores hand-write this in their .md; a generic agent needs it
		// here): qualifiers make equivalent votes tally apart ("esm" vs "esm (but only if…)").
		lines.push(
			'For "vote": the BARE option token only — for "X or Y?" vote "x" or "y", no qualifiers or conditions (put nuance in result/output) so equivalent votes tally together.',
		);
	}
	return lines.join("\n");
}

export interface ParseResult {
	ok: boolean;
	/** The validated object (present only when `ok`). */
	value?: Record<string, unknown>;
	error?: string;
}

/** Unwrap (fences/prose), JSON-parse, and validate an agent's raw output against a
 *  contract in one step — the shared path for every engine backend. A complete JSON
 *  reply is authoritative: invalid outer data cannot be bypassed by an inner object.
 *  Prose/fenced replies still try candidates until one parses and validates. */
export function parseAndValidate(output: string, def: ContractDef): ParseResult {
	const schema = validateContractDefinition(def);
	if (!schema.ok) return { ok: false, error: clipContractText(`contract failed: ${schema.error}`, CONTRACT_LIMITS.failureChars) };
	const wholeReply = output.trim();
	let firstErrors: string[] | undefined;
	for (const candidate of jsonCandidates(wholeReply)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		const v = validateContractValue(schema.def, parsed);
		if (v.ok && v.value) return { ok: true, value: v.value };
		firstErrors ??= v.errors;
		if (candidate === wholeReply) break;
	}
	const errors = firstErrors ?? ["output was not valid JSON"];
	return { ok: false, error: clipContractText(`contract ${def.name} failed: ${errors.join("; ")}`, CONTRACT_LIMITS.failureChars) };
}

/** Deterministic, key-order-independent serialisation for hashing. */
function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** A stable sha256 over any JSON-ish value (key-order-independent) — the pinning hash. */
export function stableHash(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Freeze a contract for a run: `name` + a stable sha256 over its definition. */
export function pinContract(def: ContractDef): PinnedContract {
	const snapshot = structuredClone(admittedContract(def));
	const freeze = (value: object): void => {
		for (const child of Object.values(value)) if (child !== null && typeof child === "object") freeze(child);
		Object.freeze(value);
	};
	freeze(snapshot);
	return Object.freeze({ name: snapshot.name, hash: stableHash(snapshot), def: snapshot });
}

/** Every contract name a spec may reference: the built-in `default` plus the installed files. */
export function installedContractNames(defs: Record<string, ContractDef>): string[] {
	return [...new Set(["default", ...Object.keys(defs)])];
}

/** Validate a structured value against an admitted contract. Unknown extra fields are kept. */
export function validateAgainst(def: ContractDef, value: unknown): ValidationResult {
	const schema = validateContractDefinition(def);
	return schema.ok ? validateContractValue(schema.def, value) : { ok: false, errors: [schema.error] };
}
