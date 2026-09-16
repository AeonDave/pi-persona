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
	/** Per-agent STARTUP deadline (ms): a child that produces no progress of its own (no completed
	 *  turn / tokens / streamed assistant output) within this window is killed as a stalled start.
	 *  It exists because the idle watchdog cannot catch a hung start — that watchdog is re-armed by
	 *  ANY stdout, and a child emits header/noise before it does any work.
	 *
	 *  The window must cover the WHOLE cold start, not just init: spawn, pi init, MCP init, and the
	 *  first provider response. A queued or rate-limited provider (a 429 carrying a 60s
	 *  retry-after, then retried), a cold serverless endpoint, or a local model doing a long prompt
	 *  eval on CPU can all exceed a tight window while perfectly healthy — and this deadline KILLS,
	 *  where the idle watchdog would have let the leg live. Killing healthy work costs the user
	 *  more than a dead leg settling slowly, so the default is deliberately generous.
	 *  300000 (5 min) by default; PI_PERSONA_AGENT_STARTUP_MS=0 disables it. */
	agentStartupTimeoutMs: number;
	/** Delegation nudge: when a delegating supervisor grinds a RUN of hands-on commands by hand (a
	 *  by-hand sweep) without a hand-off, append a reminder to the offending tool's result. On by
	 *  default; PI_PERSONA_NUDGE=off opts out. */
	nudge: boolean;
	/** Cross-process broker (spec B1-B7): on by default so child-engine legs (MCP, worktree,
	 *  `PI_PERSONA_ENGINE=child`) expose the same steer/contact_supervisor plane in-process
	 *  runs already have. The host still starts lazily on the first child-engine build.
	 *  PI_PERSONA_BROKER=off restores pre-broker spawn env (no host, no extra env vars). */
	broker: boolean;
	/** External agent-to-agent plane (exocom): independent top-level instances in one workspace
	 *  discover + message each other. Opt-in, OFF by default (PI_PERSONA_EXOCOM=1 / --exocom),
	 *  additionally gated by the persona's canUseBus. */
	exocom: boolean;
	/** How many settled-but-uncollected async runs {@link AsyncRunTracker} retains before
	 *  FIFO-evicting the oldest completed ones. 25 by default (today's hardcoded bound); set
	 *  PI_PERSONA_ASYNC_RETAIN=<n> (a finite value >= 1) to raise it under heavy fan-out. A
	 *  value < 1 (junk, negative, or 0 — not a meaningful retention bound) keeps the default. */
	asyncRetain: number;
	/** Opt-in wider {@link DelegationLedger} veto key: OFF (default) keys purely on
	 *  `agent+model+task` (today's veto *behavior* — unchanged; the key bytes themselves have
	 *  moved on, NUL → space → `\x1f`, but record/vet always share the same key() so it
	 *  cancels out). ON additionally folds in `role`/`tools`/`isolation`, so a genuine retry
	 *  that only changes those isn't falsely vetoed as "identical" by the 2-strike anti-loop
	 *  guard. Truthy convention mirrors exocom — see {@link OFF_WORDS}. */
	ledgerV2: boolean;
	/** Source selector for the spine — the shared behavioral layer injected between Pi's base
	 *  prompt and the persona body (docs/SPINE.md). `""` ⇒ off (the default; composition stays
	 *  byte-identical to pre-spine), `"on"` ⇒ the user-dir `spine.md` if present else the
	 *  bundled one, anything else ⇒ that path. Off convention mirrors exocom (see
	 *  {@link OFF_WORDS}); the value is otherwise kept VERBATIM because it is a path. */
	spine: string;
	/** Source selector for the spine DELEGATED LEGS get — the worker variant, a different prompt
	 *  doing a different job. Same grammar as {@link PiPersonaConfig.spine}, and it FOLLOWS that
	 *  value unless PI_PERSONA_SPINE_LEGS is set: one switch still lifts both roles, while the two
	 *  together express the four measurement arms of docs/SPINE.md (off / supervisor-only /
	 *  legs-only / both), which one selector cannot. */
	spineLegs: string;
}

type Env = Record<string, string | undefined>;

/** The words that mean "off" for an opt-in switch. `false`/`no` are in here because they are
 *  what a user actually types: without them `PI_PERSONA_EXOCOM=false` reads as truthy and
 *  `PI_PERSONA_SPINE=false` is reinterpreted as a relative file PATH. Exported (read-only) so
 *  the `{@link OFF_WORDS}` references on the switches above resolve for a reader holding only
 *  the emitted types — a link into a module-private const documents nothing outside this file. */
export const OFF_WORDS: ReadonlySet<string> = new Set(["", "off", "0", "false", "no"]);

