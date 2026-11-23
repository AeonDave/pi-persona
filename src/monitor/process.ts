/** Direct executable monitor process adapter.
 *
 * This module owns only OS process plumbing. MonitorManager owns admission,
 * deadlines, deduplication, and wake events; late process callbacks are ignored
 * after the adapter is stopped or has terminated.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { killProcessTree } from "../engine/child.ts";
import {
	MONITOR_EXIT_DRAIN_MS,
	type MonitorProcess,
	type MonitorProcessHandlers,
	type MonitorSpec,
} from "../core/monitor.ts";

interface ProcessState {
	stopped: boolean;
	ended: boolean;
}

/** Start one explicit executable with literal argv; no shell interpolation is performed.
 *
 * The job is the launched program: it settles when that program exits, after reading already-buffered
 * output for at most MONITOR_EXIT_DRAIN_MS. A descendant that inherited stdout/stderr and outlives the
 * launcher is not stopped here (Windows cannot reach it once the launcher pid is gone); the pipes are
 * destroyed so it cannot keep this process's event loop alive. */
export function startMonitorProcess(spec: MonitorSpec, handlers: MonitorProcessHandlers): MonitorProcess {
	const state: ProcessState = {
		stopped: false,
		ended: false,
	};
	let child: ChildProcess | undefined;
	let drainTimer: ReturnType<typeof setTimeout> | undefined;

	const active = (): boolean => !state.stopped && !state.ended;
	const releasePipes = (): void => {
		clearTimeout(drainTimer);
		for (const stream of [child?.stdout, child?.stderr, child?.stdin]) {
			try {
				stream?.destroy();
			} catch {
				/* a stream that cannot be destroyed has nothing left to release */
			}
		}
	};
	const stopOwned = (): void => {
		if (state.stopped || state.ended) return;
		state.stopped = true;
		// A descendant that outlives the launcher keeps the pipes open, and finish() no longer runs
		// to release them once the adapter is stopped.
		releasePipes();
		const pid = child?.pid;
		if (pid === undefined) return;
		try {
			killProcessTree(pid);
		} catch {
			/* best effort; late callbacks remain suppressed by state.stopped */
		}
	};
	const emitError = (error: Error): void => {
		if (!active()) return;
		try {
			handlers.onError(error);
		} catch {
			// An error sink is external code. It cannot prevent owned-process cleanup.
		}
		stopOwned();
	};

	const decoderOut = new StringDecoder("utf8");
	const decoderErr = new StringDecoder("utf8");

	const finish = (code: number | null, signal: NodeJS.Signals | null, lingering: boolean): void => {
		if (!active()) return;
		const trailingOut = decoderOut.end();
		const trailingErr = decoderErr.end();
		try {
			if (trailingOut) handlers.onStdout(trailingOut);
			if (trailingErr) handlers.onStderr(trailingErr);
		} catch {
			stopOwned();
			return;
		}
		if (!active()) return;
		state.ended = true;
		releasePipes();
		try {
			handlers.onExit(code, signal ?? undefined, lingering);
		} catch {
			/* the process is already closed; keep the adapter terminal */
		}
	};

	try {
		child = spawn(spec.command, [...(spec.args ?? [])], {
			cwd: spec.cwd,
			shell: false,
			stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}

	child.on("error", (error) => emitError(error));
	if (spec.stdin !== undefined) {
		// An executable can close stdin before consuming it. EPIPE is an input lifecycle detail;
		// its real exit/error and final stream drain remain authoritative.
		child.stdin?.on("error", () => {});
		child.stdin?.end(spec.stdin);
	}
	child.stdout?.on("error", (error) => emitError(error instanceof Error ? error : new Error(String(error))));
	child.stderr?.on("error", (error) => emitError(error instanceof Error ? error : new Error(String(error))));
	child.stdout?.on("data", (chunk: Buffer | string) => {
		if (!active()) return;
		const decoded = typeof chunk === "string" ? chunk : decoderOut.write(chunk);
		if (!decoded) return;
		try {
			handlers.onStdout(decoded);
		} catch {
			stopOwned();
		}
	});
	child.stderr?.on("data", (chunk: Buffer | string) => {
		if (!active()) return;
		const decoded = typeof chunk === "string" ? chunk : decoderErr.write(chunk);
		if (!decoded) return;
		try {
			handlers.onStderr(decoded);
		} catch {
			stopOwned();
		}
	});
	// Pipes that close with the process settle on "close"; a descendant that still holds them is cut off
	// one bounded window after the exit, which is never re-armed by that descendant's output.
	child.on("exit", (code, signal) => {
		if (!active()) return;
		drainTimer = setTimeout(() => finish(code, signal, true), MONITOR_EXIT_DRAIN_MS);
	});
	child.on("close", (code, signal) => finish(code, signal, false));

	return {
		stop: stopOwned,
	};
}
