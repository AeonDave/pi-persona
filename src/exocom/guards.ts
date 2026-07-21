/** exocom inbound guardrails — per-sender budget (R2) and (sender,msg_id) dedup (R8). Pure. */
export class SenderBudget {
	private readonly windowMs: number;
	private readonly maxMsgs: number;
	private readonly maxBytes: number;
	private readonly now: () => number;
	private readonly buckets = new Map<string, { start: number; msgs: number; bytes: number }>();
	constructor(opts: { windowMs: number; maxMsgs: number; maxBytes: number; now?: () => number }) {
		this.windowMs = opts.windowMs; this.maxMsgs = opts.maxMsgs; this.maxBytes = opts.maxBytes;
		this.now = opts.now ?? Date.now;
	}
	allow(sender: string, bytes: number): boolean {
		const t = this.now();
		let b = this.buckets.get(sender);
		if (!b || t - b.start >= this.windowMs) { b = { start: t, msgs: 0, bytes: 0 }; this.buckets.set(sender, b); }
		if (b.msgs + 1 > this.maxMsgs || b.bytes + bytes > this.maxBytes) return false;
		b.msgs += 1; b.bytes += bytes;
		return true;
	}
}

export class SeenMessages {
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly seen = new Map<string, number>(); // "sender\x1fmsg" -> firstSeenAt
	constructor(opts: { ttlMs: number; now?: () => number }) { this.ttlMs = opts.ttlMs; this.now = opts.now ?? Date.now; }
	seenBefore(sender: string, msgId: string): boolean {
		const t = this.now();
		// \x1f (US): collision-proof composite key — sender (from_session) and msgId are
		// self-reported by the peer, so a plain space would let crafted pairs alias each other.
		const key = `${sender}\x1f${msgId}`;
		const at = this.seen.get(key);
		if (at !== undefined && t - at < this.ttlMs) return true;
		this.seen.set(key, t);
		if (this.seen.size > 4096) for (const [k, ts] of this.seen) { if (t - ts >= this.ttlMs) this.seen.delete(k); }
		return false;
	}
}
