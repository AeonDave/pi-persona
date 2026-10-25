/** Voluntary peer work. Pure domain rules; claims and persistence stay in the ledger transaction. */
import { writeSetPathError } from "../core/ownership.ts";
import { isSemanticFrame, type ExocomSemanticFrame, type ExocomCollaborationFrame, type ExocomOffer, type ExocomProgress, type ExocomPublish, type ExocomTaskCreate, type ExocomTaskFinish, type ExocomTaskTake } from "./envelope.ts";

export interface CollaborationTask {
	created: ExocomTaskCreate;
	taken?: ExocomTaskTake;
	progress?: ExocomProgress;
	finished?: ExocomTaskFinish;
	/** Loss of the owning registry lease is visible and never permits automatic pickup. */
	stale?: true;
	/** Receiver clock at the first lease-loss reconciliation, or release timestamp. */
	staleAt?: number;
}
export interface CollaborationState { tasks: CollaborationTask[]; offers: ExocomOffer[]; evidence: ExocomPublish[]; }
export const COLLABORATION_LIMITS = { tasks: 64, offers: 64, evidence: 64, maxBytes: 131_072 } as const;
export function emptyCollaboration(): CollaborationState { return { tasks: [], offers: [], evidence: [] }; }
export function collaborationStatus(task: CollaborationTask): "open" | "taken" | "done" | "abandoned" | "stale" {
	return task.finished?.outcome ?? (task.stale ? "stale" : task.taken ? "taken" : "open");
}
export function offerStatus(offer: ExocomOffer, now: number): "open" | "expired" {
	return Date.parse(offer.expires_at) <= now ? "expired" : "open";
}
/** Time expiry is authoritative even after the exact task generation becomes unavailable. */
export function collaborationOfferStatus(offer: ExocomOffer, tasks: readonly CollaborationTask[], now: number): "open" | "expired" | "stale" {
	if (offerStatus(offer, now) === "expired") return "expired";
	const task = tasks.find((candidate) => candidate.created.work_key === offer.work_key && candidate.created.msg_id === offer.task_id);
	return task && collaborationStatus(task) === "open" ? "open" : "stale";
}
function bounded(state: CollaborationState, reserveLifecycle = true): boolean {
	// Local ledger lifecycle events are unsigned. Reserve their largest identity metadata and a
	// minimal terminal note, as well as lease loss, before admitting optional prose. A full note
	// can hit quota; taking work, finishing with a short note and release must remain available.
	const reserved = { ...state, tasks: state.tasks.map((task) => {
		if (task.finished) return task;
		const future = { work_key: task.created.work_key, task_id: task.created.msg_id, from_session: "x".repeat(128),
			from_name: "界".repeat(256), msg_id: "x".repeat(128), ts: "9999-12-31T23:59:59.999Z" };
		return { ...task, stale: true, staleAt: -Number.MAX_VALUE,
			taken: task.taken ?? { ...future, kind: "task_take" }, finished: { ...future, kind: "task_finish", outcome: "abandoned", note: "x" } };
	}) };
	return state.tasks.length <= COLLABORATION_LIMITS.tasks && state.offers.length <= COLLABORATION_LIMITS.offers
		&& state.evidence.length <= COLLABORATION_LIMITS.evidence && Buffer.byteLength(JSON.stringify(reserveLifecycle ? reserved : state), "utf8") <= COLLABORATION_LIMITS.maxBytes;
}
/** Retained facts outlive the rolling transport-id window; they must never acquire duplicate identities. */
export function retainedCollaborationEvent(state: CollaborationState, msgId: string): ExocomSemanticFrame | undefined {
	for (const task of state.tasks) {
		for (const event of [task.created, task.taken, task.progress, task.finished]) if (event?.msg_id === msgId) return event;
	}
	return state.offers.find((event) => event.msg_id === msgId) ?? state.evidence.find((event) => event.msg_id === msgId);
}
type Transition = { ok: true; state: CollaborationState } | { ok: false; error: string };
function transition(state: CollaborationState, event: ExocomCollaborationFrame | ExocomProgress, reserveLifecycle: boolean): Transition {
	if (event.kind === "progress" && event.task_id === undefined) return { ok: true, state };
	const task = state.tasks.find((value) => value.created.work_key === event.work_key);
	let next = state;
	if (event.kind === "task_create") {
		if (task) return { ok: false, error: "task work_key already exists" };
		for (const path of event.write_set) {
			const error = writeSetPathError(path);
			if (error) return { ok: false, error: `task write_set path is ${error}` };
		}
		next = { ...state, tasks: [...state.tasks, { created: event }] };
	} else {
		if (!task) return { ok: false, error: "unknown collaboration task" };
		if (event.task_id !== task.created.msg_id) return { ok: false, error: "task_id does not match this work key's retained generation" };
		if (event.kind === "publish") next = { ...state, evidence: [...state.evidence, event] };
		else if (event.kind === "offer") {
			if (state.offers.some((offer) => offer.offer_id === event.offer_id)) return { ok: false, error: "offer_id already exists" };
			if (event.to_session === event.from_session) return { ok: false, error: "offer cannot target self" };
			if (collaborationStatus(task) !== "open") return { ok: false, error: "offers require an open task" };
			next = { ...state, offers: [...state.offers, event] };
		} else {
			const status = collaborationStatus(task);
			if (event.kind === "task_take") {
				if (status !== "open") return { ok: false, error: `task is ${status}; pickup refused` };
				next = { ...state, tasks: state.tasks.map((value) => value === task ? { ...task, taken: event } : value) };
			} else {
				if (status !== "taken" || task.taken?.from_session !== event.from_session) return { ok: false, error: "only the active task taker may report progress or finish" };
				if (event.kind === "progress" && Date.parse(event.ts) < Date.parse(task.progress?.ts ?? task.taken.ts)) return { ok: false, error: "task progress predates its latest observation" };
				const updated = event.kind === "progress" ? { ...task, progress: event } : { ...task, finished: event };
				next = { ...state, tasks: state.tasks.map((value) => value === task ? updated : value) };
			}
		}
	}
	return bounded(next, reserveLifecycle) ? { ok: true, state: next } : { ok: false, error: "collaboration retention budget reached; shorten optional report text" };
}
export function applyCollaborationEvent(state: CollaborationState, event: ExocomCollaborationFrame | ExocomProgress): Transition {
	return transition(state, event, true);
}

