/**
 * Pure per-persona model configuration helpers. Persistence is owned exclusively
 * by settings-store.ts (<agentDir>/persona/settings.json).
 */

export interface PersonaConfig {
	/** Participant key → provider-qualified model id. */
	models?: Record<string, string>;
}

export type PersonaConfigStore = Record<string, PersonaConfig>;

/** The model assignments for a persona (empty object when none configured). */
export function personaModels(store: PersonaConfigStore, persona: string): Record<string, string> {
	return Object.hasOwn(store, persona) ? store[persona]?.models ?? {} : {};
}

/** Merge session model assignments without mutating the owner's saved snapshot. */
export function withPersonaModels(
	store: PersonaConfigStore,
	persona: string,
	models: Record<string, string>,
): PersonaConfigStore {
	const prev = Object.hasOwn(store, persona) ? store[persona] ?? {} : {};
	return { ...store, [persona]: { ...prev, models: { ...prev.models, ...models } } };
}
