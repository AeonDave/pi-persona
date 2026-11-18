/** Synchronous local presentation query for loaded companions. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INSPECTOR_FRAME_EVENT, inspectorFrame, type InspectorFrameProviderResponse } from "../ui/inspector-frame.ts";

export function installInspectorFrameProvider(pi: Pick<ExtensionAPI, "events">): () => void {
	return pi.events.on(INSPECTOR_FRAME_EVENT, (request: unknown) => {
		try {
			if (!request || typeof request !== "object" || Array.isArray(request)) return;
			const prototype = Object.getPrototypeOf(request);
			if (prototype !== null && prototype !== Object.prototype) return;
			const query = request as Record<string, unknown>;
			const keys = Reflect.ownKeys(query);
			if (query.version !== 1 || typeof query.respond !== "function" || keys.length !== 2 || keys.some((key) => key !== "version" && key !== "respond")) return;
			(query.respond as (response: InspectorFrameProviderResponse) => void)({ version: 1, provider: "pi-persona", frame: inspectorFrame });
		} catch {
			// Invalid requests and consumer callbacks cannot disrupt the event loop.
		}
	});
}
