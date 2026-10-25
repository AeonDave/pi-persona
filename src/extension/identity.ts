/** Session identity registration and Pi lifecycle adapter. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import { canCallTool, type EffectiveCapabilities } from "../core/capabilities.ts";
import {
	findStoredIdentity,
	IDENTITY_CONTEXT_CUSTOM_TYPE,
	IDENTITY_ENTRY_CUSTOM_TYPE,
	makeIdentityEntry,
	provisionalIdentityName,
	sanitizeIdentityName,
} from "../core/session-identity.ts";
import { compactInlineText } from "../ui/presentation.ts";
import { renderLiteralToolResult } from "../ui/literal-tool-result.ts";

export interface IdentityHost {
	capabilities(): EffectiveCapabilities | undefined;
	reservedNames(): string[];
	exocomActive(): boolean;
	onChanged(ctx: ExtensionContext): void;
}

export interface SessionIdentity {
	start(ctx: ExtensionContext): void;
	rename(raw: string, ctx: ExtensionContext): string;
	readonly name: string;
	readonly chosen: boolean;
}

const AgentNameParams = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 32, description: "A short personal handle, separate from persona and role." }),
});

/** Pi 1.4 supplies both methods. A failed host read is unavailable, never a different owner or branch. */
function readSession(ctx: ExtensionContext): { id: string; entries: readonly SessionEntry[] } | undefined {
	try {
		const id = ctx.sessionManager.getSessionId();
		return id.trim() ? { id, entries: ctx.sessionManager.getBranch() } : undefined;
	} catch {
		return undefined;
	}
}

function setIdentityStatus(ctx: ExtensionContext, name: string): void {
	try {
		ctx.ui.setStatus("persona-identity", name);
	} catch {
		/* Status is cosmetic; the append-only identity entry remains authoritative. */
	}
}

function activeTools(pi: ExtensionAPI): readonly string[] {
	try {
		return pi.getActiveTools();
	} catch {
		return [];
	}
}

function toolIsCallable(pi: ExtensionAPI, host: IdentityHost, name: string): boolean {
	if (!activeTools(pi).includes(name)) return false;
	const caps = host.capabilities();
	return caps === undefined || canCallTool(caps, name);
}

function messageCustomType(message: AgentMessage): string | undefined {
	const item = message as AgentMessage & { customType?: unknown };
	return typeof item.customType === "string" ? item.customType : undefined;
}

function hasInboundPeerRequest(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => {
		const customType = messageCustomType(message);
		return customType === "exocom_received";
	});
}

/** Render the one-shot naming bootstrap without copying any user or peer payload into it. */
export function buildIdentityContext(
	chosen: boolean,
	options: { namingTool?: "agent_name" | "exocom_name"; inboundPeer?: boolean } = {},
): string | undefined {
	if (chosen || !options.namingTool) return undefined;
	const source = options.inboundPeer ? "the current task or inbound peer request" : "the current user task or an inbound peer request";
	return (
		`[pi-persona] FIRST action: invent a distinct short personal handle from ${source}, ` +
		`then call ${options.namingTool}({ name: "<your invented handle>" }) before other work. ` +
		"The handle is separate from your persona and role, persists across turns and persona changes, and must never borrow a peer's or role's name. Do not make an extra model call. " +
		"After the naming tool succeeds, continue the task; no separate acknowledgement is needed."
	);
}

function identityReceipt(name: string, changed: boolean): string {
	return `Session handle: "${name}" (${changed ? "saved" : "unchanged"}).`;
}

