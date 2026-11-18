/** Per-leg effort selection. Pi alone owns model-capability clamping. Pure, no host imports. */
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "./types.ts";

/** Resolve the configured child default against the supervisor's concrete effort. */
export function defaultChildThinking(configured: string | undefined, supervisor: unknown): string {
	return configured ?? (isThinkingLevel(supervisor) ? supervisor : "high");
}

/** An explicit invalid selection is a configuration error, never an instruction to inherit. */
export function parseLegThinking(value: unknown, label = "thinking"): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (!isThinkingLevel(value)) throw new Error(`${label} must be one of: ${THINKING_LEVELS.join(", ")}`);
	return value;
}

/** Explicit spec (including a roster member) > agent default > configured/inherited child effort.
 * Validate explicit fields even when another field wins; never normalize a typo into inheritance. */
export function resolveLegThinking(
	spec: { thinking?: ThinkingLevel },
	agent: { thinking?: ThinkingLevel },
	childThinking: unknown,
): ThinkingLevel | undefined {
	const explicit = parseLegThinking(spec.thinking);
	const configured = parseLegThinking(agent.thinking, "agent.thinking");
	return explicit ?? configured ?? (isThinkingLevel(childThinking) ? childThinking : undefined);
}
