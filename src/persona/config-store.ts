/**
 * Per-persona configuration, indexed by persona name and persisted as one JSON
 * file in the global persona folder. Intentionally open-ended: a persona that
 * needs settings gets an entry, others don't. Two personas that share a strategy
 * keep independent configs. Today it carries per-agent model assignments (so an
 * ensemble like magi can run its cores on *different* models); more keys later.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PersonaConfig {
	/** Roster agent name → model id (e.g. "anthropic/claude-opus-4-8"). */
	models?: Record<string, string>;
}

export type PersonaConfigStore = Record<string, PersonaConfig>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPersonaConfigs(file: string): PersonaConfigStore {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!isPlainObject(parsed)) return {};
		const store: PersonaConfigStore = {};
		for (const [name, cfg] of Object.entries(parsed)) {
			if (!isPlainObject(cfg)) continue;
			const entry: PersonaConfig = {};
			if (isPlainObject(cfg.models)) {
				const models: Record<string, string> = {};
				for (const [agent, model] of Object.entries(cfg.models)) {
					if (typeof model === "string") models[agent] = model;
				}
				entry.models = models;
			}
			store[name] = entry;
		}
		return store;
	} catch {
		return {};
	}
}

export function writePersonaConfigs(file: string, store: PersonaConfigStore): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/** The model assignments for a persona (empty object when none configured). */
export function personaModels(store: PersonaConfigStore, persona: string): Record<string, string> {
	return store[persona]?.models ?? {};
}

/** Merge model assignments into a persona's config, returning a new store. */
export function withPersonaModels(
	store: PersonaConfigStore,
	persona: string,
	models: Record<string, string>,
): PersonaConfigStore {
	const prev = store[persona] ?? {};
	return { ...store, [persona]: { ...prev, models: { ...prev.models, ...models } } };
}
