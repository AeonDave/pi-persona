/**
 * Shared primitive types and small validators used across pi-persona.
 *
 * Pure module — no Pi imports. Keep this to genuinely cross-cutting primitives;
 * module-specific types live with their module.
 */

import type { Permission } from "./permissions.ts";

export type { Permission };

/** Pi reasoning/effort levels (mirrors `@earendil-works/pi-ai`'s `ThinkingLevel`). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function isThinkingLevel(x: unknown): x is ThinkingLevel {
	return typeof x === "string" && (THINKING_LEVELS as readonly string[]).includes(x);
}

/** Effort tier — an indirection over (model + thinking) resolved via settings. */
export type Effort = "fast" | "balanced" | "deep";
export const EFFORTS = ["fast", "balanced", "deep"] as const;

export function isEffort(x: unknown): x is Effort {
	return typeof x === "string" && (EFFORTS as readonly string[]).includes(x);
}

/** How a persona/agent body combines with the base system prompt. */
export type SystemPromptMode = "append" | "replace";

export function asSystemPromptMode(x: unknown, fallback: SystemPromptMode): SystemPromptMode {
	return x === "append" || x === "replace" ? x : fallback;
}