export function staleCollaboration(state: CollaborationState, isLive: (session: string) => boolean, now: number): CollaborationState {
	return { ...state, tasks: state.tasks.map((task) => task.finished || task.stale || isLive(task.taken?.from_session ?? task.created.from_session)
		? task : { ...task, stale: true, staleAt: now }) };
}
export function releaseCollaboration(state: CollaborationState, session: string, workKey: string, now: number): CollaborationState {
	return { ...state, tasks: state.tasks.map((task) => task.created.work_key === workKey && !task.finished && !task.stale
		&& (task.taken?.from_session ?? task.created.from_session) === session ? { ...task, stale: true, staleAt: now } : task) };
}
export function pruneCollaboration(state: CollaborationState, now: number, ttlMs: number, isLive: (session: string) => boolean): CollaborationState {
	const reconciled = staleCollaboration(state, isLive, now);
	const tasks = reconciled.tasks.filter((task) => {
		const terminalAt = task.finished ? Date.parse(task.finished.ts) : task.staleAt;
		return terminalAt === undefined || now - terminalAt <= ttlMs;
	});
	const retained = new Set(tasks.map((task) => task.created.work_key));
	return {
		tasks,
		offers: state.offers.filter((offer) => retained.has(offer.work_key) && now - Date.parse(offer.expires_at) <= ttlMs),
		evidence: state.evidence.filter((item) => retained.has(item.work_key) && now - Date.parse(item.ts) <= ttlMs),
	};
}

/** Reconstruct snapshots through the same rules. No malformed ownership record is silently skipped. */
export function parseCollaboration(raw: unknown): CollaborationState | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as CollaborationState;
	if (!Array.isArray(value.tasks) || !Array.isArray(value.offers) || !Array.isArray(value.evidence) || !bounded(value)) return undefined;
	let state = emptyCollaboration();
	const seen = new Set<string>();
	function replay(event: unknown, kind: string): boolean {
		if (!isSemanticFrame(event) || event.kind !== kind || seen.has(event.msg_id)) return false;
		if (!(event.kind === "task_create" || event.kind === "task_take" || event.kind === "task_finish" || event.kind === "progress" || event.kind === "offer" || event.kind === "publish")) return false;
		// Definitions must precede historical offers. Replay checks physical bounds; reserve
		// future lifecycle only on the final state, once completed tasks are terminal again.
		const applied = transition(state, event, false);
		if (!applied.ok) return false;
		seen.add(event.msg_id);
		state = applied.state;
		return true;
	}
	// All definitions precede offers/evidence; a finished task's historical offer is valid.
	for (const task of value.tasks) {
		if (!task || typeof task !== "object" || !replay(task.created, "task_create")) return undefined;
	}
	for (const offer of value.offers) if (!replay(offer, "offer")) return undefined;
	for (const task of value.tasks) {
		for (const [event, kind] of [[task.taken, "task_take"], [task.progress, "progress"], [task.finished, "task_finish"]] as const) {
			if (event !== undefined && (event.work_key !== task.created.work_key || !replay(event, kind))) return undefined;
		}
		if (task.stale !== undefined && task.stale !== true) return undefined;
		if (task.stale) {
			if (task.finished || typeof task.staleAt !== "number" || !Number.isFinite(task.staleAt)) return undefined;
			state = releaseCollaboration(state, task.taken?.from_session ?? task.created.from_session, task.created.work_key, task.staleAt);
		} else if (task.staleAt !== undefined) return undefined;
	}
	for (const evidence of value.evidence) if (!replay(evidence, "publish")) return undefined;
	return bounded(state) ? state : undefined;
}
