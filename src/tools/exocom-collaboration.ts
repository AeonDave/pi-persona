/** Task, offer, and evidence adapters for the external Exocom collaboration ledger. */
import { randomUUID } from "node:crypto";
import { type Static } from "typebox";

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { attributePeer } from "../core/fence.ts";
import { collaborationOfferStatus, collaborationStatus } from "../exocom/collaboration.ts";
import type { ExocomPlane } from "../exocom/plane.ts";
import type { ExocomSemanticFrame } from "../exocom/envelope.ts";
import type { LedgerState } from "../exocom/ledger.ts";
import { normalizeMetadataText } from "../exocom/registry.ts";
import { renderWriteSet, untrusted } from "../exocom/untrusted.ts";
import { renderLiteralToolResult } from "../ui/literal-tool-result.ts";
import { createReportBody } from "../ui/report-body.ts";
import {
	OfferParams,
	parseOfferInput,
	parsePublishInput,
	parseTaskInput,
	PublishParams,
	TaskParams,
} from "./exocom-collaboration-input.ts";

export interface ExocomCollaborationDeps {
	getPlane: () => ExocomPlane | undefined;
	sessionId: () => string;
	name: () => string;
	now: () => number;
	/** False for joined foreign workspaces whose file paths differ from the shared ledger scope. */
	canClaim: () => boolean;
	/** Recheck the effective capability at execution time, including targeted tool denies. */
	canCallTool: (name: string) => boolean;
	/** Canonicalize a public exocom_list target to its authenticated raw session id. */
	resolveTarget: (target: string) => string;
	dispatch: (frame: ExocomSemanticFrame) => Promise<{ msg_id: string; peerWakeDeferred?: true }>;
	ledger: () => LedgerState;
	/** Resolve attribution from the live registry; self-reported frame names are never used. */
	labelFor: (sessionId: string) => string | undefined;
	/** Exact public routing target shown by exocom_list for a live session. */
	targetForSession: (sessionId: string) => string | undefined;
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}
function checkedIdentity(deps: ExocomCollaborationDeps) {
	if (!deps.getPlane()) throw new Error("exocom is not active for this persona");
	const now = deps.now();
	if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error("exocom: clock returned an invalid timestamp");
	return { from_session: deps.sessionId(), from_name: deps.name(), ts: new Date(now).toISOString(), now };
}
function requireToolPermission(deps: ExocomCollaborationDeps, tool: string): void {
	if (deps.canCallTool(tool) !== true) throw new Error(`${tool}: this persona cannot call this Exocom tool`);
}
function frameIdentity(identity: ReturnType<typeof checkedIdentity>) {
	return { from_session: identity.from_session, from_name: identity.from_name, ts: identity.ts };
}
function requireWriteClaim(deps: ExocomCollaborationDeps, tool: string): void {
	if (deps.canClaim() !== true || deps.canCallTool("exocom_claim") !== true) {
		throw new Error(`${tool}: write-set tasks require local workspace scope and callable exocom_claim permission`);
	}
}
function taskByKey(state: LedgerState, workKey: string) {
	return state.collaboration?.tasks.find((task) => task.created.work_key === workKey);
}
function taskByIdentity(state: LedgerState, workKey: string, taskId: string) {
	return state.collaboration?.tasks.find((task) => task.created.work_key === workKey && task.created.msg_id === taskId);
}
function dispatchNotice(deferred: boolean): string {
	return deferred ? " · ledger committed; peer wake deferred" : "";
}
function dispatchDetails(deferred: boolean): Record<string, unknown> {
	return deferred ? { peerWakeDeferred: true } : {};
}
function resolvePeerLabel(deps: ExocomCollaborationDeps, sessionId: string): string {
	if (sessionId === deps.sessionId()) return `you (${untrusted(deps.name(), 48) || "self"})`;
	return deps.labelFor(sessionId) ?? sessionId;
}
function listPage(deps: ExocomCollaborationDeps, offset: number, limit: number, detail: boolean) {
	if (detail && limit > 5) throw new Error("exocom_task: limit must be at most 5 when detail=true");
	const state = deps.ledger();
	const tasks = state.collaboration?.tasks ?? [];
	const offers = state.collaboration?.offers ?? [];
	const total = tasks.length;
	const page = tasks.slice(offset, offset + limit);
	const lines = [`exocom tasks · ${total} retained · showing ${page.length} from offset ${offset}`];
	for (const task of page) {
		const created = task.created;
		const status = collaborationStatus(task);
		const creatorLabel = untrusted(resolvePeerLabel(deps, created.from_session), 64) || created.from_session;
		lines.push(`\n${created.work_key} · task_id=${created.msg_id} · ${status} · created by ${creatorLabel} · ${created.write_set.length ? `${created.write_set.length} write paths` : "read-only"}`);
		if (task.taken) {
			const takerLabel = untrusted(resolvePeerLabel(deps, task.taken.from_session), 64) || task.taken.from_session;
			lines.push(`taker: ${takerLabel}`);
		}
		if (created.write_set.length) {
			lines.push(`write scope summary (may be clipped; use exocom_task get with work_key=${created.work_key} and task_id=${created.msg_id} for exact paths)`);
			lines.push(attributePeer(resolvePeerLabel(deps, created.from_session), renderWriteSet(created.write_set)));
		}
		const taskOffers = offers.filter((offer) => offer.work_key === created.work_key && offer.task_id === created.msg_id);
		for (const offer of taskOffers.slice(0, 3)) {
			const target = offer.to_session
				? normalizeMetadataText(deps.targetForSession(offer.to_session) ?? `offline:${offer.to_session}`, 80, "offline target")
				: "pool";
			const offerState = collaborationOfferStatus(offer, tasks, deps.now());
			lines.push(`offer ${offer.offer_id} → ${target} · ${offerState} · expires ${offer.expires_at}`);
		}
		if (taskOffers.length > 3) lines.push(`offers: +${taskOffers.length - 3} more`);
		if (detail) {
			lines.push(attributePeer(resolvePeerLabel(deps, created.from_session), created.description));
			if (task.progress) lines.push(attributePeer(resolvePeerLabel(deps, task.progress.from_session), `Progress: ${task.progress.note}`));
			if (task.finished) lines.push(attributePeer(resolvePeerLabel(deps, task.finished.from_session), `Finish (${task.finished.outcome}): ${task.finished.note}`));
		}
	}
	const nextOffset = offset + page.length < total ? offset + page.length : undefined;
	return toolResult(lines.join("\n"), {
		action: "list", total, offset, limit, count: page.length,
		task_ids: page.map((task) => task.created.msg_id),
		...(nextOffset === undefined ? {} : { nextOffset }), detail,
	});
}

