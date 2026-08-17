/** Pure status projection shared by the live driver and its regression tests. */

export function terminalAssistantError(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	const detail = typeof record.errorMessage === "string" ? record.errorMessage.trim() : "";
	if (detail) return detail;
	return record.stopReason === "error" ? "model/provider ended with stopReason=error" : undefined;
}

/** A successfully spawned Pi process is not a successful smoke if its model turn failed. */
export function effectiveDriveExitCode(processCode: number | null, assistantError: string | undefined): number {
	if (processCode === null) return 1;
	if (processCode !== 0) return processCode;
	return assistantError ? 1 : 0;
}
