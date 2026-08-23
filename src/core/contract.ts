/**
 * Structured return contracts — the substrate that makes voting/judging
 * mechanical (reducers read fields generically) and that is PINNED per run.
 *
 * Pure module (Node stdlib only, no Pi imports). A contract is a small typed
 * schema; `pinContract` freezes a `name@hash` for a run so hot-reloading a
 * contract file never changes an in-flight run (guardrails I3).
 */

import { createHash } from "node:crypto";

export type FieldType = "string" | "number" | "boolean" | "enum";

export interface FieldSpec {
	type: FieldType;
	required?: boolean;
	/** Allowed values for `type: "enum"`. */
	values?: string[];
	/** Inclusive bounds for `type: "number"`. */
	min?: number;
	max?: number;
	/** Minimum string length for `type: "string"` — a non-empty / substantive gate (e.g. a proof
	 *  line that must carry a real command + live output, not an empty placeholder). */
	minLength?: number;
}

export interface ContractDef {
	name: string;
	fields: Record<string, FieldSpec>;
}

export interface PinnedContract {
	name: string;
	hash: string;
	def: ContractDef;
}

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	/** The validated object (present only when `ok`). */
	value?: Record<string, unknown>;
}

/** The built-in default contract: pi-fork's four sections + voting substrate. */
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

const FIELD_TYPES: readonly FieldType[] = ["string", "number", "boolean", "enum"];

export type ContractParse = { ok: true; def: ContractDef } | { ok: false; error: string };

/** Parse a `contracts/<name>.contract.json` file into a validated {@link ContractDef}.
 *  Data-driven authoring surface (spec §4.6): drop a JSON file, reference it by name via a
 *  persona/strategy `outputContract`. Reducers then read its fields generically. */
export function parseContract(content: string): ContractParse {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		return { ok: false, error: "contract is not valid JSON" };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "contract must be a JSON object" };
	const o = raw as Record<string, unknown>;
	if (typeof o.name !== "string" || !o.name.trim()) return { ok: false, error: "contract.name is required" };
	if (typeof o.fields !== "object" || o.fields === null || Array.isArray(o.fields)) return { ok: false, error: "contract.fields must be an object" };

	const fields: Record<string, FieldSpec> = {};
	for (const [fname, rawSpec] of Object.entries(o.fields as Record<string, unknown>)) {
		if (typeof rawSpec !== "object" || rawSpec === null || Array.isArray(rawSpec)) return { ok: false, error: `field "${fname}" must be an object` };
		const s = rawSpec as Record<string, unknown>;
		if (typeof s.type !== "string" || !(FIELD_TYPES as readonly string[]).includes(s.type)) {
			return { ok: false, error: `field "${fname}" has an invalid type (string|number|boolean|enum)` };
		}
		const spec: FieldSpec = { type: s.type as FieldType };
		if (s.required === true) spec.required = true;
		if (spec.type === "enum") {
			if (!Array.isArray(s.values) || !s.values.every((v): v is string => typeof v === "string") || s.values.length === 0) {
				return { ok: false, error: `enum field "${fname}" needs a non-empty string "values" list` };
			}
			spec.values = s.values;
		}
		if (typeof s.min === "number") spec.min = s.min;
		if (typeof s.max === "number") spec.max = s.max;
		if (typeof s.minLength === "number") spec.minLength = s.minLength;
		fields[fname] = spec;
	}
	return { ok: true, def: { name: o.name, fields } };
}

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
 * Scan backwards for a BALANCED object/array: walk from the last closer to its matching
 * opener, tracking string state so a brace inside a string value never miscounts. This is
 * what survives prose that itself contains braces (a report quoting code or a `${…}`),
 * where a naive first-`{` scan slices from the prose and yields garbage.
 */
