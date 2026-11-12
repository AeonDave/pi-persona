/** Synchronous public presentation query for loaded companions; Pi owns the event subscription lifetime. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CARD_FRAME_EVENT, createCardFrame, type CardFrameProviderResponse } from "../ui/card-frame.ts";

export function installCardFrameProvider(pi: Pick<ExtensionAPI, "events">): () => void {
	return pi.events.on(CARD_FRAME_EVENT, (request: unknown) => {
		try {
			if (!request || typeof request !== "object" || Array.isArray(request)) return;
			const prototype = Object.getPrototypeOf(request);
			if (prototype !== null && prototype !== Object.prototype) return;
			const query = request as Record<string, unknown>;
			const keys = Reflect.ownKeys(query);
			if (query.version !== 1 || typeof query.respond !== "function" || keys.length !== 2 || keys.some((key) => key !== "version" && key !== "respond")) return;
			(query.respond as (response: CardFrameProviderResponse) => void)({ version: 1, provider: "pi-persona", createCard: createCardFrame });
		} catch {
			// Malformed requests and local consumer callbacks cannot disrupt Persona's event loop.
		}
	});
}
