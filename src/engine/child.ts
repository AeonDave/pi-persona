/**
 * ChildProcessEngine — runs a sub-agent as a separate `pi --mode json -p`
 * process (the correctness baseline; guardrails I1). Cross-OS via the same
 * binary-resolution recipe Pi's reference subagent uses. The JSON stream is
 * folded by the pure `stream.ts` helpers; this file is only process plumbing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyEvent, type ChildUsage, createStreamState, feedLines, type ProgressSnapshot, snapshot } from "./stream.ts";

export interface ChildRunSpec {
	task: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	cwd?: string;
}

export interface ChildRunResult {
	ok: boolean;
	output: string;
	usage: ChildUsage;
	exitCode: number;
	stderr: string;
	/** True only when an external AbortSignal cancelled the run. */
	aborted: boolean;
	/** True only when the wall-clock `timeoutMs` cap fired. Disjoint from `aborted`. */
	timedOut: boolean;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface ChildEngineOptions {
	/** Override how the `pi` invocation is resolved (used in tests). */
	resolveInvocation?: (args: string[]) => { command: string; args: string[] };
	/** Grace period before escalating SIGTERM → force tree-kill on abort/timeout. */
	killGraceMs?: number;
	/** Live progress callback (for async peek / supervision). */
	onProgress?: (snapshot: ProgressSnapshot) => void;
	/** Hard wall-clock cap; a child exceeding it is killed (SIGTERM→tree-kill). */
	timeoutMs?: number;
	/** Override the cross-OS force tree-kill (used in tests). Defaults to
	 *  {@link killProcessTree}. */
	killProcessTree?: (pid: number) => void;
	/** Cap on retained stderr bytes (default 256 KiB) — a verbose child must not
	 *  inflate supervisor memory without bound. */
	maxStderrBytes?: number;
}

/** Resolve how to re-invoke `pi` on any OS (script vs generic runtime vs PATH). */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/") ?? false;
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/**
 * Force-kill a process *and its children*, cross-OS. Mirrors Pi's
 * `killProcessTree` helper (taskkill /F /T on Windows; SIGKILL to the process
 * group, falling back to the lone pid, on POSIX).
 *
 * This is the escalation used when a child ignores SIGTERM. `proc.kill("SIGKILL")`
 * alone is unreliable: `proc.killed` only records that a signal was *sent* (so a
 * `!proc.killed` guard no-ops once SIGTERM was delivered), and a single-pid kill
 * never reaches grandchildren (e.g. a `pi` child's own tool subprocesses).
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
		} catch {
			/* ignore — best effort */
		}
		return;
	}
	try {
		// Negative pid targets the whole process group (the child is spawned
		// `detached`, so it is its own group leader).
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already dead */
		}
	}
}

async function writeTempPrompt(content: string): Promise<{ path: string; cleanup: () => void }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-persona-"));
	const file = path.join(dir, "prompt.md");
	const cleanup = () => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	};
	try {
		await fs.promises.writeFile(file, content, { encoding: "utf-8", mode: 0o600 });
	} catch (err) {
		// Don't leak the just-created temp dir if the write fails before we can
		// hand the caller a cleanup handle.
		cleanup();
		throw err;
	}
	return { path: file, cleanup };
}

