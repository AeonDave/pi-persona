/** Framework adapter for loaded companion presence and current-owner activity contributions. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_EVENT, COMPANION_EVENT, companionPresence, parseCompanionActivity, type CompanionRole } from "../core/companion.ts";
import { ActivityRows } from "../ui/activity-rows.ts";
import type { AgentTree } from "../ui/agent-tree.ts";

/** Registered before worker/disable guards; the host revokes subscriptions when the extension unloads. */
export function installCompanionPresence(pi: Pick<ExtensionAPI, "events">, role: CompanionRole): void {
	pi.events.on(COMPANION_EVENT, (request: unknown) => {
		if (!request || typeof request !== "object" || Array.isArray(request)) return;
		const query = request as Record<string, unknown>;
		if (query.version !== 1 || typeof query.respond !== "function" || Reflect.ownKeys(query).some((key) => key !== "version" && key !== "respond")) return;
		try { query.respond(companionPresence(role)); } catch { /* a companion's callback cannot disrupt Persona */ }
	});
}

export interface ActivityIngress { start(ctx: ExtensionContext): void; stop(removeRows?: boolean): void }
export function installActivityIngress(pi: Pick<ExtensionAPI, "events">, tree: AgentTree, now: () => number = Date.now): ActivityIngress {
	const rows = new ActivityRows();
	let owner: { manager: ExtensionContext["sessionManager"]; sessionId: string; file: string | undefined } | undefined;
	const stop = (removeRows = true): void => {
		owner = undefined;
		const ids = rows.clear();
		if (removeRows) for (const id of ids) tree.remove(id);
	};
	pi.events.on(ACTIVITY_EVENT, (value: unknown) => {
		const event = parseCompanionActivity(value);
		if (!event || !owner || event.sessionId !== owner.sessionId) return;
		try {
			if (owner.manager.getSessionId() !== owner.sessionId || owner.manager.getSessionFile() !== owner.file) return;
			const change = rows.accept(event, now());
			if (!change) return;
			for (const id of change.removed) tree.remove(id);
			tree.add(change.node);
		} catch { /* malformed/local UI contributions never affect memory or orchestration */ }
	});
	return { start(ctx) { stop(); owner = { manager: ctx.sessionManager, sessionId: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() }; }, stop };
}
