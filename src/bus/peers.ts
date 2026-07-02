/**
 * `contact_peer` — the CHILD-side sibling-messaging tool of the communication plane
 * (design: docs/superpowers/specs/2026-07-02-sibling-peer-comm-design.md). Bound by the
 * in-process engine ONLY when the strategy opted the run into peer comm (`spec.peers`,
 * gated by the persona's `canUseBus`).
 *
 * ONE-WAY by design (decision P1): a "conversation" is reciprocal sends — the receiving
 * agent replies, if it chooses, with a send of its own. Blocking asks remain a
 * supervisor-channel privilege, so two peers can never deadlock on each other.
 *
 * The peer list comes from an engine-provided `listPeers` closure scoped to the SAME
 * strategy run — the tool never scans the whole bus, so concurrent runs stay invisible
 * to each other. A per-member send budget stops ping-pong loops (the idle watchdog
 * cannot: mutual steers re-arm each other's clocks).
 *
 * Pure factory (bus + self handle + deps), unit-tested without a live model, mirroring
 * `bus/contact.ts`.
 */

import { type Static, Type } from "typebox";

import { defineTool } from "@earendil-works/pi-coding-agent";

import type { InProcessBus } from "./inproc.ts";

/** Anti ping-pong budget: after this many sends the tool tells the member to finalize. */
export const MAX_PEER_SENDS = 20;

export interface PeerInfo {
	handle: string;
	label: string;
}

export interface ContactPeerDeps {
	/** The live peers of THIS run (excluding self) — scoped by the engine, never the whole bus. */
	listPeers: () => PeerInfo[];
	/** Override the send budget (tests). Default {@link MAX_PEER_SENDS}. */
	maxSends?: number;
}

const PeerParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("send")], {
		description:
			"list = see which peers are still working · send = push a ONE-WAY note to one peer (you do NOT wait; a peer answers, if at all, with a send of its own).",
	}),
	to: Type.Optional(Type.String({ description: "send: the peer handle (from `list`, e.g. reviewer#2)." })),
	message: Type.Optional(Type.String({ description: "send: what to tell the peer — specific and self-contained." })),
});

type PeerDetails = { action: string; delivered?: boolean; peers?: string[] };

function result(t: string, details: PeerDetails): { content: [{ type: "text"; text: string }]; details: PeerDetails } {
	return { content: [{ type: "text", text: t }], details };
}

/** Build the child's `contact_peer` tool. Same `defineTool` variance shim as
 *  `makeContactSupervisorTool`, so it slots into `customTools: ToolDefinition[]`. */
export function makeContactPeerTool(bus: InProcessBus, selfHandle: string, deps: ContactPeerDeps) {
	const maxSends = deps.maxSends ?? MAX_PEER_SENDS;
	let sent = 0;
	return defineTool({
		name: "contact_peer",
		label: "Contact peer",
		description: [
			"Message the OTHER members working this same task with you (your strategy peers).",
			"`list` shows who is still reachable; `send` pushes a one-way note to one of them.",
			"You never wait for a reply — a peer answers (if it chooses) with its own send, which",
			'reaches you as a "[message from peer …]" turn. Keep notes short and substantive;',
			"finalize your own answer once your position is stable.",
		].join(" "),
		promptSnippet: "contact_peer — list your run's sibling agents or send one a one-way note",
		parameters: PeerParams,
		async execute(_toolCallId, params: Static<typeof PeerParams>, _signal, _onUpdate, _ctx) {
			if (params.action === "list") {
				const peers = deps.listPeers();
				return result(
					peers.length > 0
						? `Reachable peers:\n${peers.map((p) => `• ${p.label}`).join("\n")}`
						: "(no peers are currently reachable — they may all have finalized; proceed solo)",
					{ action: "list", peers: peers.map((p) => p.handle) },
				);
			}
			if (!params.to || params.message === undefined) {
				return result("contact_peer send needs { to, message } — use `list` for peer handles.", { action: "send", delivered: false });
			}
			if (sent >= maxSends) {
				return result(
					`(peer-send budget exhausted — ${maxSends} notes already sent; stop debating and finalize your answer)`,
					{ action: "send", delivered: false },
				);
			}
			sent += 1;
			// Enforce the run-isolation boundary (previously only convention): a handle that is
			// not one of THIS run's peers (e.g. "supervisor", or another run's child) never gets
			// bus.send called at all — same "gone" wording as an actually-finished peer, so the
			// tool result gives no signal either way about what exists outside this run's scope.
			const inScope = deps.listPeers().some((p) => p.handle === params.to);
			const delivered = inScope && bus.send(selfHandle, params.to, params.message, "progress");
			return result(
				delivered
					? `Sent to ${params.to}.`
					: `Peer "${params.to}" is gone — it may have already finalized. Proceed with your own judgement.`,
				{ action: "send", delivered },
			);
		},
	});
}
