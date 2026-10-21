/** Public, persistable pi-persona preferences and their resolved runtime config. */

import { isThinkingLevel } from "./types.ts";
import { resolveConfig, type PiPersonaConfig } from "./config.ts";

export type CompanionId = "mind" | "flow";

/** Preferences contributed by the optional companion extensions to the shared settings panel. */
export interface CompanionPreferenceValues {
	mindCapture: "auto" | "prompt" | "off";
	mindNudge: boolean;
	flowEnabled: boolean;
	flowPort: number;
	flowIdleMs: number;
}

export type PersonaPreferences = Partial<Omit<PiPersonaConfig, "disabled" | "stateFile"> & CompanionPreferenceValues>;
export type SettingId = keyof PersonaPreferences;
export type SettingKind = "boolean" | "number" | "string" | "string-list" | "choice";

export interface PersonaSetting {
	readonly id: SettingId;
	readonly group: string;
	readonly label: string;
	readonly description: string;
	readonly kind: SettingKind;
	readonly choices?: readonly string[];
	readonly env?: string;
	readonly applyWhen: string;
	readonly owner?: CompanionId;
	readonly min?: number;
	readonly max?: number;
}

const APPLY_WHEN = "next Pi restart or native extension reload";
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The one registry used by settings UI, validation, and environment precedence. */
export const PERSONA_SETTINGS: readonly PersonaSetting[] = [
	{ id: "extraDirs", group: "Discovery", label: "Extra persona directories", description: "Additional directories searched for persona and agent definitions.", kind: "string-list", env: "PI_PERSONA_DIRS", applyWhen: APPLY_WHEN },
	{ id: "defaultPersona", group: "Startup", label: "Default persona", description: "Persona selected unless --persona is explicit; takes precedence over the remembered persona.", kind: "string", env: "PI_PERSONA_DEFAULT", applyWhen: APPLY_WHEN },
	{ id: "keybinding", group: "Interface", label: "Persona cycle key", description: "Key used to cycle through installed personas.", kind: "string", env: "PI_PERSONA_KEY", applyWhen: APPLY_WHEN },
	{ id: "persist", group: "Startup", label: "Remember last persona", description: "Restore the last explicitly selected persona in a later session.", kind: "boolean", env: "PI_PERSONA_PERSIST", applyWhen: APPLY_WHEN },
	{ id: "delegateDefaultAllow", group: "Delegation", label: "Allow delegation by default", description: "Fallback for delegate targets when the persona declares neither an allow nor a deny list; explicit rules take precedence.", kind: "boolean", env: "PI_PERSONA_DELEGATE_DEFAULT", applyWhen: APPLY_WHEN },
	{ id: "seed", group: "Discovery", label: "Install bundled defaults on first run", description: "Opt in to installing bundled personas and agents once.", kind: "boolean", env: "PI_PERSONA_SEED", applyWhen: APPLY_WHEN },
	{ id: "childThinking", group: "Delegation", label: "Delegated thinking level", description: "Thinking level forced on delegated child agents.", kind: "choice", choices: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], env: "PI_PERSONA_CHILD_THINKING", applyWhen: APPLY_WHEN },
	{ id: "engine", group: "Delegation", label: "Sub-agent engine", description: "Run sub-agents in-process or as child Pi processes.", kind: "choice", choices: ["inproc", "child"], env: "PI_PERSONA_ENGINE", applyWhen: APPLY_WHEN },
	{ id: "peekEveryMs", group: "Delegation", label: "Progress and stall check interval", description: "Milliseconds between async progress/stall checks; zero disables checks.", kind: "number", env: "PI_PERSONA_PEEK_MS", applyWhen: APPLY_WHEN, min: 0, max: MAX_TIMER_DELAY_MS },
	{ id: "checkInEveryMs", group: "Delegation", label: "Progress check-in interval", description: "Milliseconds between operator-only progress entries; zero disables check-ins.", kind: "number", env: "PI_PERSONA_CHECKIN_MS", applyWhen: APPLY_WHEN, min: 0, max: MAX_TIMER_DELAY_MS },
	{ id: "agentHardTimeoutMs", group: "Delegation", label: "Agent hard timeout", description: "Opt-in wall-clock limit in milliseconds for one agent run; zero means unlimited.", kind: "number", env: "PI_PERSONA_AGENT_MAX_MS", applyWhen: APPLY_WHEN, min: 0, max: MAX_TIMER_DELAY_MS },
	{ id: "agentStartupTimeoutMs", group: "Delegation", label: "Agent startup deadline", description: "Milliseconds allowed without first progress while an agent starts; zero disables the deadline.", kind: "number", env: "PI_PERSONA_AGENT_STARTUP_MS", applyWhen: APPLY_WHEN, min: 0, max: MAX_TIMER_DELAY_MS },
	{ id: "nudge", group: "Delegation", label: "Delegation nudges", description: "Delegation and persistence checkpoints, plus the repeated peek/result and long-sleep guards; disabling turns all of them off.", kind: "boolean", env: "PI_PERSONA_NUDGE", applyWhen: APPLY_WHEN },
	{ id: "broker", group: "Collaboration", label: "Cross-process communication broker", description: "Connect child-engine agents to supervisor messaging and steering.", kind: "boolean", env: "PI_PERSONA_BROKER", applyWhen: APPLY_WHEN },
	{ id: "exocom", group: "Collaboration", label: "External agent communication", description: "Enable communication between independent top-level Pi instances.", kind: "boolean", env: "PI_PERSONA_EXOCOM", applyWhen: APPLY_WHEN },
	{ id: "asyncRetain", group: "Delegation", label: "Retained async results", description: "Number of settled async runs retained for later collection.", kind: "number", env: "PI_PERSONA_ASYNC_RETAIN", applyWhen: APPLY_WHEN, min: 1, max: MAX_SAFE_INTEGER },
	{ id: "ledgerV2", group: "Delegation", label: "Expanded retry-loop identity", description: "Include role, tools, and isolation in the repeated-delegation guard key.", kind: "boolean", env: "PI_PERSONA_LEDGER_V2", applyWhen: APPLY_WHEN },
	{ id: "spine", group: "Prompt", label: "Supervisor spine", description: "Shared prompt layer for the supervisor: off, on for the bundled layer, or a file path.", kind: "string", env: "PI_PERSONA_SPINE", applyWhen: APPLY_WHEN },
	{ id: "spineLegs", group: "Prompt", label: "Delegated-leg spine", description: "Prompt layer for delegated agents; follows the supervisor selection unless set separately.", kind: "string", env: "PI_PERSONA_SPINE_LEGS", applyWhen: APPLY_WHEN },
	{ id: "changeReport", group: "Delegation", label: "Report files changed by agents", description: "Include a git-based changed-files report for non-worktree agent runs.", kind: "boolean", env: "PI_PERSONA_LEG_CHANGE_REPORT", applyWhen: APPLY_WHEN },
	{ id: "mindCapture", group: "Mind", label: "Memory capture mode", description: "Capture explicit user requests (auto), suggest only (prompt), or disable cue detection (off). The memory tool remains available.", kind: "choice", choices: ["auto", "prompt", "off"], env: "PI_PERSONA_MIND_CAPTURE", owner: "mind", applyWhen: "next Pi restart or native extension reload" },
	{ id: "mindNudge", group: "Mind", label: "Mind suggestions", description: "Optional memory/backlog suggestions, not explicit user capture. Only the exact environment value off disables them.", kind: "boolean", env: "PI_PERSONA_MIND_NUDGE", owner: "mind", applyWhen: "next Pi restart or native extension reload" },
	{ id: "flowEnabled", group: "Flow", label: "Attach Flow by default", description: "Enable this Pi's default dashboard attachment. --no-flow opts out for one run; other Pi sessions keep their shared service.", kind: "boolean", owner: "flow", applyWhen: "next Pi restart or native extension reload" },
	{ id: "flowPort", group: "Flow", label: "Flow shared-service port", description: "Desired loopback port; 0 asks the operating system for an available port. Invalid extension environment values fall back to 7874.", kind: "number", env: "PI_PERSONA_FLOW_PORT", owner: "flow", applyWhen: "next shared-service start after Pi restart or native extension reload; an existing service is unchanged", min: 0, max: 65_535 },
	{ id: "flowIdleMs", group: "Flow", label: "Flow idle grace (advanced)", description: "Milliseconds with no Pi registrations and no browser SSE clients before service shutdown (50–60000). Invalid environment values use 60000 with a Flow warning.", kind: "number", env: "PI_PERSONA_FLOW_IDLE_MS", owner: "flow", applyWhen: "next shared-service start after Pi restart or native extension reload; an existing service is unchanged", min: 50, max: 60_000 },
];

