/** Operator-only presentation of existing session payloads. No delivery, storage or tool shells. */
import type { ExtensionAPI, KeybindingHints, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatDuration } from "../core/time.ts";
import { neutralizeMonitorUnicode } from "../core/monitor-output.ts";
import { MONITOR_LOG_ENTRY, SCRIPT_LOG_ENTRY, parseMonitorLogRecord, type MonitorLogRecord } from "../monitor/archive.ts";
import { summarizeFailure } from "./failure-summary.ts";
import { compactInlineText, compactVisibleText, sanitizeTerminalText } from "./presentation.ts";
import { createCardFrame, type CardFramePresentation, type CardFrameState } from "./card-frame.ts";
import { communicationPreview, parseCommunicationCardDetails } from "./communication-card.ts";
import { parseRunLabelDetails, parseSettlementDetails } from "./run-labels.ts";
import { parseStatusRuns, statusPreview } from "./run-status.ts";

type State = CardFrameState;
type Card = CardFramePresentation;
/** Compact budget: title + 5 body rows + optional hint keeps every collapsed card ≤ 7 rows. */
const COMPACT_BODY_ROWS = 4;

function preview(full: string, maxLines: number, maxColumns: number): Card["preview"] {
	return (width) => compactVisibleText(full, { maxLines, maxLineChars: Math.min(width, maxColumns) });
}

/** Single source of truth for the settlement head grammar, shared by state selection and the
 * compact projection below. The generator is `buildCompletionReport` in src/engine/async.ts. */
const SETTLEMENT_HEAD = /^(?:\[pi-persona\] )?(\d+) async runs? settled — (\d+) done, (\d+) failed(?:, (\d+) stopped)?$/;

/** Only this exact runtime-owned aggregate is evidence of settlement. No keyword scan of output,
 * asks, timers, monitor event bodies, or peers. Legacy/unknown follow-ups remain informational. */
function followUpState(full: string): { state: State; status: string } {
	const first = full.split("\n", 1)[0] ?? "";
	const summary = SETTLEMENT_HEAD.exec(first);
	if (summary) {
		const total = Number(summary[1]);
		const done = Number(summary[2]);
		const failed = Number(summary[3]);
		const stopped = Number(summary[4] ?? 0);
		if ([total, done, failed, stopped].every(Number.isSafeInteger) && total > 0 && total === done + failed + stopped) {
			if (failed > 0) return { state: "error", status: "failed" };
			if (stopped > 0) return { state: "attention", status: "stopped" };
			return { state: "success", status: "complete" };
		}
	}
	return { state: "neutral", status: "info" };
}

function monitorState(record: MonitorLogRecord): { state: State; status: string } {
	if (record.outcome === "error") return { state: "error", status: "failed" };
	if (record.outcome === "timeout" || record.outcome === "cancelled") return { state: "attention", status: "stopped" };
	if (record.outcome === "exit") {
		// MonitorManager prepends this line before any untrusted stdout/stderr diagnostics.
		const first = record.text.split("\n", 1)[0] ?? "";
		const exit = /^process exited with exit code (-?\d+)$/.exec(first);
		if (exit) return exit[1] === "0" ? { state: "success", status: "complete" } : { state: "error", status: "failed" };
		if (/^process exited (?:by .+|with exit code -?\d+ \(signal .+\))$/.test(first)) return { state: "attention", status: "stopped" };
	}
	return { state: "neutral", status: "info" };
}

interface ResultEntry { label?: string; content?: string; ok?: boolean; stoppedAtGate?: string; failureKind?: string; error?: string }
interface ContentEntry { content?: string; kind?: "routine" | "stall" | "recovery"; runLabels?: unknown }
interface RunFailureEntry { id: string; label: string; agent: string; model?: string; durationMs?: number; error: string }

/** Render only runtime-owned settlement facts. Older history falls back to literal content. */
function settlementPreview(details: unknown): Card["preview"] | undefined {
	const snapshot = parseSettlementDetails(details);
	if (!snapshot || snapshot.runs.length === 0) return undefined;
	const labels = parseRunLabelDetails(details);
	if (snapshot.runs.some((run) => !labels.has(run.id))) return undefined;
	const counts = `${snapshot.done} done, ${snapshot.failed} failed${snapshot.stopped > 0 ? `, ${snapshot.stopped} stopped` : ""}`;
	return () => {
		const lines = [counts, ...snapshot.runs.map((run) => `${labels.get(run.id)} · ${run.status}${run.duration && visibleWidth(run.duration) <= 8 ? ` · ${run.duration}` : ""}`)];
		const total = snapshot.done + snapshot.failed + snapshot.stopped;
		const visible = total <= COMPACT_BODY_ROWS - 1 ? lines : [...lines.slice(0, COMPACT_BODY_ROWS - 1), `… +${total - (COMPACT_BODY_ROWS - 2)} more`];
		return { text: visible.join("\n"), truncated: true };
	};
}

