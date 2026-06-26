/**
 * pi-persona configuration resolved from environment variables.
 *
 * Pure module — takes an injected env record so it is fully testable. The
 * canonical PI_PERSONA_* names are defined here once.
 */

import { isThinkingLevel } from "./types.ts";

export interface PiPersonaConfig {
	disabled: boolean;
	extraDirs: string[];
	defaultPersona?: string;
	keybinding: string;
	persist: boolean;
	delegateDefaultAllow: boolean;
	seed: boolean;
	/** Explicit override for the persisted-state file (else a global default). */
	stateFile?: string;
	/** Thinking level forced on delegated children (else the supervisor's level).
	 *  Spawned children must carry an *explicit* level or they fall into the model's
	 *  default mode ("adaptive"), which some models reject. */
	childThinking?: string;
}

type Env = Record<string, string | undefined>;

function splitDirs(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/[;,]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function resolveConfig(env: Env): PiPersonaConfig {
	const disableFlag = env.PI_PERSONA_DISABLE;
	const def = env.PI_PERSONA_DEFAULT?.trim();

	const config: PiPersonaConfig = {
		disabled: disableFlag !== undefined && disableFlag.length > 0,
		extraDirs: splitDirs(env.PI_PERSONA_DIRS),
		keybinding: env.PI_PERSONA_KEY?.trim() || "f8",
		persist: env.PI_PERSONA_PERSIST?.trim().toLowerCase() !== "off",
		delegateDefaultAllow: env.PI_PERSONA_DELEGATE_DEFAULT?.trim().toLowerCase() !== "deny",
		seed: env.PI_PERSONA_SEED?.trim().toLowerCase() !== "off",
	};
	if (def) config.defaultPersona = def;
	const stateFile = env.PI_PERSONA_STATE_FILE?.trim();
	if (stateFile) config.stateFile = stateFile;
	const childThinking = env.PI_PERSONA_CHILD_THINKING?.trim().toLowerCase();
	if (childThinking && isThinkingLevel(childThinking)) config.childThinking = childThinking;
	return config;
}
