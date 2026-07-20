/**
 * pi-persona configuration resolved from environment variables.
 *
 * Pure module — takes an injected env record so it is fully testable. The
 * canonical PI_PERSONA_* names are defined here once.
 */

import { isThinkingLevel } from "./types.ts";

export interface PiPersonaConfig {
	disabled: boolean;
	extraDirs: string[];
	defaultPersona?: string;
	keybinding: string;
	persist: boolean;
	delegateDefaultAllow: boolean;
	seed: boolean;
	/** Explicit override for the persisted-state file (else a global default). */
	stateFile?: string;
	/** Thinking level forced on delegated children (else the supervisor's level).
	 *  Spawned children must carry an *explicit* level or they fall into the model's
	 *  default mode ("adaptive"), which some models reject. */
	childThinking?: string;
	/** Engine backend for sub-agents: "inproc" (run in-process via `createAgentSession`,
	 *  the default) or "child" (spawn `pi -p`, the baseline). */
	engine?: "child" | "inproc";
	/** Fast stall/message wakeup interval (ms): while async children run, a tick checks progress but
	 *  stays SILENT unless a leg NEWLY looks stalled or a sub-agent messaged the supervisor — so a
	 *  healthy run never interrupts. On by default (30000); PI_PERSONA_PEEK_MS=0 opts out (the routine
	 *  check-in below is independent). */
	peekEveryMs: number;
	/** Routine check-in interval (ms): how often, while async children run, the idle supervisor gets
	 *  a compact progress digest so it can catch a leg going off-track (not stalled — just wrong) and
	 *  step in early. Deliberately slow so it is an occasional glance, not a poll, and independent of
	 *  the fast stall/message wakeup. 300000 (5 min) by default; PI_PERSONA_CHECKIN_MS=0 opts out. */
	checkInEveryMs: number;
	/** Per-agent hard wall-clock cap (ms): an OPT-IN lifetime ceiling. When set (>0) it settles even
	 *  a busy-but-non-converging child the idle watchdog (reset on every event) never catches.
	 *  DISABLED by default (0 = no cap / unlimited) so a healthy, progressing child runs to completion
	 *  instead of being killed mid-work; the idle watchdog + startup deadline + token budget remain the
	 *  always-on backstops. Set PI_PERSONA_AGENT_MAX_MS=<ms> to arm a hard cap. */
	agentHardTimeoutMs: number;
	/** Per-agent STARTUP deadline (ms): a spawned child that never makes progress (no completed
	 *  turn / tokens / streamed output) within this window is killed as a stalled start — the
	 *  fast-fail for a child that never began (e.g. an `mcp: true` leg whose MCP adapter hangs in
	 *  init inside the headless child), so a dead delegation settles in ~90s instead of the full
	 *  180s idle window. 90000 by default; PI_PERSONA_AGENT_STARTUP_MS=0 disables it. */
	agentStartupTimeoutMs: number;
	/** Delegation nudge: when a delegating supervisor grinds a RUN of hands-on commands by hand (a
	 *  by-hand sweep) without a hand-off, append a reminder to the offending tool's result. On by
	 *  default; PI_PERSONA_NUDGE=off opts out. */
	nudge: boolean;
	/** Opt-in cross-process broker (spec B1-B7): off (default) ⇒ the child engine spawns
	 *  exactly as today — no host, no extra env vars, zero behavior change. On ⇒ the
	 *  extension lazily starts a session-scoped host on the first child-engine build,
	 *  giving `PI_PERSONA_ENGINE=child` runs (and every worktree-isolated leg) the comm
	 *  plane + steer that in-process runs already have. */
	broker: boolean;
}

type Env = Record<string, string | undefined>;

function splitDirs(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/[;,]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function resolveConfig(env: Env): PiPersonaConfig {
	const disableFlag = env.PI_PERSONA_DISABLE;
	const def = env.PI_PERSONA_DEFAULT?.trim();

	const config: PiPersonaConfig = {
		disabled: disableFlag !== undefined && disableFlag.length > 0,
		extraDirs: splitDirs(env.PI_PERSONA_DIRS),
		keybinding: env.PI_PERSONA_KEY?.trim() || "f8",
		persist: env.PI_PERSONA_PERSIST?.trim().toLowerCase() !== "off",
		delegateDefaultAllow: env.PI_PERSONA_DELEGATE_DEFAULT?.trim().toLowerCase() !== "deny",
		// Opt-in: auto-install the bundled defaults on first run ONLY when explicitly enabled with
		// `PI_PERSONA_SEED=on`. Default off — personas are installed via `/persona seed|restore`.
		seed: env.PI_PERSONA_SEED?.trim().toLowerCase() === "on",
		peekEveryMs: 30_000,
		checkInEveryMs: 300_000,
		// Opt-in: 0 = no hard cap (a healthy child runs to completion). The idle watchdog
		// (RUN_LIMITS.timeoutMs, reset on progress) + startup deadline + token budget are the
		// always-on backstops; set PI_PERSONA_AGENT_MAX_MS=<ms> to arm a wall-clock ceiling.
		agentHardTimeoutMs: 0,
		agentStartupTimeoutMs: 90_000,
		// On unless explicitly turned off (mirrors PI_PERSONA_PERSIST's `!== "off"` convention).
		nudge: env.PI_PERSONA_NUDGE?.trim().toLowerCase() !== "off",
		// Any non-empty value opts in (mirrors PI_PERSONA_DISABLE's own convention) — the
		// live-drive doc/examples use PI_PERSONA_BROKER=1.
		broker: !!env.PI_PERSONA_BROKER && env.PI_PERSONA_BROKER.trim().length > 0,
	};
	// A valid finite value >= 0 sets the interval (0 opts out); junk/negative keeps the default.
	const peekRaw = env.PI_PERSONA_PEEK_MS?.trim();
	if (peekRaw !== undefined && peekRaw !== "") {
		const peek = Number(peekRaw);
		if (Number.isFinite(peek) && peek >= 0) config.peekEveryMs = peek;
	}
	const checkInRaw = env.PI_PERSONA_CHECKIN_MS?.trim();
	if (checkInRaw !== undefined && checkInRaw !== "") {
		const checkIn = Number(checkInRaw);
		if (Number.isFinite(checkIn) && checkIn >= 0) config.checkInEveryMs = checkIn;
	}
	const hardRaw = env.PI_PERSONA_AGENT_MAX_MS?.trim();
	if (hardRaw !== undefined && hardRaw !== "") {
		const hard = Number(hardRaw);
		if (Number.isFinite(hard) && hard >= 0) config.agentHardTimeoutMs = hard;
	}
	const startupRaw = env.PI_PERSONA_AGENT_STARTUP_MS?.trim();
	if (startupRaw !== undefined && startupRaw !== "") {
		const startup = Number(startupRaw);
		if (Number.isFinite(startup) && startup >= 0) config.agentStartupTimeoutMs = startup;
	}
	if (def) config.defaultPersona = def;
	const stateFile = env.PI_PERSONA_STATE_FILE?.trim();
	if (stateFile) config.stateFile = stateFile;
	const childThinking = env.PI_PERSONA_CHILD_THINKING?.trim().toLowerCase();
	if (childThinking && isThinkingLevel(childThinking)) config.childThinking = childThinking;
	// In-process is the default backend; opt back to the spawn-based child engine with
	// PI_PERSONA_ENGINE=child.
	const engine = env.PI_PERSONA_ENGINE?.trim().toLowerCase();
	config.engine = engine === "child" ? "child" : "inproc";
	return config;
}
