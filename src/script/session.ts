/** Scripts are exit-only executions with their own identity, admission and delivery plane.
 * The shared monitor lifecycle owns deadlines, output bounds and process-tree cleanup. */
import { createMonitorSession, type MonitorSessionDeps } from "../monitor/session.ts";

export function createScriptSession(deps: Omit<MonitorSessionDeps, "source">) {
	const session = createMonitorSession({ ...deps, source: "script" });
	return {
		...session,
		arm: (spec: Parameters<typeof session.arm>[0]) => session.arm({ ...spec, mode: "exit", maxEvents: 1 }),
	};
}

export type ScriptSession = ReturnType<typeof createScriptSession>;
