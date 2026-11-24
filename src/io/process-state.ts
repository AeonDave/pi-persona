/** Same-host ownership. Only ESRCH proves that a recorded process has exited. */
export function processState(pid: number): "alive" | "dead" | "unknown" {
	if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
	if (pid === process.pid) return "alive";
	try { process.kill(pid, 0); return "alive"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}
