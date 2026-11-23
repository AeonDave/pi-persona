/** One bounded shell command, reusing the existing process-tree lifecycle adapter. */
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { lstat } from "node:fs/promises";
import type { MonitorProcess } from "../core/monitor.ts";
import type { ConversationWorktree } from "../core/worktree-recovery.ts";
import { renderWorktreeVerification, VERIFICATION_DEFAULT_TIMEOUT_MS, VERIFICATION_MAX_OUTPUT_CHARS, type WorktreeVerificationResult, type WorktreeVerificationSpec } from "../core/worktree-verification.ts";
import { startMonitorProcess } from "../monitor/process.ts";
import { verifyConversationWorktree } from "./conversation-worktree.ts";
import type { AgentResult } from "../orchestration/types.ts";

export interface VerificationTarget { dev: number; ino: number }

/** Pin directory identity before worker execution, not after potentially untrusted edits. */
export async function captureVerificationTarget(dir: string): Promise<VerificationTarget> {
	const stat = await lstat(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Verification target is not an owned worktree directory");
	return { dev: stat.dev, ino: stat.ino };
}

export async function verificationTargetError(worktree: ConversationWorktree, target: VerificationTarget): Promise<string | undefined> {
	try {
		const current = await captureVerificationTarget(worktree.path);
		if (current.dev !== target.dev || current.ino !== target.ino) return "The original verification worktree directory was replaced";
		const checked = await verifyConversationWorktree(worktree, worktree.root);
		return checked.ok ? undefined : checked.error;
	} catch (error) { return `Verification worktree is unavailable: ${String(error)}`; }
}

interface VerificationDeps {
	signal?: AbortSignal;
	shellPath?: string;
	resolveShell?: typeof getShellConfig;
	start?: typeof startMonitorProcess;
}

export interface VerificationObservation {
	report: WorktreeVerificationResult;
	/** Only a clean process close proves that export may begin. Stop is best effort. */
	quiescent: boolean;
}

/** Apply runtime evidence without granting the worker's text authority over the outcome. */
export async function applyWorktreeVerification(spec: WorktreeVerificationSpec, worktree: ConversationWorktree, target: VerificationTarget, worker: AgentResult, deps: VerificationDeps & { allowed: () => boolean }): Promise<{ result: AgentResult; canExport: boolean }> {
	const targetError = await verificationTargetError(worktree, target);
	const reason = !worker.ok ? "Worker did not complete successfully" : worker.sessionQuiescent !== true ? "Worker may still be writing" : deps.signal?.aborted ? "Cancelled before verification started" : !deps.allowed() ? "Effective bash permission was revoked" : targetError;
	let report: WorktreeVerificationResult;
	let canExport: boolean;
	if (reason) {
		report = { command: spec.command, cwd: worktree.path, status: "skipped", output: "", outputTruncated: false, durationMs: 0, reason };
		canExport = !targetError && worker.sessionQuiescent === true;
	} else {
		const observation = await runWorktreeVerification(spec, worktree.path, deps);
		report = observation.report;
		const changedTarget = await verificationTargetError(worktree, target);
		canExport = observation.quiescent && !changedTarget;
		if (changedTarget) report = { ...report, status: "error", reason: changedTarget };
	}
	if (report.reason) report = { ...report, reason: report.reason.slice(0, 1000) };
	const block = renderWorktreeVerification(report);
	// Keep runtime evidence in the retained prefix when the archive truncates verbose worker prose.
	let result: AgentResult = { ...worker, verification: report, output: worker.output.trim() ? `${block}\n\n${worker.output.trimEnd()}` : block };
	if (result.ok && report.status !== "passed") result = {
		...result, ok: false,
		failureKind: report.status === "timeout" ? "timeout" : report.status === "aborted" || deps.signal?.aborted ? "abort" : "contract",
		error: `Worktree verification ${report.status}${report.exitCode === undefined ? "" : ` (exit ${report.exitCode})`}${report.reason ? `: ${report.reason}` : ""}`,
		...(worker.sessionSaved === undefined ? {} : { sessionSaved: false }),
	};
	return { result, canExport };
}

export async function runWorktreeVerification(spec: WorktreeVerificationSpec, cwd: string, deps: VerificationDeps = {}): Promise<VerificationObservation> {
	const startedAt = Date.now();
	let output = "";
	let outputTruncated = false;
	const report = (status: WorktreeVerificationResult["status"], reason?: string, exitCode?: number): WorktreeVerificationResult => Object.freeze({
		command: spec.command, cwd, status, output, outputTruncated, durationMs: Math.max(0, Date.now() - startedAt),
		...(reason === undefined ? {} : { reason: reason.slice(0, 1000) }), ...(exitCode === undefined ? {} : { exitCode }),
	});
	if (deps.signal?.aborted) return { report: report("aborted", "Cancelled before verification started"), quiescent: true };
	let shell: ReturnType<typeof getShellConfig>;
	try { shell = (deps.resolveShell ?? getShellConfig)(deps.shellPath); }
	catch (error) { return { report: report("error", `Could not resolve verification shell: ${String(error)}`), quiescent: true }; }
	return new Promise((resolve) => {
		let settled = false;
		let process: MonitorProcess | undefined;
		let stopRequested = false;
		const append = (chunk: string): void => {
			if (settled || !chunk) return;
			const room = Math.max(0, VERIFICATION_MAX_OUTPUT_CHARS - output.length);
			output += chunk.slice(0, room);
			if (chunk.length > room) outputTruncated = true;
		};
		const finish = (status: WorktreeVerificationResult["status"], quiescent: boolean, reason?: string, exitCode?: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			deps.signal?.removeEventListener("abort", abort);
			if (!quiescent) {
				stopRequested = true;
				try { process?.stop(); } catch { /* retain the worktree; stopping is best effort */ }
			}
			resolve({ report: report(status, reason, exitCode), quiescent });
		};
		const abort = (): void => finish("aborted", false, "Verification cancelled; process-tree termination requested");
		const timer = setTimeout(() => finish("timeout", false, `Verification exceeded ${spec.timeoutMs ?? VERIFICATION_DEFAULT_TIMEOUT_MS} ms; process-tree termination requested`), spec.timeoutMs ?? VERIFICATION_DEFAULT_TIMEOUT_MS);
		deps.signal?.addEventListener("abort", abort, { once: true });
		if (deps.signal?.aborted) { finish("aborted", true, "Cancelled before verification started"); return; }
		try {
			process = (deps.start ?? startMonitorProcess)({
				command: shell.shell, args: shell.commandTransport === "stdin" ? shell.args : [...shell.args, spec.command],
				...(shell.commandTransport === "stdin" ? { stdin: spec.command } : {}),
				cwd, label: "Worktree verification", mode: "exit",
			}, {
				onStdout: append, onStderr: append,
				// A survivor may still write into the checkout, so a lingering exit cannot prove the worktree quiescent.
				onExit: (code, signal, lingering) => lingering
					? finish("error", false, "A background process still holds the command's output; the worktree is retained without export", code ?? undefined)
					: finish(code === 0 && !signal ? "passed" : "failed", !signal && code !== null, signal ? `Verification terminated by ${signal}` : undefined, code ?? undefined),
				onError: (error) => finish("error", false, error.message),
			});
			if (stopRequested) try { process.stop(); } catch { /* retained */ }
		} catch (error) { finish("error", false, String(error)); }
	});
}
