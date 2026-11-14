/** Unread worker notes share automatic completion delivery or explicit live result collection, never a new polling timer. */
import type { Envelope, InProcessBus } from "../bus/inproc.ts";
import { boundCompletionSurface, MAX_COMPLETION_REPORT_CHARS, type AsyncRun } from "../engine/async.ts";
import { formatIntercomDelivery } from "../tools/intercom.ts";

interface CompletionInboxDeps {
	bus: Pick<InProcessBus, "pending" | "takeWhere">;
	self: string;
	deliver(text: string, runs: readonly AsyncRun[]): void;
}

/** Commit only the snapshot successfully delivered; live asks and later arrivals remain unread. */
export function deliverPendingNotes(bus: Pick<InProcessBus, "pending" | "takeWhere">, self: string, deliver: (messages: Envelope[]) => void): boolean {
	const unread = bus.pending(self).filter((message) => !message.expectsReply);
	if (!unread.length) return false;
	const ids = new Set(unread.map((message) => message.id));
	deliver(unread);
	bus.takeWhere(self, (message) => !message.expectsReply && ids.has(message.id));
	return true;
}

/** Bound both delivery paths while keeping every drained note's retrieval id in the retained tail. */
export function formatPendingNotes(prefix: string, unread: Envelope[]): string {
	const block = formatIntercomDelivery(unread, { maxBatchChars: MAX_COMPLETION_REPORT_CHARS });
	const footer = `Intercom message ids: ${unread.map((message) => message.id).join(", ")}.`;
	return boundCompletionSurface(`${prefix}\n\n${block}\n\n${footer}`,
		'delivery truncated at 12000 characters; use intercom { action:"results" } / { action:"result", to:"<run-id>" } for reports, or { action:"message", messageId:"<id>" } for messages while retained');
}

export function createCompletionInboxDelivery(deps: CompletionInboxDeps) {
	return (report: string, runs: readonly AsyncRun[]): void => {
		// Snapshot before sending, commit consumption only after a successful synchronous host send.
		// A failed send leaves both notifier items and inbox notes available for its existing retry.
		const delivered = deliverPendingNotes(deps.bus, deps.self, (unread) => {
			deps.deliver(formatPendingNotes(report, unread), runs);
		});
		if (!delivered) deps.deliver(report, runs);
	};
}
