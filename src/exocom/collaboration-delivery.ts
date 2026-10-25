/** Signed offer wakes project retained ledger data; the envelope is never its authority. */
import { attributePeer } from "../core/fence.ts";
import { collaborationOfferStatus } from "./collaboration.ts";
import { frameSigningPayload, type ExocomOffer, type ExocomSemanticFrame } from "./envelope.ts";
import type { LedgerState } from "./ledger.ts";

export function collaborationWriteIntent(frame: ExocomSemanticFrame, state: LedgerState): boolean {
	if (frame.kind === "claim" || frame.kind === "task_create") return frame.write_set.length > 0;
	return frame.kind === "task_take" && (state.collaboration?.tasks.find((task) => task.created.work_key === frame.work_key)?.created.write_set.length ?? 0) > 0;
}

export function deliverCollaborationOffer(
	frame: ExocomOffer, state: LedgerState, sessionId: string, label: string, now: number,
): { accepted: true; notice?: string } | { accepted: false; reason: string } {
	if (frame.to_session !== sessionId) return { accepted: false, reason: "offer addressed to another session" };
	const stored = state.collaboration?.offers.find((offer) => offer.offer_id === frame.offer_id);
	if (!stored || frameSigningPayload(stored) !== frameSigningPayload(frame)) {
		return { accepted: false, reason: "offer is not durable with this sender and payload" };
	}
	const tasks = state.collaboration?.tasks ?? [];
	if (collaborationOfferStatus(stored, tasks, now) !== "open") return { accepted: true };
	const task = tasks.find((candidate) => candidate.created.work_key === stored.work_key && candidate.created.msg_id === stored.task_id);
	if (!task) return { accepted: true };
	return { accepted: true, notice: [
		`[pi-persona] Optional peer invitation · task=${stored.work_key} · offer=${stored.offer_id} · expires ${stored.expires_at}`,
		"This creates no response obligation or permission. Inspect the task and take it voluntarily only within your authorized scope; otherwise continue your work.",
		attributePeer(frame.from_session === task.created.from_session ? label : task.created.from_session, task.created.description),
	].join("\n") };
}