export interface SessionCardOptions {
	detailHint: () => string;
	/** Read the current native transcript padding when Pi rebuilds a custom entry renderer. */
	getOutputPad: () => number;
	/** Existing bounded/fenced runtime formatter, injected to keep UI independent of tool wiring. */
	processLog: (record: MonitorLogRecord) => string;
}

export function registerSessionCards(pi: Pick<ExtensionAPI, "registerMessageRenderer" | "registerEntryRenderer">, options: SessionCardOptions): void {
	const sessionCard = (card: Card, expanded: boolean, theme: Theme, outputPad = 0, keyHint?: KeybindingHints["keyHint"]): Component =>
		createCardFrame(card, {
			expanded,
			theme,
			outputPad,
			detailHint: keyHint ? () => keyHint("app.tools.expand", "to expand") : options.detailHint,
		});
	for (const customType of ["pi-persona", "exocom_received"] as const) {
		pi.registerMessageRenderer(customType, (message, { expanded, outputPad, keyHint }, theme) => {
			const raw = typeof message.content === "string" ? message.content
				: message.content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
			const full = sanitizeTerminalText(raw);
			const communication = parseCommunicationCardDetails(message.details);
			if (communication && (communication.messages.length > 0 || communication.plane === "exocom")) {
				const compact = communication.messages.length > 0
					? (width: number) => { const result = communicationPreview(communication, width); return { ...result, truncated: result.truncated || result.text !== full }; }
					: preview(full, 4, 100);
				return sessionCard({ title: `${communication.plane} update · info`, state: "neutral", full, preview: compact }, expanded, theme, outputPad, keyHint);
			}
			const { state, status } = customType === "pi-persona" ? followUpState(full) : { state: "neutral" as const, status: "inbound" };
			// Only the validated settlement envelope is a pi-persona report. Unknown is NOT
			// Markdown: monitor stdout/stderr, timers and operational notices share this type.
			const markdown = customType === "exocom_received" || status !== "info";
			const projected = customType === "pi-persona" ? settlementPreview(message.details) : undefined;
			const fallback = preview(full, 4, 100);
			return sessionCard({
				title: customType === "pi-persona" ? `${status === "info" ? "update" : "intercom update"} · ${status}` : "exocom update · info",
				state, full, markdown,
				preview: projected ?? (customType === "pi-persona" && status !== "info" ? (width) => ({ ...fallback(width), truncated: true }) : fallback),
			}, expanded, theme, outputPad, keyHint);
		});
	}
	for (const [entryType, source] of [[MONITOR_LOG_ENTRY, "monitor"], [SCRIPT_LOG_ENTRY, "script"]] as const) {
		pi.registerEntryRenderer(entryType, (entry, { expanded, keyHint }, theme) => {
			const record = parseMonitorLogRecord(entry.data);
			if (!record) return undefined;
			const { state, status } = monitorState(record);
			return sessionCard({
				title: `${source} · ${compactInlineText(record.entry.label)}`,
				state, metadata: `${record.outcome} · ${status} · ${compactInlineText(record.entry.id)}`,
				full: sanitizeTerminalText(options.processLog(record)),
				preview: (width) => ({ text: `${compactInlineText(neutralizeMonitorUnicode(record.text), { maxChars: Math.min(width, 160) })}\n${compactInlineText(record.entry.id)} · ${source.toLowerCase()} result`, truncated: true }),
			}, expanded, theme, options.getOutputPad(), keyHint);
		});
	}
	pi.registerEntryRenderer<RunFailureEntry>("pi-persona-run-failure", (entry, { expanded, keyHint }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const metadata = [compactInlineText(data.agent, { maxChars: 48 }), ...(data.durationMs !== undefined ? [formatDuration(data.durationMs)] : [])].join(" · ");
		return sessionCard({
			title: `failed · ${compactInlineText(data.label || data.agent, { maxChars: 80 })}`, state: "error", metadata,
			full: `Run ${compactInlineText(data.id)}${data.model ? `\nModel: ${compactInlineText(data.model, { maxChars: 96 })}` : ""}\n${sanitizeTerminalText(data.error)}`,
			preview: (width) => ({ text: compactVisibleText(summarizeFailure(data.error), { maxLines: 2, maxLineChars: Math.min(width, 100) }).text, truncated: true }),
		}, expanded, theme, options.getOutputPad(), keyHint);
	});
	pi.registerEntryRenderer<ResultEntry>("pi-persona-result", (entry, { expanded, keyHint }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const full = sanitizeTerminalText(data.content || "(no output)");
		const stopped = data.ok !== true && typeof data.stoppedAtGate === "string";
		const state: State = stopped ? "attention" : data.ok === true ? "success" : data.ok === false ? "error" : "neutral";
		const status = stopped ? `stopped · checkpoint ${compactInlineText(data.stoppedAtGate ?? "", { maxChars: 32 })}` : data.ok === true ? "complete" : data.ok === false ? "failed" : "unknown";
		const cause = compactVisibleText([data.failureKind, data.error].filter(Boolean).join(" · "), { maxLines: 1, maxLineChars: 80 }).text;
		const label = compactInlineText(data.label ?? "", { maxChars: 96 });
		return sessionCard({
			title: `${label || "result"} · ${status}${state === "error" && cause !== "(no output)" ? ` · ${cause}` : ""}`,
			state, full, markdown: true, preview: preview(full, 3, 100),
		}, expanded, theme, options.getOutputPad(), keyHint);
	});
	pi.registerEntryRenderer<ContentEntry>("pi-persona-nudge", (entry, { expanded, keyHint }, theme) => {
		if (!entry.data) return undefined;
		const full = sanitizeTerminalText(entry.data.content || "⟢ pi-persona · checkpoint");
		const lines = full.split("\n").map((line) => line.trim()).filter(Boolean);
		const header = compactInlineText(lines[0]?.replace(/^⟢\s*/, "") ?? "", { maxChars: 96 }) || "checkpoint";
		// Drop the generator's own "pi-persona · checkpoint" boilerplate from the datum; a bare
		// checkpoint header leaves the title as just the event word.
		const datum = header === "checkpoint" ? "" : header.replace(/^pi-persona · checkpoint\b\??/, "").replace(/^pi-persona · /, "").trim();
		const details = lines.slice(1);
		const trigger = details.find((line) => line.startsWith("Trigger:"));
		const action = details.find((line) => /^(?:Action|Verify|Otherwise):/.test(line));
		const selected = [trigger, action].filter((line): line is string => line !== undefined);
		const chosen = selected.length > 0 ? selected : details.slice(0, 2);
		return sessionCard({
			title: datum ? `checkpoint · ${datum}` : "checkpoint", state: "attention", full,
			preview: (width) => {
				const result = preview(chosen.join("\n"), 2, 100)(width);
				return { text: result.text, truncated: result.truncated || details.some((line) => !chosen.includes(line)) };
			},
		}, expanded, theme, options.getOutputPad(), keyHint);
	});
	pi.registerEntryRenderer<ContentEntry>("pi-persona-status", (entry, { expanded, keyHint }, theme) => {
		if (!entry.data) return undefined;
		const full = sanitizeTerminalText(entry.data.content || "Async activity · routine check-in");
		const stall = entry.data.kind === "stall";
		const recovery = entry.data.kind === "recovery";
		const event = stall ? "stalled" : recovery ? "resumed" : "running";
		const digest = full.split("\n").slice(1).filter((line) => line.trim().length > 0);
		const labels = parseRunLabelDetails(entry.data);
		const parsed = parseStatusRuns(full, labels);
		return sessionCard({
			title: parsed
				? `intercom update · ${event} · ${parsed.running} running${parsed.queued > 0 ? ` · ${parsed.queued} queued` : ""}`
				: `intercom update · ${event}`,
			state: stall ? "attention" : recovery ? "success" : "neutral", full,
			preview: parsed ? statusPreview(full, labels)! : (width) => {
				const result = preview(digest.slice(0, 2).join("\n") || full, 2, 140)(width);
				return { text: result.text, truncated: result.truncated || digest.length > 2 };
			},
		}, expanded, theme, options.getOutputPad(), keyHint);
	});
}
