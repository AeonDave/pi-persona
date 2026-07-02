/**
 * Built-in strategy registry — TS modules conforming to the `Strategy` interface.
 * A future loader for user-authored `strategies/*.js` (same SDK, trusted/project-
 * gated code) would register through the same map.
 */

import type { Strategy } from "./sdk.ts";
import { councilRounds } from "./strategies/council-rounds.ts";
import { criticLoop } from "./strategies/critic-loop.ts";
import { debate } from "./strategies/debate.ts";
import { fanout } from "./strategies/fanout.ts";
import { judge } from "./strategies/judge.ts";
import { magi } from "./strategies/magi.ts";
import { map } from "./strategies/map.ts";
import { pair } from "./strategies/pair.ts";
import { pipeline } from "./strategies/pipeline.ts";
import { synthesize } from "./strategies/synthesize.ts";

const BUILTINS: Record<string, Strategy> = {
	fanout,
	pipeline,
	map,
	"critic-loop": criticLoop,
	"council-rounds": councilRounds,
	debate,
	magi,
	judge,
	pair,
	synthesize,
};

export function getStrategy(name: string): Strategy | undefined {
	return BUILTINS[name];
}

/** The registered built-in strategy names, sorted — for error messages and discovery. */
export function strategyNames(): string[] {
	return Object.keys(BUILTINS).sort();
}
