/** Compact discovery only: version-shaped ids are a display heuristic, not release dates,
 * account entitlement or model quality. Keep the full catalog for queries and exact-pin resolution. */
import type { ModelLite } from "./models.ts";

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
	const date = /[-_@]((?:19|20)\d{2})-?(\d{2})-?(\d{2})$/.exec(base);
	if (date) {
		const year = Number(date[1]);
		const month = Number(date[2]);
		const day = Number(date[3]);
		const parsed = new Date(Date.UTC(year, month - 1, day));
		if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) {
			snapshot = `${date[1]}${date[2]}${date[3]}`;
			base = base.slice(0, date.index);
		}
	}
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

/** Rank full-catalog search matches without collapsing versions or snapshots. */
export function orderModelCandidates(models: readonly ModelLite[], session?: ModelLite): ModelLite[] {
	const unique = new Map(models.map((model) => [refKey(model), model]));
	return [...unique.values()].map(entry).sort((a, b) => candidateOrder(a, b, session)).map((candidate) => candidate.model);
}

/** One representative per provider/version-line/tier, plus the exact active model even when older.
 * Named tiers remain separate without a table of model releases. Opaque ids retain lexical order;
 * within a textual root, numeric generations precede older generations across all its lanes. */
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
	return [...(active ? [active] : []), ...ordered.filter((candidate) => !active || refKey(candidate.model) !== refKey(active)).map((candidate) => candidate.model)].slice(0, limit);
}
