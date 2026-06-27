/**
 * Flows (v0.5) — a declarative DAG over strategies. A `*.flow.json` file names phases,
 * each running a strategy over a roster, wired by `needs` edges. JSON-first (the magi
 * council's ruling): `JSON.parse` + a hand-rolled validator (no new deps), the DAG
 * pinned per run via the contract hasher and journaled for resume. This module is the
 * PURE core — schema, validation, and topological order; the runner (engine + journal
 * injected) lives alongside in `flow-run.ts`.
 */

import { stableHash } from "../core/contract.ts";

export interface FlowPhase {
	id: string;
	strategy: string;
	roster?: string;
	needs?: string[];
	params?: Record<string, unknown>;
}

export interface FlowSpec {
	name: string;
	description?: string;
	phases: FlowPhase[];
}

export type FlowParse = { ok: true; flow: FlowSpec } | { ok: false; error: string };
export type TopoResult = { ok: true; order: string[] } | { ok: false; error: string };

/** The pinned `flow@hash` for a run (I3): a stable sha256 over the spec, so a hot reload
 *  of the file can't change an in-flight run and a resume only matches the same flow. */
export function flowHash(spec: FlowSpec): string {
	return stableHash(spec);
}

function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Kahn's algorithm over `needs` edges → a dependency-respecting order, or a cycle error. */
export function topoOrder(phases: FlowPhase[]): TopoResult {
	const ids = new Set(phases.map((p) => p.id));
	const indeg = new Map<string, number>();
	const dependents = new Map<string, string[]>(); // a phase → the phases that need it
	for (const p of phases) indeg.set(p.id, 0);
	for (const p of phases) {
		for (const n of p.needs ?? []) {
			if (!ids.has(n)) return { ok: false, error: `phase "${p.id}" needs unknown phase "${n}"` };
			indeg.set(p.id, (indeg.get(p.id) ?? 0) + 1);
			dependents.set(n, [...(dependents.get(n) ?? []), p.id]);
		}
	}
	const queue = phases.filter((p) => (indeg.get(p.id) ?? 0) === 0).map((p) => p.id);
	const order: string[] = [];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		order.push(id);
		for (const dep of dependents.get(id) ?? []) {
			const d = (indeg.get(dep) ?? 0) - 1;
			indeg.set(dep, d);
			if (d === 0) queue.push(dep);
		}
	}
	if (order.length !== phases.length) return { ok: false, error: "flow has a cycle" };
	return { ok: true, order };
}

/** Parse + validate a `*.flow.json` into a runnable FlowSpec (or a clear error). */
export function parseFlow(content: string): FlowParse {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		return { ok: false, error: "flow is not valid JSON" };
	}
	if (!isObject(raw)) return { ok: false, error: "flow must be a JSON object" };
	if (typeof raw.name !== "string" || !raw.name.trim()) return { ok: false, error: "flow.name is required" };
	if (!Array.isArray(raw.phases) || raw.phases.length === 0) return { ok: false, error: "flow.phases must be a non-empty array" };

	const phases: FlowPhase[] = [];
	const seen = new Set<string>();
	for (const [i, p] of (raw.phases as unknown[]).entries()) {
		if (!isObject(p)) return { ok: false, error: `phase ${i} must be an object` };
		if (typeof p.id !== "string" || !p.id.trim()) return { ok: false, error: `phase ${i} needs an id` };
		if (seen.has(p.id)) return { ok: false, error: `duplicate phase id "${p.id}"` };
		if (typeof p.strategy !== "string" || !p.strategy.trim()) return { ok: false, error: `phase "${p.id}" needs a strategy` };
		seen.add(p.id);
		const phase: FlowPhase = { id: p.id, strategy: p.strategy };
		if (typeof p.roster === "string" && p.roster.trim()) phase.roster = p.roster;
		if (Array.isArray(p.needs)) {
			if (!p.needs.every((n): n is string => typeof n === "string")) return { ok: false, error: `phase "${p.id}" needs must be strings` };
			phase.needs = p.needs;
		}
		if (isObject(p.params)) phase.params = p.params;
		phases.push(phase);
	}

	const topo = topoOrder(phases);
	if (!topo.ok) return { ok: false, error: topo.error };

	const flow: FlowSpec = { name: raw.name, phases };
	if (typeof raw.description === "string") flow.description = raw.description;
	return { ok: true, flow };
}
