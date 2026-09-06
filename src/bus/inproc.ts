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

/** Retention is a bounded escape hatch for drained messages, not a second inbox. */
export const MAX_RETAINED_MESSAGES = 256;
export const MAX_RETAINED_MESSAGE_CHARS = 256_000;
export const MAX_INBOX_MESSAGES = 200;

export interface InProcessBusOptions {
	/** Override the unread-envelope bound for focused tests or a future host policy. */
	maxInbox?: number;
}

export type AskSettlementReason = "replied" | "aborted" | "timeout" | "unregistered" | "inbox-full" | "delivery-error";

export interface AskSettlement {
	id: string;
	from: string;
	to: string;
	reason: AskSettlementReason;
}

interface PendingAsk {
	envelope: Envelope;
	resolve: (reply: string) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	signal: AbortSignal | undefined;
	onAbort: () => void;
}

let seq = 0;
function nextId(): string {
	seq += 1;
	return `m${seq.toString(36)}`;
}

export class InProcessBus {
	private readonly inboxes = new Map<string, Envelope[]>();
	private readonly retainedMessages = new Map<string, Envelope>();
	private retainedMessageChars = 0;
	private readonly pendingAsks = new Map<string, PendingAsk>();
	private readonly observers = new Set<(env: Envelope) => void>();
	private readonly askSettledListeners = new Set<(event: AskSettlement) => void>();
	private readonly maxInbox: number;

	constructor(opts: InProcessBusOptions = {}) {
		this.maxInbox = opts.maxInbox !== undefined && Number.isFinite(opts.maxInbox)
			? Math.max(1, Math.floor(opts.maxInbox))
			: MAX_INBOX_MESSAGES;
	}

	/** Observe every delivered message (for event-wake follow-ups). Returns an unsubscribe. */
	onMessage(listener: (env: Envelope) => void): () => void {
		this.observers.add(listener);
		return () => this.observers.delete(listener);
	}

	/** Observe ask settlement so notification surfaces can discard stale cached prompts. */
	onAskSettled(listener: (event: AskSettlement) => void): () => void {
		this.askSettledListeners.add(listener);
		return () => this.askSettledListeners.delete(listener);
	}

	/** Cap on unread messages per inbox — a chatty child must not grow supervisor
	 *  memory without bound when nobody drains. */
	private deliver(box: Envelope[], env: Envelope): boolean {
		if (box.length >= this.maxInbox) {
			// Evict the oldest ONE-WAY note first. If every unread envelope is a live ask,
			// reject this delivery instead of silently stranding an existing sender.
			const idx = box.findIndex((e) => !e.expectsReply);
			if (idx < 0) return false;
			box.splice(idx, 1);
		}
		box.push(env);
		for (const fn of this.observers) fn(env);
		return true;
	}

	private retireAskEnvelope(pending: PendingAsk): void {
		pending.envelope.expectsReply = false;
		const { id, to: recipient } = pending.envelope;
		const box = this.inboxes.get(recipient);
		if (box) {
			const index = box.findIndex((env) => env.id === id);
			if (index >= 0) box.splice(index, 1);
		}
		const retained = this.retainedMessages.get(id);
		if (retained?.to === recipient) retained.expectsReply = false;
	}

	private settleAsk(id: string, reason: AskSettlementReason, reply?: string, failure?: Error): boolean {
		const pending = this.pendingAsks.get(id);
		if (!pending) return false;
		this.pendingAsks.delete(id);
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		pending.signal?.removeEventListener("abort", pending.onAbort);
		this.retireAskEnvelope(pending);
		if (reason === "replied") pending.resolve(reply ?? "");
		else pending.reject(failure ?? new Error(reason === "inbox-full" ? "inbox full: ask was not delivered" : `ask ${reason}`));
		const event: AskSettlement = { id, from: pending.envelope.from, to: pending.envelope.to, reason };
		for (const listener of this.askSettledListeners) {
			try {
				listener(event);
			} catch {
				// Settlement observers are cleanup hooks; one faulty observer must not alter the ask result.
			}
		}
		return true;
	}

