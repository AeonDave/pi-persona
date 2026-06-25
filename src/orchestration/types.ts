/**
 * Orchestration-layer types shared by the SDK, strategies, and reducers.
 */

import type { ChildUsage } from "../engine/stream.ts";

export type { ChildUsage };

/** The result of running one agent through the engine, as strategies see it. */
export interface AgentResult {
	agent: string;
	output: string;
	/** Validated structured fields (when the agent ran against a contract). */
	structured?: Record<string, unknown>;
	usage: ChildUsage;
	ok: boolean;
	error?: string;
}
