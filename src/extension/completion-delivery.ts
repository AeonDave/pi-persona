/** Last unread worker notes belong to the existing completion wake, never a new polling timer. */
import type { InProcessBus } from "../bus/inproc.ts";
import { boundCompletionSurface, MAX_COMPLETION_REPORT_CHARS, type AsyncRun } from "../engine/async.ts";
import { formatIntercomDelivery } from "../tools/intercom.ts";

interface CompletionInboxDeps {
	bus: Pick<InProcessBus, "pending" | "takeWhere">;
	self: string;
	deliver(text: string, runs: readonly AsyncRun[]): void;
}

export function createCompletionInboxDelivery(deps: CompletionInboxDeps) {
	return (report: string, runs: readonly AsyncRun[]): void => {
		// Snapshot before sending, commit consumption only after a successful synchronous host send.
		// A failed send leaves both notifier items and inbox notes available for its existing retry.
		const unread = deps.bus.pending(deps.self).filter((message) => !message.expectsReply);
		if (!unread.length) { deps.deliver(report, runs); return; }
		const ids = new Set(unread.map((message) => message.id));
		const block = formatIntercomDelivery(unread, { maxBatchChars: MAX_COMPLETION_REPORT_CHARS });
		// The tail survives head/tail clipping. IDs remain routing references, never display aliases;
		// body retrieval follows the bus's existing bounded retention contract.
		const footer = `Intercom message ids: ${[...ids].join(", ")}.`;
		const text = boundCompletionSurface(`${report}\n\n${block}\n\n${footer}`,
			'completion and inbox truncated at 12000 characters; use intercom { action:"results" } / { action:"result", to:"<run-id>" } for reports, or { action:"message", messageId:"<id>" } for messages while retained');
		deps.deliver(text, runs);
		deps.bus.takeWhere(deps.self, (message) => !message.expectsReply && ids.has(message.id));
	};
}