const SETTING_BY_ID = new Map<SettingId, PersonaSetting>(PERSONA_SETTINGS.map((setting) => [setting.id, setting]));

function hasExplicitEnvOverride(setting: PersonaSetting, env: Record<string, string | undefined>): boolean {
	if (!setting.env) return false;
	const value = env[setting.env];
	if (value === undefined) return false;
	// The existing resolver deliberately treats an empty legs selector as "follow spine".
	return setting.id === "spineLegs" && value.trim() === "" ? false : true;
}

/**
 * Whether a defined environment key pins a setting using the existing resolver semantics.
 * Even a value the resolver normalizes/rejects still pins its resulting default; the one
 * deliberate exception is blank PI_PERSONA_SPINE_LEGS, which means "follow spine".
 */
export function settingHasEnvironmentOverride(
	setting: PersonaSetting | SettingId,
	env: Record<string, string | undefined>,
): boolean {
	const definition = typeof setting === "string" ? SETTING_BY_ID.get(setting) : setting;
	return definition ? hasExplicitEnvOverride(definition, env) : false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function validateValue(setting: PersonaSetting, value: unknown): unknown {
	switch (setting.kind) {
		case "boolean":
			if (typeof value !== "boolean") throw new Error(`invalid preference ${setting.id}: expected a boolean`);
			return value;
		case "number":
			if (typeof value !== "number" || !Number.isSafeInteger(value)) {
				throw new Error(`invalid preference ${setting.id}: expected a safe integer`);
			}
			if (setting.min !== undefined && value < setting.min) throw new Error(`invalid preference ${setting.id}: must be at least ${setting.min}`);
			if (setting.max !== undefined && value > setting.max) throw new Error(`invalid preference ${setting.id}: must be at most ${setting.max}`);
			return value;
		case "string":
			if (typeof value !== "string") throw new Error(`invalid preference ${setting.id}: expected a string`);
			if (setting.id === "defaultPersona" || setting.id === "keybinding") {
				const normalized = value.trim();
				if (!normalized) throw new Error(`invalid preference ${setting.id}: value must not be blank`);
				return normalized;
			}
			return value;
		case "string-list":
			if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
				throw new Error(`invalid preference ${setting.id}: expected a list of strings`);
			}
			return [...value];
		case "choice":
			if (typeof value !== "string" || !setting.choices?.includes(value)) {
				throw new Error(`invalid preference ${setting.id}: expected one of ${setting.choices?.join(", ") ?? "the listed choices"}`);
			}
			if (setting.id === "childThinking" && !isThinkingLevel(value)) {
				throw new Error(`invalid preference ${setting.id}: unsupported thinking level`);
			}
			return value;
	}
}

