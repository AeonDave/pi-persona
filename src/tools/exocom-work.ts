/**
 * Collaboration tools over the work ledger: claim / ask / answer / decline / wait / release.
 * Wait is non-blocking (MCP cap) — it arms a wake like `timer`.
 */
import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";

import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { attributePeer } from "../core/fence.ts";
import type { LedgerAnswer } from "../exocom/ledger.ts";
import type { ExocomPlane } from "../exocom/plane.ts";
import type { ExocomSemanticFrame } from "../exocom/envelope.ts";
import { waitTimeoutMs } from "../exocom/wait.ts";
import { normalizeMetadataText } from "../exocom/registry.ts";

const TOKEN = { minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" } as const;

const ClaimParams = Type.Object({
	work_key: Type.String({ ...TOKEN, description: "Stable work key for this slice of collaboration." }),
	write_set: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64, description: "Repository-relative paths this session claims." }),
	slice: Type.String({ minLength: 1, maxLength: 256, description: "Short description of the claimed slice." }),
});

const AskParams = Type.Object({
	work_key: Type.String({ ...TOKEN, description: "Work key this question belongs to." }),
	target: Type.String({ minLength: 1, maxLength: 80, description: "One peer's target exactly as exocom_list shows it (never *)." }),
	question: Type.String({ minLength: 1, maxLength: 4_096, description: "The bounded question." }),
	ask_id: Type.Optional(Type.String({ ...TOKEN, description: "Correlation id; generated if omitted." })),
});

const AnswerParams = Type.Object({
	ask_id: Type.String({ ...TOKEN, description: "The ask_id being answered." }),
	work_key: Type.String({ ...TOKEN, description: "Work key of the ask." }),
	ok: Type.Boolean({ description: "Whether the ask is satisfied." }),
	evidence: Type.String({ minLength: 1, maxLength: 8_192, description: "Evidence or decline reason." }),
});

const DeclineParams = Type.Object({
	ask_id: Type.String({ ...TOKEN, description: "The ask_id being declined." }),
	work_key: Type.String({ ...TOKEN, description: "Work key of the ask." }),
	reason: Type.Optional(Type.String({ minLength: 1, maxLength: 8_192, description: "Why this session declines." })),
});

const WaitParams = Type.Object({
	work_key: Type.String({ ...TOKEN, description: "Work key to join on." }),
	ask_id: Type.String({ ...TOKEN, description: "The ask to join. A retained answer is returned immediately." }),
	timeoutMs: Type.Optional(Type.Number({ description: "Wake budget (ms). Cap 600000; default 600000. Does not block this call." })),
});

const ReleaseParams = Type.Object({
	work_key: Type.String({ ...TOKEN, description: "Work key whose claims this session releases." }),
});

const ProgressParams = Type.Object({
	work_key: Type.String({ ...TOKEN, description: "Work key to journal progress on." }),
	note: Type.String({ minLength: 1, maxLength: 4_096, description: "Progress note." }),
});

export interface ExocomWorkDeps {
	getPlane: () => ExocomPlane | undefined;
	sessionId: () => string;
	name: () => string;
	now: () => number;
	/** Canonicalize the public exocom_list target to the authenticated raw session id. */
	resolveTarget: (target: string) => string;
	/** Local ledger apply, then wire send routed by kind. */
	dispatch: (frame: ExocomSemanticFrame) => Promise<{ msg_id: string }>;
	/** Read-before-arm closes the answer-before-wait race. */
	armWait: (work_key: string, ask_id: string, timeoutMs: number) => ExocomWaitArmResult;
}

export type ExocomWaitArmResult =
	| { status: "waiting"; id: string }
	| { status: "answered"; answer: LedgerAnswer };

function tokenOrUuid(value: string | undefined): string {
	return value && /^[A-Za-z0-9._:-]+$/.test(value) ? value : randomUUID();
}

