/**
 * Built-in strategy registry — TS modules conforming to the `Strategy` interface.
 * A future loader for user-authored `strategies/*.js` (same SDK, trusted/project-
 * gated code) would register through the same map.
 */

import type { Strategy, StrategyParam } from "./sdk.ts";
import { compete } from "./strategies/compete.ts";
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
	compete,
};

export function getStrategy(name: string): Strategy | undefined {
	return BUILTINS[name];
}

/** The registered built-in strategy names, sorted — for error messages and discovery. */
export function strategyNames(): string[] {
	return Object.keys(BUILTINS).sort();
}

/** A strategy's declared param schema, for discovery (`/doctor`) and the council tool's
 *  lenient unknown-key warning. Known param-less strategies return an empty schema;
 *  `undefined` is reserved for an unknown strategy. */
export function knownParams(name: string): Record<string, StrategyParam> | undefined {
	const strategy = BUILTINS[name];
	return strategy ? (strategy.params ?? {}) : undefined;
}

/** One line per strategy for the council tool's description, generated from the registry:
 *  `- name(params, required*) — when; roster: positions; default team X.` Guidance on which method fits a
 *  problem class lives with the method, so it cannot drift from what the code does. */
export function strategyCatalog(): string {
	return strategyNames()
		.map((name) => {
			const s = BUILTINS[name] as Strategy;
			const keys = Object.keys(s.params ?? {}).map((k) => (s.required?.includes(k) ? `${k}*` : k));
			const head = `- ${name}${keys.length > 0 ? `(${keys.join(", ")})` : ""}`;
			// `magi` is the fallback every call already gets, so only a different default team is worth a mention.
			const team = s.team && s.team !== "magi" ? `; default team ${s.team}` : "";
			return `${head}${s.when ? ` — ${s.when}` : ""}${s.roster ? `; roster: ${s.roster}` : ""}${team}.`;
		})
		.join("\n");
}

/** Refuse a council call that cannot run, BEFORE any run, tree row or model picker exists: a
 *  `required` param that is missing or blank (blank counts as missing, exactly as the strategies'
 *  own `parseAuxActor` reads it). `undefined` means the call is sound. An UNKNOWN strategy is not
 *  judged here: the run itself fails with the installed list (an interactive council reports that in
 *  its completion follow-up, not in the launching call). */
export function missingRequiredParams(name: string, params: Record<string, unknown>): string | undefined {
	const strategy = BUILTINS[name];
	const missing = (strategy?.required ?? []).filter((key) => {
		const value = params[key];
		return value === undefined || value === null || (typeof value === "string" && !value.trim());
	});
	if (missing.length === 0) return undefined;
	return `"${name}" requires ${missing.map((key) => `params.${key} — ${strategy?.params?.[key]?.doc ?? "required"}`).join("; ")}`;
}
