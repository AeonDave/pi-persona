/** Operator-only presentation of existing session payloads. No delivery, storage or tool shells. */
import type { ExtensionAPI, Theme, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatDuration } from "../core/time.ts";
import { neutralizeMonitorUnicode } from "../core/monitor-output.ts";
import { createReportBody } from "./report-body.ts";
import { MONITOR_LOG_ENTRY, parseMonitorLogRecord, type MonitorLogRecord } from "../monitor/archive.ts";
import { summarizeFailure } from "./failure-summary.ts";
import { compactInlineText, compactVisibleText, sanitizeTerminalText, type CompactVisibleTextResult } from "./presentation.ts";

type State = "neutral" | "success" | "attention" | "error";
const COLORS: Record<State, { bg: ThemeBg; fg: ThemeColor }> = {
	neutral: { bg: "customMessageBg", fg: "accent" },
	success: { bg: "toolSuccessBg", fg: "success" },
	attention: { bg: "toolPendingBg", fg: "warning" },
	error: { bg: "toolErrorBg", fg: "error" },
};
interface Card {
	title: string;
	state: State;
	full: string;
	preview: (width: number) => Pick<CompactVisibleTextResult, "text" | "truncated">;
	metadata?: string;
	/** Selected only by trusted surface/envelope metadata, never prose keywords. */
	markdown?: boolean;
}

/** All seven surfaces share semantic chrome. Literal paths style at paint time; report bodies
 * use native Markdown's invalidatable layout cache. Pi rebuilds callbacks on transcript invalidation. */
function createSessionCard(card: Card, expanded: boolean, theme: Theme, detailHint: () => string, outputPad = 0): Component {
	if (expanded && card.markdown) {
		return createReportBody(card.full || "(no output)", theme, {
			padding: outputPad,
			background: COLORS[card.state].bg,
			header: (width) => [
				theme.fg(COLORS[card.state].fg, theme.bold(truncateToWidth(sanitizeTerminalText(card.title), width))),
				...(card.metadata ? [theme.fg("dim", truncateToWidth(card.metadata, width))] : []),
			].join("\n"),
		});
	}
	return {
		invalidate() { /* Literal Text path has no themed/layout cache. */ },
		render(width) {
			if (width <= 0) return [];
			const padding = Math.min(Math.max(0, Math.floor(outputPad)), Math.max(0, Math.floor((width - 1) / 2)));
			const innerWidth = Math.max(1, width - padding * 2);
			const colors = COLORS[card.state];
			const preview = expanded ? undefined : card.preview(innerWidth);
			const body = expanded ? card.full : preview?.text ?? "(no output)";
			const lines = [
				theme.fg(colors.fg, theme.bold(truncateToWidth(sanitizeTerminalText(card.title), innerWidth))),
				...(card.metadata ? [theme.fg("dim", truncateToWidth(card.metadata, innerWidth))] : []),
				...sanitizeTerminalText(body || "(no output)").split("\n").map((line) => theme.fg("toolOutput", line)),
				...(preview?.truncated ? [theme.fg("dim", truncateToWidth(detailHint(), innerWidth))] : []),
			];
			// Text owns wrapping and full-row padding/background, including embedded foreground resets.
			// A terminal narrower than a single wide glyph cannot display that glyph; clip only there.
			return new Text(lines.join("\n"), padding, 0, (text) => theme.bg(colors.bg, text))
				.render(width).map((line) => truncateToWidth(line, width));
		},
	};
}

function preview(full: string, maxLines: number, maxColumns: number): Card["preview"] {
	return (width) => compactVisibleText(full, { maxLines, maxLineChars: Math.min(width, maxColumns) });
}

/** Only this exact runtime-owned aggregate is evidence of settlement. No keyword scan of output,
 * asks, timers, monitor event bodies, or peers. Legacy/unknown follow-ups remain informational. */
