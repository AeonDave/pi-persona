/**
 * Filesystem loading of personas, agents, and teams. The thin I/O layer over the
 * pure parsers + the discovery precedence merge. A `.md` file is a persona iff
 * its frontmatter has `persona: true`; otherwise it is a plain agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { type AgentConfig, parseAgent } from "./agents/agent.ts";
import { type ContractDef, parseContract } from "./core/contract.ts";
import { type DiscoveredFile, mergeByPrecedence } from "./core/discovery.ts";
import { parseTeams } from "./orchestration/roster.ts";
import { type CouncilSpec, type Persona, parsePersona } from "./persona/persona.ts";

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
	// Classification already parses each file as a persona — cache the result so the
	// winners are not parsed a second time below.
	const parsedPersonas = new Map<string, Persona | null>();

	for (const d of dirs) {
		const personaFiles: DiscoveredFile[] = [];
		const agentFiles: DiscoveredFile[] = [];
		for (const f of listMarkdown(d.path)) {
			const text = readSafe(f.path);
			if (text === undefined) continue;
			content.set(f.path, text);
			const entry: DiscoveredFile = { name: f.name, path: f.path, scope: d.scope };
			const persona = parsePersona(text, f.path);
			parsedPersonas.set(f.path, persona);
			if (persona?.isPersona) personaFiles.push(entry);
			else agentFiles.push(entry);
		}
		personaLayers.push(personaFiles);
		agentLayers.push(agentFiles);
	}

	const personaMerge = mergeByPrecedence(personaLayers);
	const agentMerge = mergeByPrecedence(agentLayers);

	const personas: Persona[] = [];
	for (const f of personaMerge.resolved) {
		const persona = parsedPersonas.get(f.path);
		if (persona) personas.push(persona);
	}
	const agents: AgentConfig[] = [];
	for (const f of agentMerge.resolved) {
		const agent = parseAgent(content.get(f.path) ?? "", f.path);
		if (agent) agents.push(agent);
	}

	return { personas, agents, shadowed: [...personaMerge.shadowed, ...agentMerge.shadowed] };
}

/** Discover `*.contract.json` files across dirs into a name→ContractDef map (later dirs win,
 *  so project overrides user overrides builtin). Malformed files are skipped (never crash). */
export function loadContracts(dirs: ScopedDir[]): Record<string, ContractDef> {
	const merged: Record<string, ContractDef> = {};
	for (const d of dirs) {
		let entries: string[];
		try {
			entries = fs.readdirSync(d.path);
		} catch {
			continue;
		}
		for (const f of entries.filter((e) => e.toLowerCase().endsWith(".contract.json"))) {
			const text = readSafe(path.join(d.path, f));
			if (text === undefined) continue;
			const parsed = parseContract(text);
			if (parsed.ok) merged[parsed.def.name] = parsed.def;
		}
	}
	return merged;
}

/** Discover `*.preset.json` files (council presets) across dirs into a name→partial-spec map
 *  (later dirs win). A preset file is `{ strategy?, roster?, params? }`; bad files are skipped. */
export function loadPresets(dirs: ScopedDir[]): Record<string, Partial<CouncilSpec>> {
	const merged: Record<string, Partial<CouncilSpec>> = {};
	for (const d of dirs) {
		let entries: string[];
		try {
			entries = fs.readdirSync(d.path);
		} catch {
			continue;
		}
		for (const f of entries.filter((e) => e.toLowerCase().endsWith(".preset.json"))) {
			const text = readSafe(path.join(d.path, f));
			if (text === undefined) continue;
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				continue;
			}
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
			const o = raw as Record<string, unknown>;
			const spec: Partial<CouncilSpec> = {};
			if (typeof o.strategy === "string" && o.strategy.trim()) spec.strategy = o.strategy.trim();
			if (typeof o.roster === "string" && o.roster.trim()) spec.roster = o.roster.trim();
			if (o.params && typeof o.params === "object" && !Array.isArray(o.params)) spec.params = o.params as Record<string, unknown>;
			const name = f.slice(0, -".preset.json".length);
			merged[name] = spec;
		}
	}
	return merged;
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
