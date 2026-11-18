import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderContinuity, SupervisorContinuity, type ContinuitySnapshot } from "../core/supervisor-continuity.ts";

/** Observe native compaction and add a request-local snapshot, without writing history or waking Pi. */
export function installSupervisorContinuity(pi: ExtensionAPI, snapshot: () => ContinuitySnapshot): void {
	const state = new SupervisorContinuity();
	pi.on("session_compact", (event, ctx) => state.arm(ctx.sessionManager.getSessionId(), event.compactionEntry.id));
	pi.on("context_with_system", (event, ctx) => {
		if (!state.applies(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch().map((entry) => entry.id))) return;
		const index = event.messages.findLastIndex((message) => message.role === "system");
		const system = event.messages[index];
		if (!system || system.role !== "system") return;
		const content = renderContinuity(snapshot(), Date.now());
		state.prepared();
		if (!content) return;
		const messages = event.messages.slice();
		messages[index] = { ...system, sections: { ...system.sections, "pi-persona-continuity": content } };
		return { messages };
	});
	pi.on("turn_end", (event) => {
		if (event.message.role === "assistant" && event.message.stopReason !== "error" && event.message.stopReason !== "aborted") state.response();
	});
}