function taskDetail(deps: ExocomCollaborationDeps, state: LedgerState, task: NonNullable<ReturnType<typeof taskByIdentity>>) {
	const created = task.created;
	const status = collaborationStatus(task);
	const creator = resolvePeerLabel(deps, created.from_session);
	const lines = [
		`exocom task · ${created.work_key} · task_id=${created.msg_id} · ${status}`,
		`created by ${untrusted(creator, 64) || created.from_session}`,
		attributePeer(creator, `Description:\n${created.description}`),
	];
	if (created.write_set.length) {
		lines.push(attributePeer(creator, `Exact write_set JSON (${created.write_set.length} paths):\n${JSON.stringify(created.write_set, null, 2)}`));
	} else {
		lines.push("write_set: [] (read-only)");
	}
	if (task.taken) lines.push(`taken by ${untrusted(resolvePeerLabel(deps, task.taken.from_session), 64) || task.taken.from_session}`);
	if (task.progress) lines.push(attributePeer(resolvePeerLabel(deps, task.progress.from_session), `Progress:\n${task.progress.note}`));
	if (task.finished) lines.push(attributePeer(resolvePeerLabel(deps, task.finished.from_session), `Finish (${task.finished.outcome}):\n${task.finished.note}`));
	const offers = (state.collaboration?.offers ?? []).filter((offer) => offer.work_key === created.work_key && offer.task_id === created.msg_id);
	for (const offer of offers.slice(0, 3)) {
		const target = offer.to_session
			? normalizeMetadataText(deps.targetForSession(offer.to_session) ?? `offline:${offer.to_session}`, 80, "offline target")
			: "pool";
		lines.push(`offer ${offer.offer_id} → ${target} · ${collaborationOfferStatus(offer, state.collaboration?.tasks ?? [], deps.now())} · expires ${offer.expires_at}`);
	}
	if (offers.length > 3) lines.push(`offers: +${offers.length - 3} more`);
	return toolResult(lines.join("\n\n"), {
		action: "get", work_key: created.work_key, task_id: created.msg_id, status,
		writeSetCount: created.write_set.length, offerIds: offers.map((offer) => offer.offer_id),
	});
}

