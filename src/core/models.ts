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

/** A model-family routing rule. Rules are data so deployments can extend the paid-provider
 * boundary without coupling it to a persona or to one concrete model release. Prefix matching is
 * case-insensitive and applies to the model id after the provider slash. */
export interface ModelRoutingRule {
	idPrefixes: readonly string[];
	allowedProviders: readonly string[];
}

export interface ModelRoutingPolicy {
	rules: readonly ModelRoutingRule[];
}

/**
 * Safe defaults for paid model families. OpenCode/OpenRouter remain usable for model families
 * without a rule, but a Claude model may only route through claude-pro-max-native and an OpenAI
 * family model may only route through the first-party OpenAI providers. Keep this table at the
 * family/provider boundary: model ids are versioned and must not be allowlisted one by one.
 */
export const DEFAULT_MODEL_ROUTING_POLICY: ModelRoutingPolicy = {
	rules: [
		{ idPrefixes: ["claude-"], allowedProviders: ["claude-pro-max-native"] },
		{ idPrefixes: ["gpt-", "chatgpt-", "o1", "o3", "o4"], allowedProviders: ["openai", "openai-codex"] },
	],
};

export type ModelResolution =
	| { ok: true; ref: string }
	| { ok: false; reason: "unknown" | "ambiguous" | "blocked"; candidates: string[] };

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

function routingRule(id: string, policy: ModelRoutingPolicy): ModelRoutingRule | undefined {
	const lower = id.toLowerCase();
	return policy.rules.find((rule) => rule.idPrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase())));
}

function providerAllowed(provider: string, allowedProviders: readonly string[] | undefined): boolean {
	return allowedProviders === undefined || allowedProviders.some((allowed) => allowed.toLowerCase() === provider.toLowerCase());
}

/** Providers permitted for a model family, or undefined when the policy leaves that family open. */
export function allowedModelProviders(id: string, policy?: ModelRoutingPolicy): readonly string[] | undefined {
	return policy ? routingRule(id, policy)?.allowedProviders : undefined;
}

export function isModelProviderAllowed(model: ModelLite, policy?: ModelRoutingPolicy): boolean {
	return providerAllowed(model.provider, allowedModelProviders(model.id, policy));
}

/** Compare two numeric version tuples ([4,6] vs [4,5]); >0 when `a` is newer. */
function compareVersion(a: number[], b: number[]): number {
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * When EVERY candidate is the same model line differing only by a trailing numeric version
 * (`claude-sonnet-4-6` vs `-4-5` vs `-4`), the newest is the natural pick — a loose family
 * name ("sonnet") shouldn't force a `models` lookup just to choose between versions. Returns
 * the newest `provider/id`, or `undefined` when the candidates are NOT one clean version line
 * (different families/prefixes, or a non-versioned id) — those stay genuinely ambiguous.
 * Provider-agnostic: the caller passes an already single-provider set.
 */
function newestOfVersionLine(candidates: ModelLite[]): string | undefined {
	const parsed: Array<{ ref: string; prefix: string; version: number[] }> = [];
	for (const m of candidates) {
		const match = /^(.*?)-(\d+(?:-\d+)*)$/.exec(m.id);
		if (!match || match[1] === undefined || match[2] === undefined) return undefined; // non-versioned → not a clean line
		parsed.push({ ref: full(m), prefix: match[1], version: match[2].split("-").map(Number) });
	}
	if (parsed.length === 0) return undefined;
	const prefixes = new Set(parsed.map((p) => p.prefix));
	if (prefixes.size !== 1) return undefined; // distinct model lines → genuinely ambiguous
	let best = parsed[0]!;
	for (const p of parsed.slice(1)) if (compareVersion(p.version, best.version) > 0) best = p;
	return best.ref;
}

export function resolveModelRef(
	ref: string,
	models: ModelLite[],
	preferProvider?: string,
	policy?: ModelRoutingPolicy,
): ModelResolution {
	const wanted = ref.trim();
	const all = models.map(full);
	const exact = models.find((m) => full(m) === wanted);
	// An exact provider-qualified pin is an explicit user choice. Never rewrite or reject it
	// because the current routing policy is intended only for loose automatic selection.
	if (exact) return { ok: true, ref: wanted };

	// Candidate set: a unique exact id (no provider), else a case-insensitive substring.
	const byId = models.filter((m) => m.id === wanted);
	const lower = wanted.toLowerCase();
	const rawCandidates = dedupe(byId.length > 0 ? byId : models.filter((m) => full(m).toLowerCase().includes(lower)));
	const candidates = policy ? rawCandidates.filter((m) => isModelProviderAllowed(m, policy)) : rawCandidates;
	if (policy) {
		const allCandidatesArePolicyBlocked = rawCandidates.length > 0 && rawCandidates.every((m) => allowedModelProviders(m.id, policy) !== undefined && !isModelProviderAllowed(m, policy));
		if (allCandidatesArePolicyBlocked) return { ok: false, reason: "blocked", candidates: rawCandidates.map(full) };
	}

	if (candidates.length === 0) return { ok: false, reason: "unknown", candidates: all };
	if (candidates.length === 1) return { ok: true, ref: full(candidates[0]!) };

	// Ambiguous → prefer the loader/session provider (the authenticated one).
	if (preferProvider) {
		const preferred = candidates.filter((m) => m.provider === preferProvider);
		if (preferred.length === 1) return { ok: true, ref: full(preferred[0]!) };
		if (preferred.length > 1) {
			// All on the authenticated provider: if they're one model line differing only by
			// version, take the newest instead of stranding the caller with a `models` lookup.
			const newest = newestOfVersionLine(preferred);
			if (newest) return { ok: true, ref: newest };
			return { ok: false, reason: "ambiguous", candidates: preferred.map(full) };
		}
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

/**
 * The provider-fallback chain for a `provider/id` that failed at runtime: the SAME model
 * id offered by OTHER (authenticated) providers, so an unpinned run can be retried by switching
 * the route while keeping the model. Preferred provider first (most likely authenticated), the
 * failed `ref` excluded. An optional routing policy filters automatic alternatives; exact pins
 * are enforced by the fallback decorator, not this pure helper. Empty when no alternate survives.
 */
export function providerFallbacks(
	ref: string,
	models: ModelLite[],
	preferProvider?: string,
	policy?: ModelRoutingPolicy,
): string[] {
	const slash = ref.indexOf("/");
	const id = slash > 0 ? ref.slice(slash + 1) : ref;
	const alts = dedupe(models.filter((m) => m.id === id && full(m) !== ref && isModelProviderAllowed(m, policy)));
	const ordered = preferProvider
		? [...alts.filter((m) => m.provider === preferProvider), ...alts.filter((m) => m.provider !== preferProvider)]
		: alts;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of ordered) {
		const r = full(m);
		if (!seen.has(r)) {
			seen.add(r);
			out.push(r);
		}
	}
	return out;
}
