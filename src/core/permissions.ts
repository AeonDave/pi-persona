/**
 * opencode-style allow/deny permission resolution over glob patterns.
 *
 * Pure module — no Pi imports. One resolver shared by persona `tools`/`delegate`/
 * `skills` gating, agent tool allowlists, and the `EffectiveCapabilities` builder.
 */

/** An allow/deny block of glob patterns (`*` = any run, `?` = exactly one char). */
export interface Permission {
	allow?: string[];
	deny?: string[];
}

// Patterns are fixed (a persona's allow/deny lists), but `isAllowed` runs on every `tool_call`
// and across the whole tool registry on each persona switch — so compile each glob once.
const globCache = new Map<string, RegExp>();

/** Compile a glob (`*`, `?`) into a full-string-anchored RegExp; all other
 *  characters are matched literally (regex metacharacters are escaped). Memoised. */
function globToRegExp(pattern: string): RegExp {
	const cached = globCache.get(pattern);
	if (cached) return cached;
	let body = "";
	for (const ch of pattern) {
		if (ch === "*") body += ".*";
		else if (ch === "?") body += ".";
		else body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	const re = new RegExp(`^${body}$`);
	globCache.set(pattern, re);
	return re;
}

function matchesAny(name: string, patterns: string[]): boolean {
	return patterns.some((p) => globToRegExp(p).test(name));
}

/**
 * Resolve whether `name` is permitted by an opencode-style block.
 *
 * - **deny wins:** a match in `deny` → denied.
 * - **allowlist mode:** if `allow` is present, only matching names are allowed
 *   (`allow: []` ⇒ lockdown; `allow: ["*"]` ⇒ allow all).
 * - **denylist mode:** `deny` only ⇒ allow everything except denied.
 * - **absent block** (no `allow`/`deny`, or `perm` undefined) ⇒ `defaultAllow`.
 */
export function isAllowed(name: string, perm: Permission | undefined, defaultAllow = true): boolean {
	const deny = perm?.deny;
	if (deny !== undefined && matchesAny(name, deny)) return false;
	const allow = perm?.allow;
	if (allow !== undefined) return matchesAny(name, allow);
	if (deny !== undefined) return true; // denylist mode: not denied ⇒ allowed
	return defaultAllow;
}