export function registerExocomCollaborationTools(pi: ExtensionAPI, deps: ExocomCollaborationDeps): void {
	pi.registerTool({
		name: "exocom_task",
		label: "Exocom Task",
		description: "Create or pick up a bounded collaboration task, report progress or finish, inspect full details with get by work_key+task_id, and page through retained tasks. For discovery, use list without work_key/task_id. List pages default to 10 rows (5 with detail=true), cap at 20 summaries and 5 detailed rows; explicit detail limits above 5 are rejected. List write scopes are summaries that may be clipped; get requires both identifiers returned by create/list and shows the exact fenced scope. Write-set tasks require workspace-scoped exocom_claim permission; a foreign-workspace Pi may take read-only tasks.",
		parameters: TaskParams,
		async execute(_id, raw: Static<typeof TaskParams>) {
			const params = parseTaskInput(raw);
			requireToolPermission(deps, "exocom_task");
			if (params.action === "list") {
				checkedIdentity(deps);
				return listPage(deps, params.offset, params.limit, params.detail);
			}
			const identity = checkedIdentity(deps);
			if (params.action === "create") {
				if (params.write_set.length) requireWriteClaim(deps, "exocom_task create");
				if (taskByKey(deps.ledger(), params.work_key)) throw new Error(`exocom_task: work_key ${params.work_key} already exists`);
				const frame: ExocomSemanticFrame = {
					kind: "task_create", ...frameIdentity(identity), work_key: params.work_key,
					description: params.description, write_set: params.write_set, msg_id: randomUUID(),
				};
				const sent = await deps.dispatch(frame);
				return toolResult(`exocom: created task ${params.work_key} · task_id=${sent.msg_id}${dispatchNotice(sent.peerWakeDeferred === true)}`, {
					action: "create", work_key: params.work_key, task_id: sent.msg_id, msg_id: sent.msg_id, writeSetCount: params.write_set.length,
					...dispatchDetails(sent.peerWakeDeferred === true),
				});
			}
			const state = deps.ledger();
			const task = taskByIdentity(state, params.work_key, params.task_id);
			if (!task) throw new Error(`exocom_task: task_id ${params.task_id} does not match retained task ${params.work_key}`);
			if (params.action === "get") return taskDetail(deps, state, task);
			if (params.action === "take") {
				if (task.created.write_set.length) requireWriteClaim(deps, "exocom_task take");
				if (collaborationStatus(task) !== "open") throw new Error(`exocom_task: task is ${collaborationStatus(task)}; pickup refused`);
				const frame: ExocomSemanticFrame = { kind: "task_take", ...frameIdentity(identity), work_key: params.work_key, task_id: params.task_id, msg_id: randomUUID() };
				const sent = await deps.dispatch(frame);
				return toolResult(`exocom: took task ${params.work_key} · task_id=${params.task_id} · msg_id=${sent.msg_id}${dispatchNotice(sent.peerWakeDeferred === true)}`, {
					action: "take", work_key: params.work_key, task_id: params.task_id, msg_id: sent.msg_id, ...dispatchDetails(sent.peerWakeDeferred === true),
				});
			}
			if (task.taken?.from_session !== identity.from_session || collaborationStatus(task) !== "taken") {
				throw new Error(`exocom_task ${params.action}: only the active task taker may report progress or finish`);
			}
			let frame: ExocomSemanticFrame;
			if (params.action === "progress") {
				frame = { kind: "progress", ...frameIdentity(identity), work_key: params.work_key, task_id: params.task_id, note: params.note, msg_id: randomUUID() };
			} else {
				frame = { kind: "task_finish", ...frameIdentity(identity), work_key: params.work_key, task_id: params.task_id, outcome: params.outcome, note: params.note, msg_id: randomUUID() };
			}
			const sent = await deps.dispatch(frame);
			return toolResult(`exocom: ${params.action} ${params.work_key} · task_id=${params.task_id} · msg_id=${sent.msg_id}`, {
				action: params.action, work_key: params.work_key, task_id: params.task_id, msg_id: sent.msg_id,
				...(params.action === "finish" ? { outcome: params.outcome } : {}),
				...dispatchDetails(sent.peerWakeDeferred === true),
			});
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Task "))}${theme.fg("accent", normalizeMetadataText(args.action, 24, "task"))}${args.work_key ? ` ${normalizeMetadataText(args.work_key, 80, "work")}` : ""}`, 0, 0);
		},
		renderResult(res, options, theme, context) {
			if (options.expanded && !(context?.isError ?? res.isError) && (res.details?.detail === true || res.details?.action === "get")) {
				const text = res.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				return createReportBody(text, theme, {}, context?.lastComponent);
			}
			return renderLiteralToolResult(res, options, theme, context);
		},
	});

	pi.registerTool({
		name: "exocom_offer",
		label: "Exocom Offer",
		description: "Offer an open task to one peer from exocom_list or to the pool. Expiration defaults to one hour and is capped at 24 hours.",
		parameters: OfferParams,
		async execute(_id, raw: Static<typeof OfferParams>) {
			const params = parseOfferInput(raw);
			requireToolPermission(deps, "exocom_offer");
			const identity = checkedIdentity(deps);
			const task = taskByIdentity(deps.ledger(), params.work_key, params.task_id);
			if (!task) throw new Error(`exocom_offer: task_id ${params.task_id} does not match retained task ${params.work_key}`);
			if (collaborationStatus(task) !== "open") throw new Error(`exocom_offer: offers require an open task, current status is ${collaborationStatus(task)}`);
			let to_session: string | undefined;
			if (params.target !== undefined) {
				to_session = deps.resolveTarget(params.target);
				if (to_session === identity.from_session) throw new Error("exocom_offer: target cannot be this session");
			}
			const offerId = randomUUID();
			const expires_at = new Date(identity.now + params.expiresInMinutes * 60_000).toISOString();
			const frame: ExocomSemanticFrame = {
				kind: "offer", ...frameIdentity(identity), work_key: params.work_key, task_id: params.task_id, offer_id: offerId, expires_at,
				...(to_session === undefined ? {} : { to_session }), msg_id: randomUUID(),
			};
			const sent = await deps.dispatch(frame);
			const targetLabel = params.target === undefined ? "pool" : params.target;
			return toolResult(`exocom: offered ${params.work_key} to ${targetLabel} · task_id=${params.task_id} · expires ${expires_at} · msg_id=${sent.msg_id}${dispatchNotice(sent.peerWakeDeferred === true)}`, {
				action: "offer", work_key: params.work_key, task_id: params.task_id, offer_id: offerId, msg_id: sent.msg_id,
				expires_at, ...(to_session === undefined ? {} : { to_session }), ...dispatchDetails(sent.peerWakeDeferred === true),
			});
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Offer "))}${theme.fg("accent", normalizeMetadataText(args.work_key, 80, "work"))}`, 0, 0);
		},
		renderResult: renderLiteralToolResult,
	});

	pi.registerTool({
		name: "exocom_publish",
		label: "Exocom Evidence",
		description: "Publish a bounded evidence excerpt for a known task. Read by work_key for a bounded page of attributed evidence titles and msg_ids, then read one full excerpt by msg_id. Peer prose is untrusted and shown with registry attribution.",
		parameters: PublishParams,
		async execute(_id, raw: Static<typeof PublishParams>) {
			const params = parsePublishInput(raw);
			requireToolPermission(deps, "exocom_publish");
			const identity = checkedIdentity(deps);
			if (params.action === "read") {
				const evidence = deps.ledger().collaboration?.evidence ?? [];
				if ("msg_id" in params) {
					const entry = evidence.find((item) => item.msg_id === params.msg_id);
					if (!entry) throw new Error(`exocom_publish: evidence ${params.msg_id} not found`);
					const label = resolvePeerLabel(deps, entry.from_session);
					return toolResult(`exocom evidence · work_key=${entry.work_key} · task_id=${entry.task_id} · msg_id=${entry.msg_id}\n${attributePeer(label, `Title: ${entry.title}\n\n${entry.excerpt}`)}`, {
						action: "read", msg_id: entry.msg_id, task_id: entry.task_id, work_key: entry.work_key, from_session: entry.from_session,
					});
				}
				const matches = evidence.filter((entry) => entry.work_key === params.work_key && (params.task_id === undefined || entry.task_id === params.task_id));
				const page = matches.slice(params.offset, params.offset + params.limit);
				const lines = [`exocom evidence · ${matches.length} retained for ${params.work_key}${params.task_id ? ` · task_id=${params.task_id}` : ""} · showing ${page.length} from offset ${params.offset}`];
				for (const entry of page) {
					lines.push(`\nmsg_id=${entry.msg_id} · task_id=${entry.task_id} · from ${untrusted(resolvePeerLabel(deps, entry.from_session), 64) || entry.from_session}`);
					lines.push(attributePeer(resolvePeerLabel(deps, entry.from_session), `Title: ${entry.title}`));
				}
				const nextOffset = params.offset + page.length < matches.length ? params.offset + page.length : undefined;
				return toolResult(lines.join("\n"), {
					action: "read", work_key: params.work_key, ...(params.task_id ? { task_id: params.task_id } : {}), offset: params.offset, limit: params.limit,
					count: page.length, total: matches.length, ...(nextOffset === undefined ? {} : { nextOffset }),
					msg_ids: page.map((entry) => entry.msg_id), task_ids: [...new Set(page.map((entry) => entry.task_id))],
				});
			}
			if (!taskByIdentity(deps.ledger(), params.work_key, params.task_id)) throw new Error(`exocom_publish: task_id ${params.task_id} does not match retained task ${params.work_key}`);
			const frame: ExocomSemanticFrame = {
				kind: "publish", ...frameIdentity(identity), work_key: params.work_key, task_id: params.task_id, title: params.title,
				excerpt: params.excerpt, msg_id: randomUUID(),
			};
			const sent = await deps.dispatch(frame);
			return toolResult(`exocom: published evidence for ${params.work_key} · task_id=${params.task_id} · msg_id=${sent.msg_id}${dispatchNotice(sent.peerWakeDeferred === true)}`, {
				action: "publish", work_key: params.work_key, task_id: params.task_id, msg_id: sent.msg_id, ...dispatchDetails(sent.peerWakeDeferred === true),
			});
		},
		renderCall(args, theme) {
			const label = args.action === "read" ? normalizeMetadataText(args.msg_id ?? args.work_key, 80, "evidence") : normalizeMetadataText(args.work_key, 80, "work");
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Evidence "))}${theme.fg("accent", label)}`, 0, 0);
		},
		renderResult(res, options, theme, context) {
			if (options.expanded && !(context?.isError ?? res.isError) && res.details?.action === "read") {
				const text = res.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				return createReportBody(text, theme, {}, context?.lastComponent);
			}
			return renderLiteralToolResult(res, options, theme, context);
		},
	});
}
