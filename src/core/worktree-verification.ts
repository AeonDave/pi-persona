/** Explicit verification policy and runtime evidence, independent of worker prose. */
import { fenceUntrusted } from "./fence.ts";
import { isAllowed } from "./permissions.ts";

export const VERIFICATION_DEFAULT_TIMEOUT_MS = 120_000;
export const VERIFICATION_MAX_TIMEOUT_MS = 3_600_000;
export const VERIFICATION_MAX_COMMAND_CHARS = 8_192;
export const VERIFICATION_MAX_OUTPUT_CHARS = 16_000;

export interface WorktreeVerificationSpec {
	command: string;
	timeoutMs?: number;
}

export interface WorktreeVerificationResult {
	command: string;
	cwd: string;
	status: "passed" | "failed" | "timeout" | "aborted" | "error" | "skipped";
	exitCode?: number;
	output: string;
	outputTruncated: boolean;
	durationMs: number;
	reason?: string;
}

export function parseVerification(value: unknown): { ok: true; value: WorktreeVerificationSpec } | { ok: false; error: string } {
	const invalid = (error: string) => ({ ok: false as const, error });
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("verification must contain a command and optional timeoutMs");
	const object = value as Record<string, unknown>;
	if (Object.keys(object).some((key) => key !== "command" && key !== "timeoutMs")) return invalid("verification accepts only command and timeoutMs; cwd is the isolated worktree");
	if (typeof object.command !== "string" || !object.command.trim() || object.command.length > VERIFICATION_MAX_COMMAND_CHARS || object.command.includes("\0")) return invalid(`verification command must be non-empty shell source without NUL bytes, at most ${VERIFICATION_MAX_COMMAND_CHARS} characters`);
	if (object.timeoutMs !== undefined && (typeof object.timeoutMs !== "number" || !Number.isSafeInteger(object.timeoutMs) || object.timeoutMs < 1 || object.timeoutMs > VERIFICATION_MAX_TIMEOUT_MS)) return invalid(`verification timeoutMs must be an integer between 1 and ${VERIFICATION_MAX_TIMEOUT_MS}`);
	return { ok: true, value: { command: object.command, ...(typeof object.timeoutMs === "number" ? { timeoutMs: object.timeoutMs } : {}) } };
}

/** Explicit worker grants win over the host's resolved defaults; denies always win. */
export function verificationAllowsBash(tools: readonly string[] | undefined, defaultTools: readonly string[] | undefined, excludeTools?: readonly string[]): boolean {
	if (tools?.some((tool) => /^[+-]/.test(tool.trim()))) return false;
	const allow = tools ?? defaultTools;
	return isAllowed("bash", { ...(allow === undefined ? {} : { allow: [...allow] }), ...(excludeTools === undefined ? {} : { deny: [...excludeTools] }) }, true);
}

export function renderWorktreeVerification(report: WorktreeVerificationResult): string {
	const rows = [
		`--- RUNTIME WORKTREE VERIFICATION: ${report.status} ---`,
		`Command: ${JSON.stringify(report.command)}`,
		`Working directory: ${JSON.stringify(report.cwd)}`,
		`Duration: ${report.durationMs} ms${report.exitCode === undefined ? "" : `; exit code: ${report.exitCode}`}`,
	];
	if (report.reason) rows.push(`Reason: ${JSON.stringify(report.reason)}`);
	if (report.outputTruncated) rows.push(`Output truncated at ${VERIFICATION_MAX_OUTPUT_CHARS} characters.`);
	if (report.output) rows.push(`Command output (untrusted data):\n${fenceUntrusted(report.output)}`);
	return rows.join("\n");
}
