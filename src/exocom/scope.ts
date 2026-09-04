/** Resolve one session-pinned Exocom scope without confusing it with the Pi's real workspace. */
import { basename, resolve } from "node:path";

import { allocateJoinCode, resolveJoinCode, validateJoinCode } from "./codes.ts";
import { workspaceHash } from "./paths.ts";
import { normalizeMetadataText } from "./registry.ts";

export interface ExocomScope {
	/** Full 24-hex identity used by registry, transport, ledger, and artifacts. */
	scopeWorkspaceId: string;
	/** Short, case-sensitive presentation alias for `scopeWorkspaceId`. */
	scopeCode: string;
	/** The workspace this Pi can actually inspect, regardless of the scope it joined. */
	homeWorkspaceId: string;
	homeWorkspaceCode: string;
	homeWorkspaceLabel: string;
	/** True only when this Pi is attached to another workspace's Exocom plane. */
	joined: boolean;
}

export function selectExocomScope(agentDir: string, cwd: string, joinCode?: string): ExocomScope {
	const homeWorkspaceId = workspaceHash(cwd);
	let scopeWorkspaceId = homeWorkspaceId;
	let scopeCode: string | undefined;
	if (joinCode !== undefined) {
		const validCode = validateJoinCode(joinCode);
		const resolvedScope = resolveJoinCode(agentDir, validCode);
		if (!resolvedScope) throw new Error(`unknown Exocom join code "${validCode}"`);
		scopeWorkspaceId = resolvedScope;
		scopeCode = validCode;
	}
	const homeWorkspaceCode = allocateJoinCode(agentDir, homeWorkspaceId);
	const label = normalizeMetadataText(basename(resolve(cwd)), 80, "workspace");
	return {
		scopeWorkspaceId,
		scopeCode: scopeCode ?? homeWorkspaceCode,
		homeWorkspaceId,
		homeWorkspaceCode,
		homeWorkspaceLabel: label,
		joined: scopeWorkspaceId !== homeWorkspaceId,
	};
}