/** Validate JSON-sourced preferences strictly. Unknown keys are rejected so a typo cannot hide. */
export function validatePreferences(value: unknown): PersonaPreferences {
	if (!isPlainObject(value)) throw new Error("invalid persona preferences: expected an object");
	const preferences: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!SETTING_BY_ID.has(key as SettingId)) {
			throw new Error(`unknown persona preference: ${key}`);
		}
		const setting = SETTING_BY_ID.get(key as SettingId);
		if (!setting) throw new Error(`unknown persona preference: ${key}`);
		Object.defineProperty(preferences, key, {
			value: validateValue(setting, item), enumerable: true, configurable: true, writable: true,
		});
	}
	return preferences as PersonaPreferences;
}

/** Resolve startup settings: environment values remain explicit overrides over saved preferences. */
export function resolvePersonaConfig(
	preferences: PersonaPreferences,
	env: Record<string, string | undefined>,
): PiPersonaConfig {
	const saved = validatePreferences(preferences);
	const config = resolveConfig(env);
	for (const setting of PERSONA_SETTINGS) {
		if (setting.owner !== undefined) continue;
		if (settingHasEnvironmentOverride(setting, env)) continue;
		if (!Object.hasOwn(saved, setting.id)) continue;
		const value = saved[setting.id];
		if (value === undefined) continue;
		if (setting.id === "spine") {
			if (typeof value !== "string") throw new Error("invalid saved spine preference");
			config.spine = resolveConfig({ PI_PERSONA_SPINE: value }).spine;
		} else if (setting.id === "spineLegs") {
			if (typeof value !== "string") throw new Error("invalid saved spineLegs preference");
			config.spineLegs = resolveConfig({ PI_PERSONA_SPINE_LEGS: value }).spineLegs;
		} else {
			Object.assign(config, { [setting.id]: Array.isArray(value) ? [...value] : value });
		}
	}
	const savedSpine = Object.hasOwn(saved, "spine") && env.PI_PERSONA_SPINE === undefined;
	const savedLegs = Object.hasOwn(saved, "spineLegs") && !settingHasEnvironmentOverride("spineLegs", env);
	const envLegsFollow = env.PI_PERSONA_SPINE_LEGS === undefined || env.PI_PERSONA_SPINE_LEGS.trim() === "";
	if (savedSpine && !savedLegs && envLegsFollow) config.spineLegs = config.spine;
	return config;
}

