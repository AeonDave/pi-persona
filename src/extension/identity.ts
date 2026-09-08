/** Session identity registration and Pi lifecycle adapter. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

type SessionManagerCompat = {
	getSessionId?: () => string;
	getHeader?: () => { id?: string } | null;
	getBranch?: () => readonly unknown[];
	getEntries?: () => readonly unknown[];
};

function sessionManager(ctx: ExtensionContext): SessionManagerCompat {
	return (ctx as ExtensionContext & { sessionManager?: SessionManagerCompat }).sessionManager ?? {};
}

/** Read the real session id when available. Process fallback is intentionally start-only. */
function readSessionId(ctx: ExtensionContext, allowProcessFallback: boolean): string | undefined {
	const manager = sessionManager(ctx);
	try {
		const id = manager.getSessionId?.();
		if (typeof id === "string" && id.trim()) return id;
	} catch {
		/* Compatibility with light-weight session-manager test doubles. */
	}
	try {
		const id = manager.getHeader?.()?.id;
		if (typeof id === "string" && id.trim()) return id;
	} catch {
		/* Compatibility with light-weight session-manager test doubles. */
	}
	return allowProcessFallback ? `process-${process.pid}` : undefined;
}

function readEntries(ctx: ExtensionContext): readonly unknown[] {
	const manager = sessionManager(ctx);
	try {
		const branch = manager.getBranch?.();
		if (Array.isArray(branch)) return branch;
	} catch {
		/* Fall through to getEntries when a mock or older host has no branch reader. */
	}
	try {
		const entries = manager.getEntries?.();
		if (Array.isArray(entries)) return entries;
	} catch {
		/* Missing persistence only means there is no stored chosen identity to restore. */
	}
	return [];
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
		const getActiveTools = (pi as unknown as { getActiveTools?: () => string[] }).getActiveTools;
		const names = getActiveTools?.call(pi);
		return Array.isArray(names) ? names : [];
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
		return customType === "exocom_received" || customType === "exocom-inbound" || customType === "pi-persona:exocom-inbound";
	});
}

/** Render the per-request identity context without copying any user or peer payload into it. */
export function buildIdentityContext(
	name: string,
	chosen: boolean,
	options: { namingTool?: "agent_name" | "exocom_name"; inboundPeer?: boolean } = {},
): string {
	if (chosen) {
		return (
			`[pi-persona] Identity data (quoted): ${JSON.stringify(name)}. ` +
			"This is your personal handle, separate from your persona and role. Keep this same handle across turns and persona changes; never borrow a peer's or role's name."
		);
	}
	if (!options.namingTool) {
		return (
			"[pi-persona] Identity data: no personal handle has been chosen, and no naming tool is callable in this turn. " +
			"Keep personal identity separate from persona and role; do not borrow a peer or role name."
		);
	}
	const source = options.inboundPeer ? "the current task or inbound peer request" : "the current user task or an inbound peer request";
	return (
		`[pi-persona] FIRST action: invent a distinct short personal handle from ${source}, ` +
		`then call ${options.namingTool}({ name: "<your invented handle>" }) before other work. ` +
		"The handle is separate from your persona and role, persists across turns and persona changes, and must never borrow a peer's or role's name. Do not make an extra model call."
	);
}

export function installIdentity(pi: ExtensionAPI, host: IdentityHost): SessionIdentity {
	let currentSessionId: string | undefined;
	let currentName = provisionalIdentityName(`process-${process.pid}`);
	let currentChosen = false;
	let currentSessionIsFallback = false;
	let started = false;

	const identity: SessionIdentity = {
		start(ctx) {
			const detectedSessionId = readSessionId(ctx, false);
			const sessionId = detectedSessionId ?? readSessionId(ctx, true)!;
			if (started && currentSessionId === sessionId) {
				setIdentityStatus(ctx, currentName);
				return;
			}
			currentSessionId = sessionId;
			currentSessionIsFallback = detectedSessionId === undefined;
			const stored = findStoredIdentity(readEntries(ctx), sessionId, host.reservedNames());
			currentName = stored ?? provisionalIdentityName(sessionId);
			currentChosen = stored !== undefined;
			started = true;
			setIdentityStatus(ctx, currentName);
		},

		rename(raw, ctx) {
			const name = sanitizeIdentityName(raw, host.reservedNames());
			if (!name) throw new Error("identity name is empty, unsafe, generic, or reserved by a persona/agent");
			const sessionId = readSessionId(ctx, false) ?? (currentSessionIsFallback ? undefined : currentSessionId);
			if (!sessionId) throw new Error("identity session is unavailable");
			if (currentChosen && currentSessionId === sessionId && currentName === name) return currentName;

			// Persistence comes first. A failed append therefore cannot leave memory or telemetry
			// claiming a name that is absent from the session history.
			pi.appendEntry(IDENTITY_ENTRY_CUSTOM_TYPE, makeIdentityEntry(sessionId, name));
			currentSessionId = sessionId;
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
			const name = identity.rename(params.name, ctx);
			return { content: [{ type: "text", text: `agent: you are now \"${name}\"` }], details: { name } };
		},
		renderCall(args, theme) {
			const name = compactInlineText(args.name, { maxChars: 32 }) || "?";
			return new Text(`${theme.fg("toolTitle", theme.bold("Agent Name "))}${theme.fg("accent", name)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as unknown as { name?: unknown } | undefined;
			const name = typeof details?.name === "string" ? compactInlineText(details.name, { maxChars: 32 }) : "";
			const first = result.content.find((item) => item.type === "text");
			const rendered = name
				? `agent: you are now \"${name}\"`
				: first?.type === "text" ? compactInlineText(first.text, { maxChars: 96 }) : "Agent name failed";
			return new Text(theme.fg(name ? (expanded ? "toolOutput" : "accent") : "error", rendered), 0, 0);
		},
	});

	// Context is rebuilt for every provider request. Replacing this one ephemeral message keeps
	// identity current after a rename without persisting another entry or duplicating old reminders.
	pi.on("context", (event, _ctx) => {
		const messages = event.messages.filter((message) => messageCustomType(message) !== IDENTITY_CONTEXT_CUSTOM_TYPE);
		const namingTool: "exocom_name" | "agent_name" | undefined = host.exocomActive()
			? toolIsCallable(pi, host, "exocom_name") ? "exocom_name" : undefined
			: toolIsCallable(pi, host, "agent_name") ? "agent_name" : undefined;
		const contextOptions = {
			inboundPeer: hasInboundPeerRequest(event.messages),
			...(namingTool === undefined ? {} : { namingTool }),
		};
		const contextMessage = {
			role: "custom" as const,
			customType: IDENTITY_CONTEXT_CUSTOM_TYPE,
			content: buildIdentityContext(currentName, currentChosen, contextOptions),
			display: false,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		return { messages: [...messages, contextMessage] };
	});

	return identity;
}
