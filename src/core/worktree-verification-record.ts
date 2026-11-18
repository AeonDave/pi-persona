/** Admission and detached canonical copying of runtime verification evidence for storage. */
import { posix, win32 } from "node:path";
import { parseVerification, VERIFICATION_MAX_OUTPUT_CHARS, type WorktreeVerificationResult } from "./worktree-verification.ts";

const KEYS = ["command", "cwd", "status", "exitCode", "output", "outputTruncated", "durationMs", "reason"];
const STATUSES: readonly WorktreeVerificationResult["status"][] = ["passed", "failed", "timeout", "aborted", "error", "skipped"];

/** This validates runtime metadata; it never infers a result from command output or prose. */
export function parseWorktreeVerificationResult(raw: unknown): WorktreeVerificationResult | undefined {
	try {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const prototype: unknown = Object.getPrototypeOf(raw);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		for (const key of Reflect.ownKeys(raw)) {
			const descriptor = Object.getOwnPropertyDescriptor(raw, key);
			if (typeof key !== "string" || !KEYS.includes(key) || !descriptor?.enumerable || !("value" in descriptor)) return undefined;
		}
		const value = raw as Record<string, unknown>;
		if (!["command", "cwd", "status", "output", "outputTruncated", "durationMs"].every((key) => Object.hasOwn(value, key))) return undefined;
		const spec = parseVerification({ command: value.command });
		if (!spec.ok) return undefined;
		if (typeof value.cwd !== "string" || value.cwd.length > 32_768 || value.cwd.includes("\0")
			|| !(posix.isAbsolute(value.cwd) || (win32.isAbsolute(value.cwd) && win32.parse(value.cwd).root.length > 1))) return undefined;
		if (typeof value.status !== "string" || !(STATUSES as readonly string[]).includes(value.status)) return undefined;
		if (typeof value.output !== "string" || value.output.length > VERIFICATION_MAX_OUTPUT_CHARS || typeof value.outputTruncated !== "boolean") return undefined;
		if (typeof value.durationMs !== "number" || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0) return undefined;
		if (value.exitCode !== undefined && (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode))) return undefined;
		if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 1_000)) return undefined;
		if (value.status === "passed" && value.exitCode !== 0) return undefined;
		// A post-command directory check can turn an observed exit into an error; keep
		// that historical exit code while rejecting a success claim without exit zero.
		if (value.status !== "passed" && value.status !== "failed" && value.status !== "error" && value.exitCode !== undefined) return undefined;
		if (value.status === "skipped" && (value.output !== "" || value.outputTruncated || value.durationMs !== 0)) return undefined;
		return {
			command: spec.value.command, cwd: value.cwd, status: value.status as WorktreeVerificationResult["status"],
			...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number }),
			output: value.output, outputTruncated: value.outputTruncated, durationMs: value.durationMs,
			...(value.reason === undefined ? {} : { reason: value.reason as string }),
		};
	} catch { return undefined; }
}
