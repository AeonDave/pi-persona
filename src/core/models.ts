/**
 * Model reference resolution — turn a loose model name the supervisor typed into a
 * canonical `provider/id` from the registry, or fail with the candidates. Stops a
 * bare name (e.g. "sonnet") from silently resolving to an unauthenticated provider
 * (which would spawn a child that just errors "no API key").
 *
 * The same model name often exists under several providers (anthropic, bedrock×N,
 * openrouter, copilot…). When a name is ambiguous we prefer the **loader/session
 * provider** — the supervisor's own provider, which is the one actually authenticated
 * — so "sonnet" resolves to e.g. `claude-pro-max-native/claude-sonnet-4-6`, not a
 * Bedrock look-alike. Pure — list + preferred provider injected.
 */

export interface ModelLite {
	provider: string;
	id: string;
}

export type ModelResolution =
	| { ok: true; ref: string }
	| { ok: false; reason: "unknown" | "ambiguous"; candidates: string[] };

const full = (m: ModelLite): string => `${m.provider}/${m.id}`;

function dedupe(models: ModelLite[]): ModelLite[] {
	const seen = new Set<string>();
	const out: ModelLite[] = [];
	for (const m of models) {
		const key = full(m);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(m);
		}
	}
	return out;
}

export function resolveModelRef(ref: string, models: ModelLite[], preferProvider?: string): ModelResolution {
	const wanted = ref.trim();
	const all = models.map(full);
	if (all.includes(wanted)) return { ok: true, ref: wanted };

	// Candidate set: a unique exact id (no provider), else a case-insensitive substring.
	const byId = models.filter((m) => m.id === wanted);
	const lower = wanted.toLowerCase();
	const candidates = dedupe(byId.length > 0 ? byId : models.filter((m) => full(m).toLowerCase().includes(lower)));

	if (candidates.length === 0) return { ok: false, reason: "unknown", candidates: all };
	if (candidates.length === 1) return { ok: true, ref: full(candidates[0]!) };

	// Ambiguous → prefer the loader/session provider (the authenticated one).
	if (preferProvider) {
		const preferred = candidates.filter((m) => m.provider === preferProvider);
		if (preferred.length === 1) return { ok: true, ref: full(preferred[0]!) };
		if (preferred.length > 1) return { ok: false, reason: "ambiguous", candidates: preferred.map(full) };
	}

	// Still ambiguous — list the preferred provider's matches first (helps the retry).
	const ordered = preferProvider
		? [
				...candidates.filter((m) => m.provider === preferProvider),
				...candidates.filter((m) => m.provider !== preferProvider),
			]
		: candidates;
	return { ok: false, reason: "ambiguous", candidates: ordered.map(full) };
}
