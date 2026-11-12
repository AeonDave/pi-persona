/** One bounded, fenced read of a session-owned process log; never adds a wake. */
import { neutralizeMonitorUnicode } from "../core/monitor-output.ts";
import { fenceUntrusted, stripTerminalControls } from "../core/fence.ts";
import { compactInlineText } from "../ui/presentation.ts";
import type { MonitorLogRecord } from "./archive.ts";

export function renderProcessLog(record: MonitorLogRecord, full = false): string {
	const limit = full ? 16_384 : 4_000;
	const tail = (text: string) => {
		const safe = neutralizeMonitorUnicode(stripTerminalControls(text));
		return safe.length > limit ? `…[display truncated; use result with full=true for the retained capture]\n${safe.slice(-limit)}` : safe || "(no output)";
	};
	return [
		`${compactInlineText(record.entry.id)} (${compactInlineText(record.entry.label)}) — ${record.outcome}`,
		...(record.truncated ? ["Log capture is bounded; older output was truncated."] : []),
		...(record.storageWarning ? [compactInlineText(record.storageWarning, { maxChars: 400 })] : []),
		fenceUntrusted(`${tail(record.text)}\nstdout:\n${tail(record.stdout)}\nstderr:\n${tail(record.stderr)}`),
	].join("\n");
}
