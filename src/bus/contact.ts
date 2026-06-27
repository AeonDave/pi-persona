/**
 * `contact_supervisor` — the CHILD-side tool of the communication plane. A sub-agent
 * calls it to reach its supervisor while it runs (guardrails §4.9, the comtac
 * `contact_supervisor` semantic). Injected into an in-process child session as a
 * `customTool` by the engine, bound to the shared {@link InProcessBus} + the child's
 * handle.
 *
 * - `progress_update` (one-way): post and return immediately — the supervisor reads it
 *   on its next peek (or it rides back on the run's result in sync mode).
 * - `need_decision` / `interview_request` (blocking): `bus.ask` — the child waits for
 *   the supervisor's reply. This only makes sense in **async** runs where the supervisor
 *   is free to answer; the tool aborts cleanly on the run's signal so it never hangs a
 *   sync run with no one listening.
 *
 * Pure factory (takes the bus + handles), so it is unit-tested without a live model.
 */

import { type Static, Type } from "typebox";

import { defineTool } from "@earendil-works/pi-coding-agent";

import type { InProcessBus, MsgKind } from "./inproc.ts";

const ContactParams = Type.Object({
	kind: Type.Union([Type.Literal("progress"), Type.Literal("decision"), Type.Literal("interview")], {
		description:
			"progress = one-way status update (don't wait); decision = ask the supervisor to choose and WAIT for the answer; interview = ask a clarifying question and WAIT.",
	}),
	message: Type.String({ description: "What to tell or ask the supervisor — specific and self-contained." }),
});

type ContactDetails = { kind: MsgKind; delivered: boolean };

function result(t: string, details: ContactDetails): { content: [{ type: "text"; text: string }]; details: ContactDetails } {
	return { content: [{ type: "text", text: t }], details };
}

/** Build the child's `contact_supervisor` tool, bound to a bus + the child's handle.
 *  `defineTool` preserves param inference while widening the result so it slots into a
 *  `customTools: ToolDefinition[]` array (the variance shim Pi provides for exactly this).
 *
 *  `allowBlocking` (async runs only): when false, a `decision`/`interview` does NOT block —
 *  the supervisor is busy (a sync run holds the turn), so the question is posted one-way and
 *  the child proceeds. This prevents a sync delegate/council from deadlocking on a child ask. */
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
			"Use `decision` when you hit a choice only the supervisor should make, or `interview` to ask a",
			"clarifying question — both WAIT for the supervisor's reply before you continue.",
		].join(" "),
		promptSnippet: "contact_supervisor — report progress or ask the supervisor a blocking question",
		parameters: ContactParams,
		async execute(_toolCallId, params: Static<typeof ContactParams>, signal, _onUpdate, _ctx) {
			const kind = params.kind as MsgKind;
			if (kind === "progress") {
				const delivered = bus.send(fromHandle, supervisorHandle, params.message, "progress");
				return result(
					delivered ? "Progress reported to the supervisor." : "(no supervisor listening; progress dropped)",
					{ kind, delivered },
				);
			}

			// In a sync run the supervisor is blocked holding the turn → it cannot answer. Post the
			// question one-way and let the child proceed, rather than deadlock until timeout.
			if (!allowBlocking) {
				const delivered = bus.send(fromHandle, supervisorHandle, params.message, kind);
				return result(
					delivered
						? "The supervisor is busy right now; your question was noted — proceed using your best judgement."
						: "(no supervisor reachable — proceed using your best judgement)",
					{ kind, delivered },
				);
			}

			// decision | interview → block for the supervisor's reply. `bus.ask` honours the run
			// signal (cleaning up its own timer/entry), and a rejection (abort or timeout) is
			// turned into a RESULT — execute() must never throw or hang under the tool contract.
			let answer: Promise<string>;
			try {
				answer = bus.ask(fromHandle, supervisorHandle, params.message, signal ? { kind, signal } : { kind });
			} catch {
				return result("(no supervisor reachable — proceed using your best judgement)", { kind, delivered: false });
			}
			try {
				const reply = await answer;
				return result(`Supervisor: ${reply}`, { kind, delivered: true });
			} catch {
				const msg = signal?.aborted
					? "(the request was cancelled before the supervisor replied)"
					: "(the supervisor did not reply in time — proceed using your best judgement)";
				return result(msg, { kind, delivered: false });
			}
		},
	});
}
