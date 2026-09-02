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
	excludeTools?: string[];
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
	/** True when the idle watchdog OR the hard wall-clock cap fired. Disjoint from `aborted`. */
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
	/** IDLE window (ms): a child that emits NOTHING for this long is killed (SIGTERM→tree-kill).
	 *  Any output re-arms it, so a long-but-active child survives. 0/absent = no idle watchdog. */
	timeoutMs?: number;
	/** HARD wall-clock cap (ms): a definite lifetime ceiling, armed ONCE and never re-armed by
	 *  output — so it kills a busy-but-non-converging child (a loop that keeps emitting) that the
	 *  idle window above never catches. 0/absent = no cap. */
	hardTimeoutMs?: number;
	/** STARTUP deadline (ms): a child that never makes PROGRESS (no completed turn, no tokens,
	 *  no streamed output) within this window is killed as a stalled start — the "never started"
	 *  case the idle window is too generous for (a headless `mcp: true` leg whose MCP adapter hangs
	 *  in init emits only the session header, then nothing). The FIRST progress cancels it
	 *  permanently, so a slow-but-streaming turn is never touched. 0/absent = no startup deadline.
	 *
	 *  CHOOSE THE VALUE FOR THE WHOLE COLD START, not for init alone. Only the CHILD'S OWN
	 *  assistant output counts as progress — pi's echo of the delivered prompt is filtered out
	 *  (stream.ts), and header/turn_start noise never counted — so the window has to cover
	 *  process spawn + pi init + MCP init + the FIRST provider response. A queued or
	 *  rate-limited provider, a cold serverless endpoint or a local model doing a long prompt
	 *  eval can spend minutes there, and this deadline kills such a leg outright (failureKind
	 *  "timeout"); the idle watchdog would not, because it is re-armed by any stdout at all. */
	startupTimeoutMs?: number;
	/** Override the cross-OS force tree-kill (used in tests). Defaults to
	 *  {@link killProcessTree}. */
	killProcessTree?: (pid: number) => void;
	/** Cap on retained stderr bytes (default 256 KiB) — a verbose child must not
	 *  inflate supervisor memory without bound. */
	maxStderrBytes?: number;
	/** Extra env vars merged into the child's environment on top of the defaults
	 *  (e.g. the broker wiring `PI_PERSONA_BUS`/`PI_PERSONA_HANDLE` — adapter.ts's job,
	 *  this file only plumbs them through). Absent ⇒ env is exactly today's. */
	env?: Record<string, string>;
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
			const tk = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
			// An async spawn 'error' (e.g. taskkill missing, EACCES across a session boundary) is
			// emitted on the ChildProcess — with no listener Node re-throws it as an UNCAUGHT
			// exception that crashes the host. The try/catch only covers a synchronous throw.
			tk.on("error", () => {});
			tk.unref();
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
	const maxLineBytes = 1024 * 1024; // a single unterminated >1 MiB line is stream noise — loud failure, never a silent drop

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (spec.model) args.push("--model", spec.model);
	if (spec.tools !== undefined) {
		if (spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
		else args.push("--no-tools");
	}
	if (spec.excludeTools && spec.excludeTools.length > 0) args.push("--exclude-tools", spec.excludeTools.join(","));

	let prompt: { path: string; cleanup: () => void } | undefined;
	if (spec.systemPrompt?.trim()) {
		prompt = await writeTempPrompt(spec.systemPrompt);
		args.push("--append-system-prompt", prompt.path);
	}
	// The task goes over STDIN, not argv: `pi -p` prepends piped stdin to the initial
	// message, and a flow-phase task (base task + every upstream phase's output) easily
	// exceeds Windows' ~32 KiB command-line cap — as argv it would fail to spawn.
	const taskInput = `Task: ${spec.task}`;

	const state = createStreamState();
	let stderr = "";
	let stderrTruncated = false;
	let aborted = false;
	let timedOut = false;
	let hardTimedOut = false;
	let startupTimedOut = false;
	let killSignal: NodeJS.Signals | undefined; // the signal that ended the child, if any (POSIX)
	let progressed = false; // set once the child produces its FIRST real progress (turn/tokens/output)
	let spawnError: Error | undefined;
	let oversizedLine = false; // a >maxLineBytes unterminated line — loud failure, never a silent drop
	let diedWithoutStatus = false; // 'close' with null code AND null signal — never a clean exit

	try {
		const exitCode = await new Promise<number>((resolveP) => {
			const inv = resolveInvocation(args);
			// A stale broker wiring in the SUPERVISOR's own environment must not leak into a
			// plain child: PI_PERSONA_BUS would boot the child's bridge against a dead (or
			// foreign) endpoint. The adapter re-adds these deliberately via opts.env when a
			// broker is actually live for THIS run.
			const inherited = { ...process.env };
			delete inherited.PI_PERSONA_BUS;
			delete inherited.PI_PERSONA_HANDLE;
			delete inherited.PI_PERSONA_PEERS;
			delete inherited.PI_PERSONA_ALLOW_BLOCKING;
			const proc = spawn(inv.command, inv.args, {
				cwd: spec.cwd ?? process.cwd(),
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				// POSIX: give the child its own process group so an escalated
				// force-kill reaches its grandchildren too.
				detached: process.platform !== "win32",
				// CRITICAL: disable pi-persona inside the child so it is a pure executor
				// (no persona restore, no input-hook orchestration, no `delegate` tool).
				// Without this, a globally-installed pi-persona makes every child a
				// supervisor that re-spawns → exponential fork bomb.
				// PI_PERSONA_CHILD marks the child process; PI_PERSONA_LEG is the dedicated
				// "delegated worker leg" marker a companion extension reads to tell a real leg from
				// a user-set PI_PERSONA_DISABLE kill switch (see inproc.ts pushDisableGuard).
				env: { ...inherited, PI_PERSONA_DISABLE: "1", PI_PERSONA_CHILD: "1", PI_PERSONA_LEG: "1", ...opts.env },
			});

			let settled = false;
			let exited = false; // real liveness: set on 'close' (NOT proc.killed, which is "signal sent")
			let killing = false;
			let buffer = "";
			let timer: ReturnType<typeof setTimeout> | undefined;
			let hardTimer: ReturnType<typeof setTimeout> | undefined;
			let startupTimer: ReturnType<typeof setTimeout> | undefined;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			let lastResortTimer: ReturnType<typeof setTimeout> | undefined;

			// Calls whose start crossed the progress seam but whose end has not. The tool NAME is kept
			// beside the id because a synthetic close in finish() has to carry it.
			const openToolCalls = new Map<string, string>();

			const onLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const toolEvent = applyEvent(state, JSON.parse(line));
					// Ordinary stream progress stays coalesced to one snapshot per stdout chunk below.
					// Tool lifecycle transitions are the exception: several can share one chunk and each
					// authoritative transition must cross the progress seam exactly once.
					if (toolEvent) {
						if (toolEvent.phase === "start") openToolCalls.set(toolEvent.callId, toolEvent.name);
						else openToolCalls.delete(toolEvent.callId);
						opts.onProgress?.(snapshot(state, toolEvent));
					}
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
				if (hardTimer) clearTimeout(hardTimer);
				if (startupTimer) clearTimeout(startupTimer);
				const pid = proc.pid;
				// POSIX: the child is a process-GROUP leader (detached above), so signal the
				// whole group — its own tool subprocesses (grandchildren) must die with it,
				// not survive as orphans holding the workspace.
				const signalGroup = (sig: NodeJS.Signals): boolean => {
					if (process.platform === "win32" || pid === undefined) return false;
					try {
						process.kill(-pid, sig);
						return true;
					} catch {
						return false; // the group is already gone
					}
				};
				// Last resort: if NEITHER 'close' nor 'error' ever arrives after a kill (a
				// wedged process handle, a failed tree-kill), settle the run anyway — an
				// unsettled promise here hangs the whole strategy.
				lastResortTimer = setTimeout(() => {
					if (!settled) finish(1);
				}, killGraceMs + 5000);
				lastResortTimer.unref?.();
				// On Windows, proc.kill("SIGTERM") maps to TerminateProcess: it kills ONLY the root
				// and fires `close` synchronously, which clears the grace timer before it can run —
				// so the tree-kill never fires and the child's own tool subprocesses are orphaned.
				// Go straight to the force tree-kill (taskkill /F /T) there.
				if (process.platform === "win32") {
					if (pid !== undefined) forceKillTree(pid);
					return;
				}
				if (!signalGroup("SIGTERM")) {
					try {
						proc.kill("SIGTERM");
					} catch {
						/* ignore */
					}
				}
				graceTimer = setTimeout(() => {
					if (!exited && pid !== undefined) {
						forceKillTree(pid);
						signalGroup("SIGKILL"); // belt-and-braces for grandchildren the tree-kill missed
					}
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
				if (hardTimer) clearTimeout(hardTimer);
				if (startupTimer) clearTimeout(startupTimer);
				if (graceTimer) clearTimeout(graceTimer);
				if (lastResortTimer) clearTimeout(lastResortTimer);
				if (signal) signal.removeEventListener("abort", onAbort);
				// Close can beat the last `data` tick's oversized check (a child that
				// dumps one huge unterminated write and exits). Treat that remainder
				// as stream noise too — never parse it as a trailing line and "succeed".
				if (buffer.length > maxLineBytes) {
					oversizedLine = true;
					buffer = "";
				} else if (buffer.trim()) onLine(buffer);
				// A killed child (UI stop, idle/hard/startup deadline) never emits the
				// tool_execution_end for whatever it was running, so close each abandoned call here —
				// exactly once, mirroring what applyEvent would have produced. Without it the consumer
				// shows that tool "running" forever and its telemetry record is pinned by the replay
				// seed. A child that ended normally has nothing open, so nothing is double-closed.
				for (const [callId, name] of openToolCalls) opts.onProgress?.(snapshot(state, { phase: "end", callId, name, failed: true }));
				openToolCalls.clear();
				opts.onProgress?.(snapshot(state));
				resolveP(code);
			};

			// Idle timeout: a child that emits NOTHING for `timeoutMs` is treated as hung
			// and killed — but any output (re)arms the timer, so a long-but-*active* agent
			// (streaming turn/tool events) keeps running.
			// Hard wall-clock cap: armed ONCE, never re-armed by output — a definite lifetime ceiling
			// that kills a busy-but-non-converging child the idle window above never catches.
			const armHardCap = () => {
				if (!opts.hardTimeoutMs || opts.hardTimeoutMs <= 0 || settled || killing) return;
				hardTimer = setTimeout(() => {
					hardTimedOut = true;
					kill();
				}, opts.hardTimeoutMs);
				hardTimer.unref?.();
			};
			const armTimeout = () => {
				if (!opts.timeoutMs || opts.timeoutMs <= 0 || settled || killing) return;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					timedOut = true;
					kill();
				}, opts.timeoutMs);
				timer.unref?.();
			};
			// Startup deadline: armed ONCE at spawn, cancelled the instant the child makes real
			// progress. Fires for a child that has produced no assistant output at all (no completed
			// turn / tokens / streamed text) — the header line + bare turn_start noise do NOT count,
			// so a stalled init is caught while a slow-but-streaming turn survives. It cannot see
			// the difference between a hung init and a first provider response that simply hasn't
			// arrived, so the window has to be sized for the slowest acceptable cold start.
			const armStartup = () => {
				if (!opts.startupTimeoutMs || opts.startupTimeoutMs <= 0 || settled || killing) return;
				startupTimer = setTimeout(() => {
					if (progressed) return;
					startupTimedOut = true;
					kill();
				}, opts.startupTimeoutMs);
				startupTimer.unref?.();
			};
			const noteProgress = () => {
				if (progressed) return;
				const s = snapshot(state);
				if (s.turns > 0 || s.tokens > 0 || s.output.length > 0) {
					progressed = true;
					if (startupTimer) clearTimeout(startupTimer);
				}
			};

			// Deliver the task and close stdin (pi waits for EOF before starting). A child
			// that dies before reading (spawn failure, early exit) emits an async 'error'
			// (EPIPE) on stdin — tolerate it, the exit path reports the real cause.
			proc.stdin?.on("error", () => {});
			proc.stdin?.end(taskInput);

			proc.stdout?.setEncoding("utf8");
			proc.stdout?.on("data", (d: string) => {
				if (oversizedLine) return; // already failing loudly — stop processing the flood
				const { lines, rest } = feedLines(buffer, d);
				// An unterminated line over maxLineBytes is stream noise (or a stuck flood),
				// never a leg's real output. Dropping it silently would let a flooded leg
				// "succeed" on truncated output — kill the child and fail LOUDLY instead.
				if (rest.length > maxLineBytes) {
					oversizedLine = true;
					buffer = "";
					kill();
					return;
				}
				buffer = rest;
				for (const l of lines) onLine(l);
				noteProgress(); // first real progress cancels the startup deadline
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

			proc.on("close", (code, sig) => {
				exited = true;
				// POSIX signal death closes with code=null. Mapping that to 0 would report a
				// child killed by something OUTSIDE this engine (OOM killer, `kill -9`, shutdown)
				// as a clean success carrying its truncated mid-run output — none of the
				// abort/timeout flags are set for those, so nothing else would catch it.
				// A null code WITHOUT a signal is just as abnormal (a wedged spawn): never 0.
				if (sig) killSignal = sig;
				if (code === null && !sig) diedWithoutStatus = true;
				finish(code ?? 1);
			});
			// A spawn failure (e.g. ENOENT: `pi` not on PATH) must not be silently
			// folded into a bare exit code — capture it so it surfaces in errorMessage.
			proc.on("error", (err: Error) => {
				spawnError = err;
				finish(1);
			});

			armTimeout(); // start the idle clock (reset on every chunk of output)
			armHardCap(); // start the lifetime ceiling (never reset)
			armStartup(); // start the first-progress deadline (cancelled by the first real progress)
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		const ok =
			!aborted &&
			!timedOut &&
			!hardTimedOut &&
			!startupTimedOut &&
			!oversizedLine &&
			!diedWithoutStatus &&
			exitCode === 0 &&
			state.stopReason !== "error" &&
			state.stopReason !== "aborted";
		const result: ChildRunResult = {
			ok,
			output: state.output,
			usage: state.usage,
			exitCode,
			stderr,
			aborted,
			// A hard-cap OR startup-deadline kill is a timeout-class death (never a provider reroute) —
			// surface it via the same flag the idle timeout uses; the errorMessage below says WHICH fired.
			timedOut: timedOut || hardTimedOut || startupTimedOut,
		};
		if (state.model !== undefined) result.model = state.model;
		if (state.stopReason !== undefined) result.stopReason = state.stopReason;
		// errorMessage precedence: a timeout/abort is the *cause of death*, so label
		// it explicitly and fold in any stream-level error rather than letting the
		// stream message hide why the child actually stopped.
		const streamErr = state.errorMessage;
		if (hardTimedOut) {
			result.errorMessage = `agent exceeded the ${opts.hardTimeoutMs}ms hard cap${streamErr ? ` (last error: ${streamErr})` : ""}`;
		} else if (startupTimedOut) {
			// Two readings fit the same evidence and the engine cannot distinguish them, so name
			// both: claiming "it never started" would misdirect the operator of a leg that did
			// start and was waiting on a slow first response.
			result.errorMessage = `agent produced no progress within the ${opts.startupTimeoutMs}ms startup window — either it never started (a stalled init, e.g. an MCP adapter hanging) or its first provider response was slower than the window (a queued or rate-limited provider, a cold local model); raise or disable the window with PI_PERSONA_AGENT_STARTUP_MS (0 disables)${streamErr ? ` (last error: ${streamErr})` : ""}`;
		} else if (timedOut) {
			result.errorMessage = `agent timed out — no output for ${opts.timeoutMs}ms${streamErr ? ` (last error: ${streamErr})` : ""}`;
		} else if (aborted) {
			result.errorMessage = `agent aborted${streamErr ? ` (last error: ${streamErr})` : ""}`;
		} else if (oversizedLine) {
			result.errorMessage = `agent emitted an unterminated line over ${maxLineBytes} bytes — killed as stream noise (a flooded leg fails loudly; it never "succeeds" on truncated output)`;
		} else if (diedWithoutStatus) {
			result.errorMessage = `agent process closed without an exit code or signal${streamErr ? ` (last error: ${streamErr})` : ""}`;
		} else if (spawnError) {
			result.errorMessage = `failed to spawn pi: ${spawnError.message}`;
		} else if (killSignal) {
			// Reached only for a kill this engine did NOT initiate — the branches above own
			// every engine-initiated one and say which deadline fired.
			result.errorMessage = `agent process was killed by ${killSignal}${streamErr ? ` (last error: ${streamErr})` : ""}`;
		} else if (streamErr !== undefined) {
			result.errorMessage = streamErr;
		}
		return result;
	} finally {
		prompt?.cleanup();
	}
}
