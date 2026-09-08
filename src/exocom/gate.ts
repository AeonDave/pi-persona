/** Identity metadata does not claim work or settle asks. Persona denials still apply first. */
const ALLOWED = new Set(["exocom_name", "exocom_answer", "exocom_decline", "read", "grep", "find", "ls"]);

export function constrainedTurnAllows(toolName: string): boolean {
	return ALLOWED.has(toolName);
}
