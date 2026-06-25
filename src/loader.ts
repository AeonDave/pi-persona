/**
 * Filesystem loading of personas, agents, and teams. The thin I/O layer over the
 * pure parsers + the discovery precedence merge. A `.md` file is a persona iff
 * its frontmatter has `persona: true`; otherwise it is a plain agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { type AgentConfig, parseAgent } from "./agents/agent.ts";
import { type DiscoveredFile, mergeByPrecedence } from "./core/discovery.ts";
import { parseTeams } from "./orchestration/roster.ts";
import { type Persona, parsePersona } from "./persona/persona.ts";

export interface ScopedDir {
	path: string;
	scope: string;
}

export interface LoadResult {
	personas: Persona[];
	agents: AgentConfig[];
	shadowed: DiscoveredFile[];
}

/** List `*.md` files in a directory (name without extension + full path). */
export function listMarkdown(dir: string): Array<{ name: string; path: string }> {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((f) => f.toLowerCase().endsWith(".md"))
		.map((f) => ({ name: f.slice(0, -3), path: path.join(dir, f) }));
}

/** Load + classify all definitions across dirs (later dirs win same names). */
export function loadDefinitions(dirs: ScopedDir[]): LoadResult {
	const layers: DiscoveredFile[][] = dirs.map((d) =>
		listMarkdown(d.path).map((f) => ({ name: f.name, path: f.path, scope: d.scope })),
	);
	const { resolved, shadowed } = mergeByPrecedence(layers);

	const personas: Persona[] = [];
	const agents: AgentConfig[] = [];
	for (const file of resolved) {
		let content: string;
		try {
			content = fs.readFileSync(file.path, "utf-8");
		} catch {
			continue;
		}
		const persona = parsePersona(content, file.path);
		if (persona?.isPersona) {
			personas.push(persona);
			continue;
		}
		const agent = parseAgent(content, file.path);
		if (agent) agents.push(agent);
	}
	return { personas, agents, shadowed };
}

/** Merge `teams.yaml` files (later files win). */
export function loadTeams(files: string[]): Record<string, string[]> {
	const merged: Record<string, string[]> = {};
	for (const file of files) {
		let content: string;
		try {
			content = fs.readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		Object.assign(merged, parseTeams(content));
	}
	return merged;
}
