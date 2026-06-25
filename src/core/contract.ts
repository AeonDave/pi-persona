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

/** Deterministic, key-order-independent serialisation for hashing. */
function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Freeze a contract for a run: `name` + a stable sha256 over its definition. */
export function pinContract(def: ContractDef): PinnedContract {
	const hash = createHash("sha256").update(stableStringify(def)).digest("hex");
	return { name: def.name, hash, def };
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
