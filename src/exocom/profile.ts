/** Self-reported presence only; these fields carry no identity or authorization. */
export interface ExocomProfile {
	capabilities: readonly string[];
	availability?: "available" | "busy" | "away";
}

const UNSAFE_PROFILE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u206f<>]/g;
const AVAILABILITIES = new Set(["available", "busy", "away"]);

function normalizeCapability(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = Array.from(value.normalize("NFKC").replace(UNSAFE_PROFILE_TEXT, " ").replace(/\s+/g, " ").trim())
		.slice(0, 48).join("");
	return clean || undefined;
}

/** Normalize untrusted registry or tool data into the bounded, display-safe profile contract. */
export function normalizeExocomProfile(value: unknown): ExocomProfile | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const capabilities: string[] = [];
	const seen = new Set<string>();
	if (Array.isArray(input.capabilities)) {
		for (const value of input.capabilities) {
			const capability = normalizeCapability(value);
			if (!capability || seen.has(capability.toLowerCase())) continue;
			seen.add(capability.toLowerCase());
			capabilities.push(capability);
			if (capabilities.length === 8) break;
		}
	}
	const availability = typeof input.availability === "string" && AVAILABILITIES.has(input.availability)
		? input.availability as ExocomProfile["availability"]
		: undefined;
	if (capabilities.length === 0 && availability === undefined) return undefined;
	return {
		capabilities,
		...(availability ? { availability } : {}),
	};
}
