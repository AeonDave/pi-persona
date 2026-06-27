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

/**
 * Pull a JSON candidate out of an LLM reply before parsing. Models very often wrap
 * structured output in a ```json fence or surround it with prose ("Here you go: {…}"),
 * which makes a raw `JSON.parse` throw and silently fails the whole contract (the magi
 * bug: every member's vote excluded as "invalid output"). This strips a fenced code
 * block and narrows to the outermost {…}/[…]. Returns the trimmed input unchanged when
 * no object/array is found, so genuinely-malformed output still fails parsing naturally.
 */
export function extractJsonCandidate(text: string): string {
	let s = text.trim();
	// 1) Unwrap a fenced code block: ```json\n…\n``` or ```\n…\n``` (language tag optional).
	const fence = s.match(/^```[^\n`]*\n([\s\S]*?)```\s*$/);
	if (fence?.[1] !== undefined) s = fence[1].trim();
	// 2) Narrow to the outermost object/array if prose surrounds it. lastIndexOf finds the
	//    final closer, so a `}`/`]` inside a string value doesn't truncate the object.
	const starts = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
	if (starts.length > 0) {
		const start = Math.min(...starts);
		const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
		if (end > start) s = s.slice(start, end + 1);
	}
	return s;
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
				if (typeof fv !== "string") errors.push(`field ${name} must be a string`);
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
