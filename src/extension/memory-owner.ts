/** Live supervisor selection and immutable per-leg inheritance over the current local host bus. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MEMORY_OWNER_EVENT, MEMORY_OWNER_CHANGED_EVENT, type CompanionMemoryOwner } from "../core/companion.ts";

type Manager = ExtensionContext["sessionManager"];
export interface MemoryOwnerControl {
	/** Returns a readiness callback bound to this exact activation, revoked by start/stop. */
	start(manager: Manager): () => void;
	changed(): void;
	stop(): void;
}

export function installMemoryOwner(pi: Pick<ExtensionAPI, "events">, persona: () => string | null): MemoryOwnerControl {
	let binding: { manager: Manager; sessionId: string; file: string | undefined; ready: boolean } | undefined;
	const read = (sessionId: string): CompanionMemoryOwner => {
		const unavailable: CompanionMemoryOwner = { version: 1, provider: "pi-persona", sessionId, ready: false, persona: null };
		try {
			if (!binding?.ready || sessionId !== binding.sessionId || binding.manager.getSessionId() !== sessionId || binding.manager.getSessionFile() !== binding.file) return unavailable;
			return { ...unavailable, ready: true, persona: persona() };
		} catch { return unavailable; }
	};
	const notify = (): void => {
		if (!binding) return;
		try { pi.events.emit(MEMORY_OWNER_CHANGED_EVENT, read(binding.sessionId)); } catch { /* observer-only */ }
	};
	pi.events.on(MEMORY_OWNER_EVENT, (request: unknown) => {
		if (!request || typeof request !== "object" || Array.isArray(request)) return;
		const query = request as Record<string, unknown>;
		if (query.version !== 1 || typeof query.sessionId !== "string" || !query.sessionId || query.sessionId.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(query.sessionId) || typeof query.respond !== "function" || Reflect.ownKeys(query).some((key) => key !== "version" && key !== "sessionId" && key !== "respond")) return;
		try { query.respond(read(query.sessionId)); } catch { /* a caller cannot break Persona */ }
	});
	const api: MemoryOwnerControl = {
		start(manager) {
			api.stop();
			const captured = { manager, sessionId: manager.getSessionId(), file: manager.getSessionFile(), ready: false };
			binding = captured;
			return () => { if (binding === captured) { captured.ready = true; notify(); } };
		},
		changed() { if (binding?.ready) notify(); },
		stop() {
			const previous = binding;
			binding = undefined;
			if (previous) try { pi.events.emit(MEMORY_OWNER_CHANGED_EVENT, { version: 1, provider: "pi-persona", sessionId: previous.sessionId, ready: false, persona: null } satisfies CompanionMemoryOwner); } catch { /* observer-only */ }
		},
	};
	return api;
}

/** A factory closed over this child's actual manager: no mutable process-global persona state. */
export function installFrozenMemoryOwner(pi: Pick<ExtensionAPI, "events" | "on">, manager: Manager, persona: string | null): void {
	const owner = installMemoryOwner(pi, () => persona);
	owner.start(manager)();
	pi.on("session_shutdown", () => owner.stop());
}
