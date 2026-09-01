/**
 * `exocom_list` + `exocom_send` — the supervisor-facing tools over the exocom plane
 * (Task 7's {@link ExocomPlane}): independent top-level pi instances in one workspace
 * messaging each other peer-to-peer, one-way and non-blocking.
 *
 *   - `exocom_list` — who else is reachable right now (live, pruned peers).
 *   - `exocom_send` — fire a message at a named peer, or `target: "*"` to broadcast to
 *     all of them. `plane.send` only resolves a SINGLE named target (Task 7), so the
 *     broadcast fan-out is this tool's job: best-effort, one unreachable peer does not
 *     abort the rest.
 *
 * Pure over `getPlane` (a stub accessor is enough to unit-test), registered directly with
 * `pi.registerTool` — the same shape as the other `pi.registerTool` calls in extension.ts.
 * `getPlane` is a live accessor rather than a captured plane so a downgrade can fail these
 * tools closed without an `unregisterTool` API — see the doc comment on `registerExocomTools`.
 */

import { type Static, Type } from "typebox";

import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { fencePeer } from "../core/fence.ts";
import { ExocomPeerRejection, type DisplayPeer, type ExocomPlane } from "../exocom/plane.ts";
import { normalizeMetadataText, normalizePeerName } from "../exocom/registry.ts";
import { compactInlineText } from "../ui/presentation.ts";

const COLLAPSED_PEER_LIMIT = 8;
/** Model-facing presence is a sample, not a dump. Keep the count and a refresh action below. */
export const MAX_MODEL_PEER_ROWS = 24;
/** Structured broadcast details retain enough IDs/errors to act while exact totals cover the rest. */
export const MAX_BROADCAST_DETAIL_ITEMS = 64;
const MODEL_BROADCAST_ID_SAMPLE = 12;
const MODEL_BROADCAST_FAILURE_SAMPLE = 8;

const ExocomListParams = Type.Object({
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, description: "Zero-based page offset into the live peer list." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MODEL_PEER_ROWS, description: `Maximum peers to show (default ${MAX_MODEL_PEER_ROWS}).` })),
});

const ExocomSendParams = Type.Object({
	target: Type.String({ minLength: 1, maxLength: 80, description: 'The peer\'s `target` token exactly as `exocom_list` shows it (a display name still works, but it can be reassigned as peers come and go), or "*" to broadcast to every reachable peer.' }),
	message: Type.String({ minLength: 1, maxLength: 1_000_000, description: "The message body." }),
	in_reply_to: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$", description: "The msg_id you're replying to, if this is a reply." })),
});

const ExocomNameParams = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 96, description: "Your chosen exocom call-sign — a short, distinctive display handle. Free choice: invent one." }),
});

/** Single-target send vs. `target: "*"` broadcast — two distinct result shapes, so `execute`'s
 *  return type is spelled out explicitly instead of leaving it to per-branch inference (which
 *  otherwise unifies the two into an ill-typed merged shape). */
type ExocomSendDetails =
	| { msg_id: string; target: string }
	| {
		target: "*";
		/** The bounded samples below are accompanied by exact totals so a large fan-out never
		 * turns the tool result into an unbounded model/context payload. */
		peerCount: number;
		queuedCount: number;
		failedCount: number;
		msg_ids: string[];
		failed: Array<{ target: string; error: string }>;
		omittedMsgIds: number;
		omittedFailures: number;
	};

type ExocomPeerSummary = Pick<DisplayPeer, "displayName" | "persona" | "model" | "context_pct" | "target">;

function peerWord(count: number): string {
	return `${count} peer${count === 1 ? "" : "s"}`;
}

/** Human-facing rows are bounded in terminal columns. Expanded mode spends a second line on the
 * model so it can retain useful detail without turning one peer into a 300-column wall. */
function peerRows(peer: ExocomPeerSummary, expanded: boolean): string[] {
	const context = `${Math.max(0, Math.min(100, Number(peer.context_pct) || 0))}%`;
	if (expanded) {
		const name = compactInlineText(peer.displayName, { maxChars: 48 }) || "peer";
		const persona = compactInlineText(peer.persona, { maxChars: 32 }) || "unknown";
		const model = compactInlineText(peer.model, { maxChars: 88 }) || "unknown";
		return [`- ${name} · ${persona} · ctx ${context}`, `  model: ${model}`];
	}
	const name = compactInlineText(peer.displayName, { maxChars: 24 }) || "peer";
	const persona = compactInlineText(peer.persona, { maxChars: 18 }) || "unknown";
	const model = compactInlineText(peer.model, { maxChars: 36 }) || "unknown";
	return [`- ${name} · ${persona} · ${model} · ctx ${context}`];
}

