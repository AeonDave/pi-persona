/** Per-leg effort selection. Pi alone owns model-capability clamping. Pure, no host imports. */
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "./types.ts";

/** An explicit invalid selection is a configuration error, never an instruction to inherit. */
export function parseLegThinking(value: unknown, label = "thinking"): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (!isThinkingLevel(value)) throw new Error(`${label} must be one of: ${THINKING_LEVELS.join(", ")}`);
	return value;
}

/** One shared display formatter for effort on delegate launch cards: the FULL level name,
 * with `off` rendering nothing so absence is unambiguous. Unknown input renders nothing too
 * (render paths must never throw); the compact siglas live in the tree/overlay view, not here. */
const EFFORT_FULL_NAMES: Record<ThinkingLevel, string> = {
	off: "",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

export function effortFullName(level: ThinkingLevel): string {
	return EFFORT_FULL_NAMES[level] ?? "";
}

/** The COMPACT siglas for the agent-tree/overlay rows (frozen convention): minimal→mn, low→l,
 * medium→m, high→h, xhigh→xh, max→mx — with `off` rendering nothing so absence is unambiguous.
 * Unknown input renders nothing too (render paths must never throw). The delegate CARDS keep the
 * full names via {@link effortFullName}; the F9 drill-in uses those full names through the same
 * formatter — only the tree/overlay ROWS are compact. */
const EFFORT_SIGLAS: Record<ThinkingLevel, string> = {
	off: "",
	minimal: "mn",
	low: "l",
	medium: "m",
	high: "h",
	xhigh: "xh",
	max: "mx",
};

export function effortSigla(level: ThinkingLevel): string {
	return EFFORT_SIGLAS[level] ?? "";
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
