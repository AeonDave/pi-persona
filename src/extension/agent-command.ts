import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_INTERCOM_MESSAGE_CHARS } from "../tools/intercom.ts";
import { compactInlineText } from "../ui/presentation.ts";

/** A current projection of an existing worker control, never a second routing registry. */
export interface AgentMessageTarget {
	id: string;
	/** Exact live control address; a display id is never reverse-parsed into this handle. */
	nodeId: string;
	name?: string;
	label: string;
	sendable: boolean;
}

interface AgentCommandDeps {
	targets(): readonly AgentMessageTarget[];
	open(ctx: ExtensionContext): Promise<void>;
	/** Rechecks the exact live handle and returns whether it accepted the message. */
	send(id: string, text: string): boolean;
}

const USAGE = '/agents opens F9. To message a running worker: /agents send <run-id|name> <message>. Quote names containing spaces.';
const safe = (value: string): string => compactInlineText(value, { maxChars: 120 });
const quote = (value: string): string => /[\s"\\\u0000-\u001f\u007f-\u009f]/.test(value)
	? JSON.stringify(value).replace(/[\u007f-\u009f]/g, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")) : value;

/** Operator-only direct steering: no model turn, worker creation or implicit continuation. */
export function registerAgentCommand(pi: Pick<ExtensionAPI, "registerCommand">, d: AgentCommandDeps): void {
	pi.registerCommand("agents", {
		description: "Open F9, or message a worker: /agents send <run-id|name> <message>",
		getArgumentCompletions: (prefix) => {
			if (!prefix.includes(" ")) return "send".startsWith(prefix) ? [{ value: "send ", label: "send", description: "Message a running worker directly" }] : null;
			if (!prefix.startsWith("send ")) return null;
			const query = prefix.slice(5).toLocaleLowerCase();
			const choices = d.targets().filter((target) => target.sendable &&
				[target.id, target.name ?? "", target.label].some((text) => text.toLocaleLowerCase().startsWith(query)))
				.slice(0, 30).map((target) => ({ value: "send " + quote(target.id) + " ", label: safe(target.label), description: safe(target.id) }));
			return choices.length ? choices : null;
		},
		handler: async (args, ctx) => {
			if (!args.trim()) { await d.open(ctx); return; }
			const match = /^send\s+("(?:[^"\\]|\\.)*"|\S+)\s+([\s\S]+)$/.exec(args.trim());
			if (!match) { ctx.ui.notify(USAGE, "warning"); return; }
			let targetRef = match[1]!;
			try { if (targetRef.startsWith('"')) targetRef = JSON.parse(targetRef) as string; }
			catch { ctx.ui.notify(USAGE, "warning"); return; }
			const message = match[2]!.trim();
			if (!targetRef || !message || message.length > MAX_INTERCOM_MESSAGE_CHARS) {
				ctx.ui.notify("intercom: provide a worker and a nonempty message of at most " + MAX_INTERCOM_MESSAGE_CHARS + " characters.", "warning");
				return;
			}
			const targets = d.targets();
			const byId = targets.filter((target) => target.id === targetRef);
			const matched = byId.length ? byId : targets.filter((target) => target.name === targetRef);
			if (matched.length !== 1) {
				ctx.ui.notify(matched.length ? "intercom: ambiguous worker name; use " + matched.slice(0, 5).map((target) => quote(safe(target.id))).join(", ") + "." : "intercom: unknown worker " + safe(targetRef) + ". Use /agents or autocomplete to select a current worker.", "warning");
				return;
			}
			const target = matched[0]!;
			if (!target.sendable) {
				ctx.ui.notify("intercom: " + safe(target.label) + " is not accepting messages. F9 shows its status; saved completed workers require an explicit delegate resume.", "warning");
				return;
			}
			const accepted = d.send(target.nodeId, message);
			ctx.ui.notify(accepted ? "intercom: message accepted for " + safe(target.label) + "." : "intercom: message not accepted; " + safe(target.label) + " may have just finished. Check F9.", accepted ? "info" : "warning");
		},
	});
}