	private retain(env: Envelope): void {
		if (env.text.length > MAX_RETAINED_MESSAGE_CHARS || this.retainedMessages.has(env.id)) return;
		this.retainedMessages.set(env.id, env);
		this.retainedMessageChars += env.text.length;
		while (this.retainedMessages.size > MAX_RETAINED_MESSAGES || this.retainedMessageChars > MAX_RETAINED_MESSAGE_CHARS) {
			const oldest = this.retainedMessages.keys().next().value;
			if (oldest === undefined) break;
			const removed = this.retainedMessages.get(oldest);
			this.retainedMessages.delete(oldest);
			if (removed) this.retainedMessageChars -= removed.text.length;
		}
	}

	private retainAll(messages: readonly Envelope[]): void {
		for (const message of messages) this.retain(message);
	}

	register(name: string): void {
		if (!this.inboxes.has(name)) this.inboxes.set(name, []);
	}

	unregister(name: string): void {
		this.inboxes.delete(name);
		for (const [id, pending] of this.pendingAsks) {
			if (pending.envelope.from === name || pending.envelope.to === name) this.settleAsk(id, "unregistered");
		}
		for (const [id, message] of this.retainedMessages) {
			if (message.to !== name) continue;
			this.retainedMessages.delete(id);
			this.retainedMessageChars -= message.text.length;
		}
	}

	participants(): string[] {
		return [...this.inboxes.keys()];
	}

	/** One-way message (default `progress`). Returns false if the recipient is not registered. */
	send(from: string, to: string, text: string, kind: MsgKind = "progress"): boolean {
		const box = this.inboxes.get(to);
		if (!box) return false;
		return this.deliver(box, { id: nextId(), from, to, kind, text, expectsReply: false });
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
		const timeoutMs = opts.timeoutMs ?? 600_000;
		return new Promise<string>((resolve, reject) => {
			const envelope: Envelope = { id, from, to, kind: opts.kind ?? "decision", text, expectsReply: true };
			const onAbort = (): void => {
				this.settleAsk(id, "aborted");
			};
			const pending: PendingAsk = {
				envelope,
				resolve,
				reject,
				timer: undefined,
				signal: opts.signal,
				onAbort,
			};
			this.pendingAsks.set(id, pending);
			if (opts.signal?.aborted) {
				this.settleAsk(id, "aborted");
				return;
			}
			pending.timer = setTimeout(() => {
				this.settleAsk(id, "timeout", undefined, new Error(`ask timeout after ${timeoutMs}ms`));
			}, timeoutMs);
			pending.timer.unref?.();
			if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
			// Deliver only once the resolver is registered: `deliver` notifies observers
			// synchronously, and one that answers inline would otherwise hit `reply`'s
			// unknown-id path and strand this ask until its timeout.
			try {
				if (!this.deliver(box, envelope)) this.settleAsk(id, "inbox-full");
			} catch (error) {
				this.settleAsk(id, "delivery-error", undefined, error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** Answer a pending ask by its message id. Returns false (a harmless no-op) for an
	 *  unknown/expired id — so the caller can tell the child actually got the answer. */
	reply(askId: string, text: string): boolean {
		return this.settleAsk(askId, "replied", text);
	}

	/** Drain and return a participant's inbox. */
	take(name: string): Envelope[] {
		const box = this.inboxes.get(name) ?? [];
		this.inboxes.set(name, []);
		this.retainAll(box);
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
		this.retainAll(taken);
		return taken;
	}

	/** Retrieve a drained message by id while it remains inside the bounded retention window. */
	retrieve(messageId: string, recipient?: string): Envelope | undefined {
		const message = this.retainedMessages.get(messageId);
		return message && (recipient === undefined || message.to === recipient) ? message : undefined;
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