/** The model-facing row carries the ROUTE as well as the human label: a display name is
 *  recomputed from the live set on every call, so the label a roster showed can belong to a
 *  different session by the time the model sends. The TUI row above stays human-sized. */
function modelPeerRow(peer: ExocomPeerSummary): string {
	return `- ${normalizeMetadataText(peer.displayName, 80, "peer")} · ${normalizeMetadataText(peer.persona, 64, "unknown")} · ${normalizeMetadataText(peer.model, 160, "unknown")} · ctx ${Math.max(0, Math.min(100, Number(peer.context_pct) || 0))}% · target: ${normalizeMetadataText(peer.target, 80, "peer")}`;
}

/** One readable line per live peer: `displayName` (not the possibly-shared `.name`) disambiguates
 *  two peers registered under the same persona name — see plane.ts's `dedupeDisplayNames` — and
 *  `target` is what the model must actually address with. */
function formatPeers(peers: DisplayPeer[], offset = 0, limit = MAX_MODEL_PEER_ROWS): string {
	const head = `Exocom presence only (${peerWord(peers.length)}; ${peers.length === 0 ? "no reachable peers" : "not a message inbox"})`;
	if (peers.length === 0) return head;
	const shown = peers.slice(offset, offset + limit);
	const paged = offset > 0 || peers.length > limit;
	const pageHead = paged
		? `Exocom presence only (${peerWord(peers.length)}; showing ${shown.length === 0 ? "none" : `${offset + 1}–${offset + shown.length}`} of ${peers.length}; not a message inbox)`
		: head;
	const omitted = peers.length - shown.length;
	const lines = [pageHead, shown.map(modelPeerRow).join("\n")];
	if (omitted > 0) {
		const next = offset + shown.length < peers.length ? `call exocom_list with offset: ${offset + shown.length} to continue` : "call exocom_list with offset: 0 to return to the first page";
		lines.push(`…and ${omitted} peers omitted from this bounded page; ${next}.`);
	}
	lines.push("Use each peer's target exactly as shown; display names can be reassigned as peers come and go.");
	return lines.join("\n");
}

function renderListResult(
	peers: ExocomPeerSummary[],
	expanded: boolean,
	total = peers.length,
	offset = 0,
	nextOffset?: number,
): string {
	if (total === 0) return "Exocom · 0 peers · no reachable peers";
	const shown = expanded ? peers : peers.slice(0, COLLAPSED_PEER_LIMIT);
	const pageEnd = Math.min(total, offset + shown.length);
	const paged = offset > 0 || pageEnd < total;
	const page = paged
		? shown.length === 0 ? `; showing none of ${total}` : `; showing ${offset + 1}–${pageEnd} of ${total}`
		: "";
	const lines = [`Exocom · ${peerWord(total)} (presence only${page})`];
	for (const peer of shown) lines.push(...peerRows(peer, expanded));
	if (offset > 0) lines.push(`…and ${offset} peers before this page`);
	if (pageEnd < total) lines.push(`…and ${total - pageEnd} more peers after this page`);
	if (!expanded && total > shown.length) lines.push(`(${keyHint("app.tools.expand", "to expand")})`);
	if (nextOffset !== undefined && nextOffset < total) lines.push(`next offset: ${nextOffset}`);
	return lines.join("\n");
}

/** A refusal in OUR voice: the peer's own prose is stripped out of it and carried separately, so it
 *  can travel to the model behind the peer fence instead of inside this agent's tool output. */
function refusalLine(target: string, err: unknown): string {
	if (err instanceof ExocomPeerRejection) return `exocom: peer "${normalizeMetadataText(target, 80, "peer")}" rejected the message; its stated reason is quoted below`;
	return normalizeMetadataText(err instanceof Error ? err.message : String(err), 240, "exocom: send failed");
}

/** The peer half of one or more refusals, quoted into a single fence. Each reason is flattened to
 *  one bounded line first (`normalizeMetadataText`), so a peer can neither fake a fence terminator
 *  nor spend the receiving turn's context, and the fence keeps it marked as what it is. */
function fencedPeerReasons(reasons: Array<{ target: string; reason: string }>): string {
	if (reasons.length === 0) return "";
	return fencePeer(reasons
		.map((item) => `${normalizeMetadataText(item.target, 80, "peer")}: ${normalizeMetadataText(item.reason, 240, "no reason given")}`)
		.join("\n"));
}

