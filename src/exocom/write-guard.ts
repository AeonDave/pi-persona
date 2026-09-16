/** Advisory write-vs-claim overlap guard — warn-then-allow (Task 7). Pure except WriteWarnings' memory. */
import { normalizeWritePath, pathsOverlap } from "../core/ownership.ts";
import type { LedgerClaim } from "./ledger.ts";

/** Built-in tools whose `input.path` can land a write; the only ones this guard inspects. */
export const WRITE_TOOLS = new Set(["write", "edit"]);

/** The first live claim (never the caller's own) whose write_set overlaps `path`. */
export function peerClaimFor(path: string, claims: readonly LedgerClaim[], self: string): LedgerClaim | undefined {
	const target = normalizeWritePath(path);
	return claims.find((claim) =>
		claim.from_session !== self && claim.write_set.some((ws) => pathsOverlap(target, normalizeWritePath(ws))),
	);
}

/** One warning per (claim, normalized path) — the retry that follows a block is allowed through. */
export function writeWarningKey(claim: LedgerClaim, path: string): string {
	return `${claim.msg_id}|${normalizeWritePath(path).value}`;
}

export class WriteWarnings {
	private readonly keys = new Set<string>();
	seen(key: string): boolean {
		return this.keys.has(key);
	}
	remember(key: string): void {
		this.keys.add(key);
	}
	clear(): void {
		this.keys.clear();
	}
}
