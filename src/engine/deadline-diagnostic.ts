import { sanitizeDisplayLabel } from "../core/display-label.ts";

function openToolsAtTimeout(calls: ReadonlyMap<string, string>): string {
	if (calls.size === 0) return "";
	const names: string[] = [];
	for (const name of calls.values()) {
		names.push(sanitizeDisplayLabel(name, "unknown-tool", 48));
		if (names.length === 3) break;
	}
	const omitted = calls.size - names.length;
	if (omitted > 0) names.push(`+${omitted} more`);
	return ` (open ${calls.size === 1 ? "tool" : "tools"} at timeout: ${names.join(", ")})`;
}

export type WatchdogDeadline = "idle" | "hard" | "startup";

/** Capture the diagnosis before aborting: Pi can close calls or replace the last stream error during teardown. */
export function deadlineDiagnostic(
	kind: WatchdogDeadline, ms: number, phase: "child" | "inproc" | "initialization",
	calls: ReadonlyMap<string, string>, lastError: string | undefined,
): string {
	const initializing = phase === "initialization";
	let message: string;
	if (kind === "idle") {
		const where = initializing ? " during session initialization" : "";
		const signal = phase === "child" ? "output" : "events";
		const remedy = initializing ? "raise this leg's timeoutMs if initialization needs longer" : "raise this leg's timeoutMs if its tool is legitimately silent";
		message = `agent timed out${where} — no ${signal} for ${ms}ms${openToolsAtTimeout(calls)} (${remedy})`;
	} else if (kind === "hard") {
		message = `agent exceeded the ${ms}ms hard cap${initializing ? " during session initialization" : ""}`;
	} else {
		const signal = phase === "child" ? "progress" : "output";
		message = `agent produced no ${signal} within the ${ms}ms startup window`;
		if (initializing) message += " while initializing the session";
		else {
			const stalled = phase === "child" ? "a stalled init, e.g. an MCP adapter hanging" : "a stalled init";
			message += ` — either it never started (${stalled}) or its first provider response was slower than the window (a queued or rate-limited provider, a cold local model)`;
		}
		message += "; raise or disable the window with PI_PERSONA_AGENT_STARTUP_MS (0 disables)";
	}
	return lastError ? `${message} (last error: ${lastError})` : message;
}