function isSendDetails(details: unknown): details is ExocomSendDetails {
	if (!details || typeof details !== "object") return false;
	const shape = details as { msg_id?: unknown; failed?: unknown };
	return Array.isArray(shape.failed) || typeof shape.msg_id === "string";
}

function renderSendResult(details: ExocomSendDetails, expanded: boolean): string {
	if ("failed" in details) {
		const failed = details.failedCount ?? details.failed.length;
		const queued = details.queuedCount ?? details.msg_ids.length;
		const summary = `${queued > 0 ? "✓" : "✗"} queued ${queued} peer${queued === 1 ? "" : "s"}${failed > 0 ? ` · ${failed} failed` : ""}`;
		if (!expanded) return `${summary} (${keyHint("app.tools.expand", "to expand")})`;
		const lines = [summary];
		if (details.msg_ids.length > 0) lines.push(`msg_ids: ${details.msg_ids.join(", ")}`);
		for (const failure of details.failed) {
			lines.push(`✗ ${normalizeMetadataText(failure.target, 80, "peer")}: ${normalizeMetadataText(failure.error, 240, "send failed")}`);
		}
		if ((details.omittedMsgIds ?? 0) > 0) lines.push(`…and ${details.omittedMsgIds} more msg_ids omitted; use the returned count to track the remaining queued peers.`);
		if ((details.omittedFailures ?? 0) > 0) lines.push(`…and ${details.omittedFailures} more failures omitted; retry only the failed targets shown above.`);
		return lines.join("\n");
	}
	const summary = `✓ queued to ${details.target} · msg_id=${details.msg_id}`;
	return expanded ? summary : `${summary} (${keyHint("app.tools.expand", "to expand")})`;
}

/** `getPlane` is a LIVE accessor, not a captured value: a `canUseBus` downgrade (`stopExocom`,
 *  see extension.ts) nulls the plane out from under these tool closures without needing an
 *  `unregisterTool` API (pi's `ExtensionAPI` has none) — each call re-reads the current plane and
 *  fails closed if it's gone, so the tools genuinely stop working the instant exocom is torn down
 *  (I3: previously the tools captured the plane BY VALUE, so they stayed callable — and `send`
 *  stayed able to connect out — even after a downgrade revoked the persona's bus capability). */
