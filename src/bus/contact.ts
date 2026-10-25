/**
 * `contact_supervisor` — the CHILD-side tool of the communication plane. A sub-agent
 * calls it to reach its supervisor while it runs (guardrails §4.9, the comtac
 * `contact_supervisor` semantic). Injected into an in-process child session as a
 * `customTool` by the engine, bound to the shared {@link InProcessBus} + the child's
 * handle.
 *
 * - `progress` (one-way): post and return immediately.
 * - `decision` / `interview` (blocking): `bus.ask` — the child waits for
 *   the supervisor's reply. This only makes sense in **async** runs where the supervisor
 *   is free to answer; the tool aborts cleanly on the run's signal so it never hangs a
 *   sync run with no one listening.
 *
 * Pure factory (takes the bus + handles), so it is unit-tested without a live model.
 */

import { type Static, Type } from "typebox";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { compactInlineText } from "../ui/presentation.ts";
import { renderLiteralToolResult } from "../ui/literal-tool-result.ts";
import type { InProcessBus, MsgKind } from "./inproc.ts";

const ContactParams = Type.Object({
	kind: Type.Union([Type.Literal("progress"), Type.Literal("decision"), Type.Literal("interview")], {
		description:
			"progress = one-way status update (don't wait); decision = ask the supervisor to choose; interview = ask a clarifying question. Async decision/interview requests wait for a reply; synchronous requests post one-way with no possible answer, so the request remains unresolved.",
	}),
	message: Type.String({ description: "What to tell or ask the supervisor — specific and self-contained." }),
});

type ContactOutcome = "reported" | "answered" | "unavailable" | "timed-out" | "cancelled" | "failed";

type ContactDetails = {
	kind: MsgKind;
	/** Delivery evidence only, never evidence of a reply or approval. False means delivery was not confirmed. */
	delivered: boolean;
	outcome: ContactOutcome;
};

type AskFailure = "aborted" | "timeout" | "inbox-full" | "unavailable" | "generic";

const UNRESOLVED_NEXT_STEP = "Continue only with independent work already authorized; otherwise return a blocked/partial result.";

function unresolvedGuidance(kind: "decision" | "interview"): string {
	return `The ${kind} remains unresolved. ${UNRESOLVED_NEXT_STEP}`;
}

function outcomeForAskFailure(failure: AskFailure): ContactOutcome {
	switch (failure) {
		case "aborted": return "cancelled";
		case "timeout": return "timed-out";
		case "inbox-full":
		case "unavailable": return "unavailable";
		case "generic": return "failed";
	}
}

function askFailureText(failure: AskFailure): string {
	switch (failure) {
		case "aborted": return "The request was cancelled before the supervisor replied.";
		case "timeout": return "The supervisor did not reply in time.";
		case "inbox-full": return "The supervisor inbox is full; this request was not delivered. Retry later or consolidate the question.";
		case "unavailable": return "The supervisor is unavailable; delivery could not be confirmed.";
		case "generic": return "The supervisor request failed; delivery could not be confirmed.";
	}
}

function classifyAskFailure(error: unknown, signal: AbortSignal | undefined): AskFailure {
	if (signal?.aborted) return "aborted";
	const message = error instanceof Error ? error.message : "";
	if (/^ask timeout(?:\s|$)/i.test(message)) return "timeout";
	if (/^inbox full(?:\s|:|$)/i.test(message)) return "inbox-full";
	if (
		/^ask unregistered(?:\s|$)/i.test(message) ||
		/^unknown peer(?:\s|:|$)/i.test(message) ||
		/^bridge: not connected(?:\s|$)/i.test(message) ||
		/^broker (?:connection|client) closed(?:\s|$)/i.test(message)
	) return "unavailable";
	return "generic";
}

function result(t: string, details: ContactDetails): { content: [{ type: "text"; text: string }]; details: ContactDetails } {
	return { content: [{ type: "text", text: t }], details };
}

/** Build the child's `contact_supervisor` tool, bound to a bus + the child's handle.
 *  `defineTool` preserves param inference while widening the result so it slots into a
 *  `customTools: ToolDefinition[]` array (the variance shim Pi provides for exactly this).
 *
 *  `allowBlocking` (async runs only): when false, a `decision`/`interview` does NOT block —
 *  the supervisor is busy (a sync run holds the turn), so the question is posted one-way and
 *  returns unresolved. This prevents a sync delegate/council from deadlocking on a child ask. */
