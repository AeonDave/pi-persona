import { createHash } from "node:crypto";

/**
 * Read-only Exocom presence projection for human-facing surfaces.
 *
 * This intentionally carries no raw session id, routing target, endpoint, or collaboration controls.
 * `idle` describes heartbeat freshness only; the registry does not tell us whether a peer is busy.
 */

export interface ExocomPeerPresence {
	/** Stable UI identity only; not an Exocom target or credential. */
	key: string;
	name: string;
	persona?: string;
	model?: string;
	contextPercent?: number;
	status: "online" | "idle";
}

export interface ExocomPeerPresenceInput {
	sessionId: string;
	name: string;
	persona: string;
	model: string;
	contextPercent: number;
	heartbeatAt: string;
}

/** Project only display-safe facts; `idle` means a stale/unreadable heartbeat, not workload state. */
export function projectExocomPeerPresence(
	peers: readonly ExocomPeerPresenceInput[],
	now: number,
	quietAfterMs: number,
): ExocomPeerPresence[] {
	return peers.map((peer) => {
		const heartbeatAt = Date.parse(peer.heartbeatAt);
		const contextPercent = Number.isFinite(peer.contextPercent)
			? Math.max(0, Math.min(100, Math.round(peer.contextPercent)))
			: undefined;
		return {
			key: `peer:${createHash("sha256").update(peer.sessionId).digest("hex").slice(0, 16)}`,
			name: peer.name,
			...(peer.persona ? { persona: peer.persona } : {}),
			...(peer.model ? { model: peer.model } : {}),
			...(contextPercent !== undefined ? { contextPercent } : {}),
			status: Number.isFinite(now) && Number.isFinite(heartbeatAt) && now - heartbeatAt <= quietAfterMs ? "online" : "idle",
		};
	});
}

export class ExocomPeerPresenceStore {
	private peers: ExocomPeerPresence[] = [];
	private readonly listeners = new Set<() => void>();

	/** Return an isolated snapshot so a UI consumer cannot mutate the shared projection. */
	snapshot(): ExocomPeerPresence[] {
		return this.peers.map((peer) => ({ ...peer }));
	}

	/** Publish only meaningful changes; directory iteration order is not a display contract. */
	publish(peers: readonly ExocomPeerPresence[]): void {
		const next = peers.map((peer) => ({ ...peer })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
		if (sameSnapshot(this.peers, next)) return;
		this.peers = next;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A human-facing observer must not break Exocom lifecycle or widget refresh.
			}
		}
	}

	/** Subscribe to changes. Read {@link snapshot} once after subscribing for the initial view. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

function sameSnapshot(a: readonly ExocomPeerPresence[], b: readonly ExocomPeerPresence[]): boolean {
	return a.length === b.length && a.every((peer, index) => {
		const next = b[index];
		return next !== undefined && peer.key === next.key && peer.name === next.name && peer.persona === next.persona &&
			peer.model === next.model && peer.contextPercent === next.contextPercent && peer.status === next.status;
	});
}
