/** Inbound constrained-turn allowlist. Pure. Deny-wins except these tools. */
const ALLOWED = new Set(["exocom_answer", "exocom_decline", "read", "grep", "find", "ls"]);

export function constrainedTurnAllows(toolName: string): boolean {
	return ALLOWED.has(toolName);
}