export function makeContactSupervisorTool(
	bus: InProcessBus,
	fromHandle: string,
	supervisorHandle: string,
	opts: { allowBlocking?: boolean } = {},
) {
	const allowBlocking = opts.allowBlocking ?? true;
	return defineTool({
		name: "contact_supervisor",
		label: "Contact supervisor",
		description: [
			"Reach the supervisor that delegated this task WHILE you work.",
			"Use `progress` to report a milestone (one-way, don't wait).",
			"Use `decision` when you hit a choice only the supervisor should make, or `interview` to ask a clarifying question.",
			allowBlocking
				? "This async run waits for the supervisor's reply before continuing. If there is no reply, the request remains unresolved: continue only with independent work already authorized, otherwise return a blocked/partial result."
				: "This synchronous run cannot block: decision/interview are posted one-way and return immediately; no answer is possible in this path, so the request remains unresolved. Continue only with independent work already authorized, otherwise return a blocked/partial result.",
			`Messages longer than ${MAX_CONTACT_MESSAGE_CHARS} characters are shortened before delivery; use smaller messages to preserve full detail.`,
		].join(" "),
		promptSnippet: "contact_supervisor — report progress or ask the supervisor a question",
		parameters: ContactParams,
		async execute(_toolCallId, params: Static<typeof ContactParams>, signal, _onUpdate, _ctx) {
			const kind = params.kind as MsgKind;
			if (signal?.aborted) {
				const text = kind === "progress"
					? "The progress update was cancelled before delivery."
					: `The request was cancelled before the supervisor was contacted. ${unresolvedGuidance(kind)}`;
				return result(text, { kind, delivered: false, outcome: "cancelled" });
			}
			const message = boundContactMessage(params.message);
			if (kind === "progress") {
				try {
					const delivered = bus.send(fromHandle, supervisorHandle, message, "progress");
					return result(
						delivered ? "Progress reported to the supervisor." : "(no supervisor listening or progress delivery could not be confirmed; progress dropped)",
						{ kind, delivered, outcome: delivered ? "reported" : "unavailable" },
					);
				} catch {
					return result("(progress could not be sent; delivery could not be confirmed)", { kind, delivered: false, outcome: "failed" });
				}
			}

			// In a sync run the supervisor is blocked holding the turn → it cannot answer. Post the
			// question one-way, but return unresolved; the send is not authorization to proceed on it.
			if (!allowBlocking) {
				let delivered: boolean;
				try {
					delivered = bus.send(fromHandle, supervisorHandle, message, kind);
				} catch {
					return result(
						`The question could not be sent; no answer is possible in this path. ${unresolvedGuidance(kind)}`,
						{ kind, delivered: false, outcome: "failed" },
					);
				}
				const delivery = delivered ? "question sent one-way" : "question delivery could not be confirmed";
				return result(
					`The supervisor is busy right now; ${delivery}, and no answer is possible in this path. ${unresolvedGuidance(kind)}`,
					{ kind, delivered, outcome: "unavailable" },
				);
			}

			// decision | interview → block for the supervisor's reply. `bus.ask` honours the run
			// signal (cleaning up its own timer/entry), and a rejection (abort or timeout) is
			// turned into a RESULT — execute() must never throw or hang under the tool contract.
			let answer: Promise<string>;
			try {
				answer = bus.ask(fromHandle, supervisorHandle, message, signal ? { kind, signal } : { kind });
			} catch (error) {
				const failure = classifyAskFailure(error, signal);
				return result(`${askFailureText(failure)} ${unresolvedGuidance(kind)}`, {
					kind,
					delivered: false,
					outcome: outcomeForAskFailure(failure),
				});
			}
			try {
				const reply = await answer;
				// A response that settles concurrently with cancellation is stale for this call:
				// never report it as an answer once the caller's signal has aborted.
				if (signal?.aborted) {
					return result(`${askFailureText("aborted")} ${unresolvedGuidance(kind)}`, {
						kind,
						delivered: false,
						outcome: "cancelled",
					});
				}
				return result(`Supervisor: ${reply}`, { kind, delivered: true, outcome: "answered" });
			} catch (error) {
				const failure = classifyAskFailure(error, signal);
				return result(`${askFailureText(failure)} ${unresolvedGuidance(kind)}`, {
					kind,
					delivered: false,
					outcome: outcomeForAskFailure(failure),
				});
			}
		},
		// Compact purpose line only: the message is the child's own prose, and echoing it in the
		// call card would overflow the transcript the way the host fallback's raw-args echo does.
		renderCall(args, theme) {
			const kind = compactInlineText(args.kind ?? "", { maxChars: 12 });
			return new Text(theme.fg("toolTitle", theme.bold(kind ? `contact ${kind}` : "contact")), 0, 0);
		},
		// One shared literal receipt. An answered ask is bounded collapsed and expands to the full
		// reply; progress receipts are naturally one compact line. Unresolved outcomes
		// (unavailable/timed-out/cancelled/failed) are SUCCESSFUL tool results carrying an
		// unresolved outcome — the error heading appears only when the host context says isError.
		renderResult(result, { expanded }, theme, context) {
			return renderLiteralToolResult(result, { expanded }, theme, context);
		},
	});
}
/** Maximum body accepted by contact_supervisor's message action. Full reports should use the
 * delegated result channel rather than sending megabytes over the supervisor bus. */
export const MAX_CONTACT_MESSAGE_CHARS = 8_000;

/** Keep the sender-facing body bounded while preserving both ends and an omission count. */
export function boundContactMessage(message: string, maxChars = MAX_CONTACT_MESSAGE_CHARS): string {
	if (message.length <= maxChars) return message;
	const marker = `\n\n[… ${message.length - maxChars} characters omitted; send the remaining detail in smaller contact_supervisor messages …]\n\n`;
	if (marker.length >= maxChars) return marker.slice(0, Math.max(0, maxChars));
	const content = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(content / 2);
	const tail = Math.max(0, content - head);
	return `${message.slice(0, head)}${marker}${tail > 0 ? message.slice(-tail) : ""}`;
}
