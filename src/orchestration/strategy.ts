/**
 * Built-in strategy registry. In v0.1 the built-ins are TS modules conforming
 * to the `Strategy` interface; v0.2 adds a jiti loader for user-authored
 * `strategies/*.js` files using the same SDK (trusted code, project-trust gated).
 */

import type { Strategy } from "./sdk.ts";
import { criticLoop } from "./strategies/critic-loop.ts";
import { fanout } from "./strategies/fanout.ts";

const BUILTINS: Record<string, Strategy> = {
	fanout,
	"critic-loop": criticLoop,
};

export function getStrategy(name: string): Strategy | undefined {
	return BUILTINS[name];
}

export function builtinStrategyNames(): string[] {
	return Object.keys(BUILTINS);
}
