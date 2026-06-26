/**
 * In-process coordination bus (v0.3) — the default Bus backend. Handle-based
 * mailbox: participants register by name; `send` is one-way, `ask` blocks for a
 * reply to that message id. No IPC, no naming contract — cross-OS for free. The
 * cross-process broker (v0.5) implements the same surface for separate processes.
 *
 * This is the *semantic* communication plane (Bus messages), kept distinct from
 * engine runtime events and the derived progress view (guardrails §4.2).
 */

export interface Envelope {
	id: string;
	from: string;
	to: string;
	text: string;
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

	register(name: string): void {
		if (!this.inboxes.has(name)) this.inboxes.set(name, []);
	}

	participants(): string[] {
		return [...this.inboxes.keys()];
	}

	/** One-way message. Returns false if the recipient is not registered. */
	send(from: string, to: string, text: string): boolean {
		const box = this.inboxes.get(to);
		if (!box) return false;
		box.push({ id: nextId(), from, to, text, expectsReply: false });
		return true;
	}

	/** Blocking request: resolves with the reply to this message, or rejects on timeout. */
	ask(from: string, to: string, text: string, timeoutMs = 600_000): Promise<string> {
		const box = this.inboxes.get(to);
		if (!box) throw new Error(`unknown peer: ${to}`);
		const id = nextId();
		box.push({ id, from, to, text, expectsReply: true });
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingAsks.delete(id);
				reject(new Error(`ask timeout after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
			this.pendingAsks.set(id, (reply) => {
				clearTimeout(timer);
				resolve(reply);
			});
		});
	}

	/** Answer a pending ask by its message id. */
	reply(askId: string, text: string): void {
		const resolver = this.pendingAsks.get(askId);
		if (resolver) {
			this.pendingAsks.delete(askId);
			resolver(text);
		}
	}

	/** Drain and return a participant's inbox. */
	take(name: string): Envelope[] {
		const box = this.inboxes.get(name) ?? [];
		this.inboxes.set(name, []);
		return box;
	}

	/** Peek at a participant's inbox without draining it. */
	pending(name: string): Envelope[] {
		return [...(this.inboxes.get(name) ?? [])];
	}
}
