/** Operator-only presentation of existing session payloads. No delivery, storage or tool shells. */
import type { ExtensionAPI, Theme, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
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

/** The delegate-card-family frame every surface in this file shares: a bold semantic
 * `<Event> · <datum>` title, two-space-indented compact content lines, and the dim
 * expand hint only when compact actually hides content. Payloads are never modified —
 * this is projection-only (expanded still shows the complete sanitized payload). */
const INDENT = "  ";
/** Compact budget: title + 5 body rows + optional hint keeps every collapsed card ≤ 7 rows. */
const COMPACT_BODY_ROWS = 4;

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
			// The indent only applies where a clipped content column still fits; every compact line
			// is clipped to the remaining columns so indent + text never wrap or spill mid-word.
			const bodyPad = innerWidth > INDENT.length ? INDENT : "";
			const contentWidth = Math.max(1, innerWidth - bodyPad.length);
			const preview = expanded ? undefined : card.preview(contentWidth);
			const body = expanded ? card.full : preview?.text ?? "(no output)";
			const bodyLines = sanitizeTerminalText(body || "(no output)").split("\n").map((line) => expanded
				? theme.fg("toolOutput", line)
				: theme.fg("toolOutput", `${bodyPad}${truncateToWidth(line, contentWidth)}`));
			const lines = [
				theme.fg(colors.fg, theme.bold(truncateToWidth(sanitizeTerminalText(card.title), innerWidth))),
				...(card.metadata ? [theme.fg("dim", truncateToWidth(`${bodyPad}${sanitizeTerminalText(card.metadata)}`, innerWidth))] : []),
				...bodyLines,
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
interface ContentEntry { content?: string; kind?: "routine" | "stall" }
interface RunFailureEntry { id: string; label: string; agent: string; model?: string; durationMs?: number; error: string }

/** One run a settlement report names, projected to `<name> · <status>[ · <duration>]`. The
 * display name already carries the model (`runDisplayName`: "label · model"). */
interface SettledRunLine { name: string; status: "done" | "failed" | "stopped"; duration?: string }

/** Boilerplate the settlement generator interleaves between the per-run lines. Every entry is
 * drift-guarded in tests against live `buildCompletionReport` output (src/engine/async.ts):
 * receipts header + `run-x: …` reference lines, the effort header, salvage `↩` block headers,
 * the shared untrusted-fence header (core/fence.ts quoteUntrusted) and its `> `-quoted payload
 * lines, the failed-leg guidance sentence, the truncation marker and retention/tail notes. */
const SETTLEMENT_SKIP: readonly RegExp[] = [
	/^Terminal reports \(/,
	/^run-\S+: /,
	/^Thinking \(not provider cognition\):$/,
	/^↩ /,
	/^Sub-agent output \(untrusted data\):$/,
	/^>/,
	/^Handle each failure deliberately: /,
	/^\[\.\.\. .*?\]$/,
	/^⚠ /,
	/^Run ids in this report: /,
];
const SETTLEMENT_DONE = /^✅ (\S+) \((.+?)\) done(?: in (.+?))?:$/;
const SETTLEMENT_STOPPED_SECTION = /^⏹ \d+ stopped:$/;
const SETTLEMENT_FAILED_SECTION = /^❌ \d+ failed:$/;
/** Quoted (fence) bullets carry the stopped/failed runs; the section header above them names the status. */
const SETTLEMENT_BULLET = /^> ?• (\S+) \((.+?)\)(?: after (.+?))?: /;

/** Project the compact per-run lines of a settlement report, or undefined when the body is not
 * exactly the known generator shape (head line + recognized/skipped lines only). A duration is
 * kept only when it is short (≤ 8 columns, e.g. "12s"/"2m 5s"); width clipping handles the rest. */
function parseSettlementRuns(full: string): { counts: string; runs: SettledRunLine[] } | undefined {
	const lines = full.split("\n");
	const head = SETTLEMENT_HEAD.exec(lines[0] ?? "");
	if (!head) return undefined;
	const done = Number(head[2]);
	const failed = Number(head[3]);
	const stopped = Number(head[4] ?? 0);
	const counts = `${done} done, ${failed} failed${stopped > 0 ? `, ${stopped} stopped` : ""}`;
	let section: "failed" | "stopped" | undefined;
	const runs: SettledRunLine[] = [];
	const seen = new Set<string>();
	const add = (name: string | undefined, status: SettledRunLine["status"], duration: string | undefined) => {
		if (!name) return;
		const key = `${status}:${name}`;
		if (seen.has(key)) return;
		seen.add(key);
		runs.push({ name, status, ...(duration !== undefined && visibleWidth(duration) <= 8 ? { duration } : {}) });
	};
	for (const line of lines.slice(1)) {
		const bullet = SETTLEMENT_BULLET.exec(line);
		if (bullet) {
			if (section === undefined) return undefined;
			add(bullet[2], section, bullet[3]);
			continue;
		}
		if (line.trim().length === 0 || SETTLEMENT_SKIP.some((skip) => skip.test(line))) continue;
		const doneLine = SETTLEMENT_DONE.exec(line);
		if (doneLine) {
			section = undefined;
			add(doneLine[2], "done", doneLine[3]);
			continue;
		}
		if (SETTLEMENT_STOPPED_SECTION.test(line)) { section = "stopped"; continue; }
		if (SETTLEMENT_FAILED_SECTION.test(line)) { section = "failed"; continue; }
		return undefined; // unknown shape → the caller falls back to the generic bounded preview
	}
	return { counts, runs };
}

/** Compact projection of a settlement report: counts line + one line per named run, capped at
 * COMPACT_BODY_ROWS (a `… +N more` tail row replaces the overflow). Undefined run list = fallback. */
function settlementPreview(full: string): Card["preview"] | undefined {
	const parsed = parseSettlementRuns(full);
	if (!parsed || parsed.runs.length === 0) return undefined;
	return () => {
		const lines = [parsed.counts, ...parsed.runs.map((run) => `${run.name} · ${run.status}${run.duration ? ` · ${run.duration}` : ""}`)];
		const visible = lines.length <= COMPACT_BODY_ROWS ? lines : [...lines.slice(0, COMPACT_BODY_ROWS - 1), `… +${lines.length - (COMPACT_BODY_ROWS - 1)} more`];
		return { text: visible.join("\n"), truncated: true };
	};
}

interface StatusRunLine { name: string; detail: string; queued: boolean }

/** Skip-list for the peek-digest boilerplate the status card's title/frame replaces. Each entry
 * is drift-guarded in tests against live `buildPeekDigest`/`buildCheckIn` output (src/engine/async.ts):
 * the check-in header, the cumulative-token footnote and the omitted-runs tail. The
 * `Async runs: N (M running)` header is recognized below (the title carries its counts). */
const STATUS_SKIP: readonly RegExp[] = [
	/^Async activity · (?:routine check-in|possible stall)$/,
	/^Cumulative tokens show /,
	/^… \d+ additional async runs omitted/,
];
const STATUS_RUNNING = /^\[([^\]]+)\] (.+?) — running \((?:(\d+) turns, )?(.+?) cumulative input \+ output tokens\)(.*)$/;
const STATUS_SETTLED = /^\[([^\]]+)\] (.+?) — (done|failed|stopped)(?: (?:in|after) (.+?))?(?::.*)?$/;
const STATUS_HEADER_COUNTS = /^Async runs: \d+ \((\d+) running\)$/;

/** Parse one peek digest into per-run compact lines (`<name> · 53t · 216k` for running legs,
 * `<name> · done · 12s` for settled ones), or undefined when the shape is not the generator's. */
function parseStatusRuns(full: string): { running: number; queued: number; runs: StatusRunLine[] } | undefined {
	let running: number | undefined;
	let queued = 0;
	const runs: StatusRunLine[] = [];
	for (const line of full.split("\n")) {
		if (line.trim().length === 0 || STATUS_SKIP.some((skip) => skip.test(line))) continue;
		const head = STATUS_HEADER_COUNTS.exec(line);
		if (head) {
			if (running !== undefined) return undefined;
			running = Number(head[1]);
			continue;
		}
		const runLine = STATUS_RUNNING.exec(line);
		if (runLine) {
			const [, , name, turns, tokens, suffix] = runLine;
			const isQueued = /· queued \(/.test(suffix ?? "");
			if (isQueued) queued++;
			const usage = `${tokens ?? "0"} cumulative input + output tokens`;
			const detail = isQueued ? `queued · ${usage}` : `${turns !== undefined ? `${turns} turns · ` : ""}${usage}`;
			runs.push({ name: name ?? "", detail, queued: isQueued });
			continue;
		}
		const settledLine = STATUS_SETTLED.exec(line);
		if (settledLine) {
			const [, , name, status, duration] = settledLine;
			runs.push({ name: name ?? "", detail: duration !== undefined ? `${status} · ${duration}` : status ?? "", queued: false });
			continue;
		}
		return undefined; // unknown shape → the caller falls back to the generic bounded preview
	}
	if (running === undefined || runs.length === 0) return undefined;
	return { running, queued, runs };
}

/** Compact projection of the periodic status digest, capped like the settlement preview. */
function statusPreview(full: string): Card["preview"] | undefined {
	const parsed = parseStatusRuns(full);
	if (!parsed) return undefined;
	return () => {
		const lines = parsed.runs.map((run) => `${run.name} · ${run.detail}`);
		const visible = lines.length <= COMPACT_BODY_ROWS ? lines : [...lines.slice(0, COMPACT_BODY_ROWS - 1), `… +${lines.length - (COMPACT_BODY_ROWS - 1)} more`];
		return { text: visible.join("\n"), truncated: true };
	};
}

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
			const projected = customType === "pi-persona" ? settlementPreview(full) : undefined;
			return sessionCard({
				title: customType === "pi-persona" ? `Update · ${status}` : "Exocom · inbound",
				state, full, markdown,
				preview: projected ?? preview(full, 4, 100),
			}, expanded, theme, outputPad);
		});
	}
	pi.registerEntryRenderer(MONITOR_LOG_ENTRY, (entry, { expanded }, theme) => {
		const record = parseMonitorLogRecord(entry.data);
		if (!record) return undefined;
		const { state, status } = monitorState(record);
		return sessionCard({
			title: `Monitor · ${compactInlineText(record.entry.label)}`,
			state, metadata: `${record.outcome} · ${status} · ${compactInlineText(record.entry.id)}`,
			full: sanitizeTerminalText(options.monitorLog(record)),
			preview: (width) => ({ text: `${compactInlineText(neutralizeMonitorUnicode(record.text), { maxChars: Math.min(width, 160) })}\n${compactInlineText(record.entry.id)} · monitor result`, truncated: true }),
		}, expanded, theme);
	});
	pi.registerEntryRenderer<RunFailureEntry>("pi-persona-run-failure", (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const metadata = [compactInlineText(data.agent, { maxChars: 48 }), ...(data.model ? [compactInlineText(data.model, { maxChars: 96 })] : []), ...(data.durationMs !== undefined ? [formatDuration(data.durationMs)] : [])].join(" · ");
		return sessionCard({
			title: `Failed · ${compactInlineText(data.label || data.agent, { maxChars: 80 })}`, state: "error", metadata,
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
		const label = compactInlineText(data.label ?? "", { maxChars: 96 });
		return sessionCard({
			title: `${label || "Result"} · ${status}${state === "error" && cause !== "(no output)" ? ` · ${cause}` : ""}`,
			state, full, markdown: true, preview: preview(full, 3, 100),
		}, expanded, theme);
	});
	pi.registerEntryRenderer<ContentEntry>("pi-persona-nudge", (entry, { expanded }, theme) => {
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
			title: datum ? `Checkpoint · ${datum}` : "Checkpoint", state: "attention", full,
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
		const event = stall ? "Stall" : "Status";
		const digest = full.split("\n").slice(1).filter((line) => line.trim().length > 0);
		const parsed = parseStatusRuns(full);
		return sessionCard({
			title: parsed
				? `${event} · ${parsed.running} running${parsed.queued > 0 ? ` · ${parsed.queued} queued` : ""}`
				: `${event} · check-in`,
			state: stall ? "attention" : "neutral", full,
			preview: parsed ? statusPreview(full)! : (width) => {
				const result = preview(digest.slice(0, 2).join("\n") || full, 2, 140)(width);
				return { text: result.text, truncated: result.truncated || digest.length > 2 };
			},
		}, expanded, theme);
	});
}
