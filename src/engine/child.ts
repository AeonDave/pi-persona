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
	aborted: boolean;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface ChildEngineOptions {
	/** Override how the `pi` invocation is resolved (used in tests). */
	resolveInvocation?: (args: string[]) => { command: string; args: string[] };
	/** Grace period before escalating SIGTERM → SIGKILL on abort. */
	killGraceMs?: number;
	/** Live progress callback (for async peek / supervision). */
	onProgress?: (snapshot: ProgressSnapshot) => void;
	/** Hard wall-clock cap; a child exceeding it is killed (SIGTERM→SIGKILL). */
	timeoutMs?: number;
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

async function writeTempPrompt(content: string): Promise<{ path: string; cleanup: () => void }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-persona-"));
	const file = path.join(dir, "prompt.md");
	await fs.promises.writeFile(file, content, { encoding: "utf-8", mode: 0o600 });
	return {
		path: file,
		cleanup: () => {
			try {
				fs.unlinkSync(file);
			} catch {
				/* ignore */
			}
			try {
				fs.rmdirSync(dir);
			} catch {
				/* ignore */
			}
		},
	};
}

export async function runChildAgent(
	spec: ChildRunSpec,
	signal?: AbortSignal,
	opts: ChildEngineOptions = {},
): Promise<ChildRunResult> {
	const resolveInvocation = opts.resolveInvocation ?? getPiInvocation;
	const killGraceMs = opts.killGraceMs ?? 5000;

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
				// CRITICAL: disable pi-persona inside the child so it is a pure executor
				// (no persona restore, no input-hook orchestration, no `delegate` tool).
				// Without this, a globally-installed pi-persona makes every child a
				// supervisor that re-spawns → exponential fork bomb.
				env: { ...process.env, PI_PERSONA_DISABLE: "1", PI_PERSONA_CHILD: "1" },
			});
			// Decode stdout as UTF-8 so a multibyte char split across chunks isn't mangled.
			proc.stdout?.setEncoding("utf8");
			let buffer = "";
			let timer: ReturnType<typeof setTimeout> | undefined;
			const kill = () => {
				aborted = true;
				proc.kill("SIGTERM");
				const t = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, killGraceMs);
				t.unref?.();
			};
			const onLine = (line: string) => {
				if (!line.trim()) return;
				try {
					applyEvent(state, JSON.parse(line));
				} catch {
					/* ignore non-JSON noise */
				}
			};
			proc.stdout?.on("data", (d: Buffer) => {
				const { lines, rest } = feedLines(buffer, d.toString());
				buffer = rest;
				for (const l of lines) onLine(l);
				opts.onProgress?.(snapshot(state));
			});
			proc.stderr?.on("data", (d: Buffer) => {
				stderr += d.toString();
			});
			proc.on("close", (code) => {
				if (timer) clearTimeout(timer);
				if (buffer.trim()) onLine(buffer);
				resolveP(code ?? 0);
			});
			// A spawn failure (e.g. ENOENT: `pi` not on PATH) must not be silently
			// folded into a bare exit code — capture it so it surfaces in errorMessage.
			proc.on("error", (err: Error) => {
				spawnError = err;
				if (timer) clearTimeout(timer);
				resolveP(1);
			});

			// Hard timeout: a hung child (no output, never closes) is killed so it can't
			// block the turn forever.
			if (opts.timeoutMs && opts.timeoutMs > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					kill();
				}, opts.timeoutMs);
				timer.unref?.();
			}
			if (signal) {
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		const ok = !aborted && exitCode === 0 && state.stopReason !== "error" && state.stopReason !== "aborted";
		const result: ChildRunResult = {
			ok,
			output: state.output,
			usage: state.usage,
			exitCode,
			stderr,
			aborted,
		};
		if (state.model !== undefined) result.model = state.model;
		if (state.stopReason !== undefined) result.stopReason = state.stopReason;
		if (state.errorMessage !== undefined) result.errorMessage = state.errorMessage;
		if (spawnError && result.errorMessage === undefined) result.errorMessage = `failed to spawn pi: ${spawnError.message}`;
		if (timedOut && result.errorMessage === undefined) result.errorMessage = `agent timed out after ${opts.timeoutMs}ms`;
		return result;
	} finally {
		prompt?.cleanup();
	}
}
