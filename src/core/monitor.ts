/**
 * Pure monitor lifecycle and admission state.
 *
 * The process adapter is injected so this module can enforce limits, deadlines,
 * cancellation, and event shaping without touching the operating system.
 */

export type MonitorMode = "output" | "exit";

export interface MonitorSpec {
	command: string;
	args?: string[];
	cwd: string;
	label: string;
	mode: MonitorMode;
	timeoutMs?: number;
	maxEvents?: number;
}

export interface MonitorEntry {
	id: string;
	label: string;
	command: string;
	args: string[];
	cwd: string;
	mode: MonitorMode;
	startedAtEpochMs: number;
	expiresAtEpochMs: number;
	maxEvents: number;
}

export interface MonitorEvent {
	id: string;
	label: string;
	kind: "output" | "exit" | "error" | "timeout";
	atEpochMs: number;
	text: string;
	terminal: boolean;
}

export interface MonitorProcessHandlers {
	onStdout: (chunk: string) => void;
	onStderr: (chunk: string) => void;
	onExit: (code: number | null, signal?: string) => void;
	onError: (error: Error) => void;
}

export interface MonitorProcess {
	stop: () => void;
}

export interface MonitorManagerDeps {
	now: () => number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	start: (spec: MonitorSpec, handlers: MonitorProcessHandlers) => MonitorProcess;
	onEvent: (event: MonitorEvent) => void;
}

export type MonitorArmResult =
	| { ok: true; entry: MonitorEntry }
	| { ok: false; error: string };

export const MONITOR_MAX_ACTIVE = 8;
export const MONITOR_DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
export const MONITOR_MIN_TIMEOUT_MS = 1_000;
export const MONITOR_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const MONITOR_DEFAULT_MAX_EVENTS = 1;
export const MONITOR_MAX_EVENTS = 20;
export const MONITOR_MAX_LINE_CHARS = 4_000;
export const MONITOR_MAX_DIAGNOSTIC_CHARS = 4_000;
export const MONITOR_MAX_COMMAND_CHARS = 4_096;
export const MONITOR_MAX_ARGS = 64;
export const MONITOR_MAX_ARG_CHARS = 8_192;
export const MONITOR_MAX_ARGV_CHARS = 24_000;
export const MONITOR_MAX_LABEL_CHARS = 120;
export const MONITOR_TRUNCATION_MARKER = "…[truncated]";

interface ActiveMonitor {
	entry: MonitorEntry;
	handle?: unknown;
	hasHandle: boolean;
	starting: boolean;
	startError?: string;
	process?: MonitorProcess;
	terminal: boolean;
	stdoutBuffer: string;
	stdoutTail: string;
	stderrTail: string;
	seenLines: Set<string>;
	eventsSeen: number;
	lineHash: number;
	lineLength: number;
}

function appendTail(current: string, chunk: string, limit: number): string {
	if (!chunk) return current;
	if (current.length + chunk.length <= limit) return current + chunk;
	const keep = Math.max(0, limit - MONITOR_TRUNCATION_MARKER.length);
	if (chunk.length >= keep) return `${MONITOR_TRUNCATION_MARKER}${chunk.slice(-keep)}`;
	const room = keep - chunk.length;
	return `${MONITOR_TRUNCATION_MARKER}${current.length > room ? current.slice(-room) : current}${chunk}`;
}

function appendBoundedLine(current: string, chunk: string): string {
	if (chunk.length === 0) return current;
	if (current.length + chunk.length <= MONITOR_MAX_LINE_CHARS) return current + chunk;
	const keep = MONITOR_MAX_LINE_CHARS - MONITOR_TRUNCATION_MARKER.length;
	const prefix = current.length >= keep ? current.slice(0, keep) : current + chunk.slice(0, keep - current.length);
	return `${prefix}${MONITOR_TRUNCATION_MARKER}`;
}

function hashLine(hash: number, text: string): number {
	let value = hash;
	for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16_777_619) >>> 0;
	return value;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function copyEntry(entry: MonitorEntry): MonitorEntry {
	return { ...entry, args: [...entry.args] };
}

