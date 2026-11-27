import { fenceUntrusted } from "../core/fence.ts";
import { summarizeFailure } from "./failure-summary.ts";
import { compactVisibleText, type CompactVisibleTextOptions, sanitizeTerminalText } from "./presentation.ts";

/** Project only the saved failure field. Reports can also contain successful siblings' findings. */
export function projectFailureReport(report: string, error: string | undefined, tool?: "council" | "flow"): {
	cause: string;
	compactBody: string;
	fullBody: string;
	hiddenDiagnostic: boolean;
} {
	const raw = typeof error === "string" ? sanitizeTerminalText(error).trim() : "";
	const cause = raw ? summarizeFailure(raw) : "";
	if (!raw) return { cause, compactBody: report, fullBody: report, hiddenDiagnostic: false };

	// A replacement callback keeps literal dollar signs in provider prose.
	const echo = report === raw || (tool && report === `${tool} failed: ${raw}`)
		|| (report.startsWith("Sub-agent output (untrusted data):\n") && report === fenceUntrusted(raw));
	const compactBody = echo ? "" : cause === raw ? report : report.replaceAll(raw, () => cause);
	return {
		cause, compactBody, hiddenDiagnostic: !!echo || cause !== raw,
		fullBody: echo || report.includes(raw) ? report : [report, raw].filter(Boolean).join("\n\n"),
	};
}

/** Host failures have no structured details. A one-line diagnostic can be summarized as a whole;
 * multiline host output can include remediation or partial findings and keeps its bounded preview. */
export function compactDiagnosticPreview(diagnostic: string, options: CompactVisibleTextOptions) {
	const compact = diagnostic.includes("\n") ? diagnostic : summarizeFailure(diagnostic);
	const preview = compactVisibleText(compact, options);
	return { ...preview, truncated: preview.truncated || compact !== diagnostic };
}
