/** exocom limits and constants. */
export const EXOCOM = {
	INJECT_MAX_BYTES: 8_192, // R1 head-truncate an inbound message before it enters a turn
	INLINE_MAX_BYTES: 12_288, // R3 above this, spill to an artifact file and send { preview, path }
	PREVIEW_BYTES: 2_000, // R3 preview length carried inline alongside the artifact path
	MAX_HOPS: 6, // reply-chain depth cap
	SENDER_WINDOW_MS: 60_000, // R2 per-sender budget window
	SENDER_MAX_MSGS: 20, // R2 messages per sender per window
	SENDER_MAX_BYTES: 262_144, // R2 bytes per sender per window
	SEEN_TTL_MS: 300_000, // R8 dedup memory
	ACK_TIMEOUT_MS: 30_000, // R4 bound the ack-wait on send — a frozen peer can't hang a live turn
	HEARTBEAT_MS: 30_000, // registry heartbeat + pool refresh
	QUIET_AFTER_MS: 45_000, // a peer that missed a heartbeat looks "quiet" but isn't pruned yet
	STALE_AFTER_MS: 120_000, // R7 evict an entry whose heartbeat is older than this
	DELIVER_MIN_INTERVAL_MS: 10_000, // R6 floor between receiver-turn wakes from one plane
	DELIVER_MAX_PER_MIN: 6, // R6 ceiling on wakes/min
	ARTIFACT_TTL_MS: 3_600_000, // successful spill files survive long enough for the receiver to read them
	ARTIFACT_MAX_FILES: 256, // workspace-wide bound; oldest spill files are reaped before a new one is written
} as const;
