/** Bounded, immutable operator projection of one worker attempt's runtime events. No persistence. */
import { boundChatText, chatArguments, chatContent, type ChatText } from "./worker-chat-content.ts";
import { createHash } from "node:crypto";

export type WorkerChatBlock =
	| Readonly<{ kind: "user" | "assistant" | "thinking"; id: string; text: string }>
	| Readonly<{ kind: "tool"; id: string; name: string; arguments: string; output: string; status: "running" | "done" | "failed" }>
	| Readonly<{ kind: "status"; id: string; text: string; level: "info" | "error" }>;

export interface WorkerChatSnapshot {
	readonly revision: number;
	readonly blocks: readonly WorkerChatBlock[];
	readonly truncated: boolean;
}

export const WORKER_CHAT_LIMITS = Object.freeze({ blocks: 128, totalChars: 96_000, textChars: 16_000, argumentChars: 4_000 });

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function size(block: WorkerChatBlock): number {
	return block.kind === "tool" ? block.name.length + block.arguments.length + block.output.length : block.text.length;
}

function same(a: WorkerChatBlock, b: WorkerChatBlock): boolean {
	if (a.kind !== b.kind || a.id !== b.id) return false;
	if (a.kind === "tool" && b.kind === "tool") return a.name === b.name && a.arguments === b.arguments && a.output === b.output && a.status === b.status;
	if (a.kind === "status" && b.kind === "status") return a.text === b.text && a.level === b.level;
	return "text" in a && "text" in b && a.text === b.text;
}

export class WorkerChat {
	private view: WorkerChatSnapshot = Object.freeze({ revision: 0, blocks: Object.freeze([]), truncated: false });
	private sequence = 0;
	private active: { role: "user" | "assistant"; id: string } | undefined;
	private pendingTruncation = false;

	snapshot(): WorkerChatSnapshot { return this.view; }

	observe(value: unknown): void {
		const event = object(value);
		if (!event) return;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			this.tool(event, event.type);
			return;
		}
		if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return;
		const message = object(event.message);
		if (message?.role === "toolResult") {
			this.tool({ toolCallId: message.toolCallId, toolName: message.toolName, result: message, isError: message.isError }, "tool_execution_end");
			return;
		}
		if (message?.role === "user" || message?.role === "assistant") {
			const role = message.role;
			if (!this.active || this.active.role !== role) this.active = { role, id: `message-${++this.sequence}` };
			this.message(message, role, this.active.id);
			if (event.type === "message_end") {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					const text = typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : `Worker response ${message.stopReason}.`;
					this.put({ kind: "status", id: `status-${++this.sequence}`, text: this.bounded(text), level: "error" });
				}
				this.active = undefined;
			}
			return;
		}
		const delta = object(event.assistantMessageEvent);
		if (event.type !== "message_update" || !delta) return;
		const kind = delta.type === "thinking_delta" || delta.type === "thinking_end" ? "thinking"
			: delta.type === "text_delta" || delta.type === "text_end" ? "assistant" : undefined;
		const index = delta.contentIndex;
		if (!kind || typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= 4096) return;
		if (!this.active || this.active.role !== "assistant") this.active = { role: "assistant", id: `message-${++this.sequence}` };
		const id = `${this.active.id}:${index}:${kind}`;
		const previous = this.view.blocks.find((block) => block.id === id);
		const ending = delta.type === "thinking_end" || delta.type === "text_end";
		const text = ending ? delta.content : delta.delta;
		if (typeof text !== "string") return;
		this.put({ kind, id, text: this.bounded(ending ? text : `${previous && "text" in previous ? previous.text : ""}${text}`) });
	}

	private bounded(text: string, limit: number = WORKER_CHAT_LIMITS.textChars): string {
		return this.take(boundChatText(text, limit));
	}

	private take(value: ChatText): string {
		this.pendingTruncation ||= value.truncated;
		return value.text;
	}

	private message(message: Record<string, unknown>, role: "user" | "assistant", prefix: string): void {
		const content = message.content;
		if (!Array.isArray(content)) {
			const text = this.take(chatContent(content, WORKER_CHAT_LIMITS.textChars));
			if (text) this.put({ kind: role, id: `${prefix}:0:${role}`, text });
			return;
		}
		if (content.length > 128) this.pendingTruncation = true;
		for (const [index, raw] of content.slice(0, 128).entries()) {
			const part = object(raw);
			if (!part) continue;
			if (part.type === "toolCall") {
				this.tool({ toolCallId: part.id, toolName: part.name, args: part.arguments }, "tool_execution_start");
				continue;
			}
			const kind = part.type === "thinking" ? "thinking" : role;
			const text = part.type === "thinking" && typeof part.thinking === "string" ? this.bounded(part.thinking)
				: this.take(chatContent([part], WORKER_CHAT_LIMITS.textChars));
			if (text) this.put({ kind, id: `${prefix}:${index}:${kind}`, text });
		}
	}

	private tool(event: Record<string, unknown>, phase: string): void {
		const rawId = event.toolCallId;
		const callId = typeof rawId === "string" && rawId.length > 0
			? rawId.length <= 256 ? `id:${rawId}` : `sha256:${createHash("sha256").update(rawId).digest("hex")}` : undefined;
		if (!callId) return; // An uncorrelated chunk cannot safely be attributed to another tool.
		const id = `tool:${callId}`;
		const previous = this.view.blocks.find((block) => block.id === id);
		const prior = previous?.kind === "tool" ? previous : undefined;
		if (prior && prior.status !== "running" && phase !== "tool_execution_end") return;
		const name = typeof event.toolName === "string" ? this.bounded(event.toolName, 128) : prior?.name ?? "tool";
		const args = event.args === undefined ? prior?.arguments ?? "" : this.take(chatArguments(event.args, WORKER_CHAT_LIMITS.argumentChars));
		const source = phase === "tool_execution_update" ? event.partialResult : event.result;
		const output = source === undefined ? prior?.output ?? "" : this.take(chatContent(source, WORKER_CHAT_LIMITS.textChars));
		const status = phase === "tool_execution_end" ? event.isError === true ? "failed" : "done" : prior?.status ?? "running";
		this.put({ kind: "tool", id, name, arguments: args, output, status });
	}

	private put(block: WorkerChatBlock): void {
		const index = this.view.blocks.findIndex((prior) => prior.id === block.id);
		const existing = this.view.blocks[index];
		if (existing && same(existing, block) && (!this.pendingTruncation || this.view.truncated)) { this.pendingTruncation = false; return; }
		const blocks = [...this.view.blocks];
		if (index < 0) blocks.push(Object.freeze(block));
		else blocks[index] = Object.freeze(block);
		let chars = blocks.reduce((sum, item) => sum + size(item), 0);
		let truncated = this.view.truncated || this.pendingTruncation;
		while (blocks.length > WORKER_CHAT_LIMITS.blocks || chars > WORKER_CHAT_LIMITS.totalChars) {
			const removed = blocks.shift();
			if (!removed) break;
			chars -= size(removed);
			truncated = true;
		}
		this.pendingTruncation = false;
		this.view = Object.freeze({ revision: this.view.revision + 1, blocks: Object.freeze(blocks), truncated });
	}
}
