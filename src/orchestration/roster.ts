/**
 * Roster loading — `teams.yaml` maps a team name to an ordered agent list.
 * Pure: reuses the core YAML-subset parser. `makeRoster` adapts a team map to
 * the SDK's `Roster` interface (unknown team → empty list).
 */

import { asStringArray, parseYamlSubset } from "../core/frontmatter.ts";
import type { Roster } from "./sdk.ts";

export function parseTeams(yaml: string): Record<string, string[]> {
	const raw = parseYamlSubset(yaml);
	const teams: Record<string, string[]> = {};
	for (const [name, value] of Object.entries(raw)) {
		const agents = asStringArray(value);
		if (agents && agents.length > 0) teams[name] = agents;
	}
	return teams;
}

export function makeRoster(teams: Record<string, string[]>): Roster {
	return { team: (name: string) => teams[name] ?? [] };
}