function followUpState(full: string): { state: State; status: string } {
	const first = full.split("\n", 1)[0] ?? "";
	const summary = /^(?:\[pi-persona\] )?(\d+) async runs? settled — (\d+) done, (\d+) failed(?:, (\d+) stopped)?$/.exec(first);
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
interface ContentEntry { content?: string; kind?: "routine" | "stall" }
interface RunFailureEntry { id: string; label: string; agent: string; model?: string; durationMs?: number; error: string }

export interface SessionCardOptions {
	detailHint: () => string;
	/** Existing bounded/fenced runtime formatter, injected to keep UI independent of tool wiring. */
	monitorLog: (record: MonitorLogRecord) => string;
}

export function registerSessionCards(pi: Pick<ExtensionAPI, "registerMessageRenderer" | "registerEntryRenderer">, options: SessionCardOptions): void {
	const sessionCard = (card: Card, expanded: boolean, theme: Theme, outputPad = 0): Component =>
		createSessionCard(card, expanded, theme, options.detailHint, outputPad);
	for (const customType of ["pi-persona", "exocom_received"] as const) {
		pi.registerMessageRenderer(customType, (message, { expanded, outputPad }, theme) => {
			const raw = typeof message.content === "string" ? message.content
				: message.content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
			const full = sanitizeTerminalText(raw);
			const { state, status } = customType === "pi-persona" ? followUpState(full) : { state: "neutral" as const, status: "inbound" };
			// Only the validated settlement envelope is a pi-persona report. Unknown is NOT
			// Markdown: monitor stdout/stderr, timers and operational notices share this type.
			const markdown = customType === "exocom_received" || status !== "info";
			return sessionCard({ title: customType === "pi-persona" ? `pi-persona · update · ${status}` : "exocom · inbound", state, full, markdown, preview: preview(full, 4, 100) }, expanded, theme, outputPad);
		});
	}
	pi.registerEntryRenderer(MONITOR_LOG_ENTRY, (entry, { expanded }, theme) => {
		const record = parseMonitorLogRecord(entry.data);
		if (!record) return undefined;
		const { state, status } = monitorState(record);
		return sessionCard({
			title: `Monitor log ${compactInlineText(record.entry.label)} · ${record.outcome} · ${status}`,
			state, full: sanitizeTerminalText(options.monitorLog(record)),
			preview: (width) => ({ text: `${compactInlineText(neutralizeMonitorUnicode(record.text), { maxChars: Math.min(width, 160) })}\n${compactInlineText(record.entry.id)} · monitor result`, truncated: true }),
		}, expanded, theme);
	});
	pi.registerEntryRenderer<RunFailureEntry>("pi-persona-run-failure", (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const metadata = [compactInlineText(data.agent, { maxChars: 48 }), ...(data.model ? [compactInlineText(data.model, { maxChars: 96 })] : []), ...(data.durationMs !== undefined ? [formatDuration(data.durationMs)] : [])].join(" · ");
		return sessionCard({
			title: `${compactInlineText(data.label || data.agent, { maxChars: 80 })} · failed`, state: "error", metadata,
			full: `Run ${compactInlineText(data.id)}\n${sanitizeTerminalText(data.error)}`,
			preview: (width) => ({ text: compactVisibleText(summarizeFailure(data.error), { maxLines: 2, maxLineChars: Math.min(width, 100) }).text, truncated: true }),
		}, expanded, theme);
	});
	pi.registerEntryRenderer<ResultEntry>("pi-persona-result", (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const full = sanitizeTerminalText(data.content || "(no output)");
		const stopped = data.ok !== true && typeof data.stoppedAtGate === "string";
		const state: State = stopped ? "attention" : data.ok === true ? "success" : data.ok === false ? "error" : "neutral";
		const status = stopped ? `stopped · checkpoint ${compactInlineText(data.stoppedAtGate ?? "", { maxChars: 32 })}` : data.ok === true ? "complete" : data.ok === false ? "failed" : "unknown";
		const cause = compactVisibleText([data.failureKind, data.error].filter(Boolean).join(" · "), { maxLines: 1, maxLineChars: 80 }).text;
		return sessionCard({
			title: `${compactInlineText(data.label ?? "", { maxChars: 96 }) || "result"} · ${status}${state === "error" && cause !== "(no output)" ? ` · ${cause}` : ""}`,
			state, full, markdown: true, preview: preview(full, 3, 100),
		}, expanded, theme);
	});
	pi.registerEntryRenderer<ContentEntry>("pi-persona-nudge", (entry, { expanded }, theme) => {
		if (!entry.data) return undefined;
		const full = sanitizeTerminalText(entry.data.content || "⟢ pi-persona · checkpoint");
		const lines = full.split("\n").map((line) => line.trim()).filter(Boolean);
		const header = compactInlineText(lines[0]?.replace(/^⟢\s*/, "") ?? "", { maxChars: 96 }) || "pi-persona · checkpoint";
		const details = lines.slice(1);
		const trigger = details.find((line) => line.startsWith("Trigger:"));
		const action = details.find((line) => /^(?:Action|Verify|Otherwise):/.test(line));
		const selected = [trigger, action].filter((line): line is string => line !== undefined);
		const chosen = selected.length > 0 ? selected : details.slice(0, 2);
		return sessionCard({
			title: header, state: "attention", full,
			preview: (width) => {
				const result = preview(chosen.join("\n"), 2, 100)(width);
				return { text: result.text, truncated: result.truncated || details.some((line) => !chosen.includes(line)) };
			},
		}, expanded, theme);
	});
	pi.registerEntryRenderer<ContentEntry>("pi-persona-status", (entry, { expanded }, theme) => {
		if (!entry.data) return undefined;
		const full = sanitizeTerminalText(entry.data.content || "Async activity · routine check-in");
		const stall = entry.data.kind === "stall";
		const digest = full.split("\n").slice(1).filter((line) => line.trim().length > 0);
		return sessionCard({
			title: stall ? "pi-persona · possible stall" : "pi-persona · async status", state: stall ? "attention" : "neutral", full,
			preview: (width) => {
				const result = preview(digest.slice(0, 2).join("\n") || full, 2, 140)(width);
				return { text: result.text, truncated: result.truncated || digest.length > 2 };
			},
		}, expanded, theme);
	});
}
