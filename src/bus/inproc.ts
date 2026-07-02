/**
 * In-process coordination bus — the semantic communication plane (Bus messages),
 * kept DISTINCT from engine runtime events and the derived progress view
 * (guardrails §4.2: EngineEvent / Bus Msg / ProgressView are three disjoint planes).
 *
 * Handle-based mailbox: participants register by name; `send` is one-way (a child's
 * `progress_update`), `ask` blocks for a reply to that message id (a child's
 * `need_decision`/`interview_request` — the supervisor must be free to answer, i.e.
 * async coaching, §4.9). No IPC, no naming contract → cross-OS for free; a future
 * cross-process broker would implement the same surface for separate processes.
 *
 * Pure module: no Pi imports, fully unit-tested. This is the seam the in-process
 * engine wires a child's `contact_supervisor` tool onto.
 */

/** Why a child reached the supervisor — shapes how the UI/supervisor treats it. */
export type MsgKind = "progress" | "decision" | "interview";

export interface Envelope {
	id: string;
	from: string;
	to: string;
	kind: MsgKind;
	text: string;
	/** A `decision`/`interview` blocks the sender until `reply(id, …)`; `progress` never does. */
	expectsReply: boolean;
}

let seq = 0;
function nextId(): string {
	seq += 1;
	return `m${seq.toString(36)}`;
}

export class InProcessBus {
	private readonly inboxes = new Map<string, Envelope[]>();
	private readonly pendingAsks = new Map<string, (reply: string) => void>();
	private readonly observers = new Set<(env: Envelope) => void>();

	/** Observe every delivered message (for event-wake follow-ups). Returns an unsubscribe. */
	onMessage(listener: (env: Envelope) => void): () => void {
		this.observers.add(listener);
		return () => this.observers.delete(listener);
	}

	/** Cap on unread messages per inbox — a chatty child must not grow supervisor
	 *  memory without bound when nobody drains. */
	private static readonly MAX_INBOX = 200;

	private deliver(box: Envelope[], env: Envelope): void {
		if (box.length >= InProcessBus.MAX_INBOX) {
			// Evict the oldest ONE-WAY note first; a blocking ask is kept whenever possible
			// (silently dropping it would strand its sender until the ask timeout).
			const idx = box.findIndex((e) => !e.expectsReply);
			box.splice(idx >= 0 ? idx : 0, 1);
		}
		box.push(env);
		for (const fn of this.observers) fn(env);
	}

	register(name: string): void {
		if (!this.inboxes.has(name)) this.inboxes.set(name, []);
	}

	unregister(name: string): void {
		this.inboxes.delete(name);
	}

	participants(): string[] {
		return [...this.inboxes.keys()];
	}

	/** One-way message (default `progress`). Returns false if the recipient is not registered. */
	send(from: string, to: string, text: string, kind: MsgKind = "progress"): boolean {
		const box = this.inboxes.get(to);
		if (!box) return false;
		this.deliver(box, { id: nextId(), from, to, kind, text, expectsReply: false });
		return true;
	}

	/** Blocking request: resolves with the reply to this message, or rejects on timeout. */
	ask(
		from: string,
		to: string,
		text: string,
		opts: { kind?: MsgKind; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<string> {
		const box = this.inboxes.get(to);
		if (!box) throw new Error(`unknown peer: ${to}`);
		const id = nextId();
		this.deliver(box, { id, from, to, kind: opts.kind ?? "decision", text, expectsReply: true });
		const timeoutMs = opts.timeoutMs ?? 600_000;
		return new Promise<string>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const onAbort = (): void => {
				finish();
				reject(new Error("ask aborted"));
			};
			// Always drop the pending entry + timer + abort listener, so a cancelled/timed-out ask
			// never leaks a 10-minute timer or a stale resolver into the bus.
			const finish = (): void => {
				clearTimeout(timer);
				this.pendingAsks.delete(id);
				opts.signal?.removeEventListener("abort", onAbort);
			};
			timer = setTimeout(() => {
				finish();
				reject(new Error(`ask timeout after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
			if (opts.signal) {
				if (opts.signal.aborted) {
					finish();
					reject(new Error("ask aborted"));
					return;
				}
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
			this.pendingAsks.set(id, (reply) => {
				finish();
				resolve(reply);
			});
		});
	}

	/** Answer a pending ask by its message id. Returns false (a harmless no-op) for an
	 *  unknown/expired id — so the caller can tell the child actually got the answer. */
	reply(askId: string, text: string): boolean {
		const resolver = this.pendingAsks.get(askId);
		if (!resolver) return false;
		this.pendingAsks.delete(askId);
		resolver(text);
		return true;
	}

	/** Drain and return a participant's inbox. */
	take(name: string): Envelope[] {
		const box = this.inboxes.get(name) ?? [];
		this.inboxes.set(name, []);
		return box;
	}

	/** Drain and return only the messages matching `pred`, leaving the rest in the inbox. */
	takeWhere(name: string, pred: (env: Envelope) => boolean): Envelope[] {
		const box = this.inboxes.get(name);
		if (!box || box.length === 0) return [];
		const taken: Envelope[] = [];
		const kept: Envelope[] = [];
		for (const env of box) (pred(env) ? taken : kept).push(env);
		this.inboxes.set(name, kept);
		return taken;
	}

	/** Peek at a participant's inbox without draining it. */
	pending(name: string): Envelope[] {
		return [...(this.inboxes.get(name) ?? [])];
	}

	/** Whether a participant has any undrained messages. */
	hasPending(name: string): boolean {
		return (this.inboxes.get(name)?.length ?? 0) > 0;
	}
}
