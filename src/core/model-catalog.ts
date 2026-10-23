/** Compact discovery only: version-shaped ids are a display heuristic, not release dates,
 * account entitlement or model quality. Keep the full catalog for queries and exact-pin resolution. */
import type { ModelLite } from "./models.ts";
import { modelCostRank, modelCostTiers, type ModelCostMetadata } from "./model-tier.ts";

interface CatalogEntry {
	model: ModelLite;
	root: string;
	lane: string;
	version: string[];
	snapshot: string | undefined;
}

const textOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const refKey = (model: ModelLite): string => `${model.provider}\0${model.id}`;

function entry(model: ModelLite): CatalogEntry {
	let base = model.id.toLowerCase();
	let snapshot: string | undefined;
	// Snapshot tokens can precede adapter suffixes (e.g. -20250514-v1:0). Dots stay
	// version separators; validate the calendar so arbitrary eight-digit versions survive.
	base = base.replace(/(^|[-_@/:])((?:19|20)\d{2})-?(\d{2})-?(\d{2})(?=$|[-_@/:])/g, (match: string, prefix: string, yearText: string, monthText: string, dayText: string) => {
		const year = Number(yearText);
		const month = Number(monthText);
		const day = Number(dayText);
		const parsed = new Date(Date.UTC(year, month - 1, day));
		if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) {
			const date = `${yearText}${monthText}${dayText}`;
			if (snapshot === undefined || date > snapshot) snapshot = date;
			return prefix;
		}
		return match;
	});
	// Keep quantity tokens such as 8b/70b/128k as distinct lanes; they are not release versions.
	const tokens = base.match(/\d+(?:\.\d+)?[bkmt]\b|[\p{L}]+|\d+(?:[._]\d+)*/gu) ?? [];
	const words = tokens.filter((token) => /\p{L}/u.test(token));
	const version = tokens.filter((token) => !/\p{L}/u.test(token)).flatMap((token) => token.split(/[._]/).map((part) => part.replace(/^0+(?=\d)/, "")));
	return {
		model,
		root: words[0] ?? base,
		lane: words.length > 0 && version.length > 0 ? words.join("-") : `opaque:${base}`,
		version,
		snapshot,
	};
}

/** Descending numeric tuples, without floating-point loss on unusual catalog ids. */
function versionOrder(a: CatalogEntry, b: CatalogEntry): number {
	for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
		const left = a.version[i] ?? "0";
		const right = b.version[i] ?? "0";
		const order = right.length - left.length || textOrder(right, left);
		if (order) return order;
	}
	return 0;
}

function representativeOrder(a: CatalogEntry, b: CatalogEntry): number {
	return versionOrder(a, b)
		|| Number(a.snapshot !== undefined) - Number(b.snapshot !== undefined)
		|| textOrder(b.snapshot ?? "", a.snapshot ?? "")
		|| textOrder(a.model.id, b.model.id);
}

function candidateOrder(a: CatalogEntry, b: CatalogEntry, session?: ModelLite): number {
	const active = session ? refKey(session) : undefined;
	return Number(refKey(a.model) !== active) - Number(refKey(b.model) !== active)
		|| Number(a.model.provider !== session?.provider) - Number(b.model.provider !== session?.provider)
		|| textOrder(a.model.provider, b.model.provider)
		|| textOrder(a.root, b.root)
		|| versionOrder(a, b)
		|| textOrder(a.lane, b.lane)
		|| representativeOrder(a, b);
}

/** Share a truncated provider's slots across roots; names identify groups, not capabilities. */
function rotateRoots(candidates: readonly CatalogEntry[], preferredRoot?: string): CatalogEntry[] {
	const byRoot = new Map<string, CatalogEntry[]>();
	for (const candidate of candidates) {
		const group = byRoot.get(candidate.root) ?? [];
		group.push(candidate);
		byRoot.set(candidate.root, group);
	}
	const groups = [...byRoot.entries()].sort(([a], [b]) =>
		Number(a !== preferredRoot) - Number(b !== preferredRoot) || textOrder(a, b),
	).map(([, group]) => group);
	const rotated: CatalogEntry[] = [];
	for (let row = 0; rotated.length < candidates.length; row++) {
		for (const group of groups) {
			const candidate = group[row];
			if (candidate) rotated.push(candidate);
		}
	}
	return rotated;
}

