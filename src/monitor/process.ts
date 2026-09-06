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
	type MonitorProcess,
	type MonitorProcessHandlers,
	type MonitorSpec,
} from "../core/monitor.ts";

interface ProcessState {
	stopped: boolean;
	ended: boolean;
}

/** Start one explicit executable with literal argv; no shell interpolation is performed. */
export function startMonitorProcess(spec: MonitorSpec, handlers: MonitorProcessHandlers): MonitorProcess {
	const state: ProcessState = {
		stopped: false,
		ended: false,
	};
	let child: ChildProcess | undefined;

	const active = (): boolean => !state.stopped && !state.ended;
	const stopOwned = (): void => {
		if (state.stopped || state.ended) return;
		state.stopped = true;
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

	const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
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
		try {
			handlers.onExit(code, signal ?? undefined);
		} catch {
			/* the process is already closed; keep the adapter terminal */
		}
	};

	try {
		child = spawn(spec.command, [...(spec.args ?? [])], {
			cwd: spec.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}

	child.on("error", (error) => emitError(error));
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
	child.on("close", (code, signal) => finish(code, signal));

	return {
		stop: stopOwned,
	};
}