function resolveMindCapture(value: string | undefined): CompanionPreferenceValues["mindCapture"] {
	const normalized = value?.trim().toLowerCase();
	return normalized === "prompt" || normalized === "off" ? normalized : "auto";
}

function resolveFlowPort(value: string | undefined): number {
	if (value === undefined || !/^\d+$/.test(value)) return 7874;
	const port = Number(value);
	return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : 7874;
}

function resolveFlowIdleMs(value: string | undefined): number {
	if (value === undefined || !/^\d+$/.test(value)) return 60_000;
	const idleMs = Number(value);
	return Number.isSafeInteger(idleMs) && idleMs >= 50 && idleMs <= 60_000 ? idleMs : 60_000;
}

/** Resolve pi-persona config plus companion previews using the companions' current env grammar. */
export function resolveSettingsValues(
	preferences: PersonaPreferences,
	env: Record<string, string | undefined>,
): PiPersonaConfig & CompanionPreferenceValues {
	const saved = validatePreferences(preferences);
	const config = resolvePersonaConfig(saved, env);
	const values: CompanionPreferenceValues = {
		mindCapture: resolveMindCapture(env.PI_PERSONA_MIND_CAPTURE),
		mindNudge: env.PI_PERSONA_MIND_NUDGE !== "off",
		flowEnabled: true,
		flowPort: resolveFlowPort(env.PI_PERSONA_FLOW_PORT),
		flowIdleMs: resolveFlowIdleMs(env.PI_PERSONA_FLOW_IDLE_MS),
	};
	for (const setting of PERSONA_SETTINGS) {
		if (setting.owner === undefined || settingHasEnvironmentOverride(setting, env)) continue;
		if (!Object.hasOwn(saved, setting.id)) continue;
		const value = saved[setting.id];
		if (value !== undefined) Object.assign(values, { [setting.id]: Array.isArray(value) ? [...value] : value });
	}
	return { ...config, ...values };
}

/** Parse the text field used by a settings editor according to registry metadata. */
export function parseSettingInput(setting: PersonaSetting, text: string): unknown {
	switch (setting.kind) {
		case "boolean": {
			const value = text.trim().toLowerCase();
			if (["true", "on", "yes", "1"].includes(value)) return true;
			if (["false", "off", "no", "0"].includes(value)) return false;
			throw new Error(`invalid ${setting.id}: enter true or false`);
		}
		case "number": {
			const trimmed = text.trim();
			if (!trimmed) throw new Error(`invalid ${setting.id}: enter a number`);
			const value = Number(trimmed);
			return validateValue(setting, value);
		}
		case "string":
			return validateValue(setting, text);
		case "string-list":
			if (text.trimStart().startsWith("[")) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(text) as unknown;
				} catch {
					throw new Error(`invalid ${setting.id}: expected a JSON string array or one item per line`);
				}
				return validateValue(setting, parsed);
			}
			return validateValue(setting, text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
		case "choice":
			return validateValue(setting, text.trim());
	}
}