export class MonitorManager {
	private readonly deps: MonitorManagerDeps;
	private readonly monitors = new Map<string, ActiveMonitor>();
	private sequence = 0;

	constructor(deps: MonitorManagerDeps) {
		this.deps = deps;
	}

	arm(request: MonitorSpec): MonitorArmResult {
		const validation = this.validate(request);
		if (validation) return { ok: false, error: validation };
		if (this.monitors.size >= MONITOR_MAX_ACTIVE) {
			return { ok: false, error: `too many active monitors (maximum ${MONITOR_MAX_ACTIVE}); cancel one before arming another.` };
		}

		const timeoutMs = request.timeoutMs ?? MONITOR_DEFAULT_TIMEOUT_MS;
		const maxEvents = request.maxEvents ?? MONITOR_DEFAULT_MAX_EVENTS;
		const now = this.deps.now();
		const id = `monitor-${++this.sequence}`;
		const entry: MonitorEntry = {
			id,
			label: request.label.trim(),
			command: request.command,
			args: [...(request.args ?? [])],
			cwd: request.cwd,
			mode: request.mode,
			startedAtEpochMs: now,
			expiresAtEpochMs: now + timeoutMs,
			maxEvents,
		};
		const active: ActiveMonitor = {
			entry,
			hasHandle: false,
			starting: true,
			terminal: false,
			stdoutBuffer: "",
			stdoutTail: "",
			stderrTail: "",
			seenLines: new Set<string>(),
			eventsSeen: 0,
			lineHash: 2_166_136_261,
			lineLength: 0,
		};
		this.monitors.set(id, active);

		const handlers: MonitorProcessHandlers = {
			onStdout: (chunk) => this.receiveStdout(id, chunk),
			onStderr: (chunk) => this.receiveStderr(id, chunk),
			onExit: (code, signal) => this.receiveExit(id, code, signal),
			onError: (error) => this.receiveError(id, error),
		};

		try {
			const process = this.deps.start(
				{
					...request,
					args: [...(request.args ?? [])],
					timeoutMs,
					maxEvents,
				},
				handlers,
			);
			active.process = process;
			active.starting = false;
			if (active.startError !== undefined) {
				try {
					process.stop();
				} catch {
					/* best effort; the synchronous start failure is already terminal */
				}
				return { ok: false, error: `could not start monitor: ${active.startError}` };
			}
			// A synchronous fake or spawn wrapper can finish before start() returns. In that
			// case terminal() already removed the monitor, but the returned process still needs
			// the cleanup call so it cannot keep producing late callbacks.
			if (active.terminal) {
				process.stop();
				return { ok: true, entry: copyEntry(entry) };
			}
			const handle = this.deps.setTimer(() => this.timeout(id), timeoutMs);
			if (active.terminal || this.monitors.get(id) !== active) {
				this.deps.clearTimer(handle);
			} else {
				active.handle = handle;
				active.hasHandle = true;
			}
		} catch (error) {
			this.removeWithoutEvent(active);
			return { ok: false, error: `could not start monitor: ${errorText(error)}` };
		}

		return { ok: true, entry: copyEntry(entry) };
	}

	list(): MonitorEntry[] {
		return [...this.monitors.values()]
			.sort((a, b) => a.entry.startedAtEpochMs - b.entry.startedAtEpochMs || a.entry.id.localeCompare(b.entry.id))
			.map((active) => copyEntry(active.entry));
	}

	cancel(id: string): boolean {
		const active = this.monitors.get(id);
		if (!active) return false;
		this.removeWithoutEvent(active);
		return true;
	}

	cancelAll(): void {
		for (const active of [...this.monitors.values()]) this.removeWithoutEvent(active);
	}

