/** Public local companion contracts. These describe loaded capabilities and UI activity, not authority. */
export const COMPANION_EVENT = "pi-persona:companion:v1";
export const ACTIVITY_EVENT = "pi-persona:activity:v1";
export const MEMORY_OWNER_EVENT = "pi-persona:memory-owner:v1";
export const MEMORY_OWNER_CHANGED_EVENT = "pi-persona:memory-owner-changed:v1";
export const MEMORY_PERSONA_ENV = "PI_PERSONA_MEMORY_PERSONA";

export interface CompanionMemoryOwner {
	version: 1;
	provider: "pi-persona";
	sessionId: string;
	ready: boolean;
	persona: string | null;
}

/** Spawn-local inheritance only. Absent/invalid is unavailable, never a global-settings fallback. */
export function inheritedMemoryPersona(raw: string | undefined): { persona: string | null } | undefined {
	if (raw === undefined || raw.length > 8_192) return undefined;
	try {
		const value = JSON.parse(raw) as Record<string, unknown> | null;
		if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || Object.keys(value).some((key) => key !== "version" && key !== "persona")) return undefined;
		if (value.persona !== null && (typeof value.persona !== "string" || !value.persona.trim() || value.persona.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(value.persona))) return undefined;
		return { persona: value.persona as string | null };
	} catch { return undefined; }
}

export type CompanionRole = "supervisor" | "leg" | "disabled";
export interface CompanionPresence {
	version: 1;
	provider: "pi-persona";
	role: CompanionRole;
	capabilities: { memory: 1 | false; activity: 1 | false };
}
export interface CompanionActivity {
	version: 1;
	producerId: "pi-persona-mind";
	activityId: string;
	sessionId: string;
	phase: "inspect" | "stage" | "apply";
	state: "running" | "staged" | "done" | "failed";
	target: "project" | "project-long" | "persona" | "shared";
}

export function companionPresence(role: CompanionRole): CompanionPresence {
	return { version: 1, provider: "pi-persona", role, capabilities: { memory: role === "disabled" ? false : 1, activity: role === "supervisor" ? 1 : false } };
}

/** Closed records cannot accidentally export raw memory, model claims, or prompts into the tree. */
export function parseCompanionActivity(value: unknown): CompanionActivity | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) return undefined;
	const allowed = new Set(["version", "producerId", "activityId", "sessionId", "phase", "state", "target"]);
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
	const activity = value as Record<string, unknown>;
	if (activity.version !== 1 || activity.producerId !== "pi-persona-mind") return undefined;
	if (typeof activity.activityId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(activity.activityId)) return undefined;
	if (typeof activity.sessionId !== "string" || activity.sessionId.length < 1 || activity.sessionId.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(activity.sessionId)) return undefined;
	if (activity.phase !== "inspect" && activity.phase !== "stage" && activity.phase !== "apply") return undefined;
	if (activity.state !== "running" && activity.state !== "staged" && activity.state !== "done" && activity.state !== "failed") return undefined;
	if (activity.state === "staged" && activity.phase !== "stage") return undefined;
	if (activity.target !== "project" && activity.target !== "project-long" && activity.target !== "persona" && activity.target !== "shared") return undefined;
	return { version: 1, producerId: "pi-persona-mind", activityId: activity.activityId, sessionId: activity.sessionId, phase: activity.phase, state: activity.state, target: activity.target };
}
