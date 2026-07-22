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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { DisplayPeer, ExocomPlane } from "../exocom/plane.ts";
import { normalizeMetadataText, normalizePeerName } from "../exocom/registry.ts";

const ExocomSendParams = Type.Object({
	target: Type.String({ minLength: 1, maxLength: 80, description: 'The peer\'s name (from `exocom_list`), or "*" to broadcast to every reachable peer.' }),
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
	| { target: "*"; msg_ids: string[]; failed: Array<{ target: string; error: string }> };

/** One readable line per live peer. `displayName` (not the possibly-shared `.name`) is what
 *  disambiguates two peers registered under the same persona name — see plane.ts's
 *  `dedupeDisplayNames`. */
function formatPeers(peers: DisplayPeer[]): string {
	const rows = peers
		.map((p) => `- ${normalizeMetadataText(p.displayName, 80, "peer")} · ${normalizeMetadataText(p.persona, 64, "unknown")} · ${normalizeMetadataText(p.model, 160, "unknown")} · ctx ${Math.max(0, Math.min(100, Number(p.context_pct) || 0))}%`)
		.join("\n");
	return [`Exocom presence only (${peers.length} peers; not a message inbox)`, rows, "Use target exactly as shown."].filter(Boolean).join("\n");
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
		parameters: Type.Object({}),
		async execute() {
			const plane = getPlane();
			if (!plane) throw new Error("exocom is not active for this persona");
			const peers = plane.listPeers();
			return { content: [{ type: "text", text: formatPeers(peers) }], details: { peers } };
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
			if (params.target === "*") {
				const peers = plane.listPeers();
				const msg_ids: string[] = [];
				const sent: Array<{ target: string; msg_id: string }> = [];
				const failed: Array<{ target: string; error: string }> = [];
				await Promise.all(
					// By displayName, not the possibly-shared `.name`: two LIVE peers can share a raw
					// name (session_id-keyed registry, PartA), and `plane.send` resolves its target
					// against `listPeers()`'s displayName (unique per live peer) — addressing by `.name`
					// here would resolve BOTH same-named peers to the SAME one.
					peers.map(async (p) => {
						try {
							const { msg_id } = await plane.send(p.displayName, params.message, params.in_reply_to);
							msg_ids.push(msg_id);
							sent.push({ target: p.displayName, msg_id });
						} catch (err) {
							failed.push({ target: p.displayName, error: err instanceof Error ? err.message : String(err) });
						}
					}),
				);
				const ids = sent.map((item) => `${item.target}=${item.msg_id}`).join(", ");
				const failNote = failed.length > 0 ? `; ${failed.length} failed` : "";
				return {
				content: [{ type: "text", text: `✓ received and queued by ${sent.length}/${peers.length} peers${failNote}; replies arrive automatically as [exocom_received] — do not poll exocom_list${ids ? `; msg_ids: ${ids}` : ""}` }],
					details: { target: "*", msg_ids, failed },
				};
			}

			const { msg_id } = await plane.send(params.target, params.message, params.in_reply_to);
			return {
			content: [{ type: "text", text: `✓ received and queued by ${params.target}; reply arrives automatically as [exocom_received] — do not poll exocom_list. msg_id=${msg_id}` }],
				details: { msg_id, target: params.target },
			};
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
	});
}
