/**
 * Pure session identity primitives.
 *
 * A session identity is a small personal handle for one Pi session.  It is deliberately
 * independent from the active persona, an agent role, and the Exocom registry.  The extension
 * adapter owns persistence and host lifecycle; this module only defines the bounded data shape and
 * the rules used when data crosses that boundary.
 */

import { sanitizeDisplayLabel } from "./display-label.ts";
import { stripTerminalControls } from "./fence.ts";

export const IDENTITY_ENTRY_CUSTOM_TYPE = "pi-persona:identity";
export const IDENTITY_CONTEXT_CUSTOM_TYPE = "pi-persona:identity-context";
export const MAX_IDENTITY_NAME_CHARS = 32;

export interface SessionIdentityEntryData {
	version: 1;
	sessionId: string;
	name: string;
}

const GENERIC_IDENTITY_NAMES = new Set(["unnamed", "agent", "supervisor", "pi"]);

/** Canonical comparison key for a human-provided label. */
export function identityNameKey(value: unknown): string {
	if (typeof value !== "string") return "";
	return stripTerminalControls(value)
		.normalize("NFKC")
		.trim()
		.toLocaleLowerCase("en-US")
		.replace(/[\s_-]+/gu, "-");
}

/** Whether a name is reserved by the generic runtime or by a discovered persona/agent. */
export function isReservedIdentityName(name: unknown, reservedNames: readonly string[] = []): boolean {
	const key = identityNameKey(name);
	if (!key) return false;
	if (GENERIC_IDENTITY_NAMES.has(key)) return true;
	return reservedNames.some((reserved) => {
		const reservedKey = identityNameKey(reserved);
		return reservedKey !== "" && (reservedKey === key || identityNameKey(sanitizeDisplayLabel(reserved, "", MAX_IDENTITY_NAME_CHARS)) === key);
	});
}

/**
 * Reduce a candidate to a short, printable display label.  `undefined` means the value cannot be
 * used as an identity.  The explicit empty fallback is intentional: `sanitizeDisplayLabel`'s
 * normal fallback is useful for UI labels but would turn an empty identity into "agent".
 */
export function sanitizeIdentityName(value: unknown, reservedNames: readonly string[] = []): string | undefined {
	if (typeof value !== "string") return undefined;
	const visible = stripTerminalControls(value.slice(0, 4096)).normalize("NFKC").trim();
	if (!visible) return undefined;
	const safe = sanitizeDisplayLabel(visible, "", MAX_IDENTITY_NAME_CHARS);
	if (!safe || isReservedIdentityName(safe, reservedNames)) return undefined;
	return safe;
}

/** Make a distinct provisional handle from a session id without consulting any name catalog. */
export function provisionalIdentityName(sessionId: string): string {
	const alphanumeric = sessionId.normalize("NFKC").replace(/[^A-Za-z0-9]/g, "");
	return `pi-${(alphanumeric.slice(-8) || "unknown")}`;
}

/** Read the newest valid identity entry on the selected session branch. */
export function findStoredIdentity(
	entries: readonly unknown[],
	sessionId: string,
	reservedNames: readonly string[] = [],
): string | undefined {
	if (!sessionId) return undefined;
	let found: string | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (item.type !== "custom" || item.customType !== IDENTITY_ENTRY_CUSTOM_TYPE) continue;
		if (!item.data || typeof item.data !== "object") continue;
		const data = item.data as Partial<SessionIdentityEntryData>;
		if (data.version !== 1 || data.sessionId !== sessionId || typeof data.name !== "string") continue;
		const safe = sanitizeIdentityName(data.name, reservedNames);
		if (safe) found = safe;
	}
	return found;
}

export function makeIdentityEntry(sessionId: string, name: string): SessionIdentityEntryData {
	return { version: 1, sessionId, name };
}