export function registerExocomTools(
	pi: ExtensionAPI,
	getPlane: () => ExocomPlane | undefined,
	onRename?: (name: string) => string,
): void {
	pi.registerTool({
		name: "exocom_list",
		label: "Exocom List",
		description: "List current exocom peer presence only; this is not a message inbox and replies arrive automatically.",
		parameters: ExocomListParams,
		async execute(_toolCallId, params: Static<typeof ExocomListParams>) {
			const plane = getPlane();
			if (!plane) throw new Error("exocom is not active for this persona");
			const peers = plane.listPeers();
			const offset = Math.min(peers.length, Math.max(0, Math.floor(params?.offset ?? 0)));
			const limit = Math.max(1, Math.min(MAX_MODEL_PEER_ROWS, Math.floor(params?.limit ?? MAX_MODEL_PEER_ROWS)));
			const shown: ExocomPeerSummary[] = peers.slice(offset, offset + limit).map((peer) => ({
				displayName: normalizeMetadataText(peer.displayName, 80, "peer"),
				target: normalizeMetadataText(peer.target, 80, "peer"),
				persona: normalizeMetadataText(peer.persona, 64, "unknown"),
				model: normalizeMetadataText(peer.model, 160, "unknown"),
				context_pct: Math.max(0, Math.min(100, Number(peer.context_pct) || 0)),
			}));
			return {
				content: [{ type: "text", text: formatPeers(peers, offset, limit) }],
				details: {
					peers: shown,
					total: peers.length,
					offset,
					limit,
					omitted: peers.length - shown.length,
					...(offset + shown.length < peers.length ? { nextOffset: offset + shown.length } : {}),
				},
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Exocom List")), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as unknown as {
				peers?: ExocomPeerSummary[];
				total?: number;
				offset?: number;
				nextOffset?: number;
			} | undefined;
			if (!details || !Array.isArray(details.peers)) {
				const first = result.content.find((item) => item.type === "text");
				return new Text(theme.fg("error", first?.type === "text" ? first.text : "Exocom list failed"), 0, 0);
			}
			const peers = details.peers;
			const total = typeof details.total === "number" ? details.total : peers.length;
			const offset = typeof details.offset === "number" ? Math.max(0, details.offset) : 0;
			const nextOffset = typeof details.nextOffset === "number" ? details.nextOffset : undefined;
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", renderListResult(peers, expanded, total, offset, nextOffset)), 0, 0);
		},
	});

	pi.registerTool({
		name: "exocom_send",
		label: "Exocom Send",
		description: [
			"Send a ONE-WAY, non-blocking message to another top-level pi instance in this workspace",
			"(see `exocom_list`) — it returns a `msg_id` immediately and does not wait for the peer to",
			"act on it. If you're replying to something a peer sent you, set `in_reply_to` to its",
			'`msg_id`. `target: "*"` broadcasts the message to every reachable peer.',
		].join(" "),
		parameters: ExocomSendParams,
		async execute(
			_toolCallId,
			params: Static<typeof ExocomSendParams>,
		): Promise<{ content: [{ type: "text"; text: string }]; details: ExocomSendDetails }> {
			const plane = getPlane();
			if (!plane) throw new Error("exocom is not active for this persona");
			if (params.target === "*" && params.in_reply_to) {
				throw new Error('exocom_send: target "*" cannot carry in_reply_to — a broadcast cannot be a reply (N−1 peers would reject it).');
			}
			if (params.target === "*") {
				const peers = plane.listPeers();
				const sent: Array<{ target: string; msg_id: string }> = [];
				const failed: Array<{ target: string; error: string }> = [];
				// Peer-authored refusal prose, kept apart from our own failure lines so the whole
				// fan-out's worth of it can be quoted into ONE peer fence below.
				const rejections: Array<{ target: string; reason: string }> = [];
				const outcomes = await Promise.all(
					// By the session-pinned target, not the possibly-shared `.name` nor the display
					// label: two LIVE peers can share a raw name (session_id-keyed registry, PartA),
					// and a label is recomputed from the live set on every call — a peer that joins or
					// leaves mid-fan-out can inherit another's label and receive its message.
					peers.map(async (p) => {
						try {
							const { msg_id } = await plane.send(p.target, params.message, params.in_reply_to);
							return { ok: true as const, target: p.target, msg_id };
						} catch (err) {
							return {
								ok: false as const, target: p.target,
								error: err instanceof Error ? err.message : String(err),
								reason: err instanceof ExocomPeerRejection ? err.reason : undefined,
							};
						}
					}),
				);
				// Promise completion order is not a presentation contract. Fold after all sends settle so
				// sampled IDs/errors retain the stable registry order even when peers answer at different speeds.
				for (const outcome of outcomes) {
					if (outcome.ok) { sent.push({ target: outcome.target, msg_id: outcome.msg_id }); continue; }
					failed.push({ target: outcome.target, error: outcome.error });
					if (outcome.reason !== undefined) rejections.push({ target: outcome.target, reason: outcome.reason });
				}
				const failNote = failed.length > 0 ? `; ${failed.length} failed` : "";
				const marker = sent.length > 0 ? "✓" : "✗";
				const shownIds = sent.slice(0, MODEL_BROADCAST_ID_SAMPLE).map((item) =>
					`${normalizeMetadataText(item.target, 80, "peer")}=${normalizeMetadataText(item.msg_id, 128, "msg")}`,
				);
				const omittedIds = sent.length - shownIds.length;
				// The model-facing sample describes each failure in OUR words; a peer's own explanation
				// travels only inside the fence appended below (`details` keeps it verbatim for the
				// operator's card, which is rendering, not context).
				const rejectedTargets = new Set(rejections.map((item) => item.target));
				const shownFailures = failed.slice(0, MODEL_BROADCAST_FAILURE_SAMPLE).map((item) =>
					`${normalizeMetadataText(item.target, 80, "peer")}: ${rejectedTargets.has(item.target) ? "rejected by the peer; reason quoted below" : normalizeMetadataText(item.error, 160, "send failed")}`,
				);
				const omittedFailures = failed.length - shownFailures.length;
				const action = omittedIds > 0 || omittedFailures > 0
					? `; ${[
						shownIds.length > 0 ? `msg_ids: ${shownIds.join(", ")}${omittedIds > 0 ? `; +${omittedIds} more msg_ids omitted` : ""}` : "",
						shownFailures.length > 0 ? `failures: ${shownFailures.join("; ")}${omittedFailures > 0 ? `; +${omittedFailures} more failures omitted` : ""}` : "",
					].filter(Boolean).join("; ")}`
					: shownIds.length > 0 ? `; msg_ids: ${shownIds.join(", ")}` : "";
				const quoted = fencedPeerReasons(rejections.slice(0, MODEL_BROADCAST_FAILURE_SAMPLE));
				const summary = `${marker} queued ${sent.length}/${peers.length} ${peers.length === 1 ? "peer" : "peers"}${failNote}${action}`;
				return {
					content: [{ type: "text", text: peers.length === 0 ? "⚠ no reachable peers; nothing queued" : [summary, quoted].filter(Boolean).join("\n") }],
					details: {
						target: "*",
						peerCount: peers.length,
						queuedCount: sent.length,
						failedCount: failed.length,
						msg_ids: sent.slice(0, MAX_BROADCAST_DETAIL_ITEMS).map((item) => normalizeMetadataText(item.msg_id, 128, "msg")),
						failed: failed.slice(0, MAX_BROADCAST_DETAIL_ITEMS).map((failure) => ({
							target: normalizeMetadataText(failure.target, 80, "peer"),
							error: normalizeMetadataText(failure.error, 240, "send failed"),
						})),
						omittedMsgIds: Math.max(0, sent.length - MAX_BROADCAST_DETAIL_ITEMS),
						omittedFailures: Math.max(0, failed.length - MAX_BROADCAST_DETAIL_ITEMS),
					},
				};
			}

			let msg_id: string;
			try {
				({ msg_id } = await plane.send(params.target, params.message, params.in_reply_to));
			} catch (err) {
				// pi turns a thrown execute() into model-facing tool-result text, so a refusal carrying
				// the PEER's own NACK prose would land in the supervisor's context as this agent's own
				// words. Our half stays ours; the peer's half is flattened and fenced, exactly as an
				// inbound peer message is (src/core/fence.ts).
				const quoted = err instanceof ExocomPeerRejection ? fencedPeerReasons([{ target: params.target, reason: err.reason }]) : "";
				throw new Error([refusalLine(params.target, err), quoted].filter(Boolean).join("\n"));
			}
			return {
				content: [{ type: "text", text: `✓ queued to ${params.target} · msg_id=${msg_id}` }],
				details: { msg_id, target: params.target },
			};
		},
		renderCall(args, theme) {
			const target = normalizeMetadataText(args.target, 80, "*");
			const message = String(args.message ?? "").replace(/\s+/g, " ").trim();
			const preview = normalizeMetadataText(message, 60);
			const suffix = preview.length < message.length ? "…" : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Send "))}${theme.fg("accent", target)}${preview ? theme.fg("dim", ` ${preview}${suffix}`) : ""}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as unknown as ExocomSendDetails | undefined;
			// pi renders this for a FAILED call too, handing us the error's empty details object — an
			// unrecognised shape is a failure to show, not a send to congratulate the user on.
			if (!isSendDetails(details)) {
				const text = result.content.find((item) => item.type === "text");
				return new Text(theme.fg("error", text?.type === "text" ? text.text : "(no result)"), 0, 0);
			}
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", renderSendResult(details, expanded)), 0, 0);
		},
	});

	pi.registerTool({
		name: "exocom_name",
		label: "Exocom Name",
		description: [
			"Pick your OWN call-sign on the exocom pool — any short, distinctive handle you like",
			"(invent one freely: a codename, a fantasy name, whatever makes you recognizable to the",
			"other instances). You start with an auto-assigned call-sign; use this to make it yours.",
		].join(" "),
		parameters: ExocomNameParams,
		async execute(_toolCallId, params: Static<typeof ExocomNameParams>) {
			const plane = getPlane();
			if (!plane || !onRename) throw new Error("exocom is not active for this persona");
			const applied = normalizePeerName(onRename(normalizePeerName(params.name)));
			return { content: [{ type: "text", text: `exocom: you are now "${applied}"` }], details: { name: applied } };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("Exocom Name "))}${theme.fg("accent", normalizeMetadataText(args.name, 96, "peer"))}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as unknown as { name?: string } | undefined;
			if (!details?.name) {
				const first = result.content.find((item) => item.type === "text");
				return new Text(theme.fg("error", first?.type === "text" ? first.text : "Exocom name failed"), 0, 0);
			}
			const name = normalizeMetadataText(details.name, 96, "(unchanged)");
			const text = `exocom: you are now "${name}"`;
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", expanded ? text : `${text} (${keyHint("app.tools.expand", "to expand")})`), 0, 0);
		},
	});
}
