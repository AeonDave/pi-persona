/** Saved operator diagnostics for a rejected launch; never part of model-facing content. */
import type { DelegateTask } from "./delegate.ts";

export const REJECTION_ARGUMENT_LIMIT = 32_768;
export const REJECTION_GUARD_LIMIT = 16_384;
export interface DiagnosticText { text: string; truncated: boolean }
export interface WorkspaceAssessment {
	mayWrite: boolean;
	tools: { source: "task" | "agent" | "session-default"; values: readonly string[] | null };
	mcp: { source: "task" | "agent" | "default"; value: boolean };
	reason: string;
	nonReadOnlyTools: readonly string[] | null;
}

export function boundedDiagnostic(text: string, limit: number): DiagnosticText {
	const prefix = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
	return { text: prefix, truncated: text.length > prefix.length };
}

export function snapshotRejectionDiagnostics(raw: unknown, effectiveConcurrency: number, tasks: readonly {
	index: number; task: DelegateTask; requested: DelegateTask; assessment: WorkspaceAssessment;
}[]) {
	let original: string;
	try { original = JSON.stringify(raw, null, 2) ?? "(arguments unavailable)"; }
	catch { original = "(arguments could not be serialized as JSON)"; }
	const show = (value: unknown): string => value === undefined ? "not supplied" : JSON.stringify(value);
	const guard = [
		`Effective concurrency: ${effectiveConcurrency}`,
		"Top-level tools/writeSet are single-mode fields; not inherited by tasks[].",
		"These are the guard's selected grants, not an enumeration of the host's final toolset.",
		...tasks.map(({ index, task, requested, assessment: a }) => [
			`tasks[${index}] ${JSON.stringify(task.agent)}${task.name ? ` (${JSON.stringify(task.name)})` : ""}`,
			`  requested tools: ${show(requested.tools)}`,
			`  requested mcp: ${show(requested.mcp)}`,
			`  requested writeSet: ${show(requested.writeSet)}`,
			`  guard tools (${a.tools.source}): ${a.tools.values === null ? "not enumerated" : show(a.tools.values)}`,
			`  guard mcp (${a.mcp.source}): ${a.mcp.value}`,
			`  guard writeSet (${task.writeSet !== requested.writeSet ? "agent" : requested.writeSet !== undefined ? "task" : "undeclared"}): ${show(task.writeSet)}`,
			`  classification: ${a.mayWrite ? "writer" : "reader"} — ${a.reason}`,
			`  non-read-only or unrecognized tools: ${a.nonReadOnlyTools === null ? "not assessed (MCP or unspecified default already implies writer)" : show(a.nonReadOnlyTools)}`,
		].join("\n")),
	].join("\n\n");
	return { version: 1 as const,
		arguments: boundedDiagnostic(original, REJECTION_ARGUMENT_LIMIT),
		guard: boundedDiagnostic(guard, REJECTION_GUARD_LIMIT),
	};
}
