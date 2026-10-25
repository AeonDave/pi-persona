/** Identity metadata does not claim work or settle asks. Persona denials still apply first. */
const ALLOWED = new Set(["exocom_name", "exocom_answer", "exocom_decline", "exocom_status", "read", "grep", "find", "ls"]);

export function constrainedTurnAllows(toolName: string, input?: unknown): boolean {
	if (ALLOWED.has(toolName)) return true;
	if (!input || typeof input !== "object") return false;
	const action = (input as { action?: unknown }).action;
	return (toolName === "exocom_task" && (action === "list" || action === "get"))
		|| (toolName === "exocom_publish" && action === "read")
		|| (toolName === "exocom_profile" && action === "get");
}
