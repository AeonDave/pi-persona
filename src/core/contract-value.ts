/** Recursive returned-value validation for the single contract schema language. */
import { CONTRACT_LIMITS, contractPath, inspectContractData, isContractObject } from "./contract-data.ts";
import type { ContractDef, FieldSpec } from "./contract-schema.ts";

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	/** The validated object (present only when ok). Ordinary extra fields are retained. */
	value?: Record<string, unknown>;
}

/** Definition admission is owned by contract.ts; this checks data against that definition. */
export function validateContractValue(def: ContractDef, value: unknown): ValidationResult {
	if (!isContractObject(value)) return { ok: false, errors: ["expected a JSON object"] };
	const unsafe = inspectContractData(value, CONTRACT_LIMITS.valueDepth, CONTRACT_LIMITS.valueChars);
	if (unsafe) return { ok: false, errors: [unsafe] };
	const errors: string[] = [];
	const fields = (specs: Record<string, FieldSpec>, obj: Record<string, unknown>, path: string): void => {
		for (const [name, spec] of Object.entries(specs)) {
			if (errors.length >= CONTRACT_LIMITS.errors) return;
			const fieldPath = contractPath(path, name);
			const current = Object.hasOwn(obj, name) ? obj[name] : undefined;
			if (current === undefined || current === null) {
				if (spec.required) errors.push(`missing required field: ${fieldPath}`);
			} else field(spec, current, fieldPath);
		}
	};
	const field = (spec: FieldSpec, current: unknown, path: string): void => {
		const error = (message: string): void => { if (errors.length < CONTRACT_LIMITS.errors) errors.push(`field ${path} ${message}`); };
		switch (spec.type) {
			case "string":
				if (typeof current !== "string") error("must be a string");
				else if (spec.minLength !== undefined && current.length < spec.minLength) error(`must be at least ${spec.minLength} characters`);
				break;
			case "number":
			case "integer":
				if (typeof current !== "number" || (spec.type === "integer" && !Number.isSafeInteger(current))) error(`must be ${spec.type === "integer" ? "an integer" : "a number"}`);
				else {
					if (spec.min !== undefined && current < spec.min) error(`must be >= ${spec.min}`);
					if (spec.max !== undefined && current > spec.max) error(`must be <= ${spec.max}`);
				}
				break;
			case "boolean": if (typeof current !== "boolean") error("must be a boolean"); break;
			case "enum": if (typeof current !== "string" || !spec.values?.includes(current)) error(`must be one of: ${spec.values?.join(", ")}`); break;
			case "object":
				if (!isContractObject(current)) error("must be an object");
				else fields(spec.fields!, current, path);
				break;
			case "array":
				if (!Array.isArray(current)) { error("must be an array"); break; }
				if (spec.minItems !== undefined && current.length < spec.minItems) error(`must contain at least ${spec.minItems} items`);
				if (spec.maxItems !== undefined && current.length > spec.maxItems) error(`must contain at most ${spec.maxItems} items`);
				for (let i = 0; i < current.length && errors.length < CONTRACT_LIMITS.errors; i++) field(spec.items!, current[i], `${path}[${i}]`);
				break;
		}
	};
	fields(def.fields, value, "");
	return errors.length === 0 ? { ok: true, errors, value } : { ok: false, errors };
}