	private validate(request: MonitorSpec): string | undefined {
		if (!request || typeof request !== "object") return "monitor spec is required.";
		if (typeof request.command !== "string" || request.command.trim().length === 0) return "monitor command must be a non-empty executable name.";
		if (request.command.length > MONITOR_MAX_COMMAND_CHARS) return `monitor command exceeds the maximum ${MONITOR_MAX_COMMAND_CHARS} characters.`;
		if (request.command.includes("\0")) return "monitor command cannot contain NUL bytes.";
		if (typeof request.cwd !== "string" || request.cwd.trim().length === 0) return "monitor cwd must be a non-empty directory.";
		if (request.cwd.includes("\0")) return "monitor cwd cannot contain NUL bytes.";
		if (typeof request.label !== "string" || request.label.trim().length === 0) return "monitor label must be non-empty.";
		if (request.label.length > MONITOR_MAX_LABEL_CHARS) return `monitor label exceeds the maximum ${MONITOR_MAX_LABEL_CHARS} characters.`;
		if (request.label.includes("\0")) return "monitor label cannot contain NUL bytes.";
		if (request.mode !== "output" && request.mode !== "exit") return "monitor mode must be `output` or `exit`.";
		if (request.args !== undefined && (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string"))) return "monitor args must be an array of strings.";
		if (request.args !== undefined && request.args.length > MONITOR_MAX_ARGS) return `monitor args exceeds the maximum ${MONITOR_MAX_ARGS} items.`;
		if (request.args?.some((arg) => arg.includes("\0"))) return "monitor args cannot contain NUL bytes.";
		if (request.args?.some((arg) => arg.length > MONITOR_MAX_ARG_CHARS)) return `a monitor argument exceeds the maximum ${MONITOR_MAX_ARG_CHARS} characters.`;
		const argvChars = (request.args ?? []).reduce((total, arg) => total + arg.length, 0);
		if (argvChars > MONITOR_MAX_ARGV_CHARS) return `monitor arguments exceed the maximum ${MONITOR_MAX_ARGV_CHARS} characters combined.`;

		const timeoutMs = request.timeoutMs ?? MONITOR_DEFAULT_TIMEOUT_MS;
		if (!Number.isFinite(timeoutMs) || timeoutMs < MONITOR_MIN_TIMEOUT_MS) return `monitor timeoutMs must be at least ${MONITOR_MIN_TIMEOUT_MS}ms.`;
		if (timeoutMs > MONITOR_MAX_TIMEOUT_MS) return `monitor timeoutMs exceeds the maximum ${MONITOR_MAX_TIMEOUT_MS}ms.`;

		const maxEvents = request.maxEvents ?? MONITOR_DEFAULT_MAX_EVENTS;
		if (!Number.isInteger(maxEvents) || maxEvents < 1) return "monitor maxEvents must be a positive integer.";
		if (maxEvents > MONITOR_MAX_EVENTS) return `monitor maxEvents exceeds the maximum ${MONITOR_MAX_EVENTS}.`;
		return undefined;
	}

	private timeout(id: string): void {
		const active = this.monitors.get(id);
		if (!active || active.terminal) return;
		const diagnostics = this.diagnostics(active);
		const suffix = diagnostics ? `\n${diagnostics}` : "";
		this.finish(active, {
			id: active.entry.id,
			label: active.entry.label,
			kind: "timeout",
			atEpochMs: this.deps.now(),
			text: `monitor timed out after ${active.entry.expiresAtEpochMs - active.entry.startedAtEpochMs}ms${suffix}`,
			terminal: true,
		});
	}

	private receiveStdout(id: string, chunk: string): void {
		const active = this.monitors.get(id);
		if (!active || active.terminal || !chunk) return;
		if (active.entry.mode === "exit") {
			active.stdoutTail = appendTail(active.stdoutTail, chunk, MONITOR_MAX_DIAGNOSTIC_CHARS);
			return;
		}

		let start = 0;
		while (true) {
			const newline = chunk.indexOf("\n", start);
			if (newline < 0) {
				const remainder = chunk.slice(start);
				active.stdoutBuffer = appendBoundedLine(active.stdoutBuffer, remainder);
				active.lineHash = hashLine(active.lineHash, remainder);
				active.lineLength += remainder.length;
				return;
			}
			// Hash the same bytes regardless of where the stream chunk split landed. Display
			// trimming happens at emitOutput, after a CR from either chunk has contributed.
			const line = chunk.slice(start, newline);
			active.stdoutBuffer = appendBoundedLine(active.stdoutBuffer, line);
			active.lineHash = hashLine(active.lineHash, line);
			active.lineLength += line.length;
			this.emitOutput(active, active.stdoutBuffer, `${active.lineLength}:${active.lineHash}`);
			active.stdoutBuffer = "";
			active.lineHash = 2_166_136_261;
			active.lineLength = 0;
			if (active.terminal) return;
			start = newline + 1;
			if (start >= chunk.length) {
				active.stdoutBuffer = "";
				return;
			}
		}
	}

	private receiveStderr(id: string, chunk: string): void {
		const active = this.monitors.get(id);
		if (!active || active.terminal) return;
		active.stderrTail = appendTail(active.stderrTail, chunk, MONITOR_MAX_DIAGNOSTIC_CHARS);
	}

	private receiveExit(id: string, code: number | null, signal?: string): void {
		const active = this.monitors.get(id);
		if (!active || active.terminal) return;
		this.finish(active, {
			id: active.entry.id,
			label: active.entry.label,
			kind: "exit",
			atEpochMs: this.deps.now(),
			text: this.exitText(active, code, signal),
			terminal: true,
		});
	}

	private receiveError(id: string, error: Error): void {
		const active = this.monitors.get(id);
		if (!active || active.terminal) return;
		if (active.starting) {
			active.startError = error.message;
			this.removeWithoutEvent(active);
			return;
		}
		const diagnostics = this.diagnostics(active);
		this.finish(active, {
			id: active.entry.id,
			label: active.entry.label,
			kind: "error",
			atEpochMs: this.deps.now(),
			text: `monitor process error: ${error.message}${diagnostics ? `\n${diagnostics}` : ""}`,
			terminal: true,
		});
	}

	private emitOutput(active: ActiveMonitor, rawLine: string, identity: string): void {
		const line = rawLine.trim();
		if (!line || active.terminal || active.seenLines.has(identity)) return;
		active.seenLines.add(identity);
		active.eventsSeen++;
		const terminal = active.eventsSeen >= active.entry.maxEvents;
		const event: MonitorEvent = {
			id: active.entry.id,
			label: active.entry.label,
			kind: "output",
			atEpochMs: this.deps.now(),
			text: line,
			terminal,
		};
		if (terminal) this.finish(active, event);
		else this.deps.onEvent(event);
	}

	private exitText(active: ActiveMonitor, code: number | null, signal?: string): string {
		const status = code === null
			? `process exited by ${signal ?? "unknown signal"}`
			: `process exited with exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
		const diagnostics = this.diagnostics(active);
		return diagnostics ? `${status}\n${diagnostics}` : status;
	}

	private diagnostics(active: ActiveMonitor): string {
		const parts: string[] = [];
		if (active.stdoutTail) parts.push(`stdout:\n${active.stdoutTail}`);
		if (active.entry.mode === "output" && active.stdoutBuffer) parts.push(`partial stdout (unterminated):\n${active.stdoutBuffer}`);
		if (active.stderrTail) parts.push(`stderr:\n${active.stderrTail}`);
		return parts.join("\n");
	}

	private finish(active: ActiveMonitor, event: MonitorEvent): void {
		if (active.terminal || this.monitors.get(active.entry.id) !== active) return;
		active.terminal = true;
		this.monitors.delete(active.entry.id);
		if (active.hasHandle) this.deps.clearTimer(active.handle);
		try {
			active.process?.stop();
		} catch {
			/* cleanup must not suppress the terminal wake */
		}
		this.deps.onEvent(event);
	}

	private removeWithoutEvent(active: ActiveMonitor): void {
		if (active.terminal || this.monitors.get(active.entry.id) !== active) return;
		active.terminal = true;
		this.monitors.delete(active.entry.id);
		if (active.hasHandle) this.deps.clearTimer(active.handle);
		try {
			active.process?.stop();
		} catch {
			/* best effort; cancellation remains terminal */
		}
	}
}
