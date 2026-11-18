/** The one small contract schema language, shared by file and programmatic definitions. */
import { CONTRACT_LIMITS, contractPath, inspectContractData, isContractObject } from "./contract-data.ts";

export type FieldType = "string" | "number" | "integer" | "boolean" | "enum" | "object" | "array";

export interface FieldSpec {
	type: FieldType;
	required?: boolean;
	/** Allowed strings for enum fields. */
	values?: string[];
	/** Inclusive number/integer bounds. */
	min?: number;
	max?: number;
	minLength?: number;
	/** Object fields and array item schema use this same language recursively. */
	fields?: Record<string, FieldSpec>;
	items?: FieldSpec;
	minItems?: number;
	maxItems?: number;
}

export interface ContractDef {
	name: string;
	fields: Record<string, FieldSpec>;
}

export type ContractParse = { ok: true; def: ContractDef } | { ok: false; error: string };

const TYPE_KEYS: Record<FieldType, readonly string[]> = {
	string: ["minLength"], number: ["min", "max"], integer: ["min", "max"],
	boolean: [], enum: ["values"], object: ["fields"], array: ["items", "minItems", "maxItems"],
};

/** Validate the definition itself before it can instruct, pin or validate a run. */
export function validateContractDefinition(raw: unknown): ContractParse {
	const unsafe = inspectContractData(raw, CONTRACT_LIMITS.schemaDepth * 3 + 3, CONTRACT_LIMITS.schemaChars);
	if (unsafe) return { ok: false, error: unsafe };
	if (!isContractObject(raw)) return { ok: false, error: "contract must be a JSON object" };
	if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 128) return { ok: false, error: "contract.name must be a non-empty string of at most 128 characters" };
	for (const key of Object.keys(raw)) if (key !== "name" && key !== "fields") return { ok: false, error: `contract.${key} is not a supported property` };
	let fieldCount = 0;
	const fieldsError = (fields: unknown, path: string, depth: number): string | undefined => {
		if (!isContractObject(fields)) return `${path || "contract"}.fields must be an object`;
		for (const [name, spec] of Object.entries(fields)) {
			const fieldPath = contractPath(path, name);
			if (!name || name.length > 128) return `${fieldPath} must have a name of 1..128 characters`;
			const error = specError(spec, fieldPath, depth);
			if (error) return error;
		}
		return undefined;
	};
	const specError = (rawSpec: unknown, path: string, depth: number): string | undefined => {
		if (++fieldCount > CONTRACT_LIMITS.schemaFields) return `contract exceeds ${CONTRACT_LIMITS.schemaFields} fields and item schemas`;
		if (depth > CONTRACT_LIMITS.schemaDepth) return `${path} exceeds maximum schema depth ${CONTRACT_LIMITS.schemaDepth}`;
		if (!isContractObject(rawSpec)) return `field ${path} must be an object`;
		if (typeof rawSpec.type !== "string" || !Object.hasOwn(TYPE_KEYS, rawSpec.type)) return `field ${path} has an invalid type (${Object.keys(TYPE_KEYS).join("|")})`;
		const type = rawSpec.type as FieldType;
		for (const key of Object.keys(rawSpec)) {
			if (key !== "type" && key !== "required" && !TYPE_KEYS[type].includes(key)) return `field ${path}.${key} is not supported for ${type}`;
		}
		if (rawSpec.required !== undefined && typeof rawSpec.required !== "boolean") return `field ${path}.required must be a boolean`;
		for (const key of TYPE_KEYS[type]) {
			const bound = rawSpec[key];
			if (bound === undefined || key === "items" || key === "fields" || key === "values") continue;
			if (typeof bound !== "number" || !Number.isFinite(bound)) return `field ${path}.${key} must be finite`;
			if ((key === "minLength" || key === "minItems" || key === "maxItems") && (!Number.isSafeInteger(bound) || bound < 0)) return `field ${path}.${key} must be a non-negative integer`;
			if ((key === "minItems" || key === "maxItems") && bound > CONTRACT_LIMITS.arrayItems) return `field ${path}.${key} cannot exceed ${CONTRACT_LIMITS.arrayItems}`;
		}
		if (typeof rawSpec.min === "number" && typeof rawSpec.max === "number" && rawSpec.min > rawSpec.max) return `field ${path}.min must not exceed max`;
		if (typeof rawSpec.minItems === "number" && typeof rawSpec.maxItems === "number" && rawSpec.minItems > rawSpec.maxItems) return `field ${path}.minItems must not exceed maxItems`;
		if (type === "enum" && (!Array.isArray(rawSpec.values) || rawSpec.values.length === 0 || rawSpec.values.length > CONTRACT_LIMITS.enumValues || !rawSpec.values.every((v) => typeof v === "string"))) return `enum field ${path} needs 1..${CONTRACT_LIMITS.enumValues} string values`;
		if (type === "object") return fieldsError(rawSpec.fields, path, depth + 1);
		if (type === "array") return specError(rawSpec.items, `${path}[]`, depth + 1);
		return undefined;
	};
	const error = fieldsError(raw.fields, "", 1);
	return error ? { ok: false, error } : { ok: true, def: raw as unknown as ContractDef };
}

/** Parse a hot-editable contracts/<name>.contract.json definition. */
export function parseContract(content: string): ContractParse {
	if (content.length > CONTRACT_LIMITS.schemaChars) return { ok: false, error: `contract exceeds ${CONTRACT_LIMITS.schemaChars} characters` };
	let raw: unknown;
	try { raw = JSON.parse(content); }
	catch { return { ok: false, error: "contract is not valid JSON" }; }
	return validateContractDefinition(raw);
}
