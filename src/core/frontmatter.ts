/**
 * The single Markdown + YAML-frontmatter engine for pi-persona.
 *
 * Pure module — no Pi imports. Used by personas, agents, chains, and any other
 * frontmatter-bearing file. The YAML is a deliberate SUBSET (not a full engine):
 * top-level `key: value` scalars, inline `[a, b]` and block (`- a`) lists, and one
 * level of nested maps (for `delegate`/`tools` allow/deny). Coercion helpers turn
 * raw values into the typed shapes the rest of the system expects.
 */

import type { Permission } from "./permissions.ts";

// --------------------------------------------------------------------------
// Frontmatter split
// --------------------------------------------------------------------------

/** Split `---\nfrontmatter\n---\nbody`. Missing frontmatter → all body. */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
	const normalized = content.replace(/^﻿/, "");
	const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: "", body: normalized.trim() };
	return { frontmatter: match[1] ?? "", body: (match[2] ?? "").trim() };
}

// --------------------------------------------------------------------------
// Minimal YAML-subset parser
// --------------------------------------------------------------------------

/** Strip a trailing `# comment` that is not inside quotes. */
function stripComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "'" && !inDouble) inSingle = !inSingle;
		else if (c === '"' && !inSingle) inDouble = !inDouble;
		else if (c === "#" && !inSingle && !inDouble && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
			return line.slice(0, i);
		}
	}
	return line;
}

function unquote(value: string): string {
	const v = value.trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

/** Parse a scalar or inline list (`[a, "b", c]`) → string | string[] | boolean. */
function parseValue(raw: string): string | string[] | boolean {
	const v = raw.trim();
	if (v.startsWith("[") && v.endsWith("]")) {
		const inner = v.slice(1, -1).trim();
		if (inner === "") return [];
		return inner
			.split(",")
			.map((s) => unquote(s))
			.filter((s) => s.length > 0);
	}
	if (v === "true") return true;
	if (v === "false") return false;
	return unquote(v);
}

interface Frame {
	indent: number;
	container: Record<string, unknown>;
	/** When this frame was opened by `key:` with no value, the parent + key so a
	 *  following `- item` line can convert it to an array. */
	selfKey?: string;
	parent?: Record<string, unknown>;
	listArr?: unknown[];
}

/** Parse the YAML subset (see module doc) into a plain object. */
export function parseYamlSubset(src: string): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	const stack: Frame[] = [{ indent: -1, container: root }];

	for (const rawLine of src.split(/\r?\n/)) {
		const line = stripComment(rawLine);
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		const content = line.trim();

		while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
		const top = stack[stack.length - 1]!;

		if (content.startsWith("- ") || content === "-") {
			// Block list item under the current `key:` frame.
			const itemRaw = content === "-" ? "" : content.slice(2);
			if (!top.listArr) {
				top.listArr = [];
				if (top.parent && top.selfKey) top.parent[top.selfKey] = top.listArr;
			}
			top.listArr.push(parseValue(itemRaw));
			continue;
		}

		const colon = content.indexOf(":");
		if (colon < 0) continue; // not a key line — ignore
		const key = content.slice(0, colon).trim();
		const rest = content.slice(colon + 1).trim();

		if (rest === "") {
			// Open a nested container (map by default; becomes a list if `- ` follows).
			const child: Record<string, unknown> = {};
			top.container[key] = child;
			stack.push({ indent, container: child, selfKey: key, parent: top.container });
		} else {
			top.container[key] = parseValue(rest);
		}
	}

	return root;
}

// --------------------------------------------------------------------------
// Coercion helpers
// --------------------------------------------------------------------------

/** Coerce a value to a string[] (array, or comma-separated scalar). Empty → undefined. */
export function asStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.map((v) => String(v)).filter((s) => s.length > 0);
	if (typeof value === "string" && value.trim().length > 0) {
		return value
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}
	return undefined;
}

/** Coerce a value to a `Permission`. A bare list/scalar is the `allow` shorthand. */
export function asPermission(value: unknown): Permission | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		const allow = asStringArray(value);
		return allow ? { allow } : undefined;
	}
	const obj = value as Record<string, unknown>;
	const allow = asStringArray(obj.allow);
	const deny = asStringArray(obj.deny);
	if (allow === undefined && deny === undefined) return undefined;
	const perm: Permission = {};
	if (allow !== undefined) perm.allow = allow;
	if (deny !== undefined) perm.deny = deny;
	return perm;
}

/** Coerce a value to a boolean (real booleans or the strings `"true"`/`"false"`). */
export function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}
