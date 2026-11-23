/** Bounded JSON data admission shared by contract definitions and returned values. */
export const CONTRACT_LIMITS = Object.freeze({
	schemaChars: 65_536,
	schemaDepth: 8,
	schemaFields: 256,
	enumValues: 128,
	arrayItems: 1_024,
	valueDepth: 16,
	valueNodes: 10_000,
	valueChars: 1_048_576,
	errors: 32,
	pathSegmentChars: 64,
	failureChars: 2_000,
});

/** Clip model-controlled text so a diagnostic cannot grow with hostile input. */
export function clipContractText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function contractPath(parent: string, key: string): string {
	const segment = clipContractText(key, CONTRACT_LIMITS.pathSegmentChars);
	if (/^[A-Za-z_$][\w$]*$/.test(key)) return parent ? `${parent}.${segment}` : segment;
	// A top-level name has no parent to subscript: quote it instead of `["name"]`.
	return parent ? `${parent}[${JSON.stringify(segment)}]` : JSON.stringify(segment);
}

export function isContractObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Reject non-JSON values, hostile keys and cycles, including in undeclared extra fields.
 * Inspect descriptors before reading values so a programmatic accessor is never executed. */
export function inspectContractData(value: unknown, maxDepth: number, maxChars: number): string | undefined {
	let nodes = 0;
	let chars = 0;
	const ancestors = new Set<object>();
	const visit = (current: unknown, path: string, depth: number): string | undefined => {
		if (++nodes > CONTRACT_LIMITS.valueNodes) return `value exceeds ${CONTRACT_LIMITS.valueNodes} nodes`;
		if (depth > maxDepth) return `${path || "value"} exceeds maximum depth ${maxDepth}`;
		if (typeof current === "string") chars += current.length;
		if (chars > maxChars) return `value exceeds ${maxChars} characters`;
		if (current === null || typeof current === "string" || typeof current === "boolean") return undefined;
		if (typeof current === "number") return Number.isFinite(current) ? undefined : `${path || "value"} must be finite`;
		if (typeof current !== "object") return `${path || "value"} must contain only JSON values`;
		if (ancestors.has(current)) return `${path || "value"} contains a cycle`;
		const array = Array.isArray(current);
		if (!array && !isContractObject(current)) return `${path || "value"} must be a JSON object`;
		if (array && current.length > CONTRACT_LIMITS.arrayItems) return `${path || "value"} exceeds ${CONTRACT_LIMITS.arrayItems} items`;
		const keys = Reflect.ownKeys(current);
		if (keys.length > CONTRACT_LIMITS.valueNodes - nodes + 1) return `value exceeds ${CONTRACT_LIMITS.valueNodes} nodes`;
		ancestors.add(current);
		for (const key of keys) {
			if (array && key === "length") continue;
			if (typeof key !== "string") return `${path || "value"} contains a non-JSON key`;
			const childPath = array ? `${path}[${key}]` : contractPath(path, key);
			if (["__proto__", "constructor", "prototype"].includes(key)) return `${childPath} is a forbidden key`;
			if (array && !/^(0|[1-9]\d*)$/.test(key)) return `${childPath} is not an array index`;
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return `${childPath} must be a JSON data property`;
			chars += key.length;
			const error = visit(descriptor.value, childPath, depth + 1);
			if (error) return error;
		}
		if (array && keys.length !== current.length + 1) return `${path || "value"} must not contain missing array items`;
		ancestors.delete(current);
		return undefined;
	};
	return visit(value, "", 0);
}
