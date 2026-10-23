import { stripTerminalControls } from "../core/fence.ts";
import type { MonitorEntry, MonitorEvent, MonitorOutput } from "../core/monitor.ts";
import { MonitorOutputTail } from "../core/monitor-output.ts";
import type { TimerEntry } from "../core/timer.ts";
import type { AddNodeInput, AgentNodePatch, AgentNodeStatus } from "./agent-tree.ts";

/**
 * Wake-source rows — the pure mapping from monitor/timer lifecycle callbacks to agent-tree rows.
 *
 * Monitors and timers are background wake sources, not agents, but the operator should see them
 * beside the sub-agents: what is armed, when it is due, what it has produced, why it ended. This
 * module turns each lifecycle callback into an `AddNodeInput` / `AgentNodePatch` and nothing more:
 * no tree, no clock, no Pi imports. Every timestamp comes from the entry or event itself, so the
 * output is deterministic. Monitor labels, details and metadata are sanitized and bounded;
 * live output adds a single-line progress preview without becoming a semantic event. Anything
 * long — command, timer message, event history and bounded stdout/stderr tails — lives in
 * `output`, which only the F9 drill-in shows.
 */

/** Longest `command: …` description line (args may total 24k chars). */
const COMMAND_LINE_MAX = 2_000;
/** Longest first-line excerpt of one monitor event kept in the drill-in. */
const EVENT_TEXT_MAX = 1_000;
/** Longest first-line summary of a non-output terminal event, used as the row detail. */
const SUMMARY_MAX = 120;
/** Longest timer label shown on a row (the scheduler bounds it too; this projection does not trust that). */
const TIMER_LABEL_MAX = 120;
/** Event lines the drill-in remembers per monitor; older ones fall off the front. */
const MAX_EVENT_LINES = 40;
/** The manager's status line for a clean exit; diagnostics (stdout/stderr tails) follow on later lines. */
const CLEAN_EXIT = /\bexit code 0\b/;

/** Tree id of a wake-source row: `monitor:<id>` / `timer:<id>` (never collides with `async:`/strategy ids). */
export function wakeNodeId(kind: "monitor" | "timer", id: string): string {
	return `${kind}:${id}`;
}

export interface WakeRowChange {
	id: string;
	patch: AgentNodePatch;
}

export interface WakeRowEvent extends WakeRowChange {
	/** true when this event ended the watch (the row must settle and leave). */
	settled: boolean;
}

/** ISO-8601 for a display line; "?" for a non-finite or out-of-range instant instead of throwing. */
function iso(ms: number): string {
	if (!Number.isFinite(ms)) return "?";
	const date = new Date(ms);
	return Number.isFinite(date.getTime()) ? date.toISOString() : "?";
}

