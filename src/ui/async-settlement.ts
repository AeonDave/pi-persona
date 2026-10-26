/** Terminal tree projection. Live fan-outs keep bounded receipts until their last leg settles. */
import type { AsyncRun } from "../engine/async.ts";
import { compactMemberResult } from "../orchestration/render.ts";
import { resultReceiptHint } from "../results/retrieval.ts";
import { shortModel } from "../tools/delegate.ts";
import type { AgentTree } from "./agent-tree.ts";
import { compactInlineText, sanitizeTerminalText } from "./presentation.ts";
import { observedModel } from "./strategy-leg.ts";
import { formatUsage } from "./usage.ts";

const PREVIEW_CHARS = 4_096;

function terminalPreview(run: AsyncRun): string {
	const result = run.result;
	const error = run.error ?? result?.error;
	const body = result?.structured ? compactMemberResult(result) : result?.output || run.progress.output;
	const parts = [error, body].filter((part): part is string => Boolean(part));
	const rawLength = parts.reduce((length, part) => length + part.length, 0) + Math.max(0, parts.length - 1) * 2;
	// Bound work before sanitizing: a huge report must not block a terminal settlement frame.
	const text = sanitizeTerminalText(parts.map((part) => part.slice(0, PREVIEW_CHARS + 1)).join("\n\n").slice(0, PREVIEW_CHARS + 1));
	// A clipped preview must not split a UTF-16 surrogate pair or pretend to be the full report.
	let end = Math.min(text.length, PREVIEW_CHARS);
	if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
	const preview = text.slice(0, end) || "(no output)";
	const hint = resultReceiptHint(run.resultReceipt);
	return [preview, rawLength > PREVIEW_CHARS ? "(preview truncated)" : "",
		hint ? sanitizeTerminalText(hint).slice(0, 800) : `Retrieve retained result with intercom { action:"result", to:"${run.id}" }.`]
		.filter(Boolean).join("\n\n");
}

export function settleAsyncTreeNode(tree: AgentTree, run: AsyncRun): void {
	if (run.status === "running") return;
	const id = `async:${run.id}`;
	const nodes = tree.snapshot();
	const node = nodes.find((item) => item.id === id);
	if (!node) return; // A late completion cannot restore a cleared session's UI.
	const parent = nodes.find((item) => item.id === node.parentId);
	const keepInBatch = run.batch !== undefined && parent?.id === `delegate:${run.batch}`
		&& parent.kind === "delegate" && parent.status === "running";
	const model = observedModel(run.result?.modelUsed, node.model);
	tree.add({
		id,
		label: keepInBatch ? compactInlineText([run.label ?? run.agent, shortModel(model)].filter(Boolean).join(" · "), { maxChars: 120 }) : node.label,
		status: run.status,
		model,
		detail: run.error ?? run.result?.error ?? (run.result ? formatUsage(run.result.usage) : ""),
		...(run.result ? { usage: run.result.usage } : {}),
		...(run.result?.thinkingEffective ? { thinkingEffective: run.result.thinkingEffective } : {}),
		...(keepInBatch ? { output: terminalPreview(run) } : {}),
	});
	if (!keepInBatch) tree.remove(id);
}
