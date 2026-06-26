/**
 * Model reference resolution — turn a loose model name the supervisor typed into a
 * canonical `provider/id` from the registry, or fail with the candidates. Stops a
 * bare name (e.g. "sonnet") from silently resolving to an unauthenticated provider
 * (which would spawn a child that just errors "no API key"). Pure — list injected.
 */

export interface ModelLite {
	provider: string;
	id: string;
}

export type ModelResolution =
	| { ok: true; ref: string }
	| { ok: false; reason: "unknown" | "ambiguous"; candidates: string[] };

const full = (m: ModelLite): string => `${m.provider}/${m.id}`;

export function resolveModelRef(ref: string, models: ModelLite[]): ModelResolution {
	const wanted = ref.trim();
	const all = models.map(full);
	if (all.includes(wanted)) return { ok: true, ref: wanted };

	// Unique exact id (without the provider prefix).
	const byId = models.filter((m) => m.id === wanted);
	if (byId.length === 1) return { ok: true, ref: full(byId[0]!) };
	if (byId.length > 1) return { ok: false, reason: "ambiguous", candidates: byId.map(full) };

	// Unique case-insensitive substring of provider/id.
	const lower = wanted.toLowerCase();
	const sub = [...new Set(models.filter((m) => full(m).toLowerCase().includes(lower)).map(full))];
	if (sub.length === 1) return { ok: true, ref: sub[0]! };
	if (sub.length > 1) return { ok: false, reason: "ambiguous", candidates: sub };

	return { ok: false, reason: "unknown", candidates: all };
}