/** At most `max` code units, ending in "…" when clipped; never cuts an astral character in half. */
function clamp(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}…`;
}

function firstLine(text: string): string {
	const newline = text.indexOf("\n");
	const line = newline < 0 ? text : text.slice(0, newline);
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * One self-contained display line: terminal controls stripped, any line break that survives
 * (`stripTerminalControls` maps a bare `\r` to `\n`) collapsed to a single visible marker.
 *
 * Done per stored line, NOT at render time, on purpose. `renderMonitorOutput` joins every stored line
 * into one buffer and the F9 overlay sanitises only that joined buffer, after the join. A child
 * line carrying a bare `\r` would then render as two lines, the second able to pose as a genuine
 * `[<iso>] …` event line (a forged event), and an unterminated escape in one line could swallow the
 * genuine lines after it. Each line must already be inert before it is joined with its neighbours.
 */
function oneLine(text: string): string {
	return stripTerminalControls(text).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\n\u2028\u2029]+/g, " ⏎ ").replace(/\t/g, " ").trim();
}

/** What a monitor remembers between its arming and its end. */
interface MonitorState {
	displayId: string;
	mode: MonitorEntry["mode"];
	stdout: MonitorOutputTail;
	stderr: MonitorOutputTail;
	preview: string;
	latestStream: MonitorOutput["stream"];
	/** One dirty bit per admitted monitor, never a queue of raw chunks. */
	outputPending: boolean;
	/** Description lines above the events counter (mode, command, cwd, timing). */
	base: string[];
	maxEvents: number;
	/** Whether the description carries an `events:` counter line (output mode). */
	counted: boolean;
	/** Output events seen so far. */
	events: number;
	/** The last `MAX_EVENT_LINES` event lines, oldest first. */
	lines: string[];
}

function renderMonitorOutput(state: MonitorState): string {
	const counter = state.counted || state.events > 0 ? [`events: ${state.events}/${state.maxEvents}`] : [];
	const tails: string[] = [];
	for (const stream of ["stdout", "stderr"] as const) {
		const text = state[stream].text.trimEnd();
		// Quote every untrusted line: output must not impersonate the metadata or event history.
		if (text) tails.push(`${stream} tail:\n> ${text.replace(/\n/g, "\n> ")}`);
	}
	return [...state.base, ...counter, ...state.lines, ...tails].join("\n");
}

/** Preview construction, like the drill-in, belongs to publication rather than raw ingestion. */
function refreshMonitorPreview(state: MonitorState): void {
	if (!state.outputPending) return;
	const other = state.latestStream === "stdout" ? "stderr" : "stdout";
	for (const stream of [state.latestStream, other] as const) {
		const preview = clamp(state[stream].preview, SUMMARY_MAX);
		if (preview) {
			state.preview = `${stream}: ${preview}`;
			break;
		}
	}
	state.outputPending = false;
}

function monitorDetail(state: MonitorState): string {
	const counter = state.counted || state.events > 0 ? ` · ${state.events}/${state.maxEvents} events` : "";
	return `${state.displayId} · ${state.mode}${counter}${state.preview ? ` · ${state.preview}` : ""}`;
}

function terminalStatus(event: MonitorEvent): AgentNodeStatus {
	if (event.kind === "output") return "done";
	// Only the manager's status line decides: a failed child's stdout/stderr tail can say anything.
	if (event.kind === "exit") return CLEAN_EXIT.test(firstLine(event.text)) ? "done" : "failed";
	return "failed";
}

export class WakeRows {
	private readonly monitors = new Map<string, MonitorState>();

	monitorArmed(entry: MonitorEntry): AddNodeInput {
		const counted = entry.mode === "output";
		const displayId = clamp(oneLine(entry.id), SUMMARY_MAX);
		const state: MonitorState = {
			displayId,
			mode: entry.mode,
			stdout: new MonitorOutputTail(),
			stderr: new MonitorOutputTail(),
			preview: "",
			latestStream: "stdout",
			outputPending: false,
			base: [
				`${displayId} · ${entry.mode} mode`,
				clamp(oneLine(`command: ${[entry.command, ...entry.args].join(" ")}`), COMMAND_LINE_MAX),
				clamp(oneLine(`cwd: ${entry.cwd}`), COMMAND_LINE_MAX),
				`armed ${iso(entry.startedAtEpochMs)} · deadline ${iso(entry.expiresAtEpochMs)}`,
			],
			maxEvents: entry.maxEvents,
			counted,
			events: 0,
			lines: [],
		};
		this.monitors.set(entry.id, state);
		return {
			id: wakeNodeId("monitor", entry.id),
			label: clamp(oneLine(entry.label), SUMMARY_MAX),
			kind: "monitor",
			status: "running",
			detail: `${displayId} · ${entry.mode}`,
			startedAt: entry.startedAtEpochMs,
			lastAdvanceAt: entry.startedAtEpochMs,
			dueAt: entry.expiresAtEpochMs,
			output: renderMonitorOutput(state),
		};
	}

	/** Feed bounded tails immediately; no full-tail reads, tree patches or semantic credit per chunk. */
	monitorOutput(output: MonitorOutput): boolean {
		const state = this.monitors.get(output.id);
		if (!state) return false;
		state[output.stream].append(output.text);
		state.latestStream = output.stream;
		state.outputPending = true;
		return true;
	}

	/** Called by the existing UI frame BEFORE composing the widget, once per dirty monitor. */
	flushMonitorOutput(): WakeRowChange[] {
		const changes: WakeRowChange[] = [];
		for (const [id, state] of this.monitors) {
			if (!state.outputPending) continue;
			refreshMonitorPreview(state);
			changes.push({ id: wakeNodeId("monitor", id), patch: { detail: monitorDetail(state), output: renderMonitorOutput(state) } });
		}
		return changes;
	}

	/** Shutdown owns the final archive capture, not another UI frame. Late output is ignored. */
	clearMonitors(): void {
		this.monitors.clear();
	}

	monitorEvent(event: MonitorEvent): WakeRowEvent {
		const state = this.monitors.get(event.id);
		const head = clamp(oneLine(firstLine(event.text)), EVENT_TEXT_MAX);
		let observed = 1;
		if (state) {
			refreshMonitorPreview(state);
			if (event.kind === "output") state.events += 1;
			observed = state.events;
			state.lines.push(`[${iso(event.atEpochMs)}] ${head}`);
			if (state.lines.length > MAX_EVENT_LINES) state.lines.splice(0, state.lines.length - MAX_EVENT_LINES);
		}
		const max = state ? String(state.maxEvents) : "?";
		const displayId = state?.displayId ?? clamp(oneLine(event.id), SUMMARY_MAX);

		const patch: AgentNodePatch = { lastAdvanceAt: event.atEpochMs };
		if (event.terminal) {
			patch.status = terminalStatus(event);
			patch.detail = `${displayId} · ${event.kind === "output" ? `${observed}/${max} events · watch ended` : clamp(head, SUMMARY_MAX)}`;
		} else if (event.kind === "output") {
			patch.detail = state?.preview ? monitorDetail(state) : `${displayId} · output · ${observed}/${max} events`;
		}
		if (state) patch.output = renderMonitorOutput(state);
		if (event.terminal) this.monitors.delete(event.id);
		return { id: wakeNodeId("monitor", event.id), patch, settled: event.terminal };
	}

	monitorRemoved(entry: MonitorEntry): WakeRowChange {
		const state = this.monitors.get(entry.id);
		const output = state?.outputPending ? renderMonitorOutput(state) : undefined;
		this.monitors.delete(entry.id);
		return { id: wakeNodeId("monitor", entry.id), patch: { status: "stopped", detail: `${clamp(oneLine(entry.id), SUMMARY_MAX)} · cancelled`, ...(output !== undefined ? { output } : {}) } };
	}

	timerArmed(entry: TimerEntry): AddNodeInput {
		return {
			id: wakeNodeId("timer", entry.id),
			label: clamp(entry.label, TIMER_LABEL_MAX),
			kind: "timer",
			status: "running",
			// A timer armed without a label is already labelled by its id; do not repeat it.
			...(entry.label !== entry.id ? { detail: entry.id } : {}),
			startedAt: entry.armedAtEpochMs,
			lastAdvanceAt: entry.armedAtEpochMs,
			dueAt: entry.fireAtEpochMs,
			output: `${entry.id} · fires ${iso(entry.fireAtEpochMs)} (armed ${iso(entry.armedAtEpochMs)})\nmessage: ${entry.message}`,
		};
	}

	timerFired(entry: TimerEntry): WakeRowChange {
		return { id: wakeNodeId("timer", entry.id), patch: { status: "done", detail: `${entry.id} · fired` } };
	}

	timerCancelled(entry: TimerEntry): WakeRowChange {
		return { id: wakeNodeId("timer", entry.id), patch: { status: "stopped", detail: `${entry.id} · cancelled` } };
	}
}
