/** Bounded OS process seam used only by the package qualifier (never a shell). */
import { spawn, type ChildProcess } from "node:child_process";

export function stopQualificationProcessTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
		killer.on("error", () => { child.kill("SIGKILL"); });
	} else {
		try { process.kill(-child.pid, "SIGKILL"); }
		catch { child.kill("SIGKILL"); }
	}
}

interface ProcessOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }
export interface ProcessResult { code: number | null; stdout: string; stderr: string }

export function runQualificationProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
		let stdout = "", stderr = "";
		let failure: Error | undefined;
		let forceDeadline: ReturnType<typeof setTimeout> | undefined;
		const fail = (error: Error) => {
			if (failure) return;
			failure = error;
			stopQualificationProcessTree(child);
			forceDeadline = setTimeout(() => reject(new Error(`${error.message}; process close not observed`)), 5000);
		};
		const timer = setTimeout(() => fail(new Error(`Process deadline exceeded (${options.timeoutMs} ms): ${command}`)), options.timeoutMs);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout = (stdout + chunk).slice(0, 4 * 1024 * 1024 + 1);
			if (stdout.length > 4 * 1024 * 1024) fail(new Error("Qualification stdout limit exceeded"));
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(0, 4 * 1024 * 1024 + 1);
			if (stderr.length > 4 * 1024 * 1024) fail(new Error("Qualification stderr limit exceeded"));
		});
		child.on("error", (error) => { failure ??= error; });
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(forceDeadline);
			if (failure) reject(failure); else resolve({ code, stdout, stderr });
		});
	});
}