/** Rank full-catalog search matches without collapsing versions or snapshots. */
export function orderModelCandidates(models: readonly ModelLite[], session?: ModelLite): ModelLite[] {
	const unique = new Map(models.map((model) => [refKey(model), model]));
	return [...unique.values()].map(entry).sort((a, b) => candidateOrder(a, b, session)).map((candidate) => candidate.model);
}

/** One representative per provider/version-line/tier, plus the exact active model even when older.
 * Named tiers remain separate without a table of model releases. Opaque ids retain lexical order;
 * within a textual root, numeric generations precede older generations across all its lanes.
 * Only a provider that exceeds its remaining slots rotates roots, with the active root first. */
export function shortlistModels(models: readonly ModelLite[], session?: ModelLite, max = 40): ModelLite[] {
	const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 40;
	if (limit === 0) return [];
	const unique = new Map(models.map((model) => [refKey(model), model]));
	const active = session ? unique.get(refKey(session)) : undefined;
	const representatives = new Map<string, CatalogEntry>();
	for (const model of unique.values()) {
		const candidate = entry(model);
		const key = `${model.provider}\0${candidate.lane}`;
		const previous = representatives.get(key);
		if (!previous || representativeOrder(candidate, previous) < 0) representatives.set(key, candidate);
	}
	const ordered = [...representatives.values()].sort((a, b) => candidateOrder(a, b, session));
	const byProvider = new Map<string, CatalogEntry[]>();
	for (const candidate of ordered) {
		if (active && refKey(candidate.model) === refKey(active)) continue;
		const group = byProvider.get(candidate.model.provider) ?? [];
		group.push(candidate);
		byProvider.set(candidate.model.provider, group);
	}
	const selected = active ? [active] : [];
	for (const [provider, candidates] of byProvider) {
		const remaining = limit - selected.length;
		if (remaining === 0) break;
		const balanced = candidates.length > remaining
			? rotateRoots(candidates, provider === active?.provider ? entry(active).root : undefined)
			: candidates;
		selected.push(...balanced.slice(0, remaining).map((candidate) => candidate.model));
	}
	return selected;
}

/** Recommendation families use the model name after a namespace, unlike rotation's vendor root.
 * Dots before letters delimit namespace segments; numeric version dots stay in the model name. */
function recommendationGroup(model: ModelLite): { family: string; major: string | undefined } {
	const id = model.id.toLowerCase();
	let nameStart = 0;
	for (const separator of id.matchAll(/\/|\.(?=\p{L})/gu)) nameStart = separator.index + 1;
	const name = entry({ provider: model.provider, id: id.slice(nameStart) });
	return { family: `${id.slice(0, nameStart)}\0${name.root}`, major: name.version[0] };
}

/** Advisory neighbors of the current model; full queries and exact pins use the full catalog. */
export function recommendModels(models: readonly ModelCostMetadata[], session?: ModelLite, max = 40): ModelCostMetadata[] {
	if (!session) return shortlistModels(models, undefined, max);
	const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 40;
	if (limit === 0) return [];
	const anchor = recommendationGroup(session);
	const neighbors = models.filter((model) => {
		if (model.provider !== session.provider) return false;
		const candidate = recommendationGroup(model);
		return candidate.family === anchor.family && (anchor.major === undefined || candidate.major === anchor.major);
	});
	// Filter before latest-per-lane selection: a newer generation must not erase a neighbor
	// of an older working supervisor. Price bands keep the full uncapped provider reference.
	const selected = shortlistModels(neighbors, session, Number.MAX_SAFE_INTEGER).map(entry);
	const tiers = modelCostTiers(models, shortlistModels(models, undefined, Number.MAX_SAFE_INTEGER));
	const active = refKey(session);
	selected.sort((a, b) =>
		Number(refKey(a.model) !== active) - Number(refKey(b.model) !== active)
		|| modelCostRank(tiers.get(`${a.model.provider}/${a.model.id}`)) - modelCostRank(tiers.get(`${b.model.provider}/${b.model.id}`))
		|| candidateOrder(a, b, session),
	);
	return selected.slice(0, limit).map((candidate) => candidate.model);
}
