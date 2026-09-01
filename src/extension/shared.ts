/**
 * Small leaf helpers shared by the extension composition root and extracted hook/tool modules.
 * This module must not import `extension.ts` or any of the registration modules that consume it.
 */
import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";

import { sanitizeDisplayLabel } from "../core/display-label.ts";
import { boundCompletionSurface, MAX_COMPLETION_REPORT_CHARS } from "../engine/async.ts";
import type { InboundDecision } from "../exocom/inbound.ts";
import { EXOCOM } from "../exocom/limits.ts";
import type { DisplayPeer, ExocomInboundResult } from "../exocom/plane.ts";
import type { DelegateView } from "../tools/delegate.ts";
import type { AgentNodeStatus } from "../ui/agent-tree.ts";
import { compactInlineText } from "../ui/presentation.ts";

const PI_PERSONA_TOOL_ERROR = "__piPersonaToolError";

export function failureDetails<T extends object>(details: T): T & { __piPersonaToolError: true } {
	return { ...details, [PI_PERSONA_TOOL_ERROR]: true };
}

export function piPersonaToolErrorPatch(details: unknown): { isError: true; details: Record<string, unknown> } | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const record = details as Record<string, unknown>;
	if (record[PI_PERSONA_TOOL_ERROR] !== true) return undefined;
	const clean = { ...record };
	delete clean[PI_PERSONA_TOOL_ERROR];
	return { isError: true, details: clean };
}

export function canDeliverPersonaNotification(orchestrating: boolean, processingDeferred: boolean, hostIdle: boolean): boolean {
	return !orchestrating && !processingDeferred && hostIdle;
}

export function sanitizePeerField(value: string, max: number): string {
	return value
		.normalize("NFKC")
		.replace(/[^A-Za-z0-9._/@:+#-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._/@:+#]+|[-._/@:+#]+$/g, "")
		.slice(0, max);
}

export function sanitizeLabel(s: string): string {
	return sanitizePeerField(s, 80) || "peer";
}

const EXOCOM_ROUTING_TOKEN = /@[a-f0-9]{24}$/i;

export function canonicalExocomTelemetryTargets(
	peers: ReadonlyArray<Pick<DisplayPeer, "session_id" | "displayName" | "target">>,
	target: string,
): string[] {
	if (target === "*") return peers.map((peer) => peer.session_id);
	const exact = peers.find((peer) => peer.target === target);
	if (exact) return [exact.session_id];
	if (EXOCOM_ROUTING_TOKEN.test(target)) return [];
	const display = peers.find((peer) => peer.displayName === target);
	return display ? [display.session_id] : [];
}

export function exocomInboundDisposition(decision: InboundDecision): ExocomInboundResult {
	if ("deliver" in decision) return { accepted: true };
	if ("duplicate" in decision) return { accepted: true, duplicate: true };
	return { accepted: false, reason: decision.drop };
}

export function formatExocomQueuedToast(label: string, inReplyTo: string | undefined): string {
	return `exocom: ${inReplyTo === undefined ? "message" : "reply"} from ${label} queued`;
}

export interface ExocomQueuedToast {
	label: string;
	inReplyTo: string | undefined;
}

export function formatExocomQueuedBatchToast(items: readonly ExocomQueuedToast[]): string {
	if (items.length === 0) return "";
	const first = items[0]!;
	if (items.length === 1) return formatExocomQueuedToast(first.label, first.inReplyTo);
	const counts = new Map<string, number>();
	for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
	const senders = [...counts.entries()];
	const visible = senders.slice(0, 3).map(([label, count]) => count > 1 ? `${label} ×${count}` : label);
	const omitted = senders.length - visible.length;
	return `exocom: ${items.length} messages/replies queued from ${visible.join(", ")}${omitted > 0 ? `, +${omitted} more` : ""}`;
}

export function boundExocomInboundBatch(items: readonly string[]): string {
	return boundCompletionSurface(
		items.join("\n\n"),
		"exocom inbound batch truncated; remaining peer messages stay queued for later delivery",
	);
}

export function exocomInboundBatchSize(items: readonly string[]): number {
	let chars = 0;
	let count = 0;
	for (const item of items) {
		const withItem = chars + (count > 0 ? 2 : 0) + item.length;
		if (count > 0 && withItem > MAX_COMPLETION_REPORT_CHARS) break;
		chars = withItem;
		count += 1;
	}
	return Math.max(1, count);
}

export const EXOCOM_INBOX_MAX = 3 * EXOCOM.SENDER_MAX_MSGS;

export function agentNodeStatusForDelegate(view: Pick<DelegateView, "running" | "ok"> & { failureKind?: DelegateView["failureKind"] }): AgentNodeStatus {
	if (view.running) return "running";
	if (view.failureKind === "abort") return "stopped";
	return view.ok ? "done" : "failed";
}

export function sendPersonaFollowUp(
	pi: Pick<ExtensionAPI, "sendMessage">,
	content: string,
	customType = "pi-persona",
): void {
	const body = customType === "pi-persona" ? content.replace(/^\[pi-persona\]\s*/, "") : content;
	pi.sendMessage(
		{ customType, content: body, display: true },
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

export function expandDetailHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "expand to see full detail";
	}
}

export function formatCouncilCallLabel(strategy: string, roster: string): string {
	const safeStrategy = compactInlineText(strategy, { maxChars: 80 }) || "?";
	const safeRoster = compactInlineText(roster, { maxChars: 80 }) || "?";
	return `council ${safeStrategy}${strategy === roster ? "" : ` · ${safeRoster}`}`;
}

export interface PendingAsk {
	askId: string;
	text: string;
}

export function reconcileAnsweredAsk(
	askId: string,
	notifier: { discard: (pred: (item: PendingAsk) => boolean) => void },
	inbox: { takeWhere: (handle: string, pred: (env: { id: string }) => boolean) => unknown },
	handle: string,
): void {
	notifier.discard((item) => item.askId === askId);
	inbox.takeWhere(handle, (env) => env.id === askId);
}

export function shouldReportHeartbeatFailure(consecutiveFailures: number): boolean {
	return consecutiveFailures === 1 || consecutiveFailures % 10 === 0;
}

export function fenceIntercomOutcome(out: { text: string; details: { action: string; messages?: unknown[] } }, fence: (t: string) => string): string {
	const untrusted = out.details.action === "inbox" && (out.details.messages?.length ?? 0) > 0;
	return untrusted ? fence(out.text) : out.text;
}

export function coachingDisabledHint(personaName: string | undefined): string {
	const who = sanitizeDisplayLabel(personaName ?? "default", "default");
	return `(coaching is OFF for persona "${who}" — sub-agents get no contact_supervisor tool, so the message bus is empty. To just watch or redirect them use action "peek"/"steer"; to exchange messages, add \`coaching: true\` or switch to a coaching persona.)`;
}