export async function runChildAgent(
	spec: ChildRunSpec,
	signal?: AbortSignal,
	opts: ChildEngineOptions = {},
): Promise<ChildRunResult> {
	const resolveInvocation = opts.resolveInvocation ?? getPiInvocation;
	const killGraceMs = opts.killGraceMs ?? 5000;
	const forceKillTree = opts.killProcessTree ?? killProcessTree;
	const maxStderrBytes = opts.maxStderrBytes ?? 256 * 1024;
	const maxLineBytes = 1024 * 1024; // drop a single unterminated >1 MiB line (noise / memory guard)

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (spec.model) args.push("--model", spec.model);
	if (spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));

	let prompt: { path: string; cleanup: () => void } | undefined;
	if (spec.systemPrompt?.trim()) {
		prompt = await writeTempPrompt(spec.systemPrompt);
		args.push("--append-system-prompt", prompt.path);
	}
	args.push(`Task: ${spec.task}`);

	const state = createStreamState();
	let stderr = "";
	let stderrTruncated = false;
	let aborted = false;
	let timedOut = false;
	let spawnError: Error | undefined;

	try {
		const exitCode = await new Promise<number>((resolveP) => {
			const inv = resolveInvocation(args);
			const proc = spawn(inv.command, inv.args, {
				cwd: spec.cwd ?? process.cwd(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// POSIX: give the child its own process group so an escalated
				// force-kill reaches its grandchildren too.
				detached: process.platform !== "win32",
				// CRITICAL: disable pi-persona inside the child so it is a pure executor
				// (no persona restore, no input-hook orchestration, no `delegate` tool).
				// Without this, a globally-installed pi-persona makes every child a
				// supervisor that re-spawns → exponential fork bomb.
				env: { ...process.env, PI_PERSONA_DISABLE: "1", PI_PERSONA_CHILD: "1" },
			});

			let settled = false;
			let exited = false; // real liveness: set on 'close' (NOT proc.killed, which is "signal sent")
			let killing = false;
			let buffer = "";
			let timer: ReturnType<typeof setTimeout> | undefined;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;

			const onLine = (line: string) => {
				if (!line.trim()) return;
				try {
					applyEvent(state, JSON.parse(line));
				} catch {
					/* ignore non-JSON noise */
				}
			};

			// Graceful SIGTERM, then escalate to a force tree-kill if the child has
			// not actually exited after the grace window. Idempotent and timer-safe.
			const kill = () => {
				if (killing) return;
				killing = true;
				if (timer) clearTimeout(timer);
				const pid = proc.pid;
				try {
					proc.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				graceTimer = setTimeout(() => {
					if (!exited && pid !== undefined) forceKillTree(pid);
				}, killGraceMs);
				graceTimer.unref?.();
			};

			const onAbort = () => {
				aborted = true;
				kill();
			};

			// Resolve exactly once; flush the trailing partial line + a final
			// progress tick, and detach the abort listener so a shared/long-lived
			// AbortSignal doesn't accumulate dead `kill` closures.
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (graceTimer) clearTimeout(graceTimer);
				if (signal) signal.removeEventListener("abort", onAbort);
				if (buffer.trim()) onLine(buffer);
				opts.onProgress?.(snapshot(state));
				resolveP(code);
			};

			// Idle timeout: a child that emits NOTHING for `timeoutMs` is treated as hung
			// and killed — but any output (re)arms the timer, so a long-but-*active* agent
			// (streaming turn/tool events) keeps running.
			const armTimeout = () => {
				if (!opts.timeoutMs || opts.timeoutMs <= 0 || settled || killing) return;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					timedOut = true;
					kill();
				}, opts.timeoutMs);
				timer.unref?.();
			};

			proc.stdout?.setEncoding("utf8");
			proc.stdout?.on("data", (d: string) => {
				const { lines, rest } = feedLines(buffer, d);
				// Guard against an unbounded unterminated line (binary/noise flood).
				buffer = rest.length > maxLineBytes ? "" : rest;
				for (const l of lines) onLine(l);
				opts.onProgress?.(snapshot(state));
				armTimeout(); // output → reset the idle clock
			});
			// A stream 'error' (e.g. EPIPE on a dying child) on an emitter with no
			// listener is rethrown as an uncaught exception — tolerate it.
			proc.stdout?.on("error", () => {});

			proc.stderr?.on("data", (d: Buffer) => {
				if (stderr.length >= maxStderrBytes) return;
				const chunk = d.toString();
				const room = maxStderrBytes - stderr.length;
				if (chunk.length > room) {
					stderr += chunk.slice(0, room);
					if (!stderrTruncated) {
						stderr += "\n…[stderr truncated]";
						stderrTruncated = true;
					}
				} else {
					stderr += chunk;
				}
			});
			proc.stderr?.on("error", () => {});

			proc.on("close", (code) => {
				exited = true;
				finish(code ?? 0);
			});
			// A spawn failure (e.g. ENOENT: `pi` not on PATH) must not be silently
			// folded into a bare exit code — capture it so it surfaces in errorMessage.
			proc.on("error", (err: Error) => {
				spawnError = err;
				finish(1);
			});

			armTimeout(); // start the idle clock (reset on every chunk of output)
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		const ok =
			!aborted && !timedOut && exitCode === 0 && state.stopReason !== "error" && state.stopReason !== "aborted";
		const result: ChildRunResult = {
			ok,
			output: state.output,
			usage: state.usage,
			exitCode,
			stderr,
			aborted,
			timedOut,
		};
		if (state.model !== undefined) result.model = state.model;
		if (state.stopReason !== undefined) result.stopReason = state.stopReason;
		// errorMessage precedence: a timeout/abort is the *cause of death*, so label
		// it explicitly and fold in any stream-level error rather than letting the
		// stream message hide why the child actually stopped.
		const streamErr = state.errorMessage;
		if (timedOut) {
			result.errorMessage = `agent timed out — no output for ${opts.timeoutMs}ms${streamErr ? ` (last error: ${streamErr})` : ""}`;
		} else if (aborted) {
			result.errorMessage = `agent aborted${streamErr ? ` (last error: ${streamErr})` : ""}`;
		} else if (spawnError) {
			result.errorMessage = `failed to spawn pi: ${spawnError.message}`;
		} else if (streamErr !== undefined) {
			result.errorMessage = streamErr;
		}
		return result;
	} finally {
		prompt?.cleanup();
	}
}