function result(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

export function registerExocomWorkTools(pi: ExtensionAPI, deps: ExocomWorkDeps): void {
	const identity = () => {
		const plane = deps.getPlane();
		if (!plane) throw new Error("exocom is not active for this persona");
		return { plane, from_session: deps.sessionId(), from_name: deps.name(), ts: new Date(deps.now()).toISOString() };
	};

	pi.registerTool({
		name: "exocom_claim",
		label: "Exocom Claim",
		description: "Claim a write-set slice on the workspace work ledger. Overlap with an open claim is refused.",
		parameters: ClaimParams,
		async execute(_id, params: Static<typeof ClaimParams>) {
			const { from_session, from_name, ts } = identity();
			const frame: ExocomSemanticFrame = {
				kind: "claim", work_key: params.work_key, from_session, from_name,
				write_set: params.write_set, slice: params.slice, msg_id: randomUUID(), ts,
			};
			const { msg_id } = await deps.dispatch(frame);
			return result(`exocom: claimed ${params.work_key} · msg_id=${msg_id}`, { work_key: params.work_key, msg_id });
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Claim "))}${theme.fg("accent", normalizeMetadataText(args.work_key, 80, "work"))}`, 0, 0);
		},
		renderResult(res, { expanded }, theme) {
			const first = res.content.find((item) => item.type === "text");
			const text = first?.type === "text" ? first.text : "Exocom claim failed";
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", expanded ? text : `${text} (${keyHint("app.tools.expand", "to expand")})`), 0, 0);
		},
	});

	pi.registerTool({
		name: "exocom_ask",
		label: "Exocom Ask",
		description: "Ask one peer session a bounded question on a work key. Never broadcasts (*). One pending ask per (work_key, to).",
		parameters: AskParams,
		async execute(_id, params: Static<typeof AskParams>) {
			const { from_session, from_name, ts } = identity();
			if (params.target === "*") {
				throw new Error("exocom_ask: target must name one other session, never *");
			}
			const to_session = deps.resolveTarget(params.target);
			if (to_session === from_session) throw new Error("exocom_ask: target cannot be this session");
			const frame: ExocomSemanticFrame = {
				kind: "ask", ask_id: tokenOrUuid(params.ask_id), work_key: params.work_key,
				from_session, from_name, to_session, question: params.question,
				msg_id: randomUUID(), ts,
			};
			const { msg_id } = await deps.dispatch(frame);
			return result(`exocom: asked ${params.target} · ask_id=${frame.ask_id} · msg_id=${msg_id}`, { ask_id: frame.ask_id, msg_id, work_key: params.work_key, target: params.target });
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Ask "))}${theme.fg("accent", normalizeMetadataText(args.target, 80, "peer"))}`, 0, 0);
		},
		renderResult(res, { expanded }, theme) {
			const first = res.content.find((item) => item.type === "text");
			const text = first?.type === "text" ? first.text : "Exocom ask failed";
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", expanded ? text : `${text} (${keyHint("app.tools.expand", "to expand")})`), 0, 0);
		},
	});

	pi.registerTool({
		name: "exocom_answer",
		label: "Exocom Answer",
		description: "Answer a pending ask addressed to this session. Drops the ask and wakes the asker's wait.",
		parameters: AnswerParams,
		async execute(_id, params: Static<typeof AnswerParams>) {
			const { from_session, from_name, ts } = identity();
			const frame: ExocomSemanticFrame = {
				kind: "answer", ask_id: params.ask_id, work_key: params.work_key,
				from_session, from_name, ok: params.ok, evidence: params.evidence,
				msg_id: randomUUID(), ts,
			};
			const { msg_id } = await deps.dispatch(frame);
			return result(`exocom: answered ${params.ask_id} · ok=${params.ok} · msg_id=${msg_id}`, { ask_id: params.ask_id, msg_id, ok: params.ok });
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Answer "))}${theme.fg("accent", normalizeMetadataText(args.ask_id, 80, "ask"))}`, 0, 0);
		},
		renderResult(res, { expanded }, theme) {
			const first = res.content.find((item) => item.type === "text");
			const text = first?.type === "text" ? first.text : "Exocom answer failed";
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", expanded ? text : `${text} (${keyHint("app.tools.expand", "to expand")})`), 0, 0);
		},
	});

	pi.registerTool({
		name: "exocom_decline",
		label: "Exocom Decline",
		description: "Decline a pending ask addressed to this session (answer with ok=false).",
		parameters: DeclineParams,
		async execute(_id, params: Static<typeof DeclineParams>) {
			const { from_session, from_name, ts } = identity();
			const frame: ExocomSemanticFrame = {
				kind: "answer", ask_id: params.ask_id, work_key: params.work_key,
				from_session, from_name, ok: false, evidence: params.reason ?? "declined",
				msg_id: randomUUID(), ts,
			};
			const { msg_id } = await deps.dispatch(frame);
			return result(`exocom: declined ${params.ask_id} · msg_id=${msg_id}`, { ask_id: params.ask_id, msg_id, ok: false });
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Decline "))}${theme.fg("accent", normalizeMetadataText(args.ask_id, 80, "ask"))}`, 0, 0);
		},
		renderResult(res, { expanded }, theme) {
			const first = res.content.find((item) => item.type === "text");
			const text = first?.type === "text" ? first.text : "Exocom decline failed";
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", expanded ? text : `${text} (${keyHint("app.tools.expand", "to expand")})`), 0, 0);
		},
	});

	pi.registerTool({
		name: "exocom_wait",
		label: "Exocom Wait",
		description: "Join one ask WITHOUT blocking this tool call. Returns a retained answer immediately, otherwise a follow-up wakes you on answer or timeout (cap 600000ms).",
		parameters: WaitParams,
		async execute(_id, params: Static<typeof WaitParams>) {
			identity();
			const timeoutMs = waitTimeoutMs(params.timeoutMs);
			const armed = deps.armWait(params.work_key, params.ask_id, timeoutMs);
			if (armed.status === "answered") {
				const answer = armed.answer;
				return result(
					`exocom: ${params.ask_id} already answered · ok=${answer.ok}\n${attributePeer(answer.from_session, answer.evidence)}`,
					{ work_key: params.work_key, ask_id: params.ask_id, status: "answered", ok: answer.ok, msg_id: answer.msg_id },
				);
			}
			return result(`exocom: waiting on ${params.work_key} ask_id=${params.ask_id} · timeout ${timeoutMs}ms · ${armed.id}. End this turn; you will be woken.`, { work_key: params.work_key, ask_id: params.ask_id, timeoutMs, id: armed.id, status: "waiting" });
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Wait "))}${theme.fg("accent", normalizeMetadataText(args.work_key, 80, "work"))}`, 0, 0);
		},
		renderResult(res, { expanded }, theme) {
			const first = res.content.find((item) => item.type === "text");
			const text = first?.type === "text" ? first.text : "Exocom wait failed";
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", expanded ? text : `${text} (${keyHint("app.tools.expand", "to expand")})`), 0, 0);
		},
	});

	pi.registerTool({
		name: "exocom_release",
		label: "Exocom Release",
		description: "Release this session's open claims on a work key and drop its outbound pending asks.",
		parameters: ReleaseParams,
		async execute(_id, params: Static<typeof ReleaseParams>) {
			const { from_session, from_name, ts } = identity();
			const frame: ExocomSemanticFrame = {
				kind: "release", work_key: params.work_key, from_session, from_name, msg_id: randomUUID(), ts,
			};
			const { msg_id } = await deps.dispatch(frame);
			return result(`exocom: released ${params.work_key} · msg_id=${msg_id}`, { work_key: params.work_key, msg_id });
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Release "))}${theme.fg("accent", normalizeMetadataText(args.work_key, 80, "work"))}`, 0, 0);
		},
		renderResult(res, { expanded }, theme) {
			const first = res.content.find((item) => item.type === "text");
			const text = first?.type === "text" ? first.text : "Exocom release failed";
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", expanded ? text : `${text} (${keyHint("app.tools.expand", "to expand")})`), 0, 0);
		},
	});

	pi.registerTool({
		name: "exocom_progress",
		label: "Exocom Progress",
		description: "Journal a progress note on a work key. Does not change claims or asks.",
		parameters: ProgressParams,
		async execute(_id, params: Static<typeof ProgressParams>) {
			const { from_session, from_name, ts } = identity();
			const frame: ExocomSemanticFrame = {
				kind: "progress", work_key: params.work_key, from_session, from_name, note: params.note, msg_id: randomUUID(), ts,
			};
			const { msg_id } = await deps.dispatch(frame);
			return result(`exocom: progress ${params.work_key} · msg_id=${msg_id}`, { work_key: params.work_key, msg_id });
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Progress "))}${theme.fg("accent", normalizeMetadataText(args.work_key, 80, "work"))}`, 0, 0);
		},
		renderResult(res, { expanded }, theme) {
			const first = res.content.find((item) => item.type === "text");
			const text = first?.type === "text" ? first.text : "Exocom progress failed";
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", expanded ? text : `${text} (${keyHint("app.tools.expand", "to expand")})`), 0, 0);
		},
	});
}
