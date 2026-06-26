/**
 * Built-in strategy registry — TS modules conforming to the `Strategy` interface.
 * A future loader for user-authored `strategies/*.js` (same SDK, trusted/project-
 * gated code) would register through the same map.
 */

import type { Strategy } from "./sdk.ts";
import { criticLoop } from "./strategies/critic-loop.ts";
import { fanout } from "./strategies/fanout.ts";
import { magi } from "./strategies/magi.ts";

const BUILTINS: Record<string, Strategy> = {
	fanout,
	"critic-loop": criticLoop,
	magi,
};

export function getStrategy(name: string): Strategy | undefined {
	return BUILTINS[name];
}