function balancedFromEnd(s: string): string | undefined {
	const close = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
	if (close < 0) return undefined;
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

/**
 * Pull a JSON candidate out of an LLM reply before parsing. Models very often wrap
 * structured output in a ```json fence or surround it with prose ("Here you go: {…}"),
 * which makes a raw `JSON.parse` throw and silently fails the whole contract (the magi
 * bug: every member's vote excluded as "invalid output").
 *
 * Candidates are tried most-specific first and the FIRST ONE THAT ACTUALLY PARSES wins,
 * so a heuristic can never win by producing confident garbage:
 *   1. the whole text (already-clean JSON);
 *   2. each fenced block, last fence first (the contract puts the answer last, so an
 *      earlier fence is quoted evidence);
 *   3. a balanced object/array scanned backwards from the last closer, string-aware.
 * Falls back to the legacy outermost-slice so genuinely-malformed output still fails
 * parsing naturally with the same shape of error as before.
 *
 * Regression this closes: a report whose PROSE contains a brace (quoted code, a `${…}`)
 * followed by the fenced answer. The old path only unwrapped a fence spanning the ENTIRE
 * output, then sliced from the FIRST brace — landing inside the prose and failing a leg
 * whose work was correct ("contract <name> failed: output was not valid JSON").
 */
export function extractJsonCandidate(text: string): string {
	const s = text.trim();
	if (parses(s)) return s;
	for (const block of fencedBlocks(s)) {
		if (parses(block)) return block;
		// A fence may itself hold prose around the object ("Result:\n{…}").
		const inner = balancedFromEnd(block);
		if (inner !== undefined && parses(inner)) return inner;
	}
	const balanced = balancedFromEnd(s);
	if (balanced !== undefined && parses(balanced)) return balanced;
	// Legacy fallback: outermost slice. Nothing parsed, so this only shapes the error.
	const starts = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
	if (starts.length > 0) {
		const start = Math.min(...starts);
		const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
		if (end > start) return s.slice(start, end + 1);
	}
	return s;
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
	return `- ${name} (${parts.join(", ")})`;
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
	const lines = [
		`--- output contract (${def.name}) ---`,
		"End your FINAL answer with a single JSON object (prose before it is fine, nothing after it) with these fields:",
		...Object.entries(def.fields).map(([n, s]) => fieldLine(n, s)),
		"The object is parsed mechanically. Include every required field; omit fields you have nothing for.",
	];
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
 *  contract in one step — the shared path for every engine backend. */
export function parseAndValidate(output: string, def: ContractDef): ParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJsonCandidate(output));
	} catch {
		parsed = undefined;
	}
	const v: ValidationResult =
		parsed === undefined ? { ok: false, errors: ["output was not valid JSON"] } : validateAgainst(def, parsed);
	if (v.ok && v.value) return { ok: true, value: v.value };
	return { ok: false, error: `contract ${def.name} failed: ${v.errors.join("; ")}` };
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
	return { name: def.name, hash: stableHash(def), def };
}

/** Validate a structured value against a contract. Unknown extra fields are kept. */
export function validateAgainst(def: ContractDef, value: unknown): ValidationResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, errors: ["expected a JSON object"] };
	}
	const obj = value as Record<string, unknown>;
	const errors: string[] = [];

	for (const [name, spec] of Object.entries(def.fields)) {
		const fv = obj[name];
		const present = fv !== undefined && fv !== null;
		if (!present) {
			if (spec.required) errors.push(`missing required field: ${name}`);
			continue;
		}
		switch (spec.type) {
			case "string":
				if (typeof fv !== "string") {
					errors.push(`field ${name} must be a string`);
					break;
				}
				if (spec.minLength !== undefined && fv.length < spec.minLength) {
					errors.push(`field ${name} must be at least ${spec.minLength} characters`);
				}
				break;
			case "number":
				if (typeof fv !== "number" || Number.isNaN(fv)) {
					errors.push(`field ${name} must be a number`);
					break;
				}
				if (spec.min !== undefined && fv < spec.min) errors.push(`field ${name} must be >= ${spec.min}`);
				if (spec.max !== undefined && fv > spec.max) errors.push(`field ${name} must be <= ${spec.max}`);
				break;
			case "boolean":
				if (typeof fv !== "boolean") errors.push(`field ${name} must be a boolean`);
				break;
			case "enum": {
				const values = spec.values ?? [];
				if (typeof fv !== "string" || !values.includes(fv)) {
					errors.push(`field ${name} must be one of: ${values.join(", ")}`);
				}
				break;
			}
		}
	}

	return errors.length === 0 ? { ok: true, errors, value: obj } : { ok: false, errors };
}