/** The words that mean "on". Symmetric with {@link OFF_WORDS} and needed for the same reason: a
 *  switch whose value can also be a PATH cannot treat "not off" as "on", so `1`/`true`/`yes` —
 *  which the broker's own docs teach users to type — would otherwise be resolved as relative
 *  filenames. */
export const ON_WORDS: ReadonlySet<string> = new Set(["on", "1", "true", "yes"]);

/** One definition of "off", shared by the switches whose value is a plain flag or a path. The
 *  older boolean switches (`persist`, `nudge`, `seed`, `disabled`, `delegateDefaultAllow`)
 *  predate it and keep their own published conventions — changing those would alter what an
 *  existing user's environment means. Unset counts as off. `broker` uses this helper with a
 *  default-on pin (`PI_PERSONA_BROKER ?? "on"`). */
function isOff(value: string | undefined): boolean {
	return OFF_WORDS.has((value ?? "").trim().toLowerCase());
}

/** The spine selectors' shared value grammar: an off word ⇒ `""`, an on word ⇒ `"on"`, anything
 *  else is a PATH. Only the SELECTOR words are matched case-insensitively; a path survives
 *  verbatim, case included, because filesystems are case-sensitive. */
function spineSelector(raw: string): string {
	if (isOff(raw)) return "";
	return ON_WORDS.has(raw.trim().toLowerCase()) ? "on" : raw;
}

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
		// "deny" locks the delegate roster down; the shared OFF_WORDS are accepted as the same
		// request (additive — "off" previously meant default-ALLOW, a security default a user
		// could believe they had tightened while changing nothing).
		delegateDefaultAllow: (() => {
			const v = env.PI_PERSONA_DELEGATE_DEFAULT?.trim().toLowerCase();
			if (v === undefined || v === "") return true; // unset stays default-allow
			return v !== "deny" && !OFF_WORDS.has(v);
		})(),
		// Opt-in: auto-install the bundled defaults on first run ONLY when explicitly enabled with
		// `PI_PERSONA_SEED=on`. Default off — personas are installed via `/persona seed|restore`.
		seed: env.PI_PERSONA_SEED?.trim().toLowerCase() === "on",
		peekEveryMs: 30_000,
		checkInEveryMs: 300_000,
		// Opt-in: 0 = no hard cap (a healthy child runs to completion). The idle watchdog
		// (RUN_LIMITS.timeoutMs, reset on progress) + startup deadline + token budget are the
		// always-on backstops; set PI_PERSONA_AGENT_MAX_MS=<ms> to arm a wall-clock ceiling.
		agentHardTimeoutMs: 0,
		agentStartupTimeoutMs: 300_000,
		// On unless explicitly turned off (mirrors PI_PERSONA_PERSIST's `!== "off"` convention).
		nudge: env.PI_PERSONA_NUDGE?.trim().toLowerCase() !== "off",
		// On unless explicitly turned off, so an MCP/worktree/child-engine async leg is
		// steerable without a hidden env pin. Off-words restore pre-broker spawn env.
		broker: !isOff(env.PI_PERSONA_BROKER ?? "on"),
		exocom: false,
		asyncRetain: 25,
		ledgerV2: false,
		spine: "",
		spineLegs: "",
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
	// A finite value >= 1 sets the retention bound; 0 isn't meaningful here (unlike the interval
	// knobs above, where 0 opts out) so it — like junk/negative — falls back to the default 25.
	const asyncRetainRaw = env.PI_PERSONA_ASYNC_RETAIN?.trim();
	if (asyncRetainRaw !== undefined && asyncRetainRaw !== "") {
		const retain = Number(asyncRetainRaw);
		if (Number.isFinite(retain) && retain >= 1) config.asyncRetain = retain;
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
	config.exocom = !isOff(env.PI_PERSONA_EXOCOM);
	config.ledgerV2 = !isOff(env.PI_PERSONA_LEDGER_V2);
	config.spine = spineSelector(env.PI_PERSONA_SPINE?.trim() ?? "");
	// The legs' selector FOLLOWS the supervisor's unless it is set, so one switch still lifts both
	// roles while the pair expresses all four measurement arms (docs/SPINE.md). Present-but-empty
	// counts as UNSET here rather than as the off word it is elsewhere: `PI_PERSONA_SPINE_LEGS=` is
	// how a shell clears a variable, and an inherited empty splitting the legs off from the
	// supervisor would be a silent, invisible arm nobody chose.
	const legsRaw = env.PI_PERSONA_SPINE_LEGS?.trim();
	config.spineLegs = legsRaw ? spineSelector(legsRaw) : config.spine;
	return config;
}