export function installIdentity(pi: ExtensionAPI, host: IdentityHost): SessionIdentity {
	let currentSessionId: string | undefined;
	let currentName = "unavailable";
	let currentChosen = false;
	const unavailable = (ctx: ExtensionContext): void => {
		currentSessionId = undefined;
		currentName = "unavailable";
		currentChosen = false;
		setIdentityStatus(ctx, currentName);
	};
	const selectSession = (session: NonNullable<ReturnType<typeof readSession>>): void => {
		if (currentSessionId === session.id) return;
		const stored = findStoredIdentity(session.entries, session.id, host.reservedNames());
		currentSessionId = session.id;
		currentName = stored ?? provisionalIdentityName(session.id);
		currentChosen = stored !== undefined;
	};

	const identity: SessionIdentity = {
		start(ctx) {
			const session = readSession(ctx);
			if (!session) { unavailable(ctx); return; }
			selectSession(session);
			setIdentityStatus(ctx, currentName);
		},

		rename(raw, ctx) {
			const name = sanitizeIdentityName(raw, host.reservedNames());
			if (!name) throw new Error("identity name is empty, unsafe, generic, or reserved by a persona/agent");
			const session = readSession(ctx);
			if (!session) { unavailable(ctx); throw new Error("identity session is unavailable"); }
			selectSession(session);
			if (currentChosen && currentName === name) return currentName;

			// Persistence comes first. A failed append therefore cannot leave memory or telemetry
			// claiming a name that is absent from the session history.
			pi.appendEntry(IDENTITY_ENTRY_CUSTOM_TYPE, makeIdentityEntry(session.id, name));
			currentName = name;
			currentChosen = true;
			setIdentityStatus(ctx, currentName);
			try {
				host.onChanged(ctx);
			} catch {
				/* Identity persistence is authoritative; Exocom/telemetry refresh is best effort. */
			}
			return currentName;
		},

		get name() { return currentName; },
		get chosen() { return currentChosen; },
	};

	pi.registerTool({
		name: "agent_name",
		label: "Agent Name",
		description: "Choose a short personal handle for this session. It is separate from the active persona and role, persists across turns and persona changes, and is unavailable while Exocom is active; use exocom_name there.",
		parameters: AgentNameParams,
		async execute(_toolCallId, params: Static<typeof AgentNameParams>, _signal, _onUpdate, ctx) {
			if (host.exocomActive()) throw new Error("agent_name is unavailable while Exocom is active; use exocom_name");
			if (!activeTools(pi).includes("agent_name")) throw new Error("agent_name is not active in this session");
			const caps = host.capabilities();
			if (caps !== undefined && !canCallTool(caps, "agent_name")) throw new Error("agent_name is not permitted by the active persona");
			const previousName = identity.chosen ? identity.name : undefined;
			const name = identity.rename(params.name, ctx);
			const changed = previousName !== name;
			const text = identityReceipt(name, changed);
			return { content: [{ type: "text", text }], details: { name, changed } };
		},
		renderCall(args, theme) {
			const name = compactInlineText(args.name ?? "", { maxChars: 32 }) || "?";
			return new Text(`${theme.fg("toolTitle", theme.bold("Agent Name "))}${theme.fg("accent", name)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			const failed = context?.isError ?? result.isError ?? false;
			const details = result.details as unknown as { name?: unknown; changed?: unknown } | undefined;
			const name = !failed && typeof details?.name === "string" ? details.name : "";
			// Failures share the one literal renderer (error heading, bounded preview, full expanded
			// text); a chosen handle is a one-line purpose receipt collapsed and the complete literal
			// receipt expanded.
			if (!name || expanded) return renderLiteralToolResult(result, { expanded }, theme, context);
			return new Text(theme.fg("accent", compactInlineText(identityReceipt(name, details?.changed !== false), { maxChars: 80 })), 0, 0);
		},
	});

	// Context is rebuilt for every provider request. The hidden message is actionable only until a
	// name is chosen; emitting identity metadata afterwards makes it look like a fresh user turn on
	// every tool-loop continuation. Always strip an older copy, then add only the naming bootstrap.
	pi.on("context", (event, _ctx) => {
		const messages = event.messages.filter((message) => messageCustomType(message) !== IDENTITY_CONTEXT_CUSTOM_TYPE);
		const namingTool: "exocom_name" | "agent_name" | undefined = host.exocomActive()
			? toolIsCallable(pi, host, "exocom_name") ? "exocom_name" : undefined
			: toolIsCallable(pi, host, "agent_name") ? "agent_name" : undefined;
		const contextOptions = {
			inboundPeer: hasInboundPeerRequest(event.messages),
			...(namingTool === undefined ? {} : { namingTool }),
		};
		const content = currentSessionId === undefined ? undefined : buildIdentityContext(currentChosen, contextOptions);
		if (content === undefined) return { messages };
		const contextMessage = {
			role: "custom" as const,
			customType: IDENTITY_CONTEXT_CUSTOM_TYPE,
			content,
			display: false,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		return { messages: [...messages, contextMessage] };
	});

	return identity;
}
