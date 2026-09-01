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
import { parseTeams, type RosterMember } from "./orchestration/roster.ts";
import { type CouncilSpec, type Persona, parsePersona } from "./persona/persona.ts";

export interface ScopedDir {
	path: string;
	scope: string;
}

export interface LoadResult {
	personas: Persona[];
	agents: AgentConfig[];
	shadowed: DiscoveredFile[];
	/** Ambiguous names found in the shared persona/agent namespace. These entries are omitted. */
	collisions: Array<{ name: string; persona: DiscoveredFile; agent: DiscoveredFile }>;
	/** Per-file problems that previously dropped a definition silently: unreadable file,
	 *  missing frontmatter `name`, filename≠`name` mismatch. Surfaced via /doctor and the
	 *  startup diagnostics notification — a typo'd frontmatter must not vanish an agent
	 *  from the roster without a trace. */
	warnings: string[];
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
 * Load + classify all definitions across dirs. Personas (`persona: true`) and agents share one
 * runtime namespace: a name collision is returned as a diagnostic and omitted from both effective
 * registries, so activation cannot silently choose a different definition for delegate vs persona.
 * Each kind is still merged by precedence independently before the collision check.
 *
 * Identity is the frontmatter `name`, never the filename: the merge, shadowing, and the
 * collision guard all key on the parsed name, so a persona `foo.md` declaring `name: dev`
 * collides with an agent `dev.md` declaring `name: dev` exactly like a same-filename pair.
 * A name≠basename mismatch is warned about (confusing to debug), not rejected.
 */
export function loadDefinitions(dirs: ScopedDir[]): LoadResult {
	const personaLayers: DiscoveredFile[][] = [];
	const agentLayers: DiscoveredFile[][] = [];
	const content = new Map<string, string>();
	const warnings: string[] = [];
	// Classification already parses each file as a persona — cache the result so the
	// winners are not parsed a second time below.
	const parsedPersonas = new Map<string, Persona | null>();

	for (const d of dirs) {
		const personaFiles: DiscoveredFile[] = [];
		const agentFiles: DiscoveredFile[] = [];
		for (const f of listMarkdown(d.path)) {
			const text = readSafe(f.path);
			if (text === undefined) {
				warnings.push(`${f.path}: unreadable — skipped`);
				continue;
			}
			content.set(f.path, text);
			const persona = parsePersona(text, f.path);
			parsedPersonas.set(f.path, persona);
			if (!persona) {
				// parseAgent fails on the same condition (missing frontmatter `name`),
				// so this file can be NEITHER — say so instead of silently dropping it.
				warnings.push(`${f.path}: no frontmatter "name" — skipped`);
				continue;
			}
			if (persona.name !== f.name) {
				warnings.push(`${f.path}: frontmatter name "${persona.name}" differs from the filename — the frontmatter name wins`);
			}
			const entry: DiscoveredFile = { name: persona.name, path: f.path, scope: d.scope };
			if (persona.isPersona) personaFiles.push(entry);
			else agentFiles.push(entry);
		}
		personaLayers.push(personaFiles);
		agentLayers.push(agentFiles);
	}

	const personaMerge = mergeByPrecedence(personaLayers);
	const agentMerge = mergeByPrecedence(agentLayers);
	const agentByName = new Map(agentMerge.resolved.map((f) => [f.name, f]));
	const collisions: LoadResult["collisions"] = [];
	for (const persona of personaMerge.resolved) {
		const agent = agentByName.get(persona.name);
		if (agent) collisions.push({ name: persona.name, persona, agent });
	}
	const collisionNames = new Set(collisions.map((c) => c.name));

	const personas: Persona[] = [];
	for (const f of personaMerge.resolved) {
		if (collisionNames.has(f.name)) continue;
		const persona = parsedPersonas.get(f.path);
		if (persona) personas.push(persona);
	}
	const agents: AgentConfig[] = [];
	for (const f of agentMerge.resolved) {
		if (collisionNames.has(f.name)) continue;
		const agent = parseAgent(content.get(f.path) ?? "", f.path);
		if (agent) agents.push(agent);
	}

	return { personas, agents, shadowed: [...personaMerge.shadowed, ...agentMerge.shadowed], collisions, warnings };
}

export interface ContractsLoad {
	contracts: Record<string, ContractDef>;
	warnings: string[];
}

/** Discover `*.contract.json` files across dirs into a name→ContractDef map (later dirs win,
 *  so project overrides user overrides builtin). The registry key is the FILENAME
 *  (`<name>.contract.json`) — deterministic, unlike two same-dir files declaring the same
 *  embedded `name`, which would resolve by readdir order. A filename≠`name` mismatch and a
 *  malformed file are warned about, never silently skipped. */
export function loadContracts(dirs: ScopedDir[]): ContractsLoad {
	const merged: Record<string, ContractDef> = {};
	const warnings: string[] = [];
	for (const d of dirs) {
		let entries: string[];
		try {
			entries = fs.readdirSync(d.path);
		} catch {
			continue;
		}
		for (const f of entries.filter((e) => e.toLowerCase().endsWith(".contract.json"))) {
			const full = path.join(d.path, f);
			const text = readSafe(full);
			if (text === undefined) {
				warnings.push(`${full}: unreadable — skipped`);
				continue;
			}
			const parsed = parseContract(text);
			if (!parsed.ok) {
				warnings.push(`${full}: ${parsed.error} — skipped`);
				continue;
			}
			const key = f.slice(0, -".contract.json".length);
			if (parsed.def.name !== key) {
				warnings.push(`${full}: embedded name "${parsed.def.name}" differs from the filename — registered as "${key}"`);
			}
			merged[key] = parsed.def;
		}
	}
	return { contracts: merged, warnings };
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
export function loadTeams(files: string[]): Record<string, RosterMember[]> {
	const merged: Record<string, RosterMember[]> = {};
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
