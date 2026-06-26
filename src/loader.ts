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

function readSafe(path: string): string | undefined {
	try {
		return fs.readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Load + classify all definitions across dirs. Personas (`persona: true`) and
 * agents live in SEPARATE namespaces — a persona and an agent may share a name
 * without colliding — and each is merged by precedence independently (later dirs
 * win same names within a namespace).
 */
export function loadDefinitions(dirs: ScopedDir[]): LoadResult {
	const personaLayers: DiscoveredFile[][] = [];
	const agentLayers: DiscoveredFile[][] = [];
	const content = new Map<string, string>();

	for (const d of dirs) {
		const personaFiles: DiscoveredFile[] = [];
		const agentFiles: DiscoveredFile[] = [];
		for (const f of listMarkdown(d.path)) {
			const text = readSafe(f.path);
			if (text === undefined) continue;
			content.set(f.path, text);
			const entry: DiscoveredFile = { name: f.name, path: f.path, scope: d.scope };
			if (parsePersona(text, f.path)?.isPersona) personaFiles.push(entry);
			else agentFiles.push(entry);
		}
		personaLayers.push(personaFiles);
		agentLayers.push(agentFiles);
	}

	const personaMerge = mergeByPrecedence(personaLayers);
	const agentMerge = mergeByPrecedence(agentLayers);

	const personas: Persona[] = [];
	for (const f of personaMerge.resolved) {
		const persona = parsePersona(content.get(f.path) ?? "", f.path);
		if (persona) personas.push(persona);
	}
	const agents: AgentConfig[] = [];
	for (const f of agentMerge.resolved) {
		const agent = parseAgent(content.get(f.path) ?? "", f.path);
		if (agent) agents.push(agent);
	}

	return { personas, agents, shadowed: [...personaMerge.shadowed, ...agentMerge.shadowed] };
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
