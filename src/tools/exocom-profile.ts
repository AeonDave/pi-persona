/** Self-reported Exocom presence. This metadata never grants authority or changes tool gates. */
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { normalizeExocomProfile, type ExocomProfile } from "../exocom/profile.ts";
import type { ExocomPlane } from "../exocom/plane.ts";
import { renderLiteralToolResult } from "../ui/literal-tool-result.ts";

const ExocomProfileParams = Type.Object({
	action: Type.Union([Type.Literal("get"), Type.Literal("set"), Type.Literal("clear")], {
		description: "get the current self-report · set selected fields · clear it back to unknown",
	}),
	capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 48 }), {
		maxItems: 8,
		description: "set: up to 8 self-reported capability labels, each at most 48 characters",
	})),
	availability: Type.Optional(Type.Union([
		Type.Literal("available"), Type.Literal("busy"), Type.Literal("away"),
	], { description: "set: your self-reported current availability; omitted remains unknown" })),
});

interface ProfileToolDetails {
	action: "get" | "set" | "clear";
	profile?: ExocomProfile;
}

function formatProfile(profile: ExocomProfile | undefined): string {
	if (!profile) return "No profile reported; availability is unknown.";
	const availability = profile.availability ?? "unknown";
	const capabilities = profile.capabilities.length > 0 ? profile.capabilities.join(" · ") : "not reported";
	return `Self-reported availability: ${availability}\nSelf-reported capabilities: ${capabilities}`;
}

function actionText(details: ProfileToolDetails): string {
	if (details.action === "clear") return "Profile cleared; availability is unknown.";
	return formatProfile(details.profile);
}

/** `getPlane` is read on each call so a revoked Exocom plane cannot leave a stale mutator alive. */
export function registerExocomProfileTool(pi: ExtensionAPI, getPlane: () => ExocomPlane | undefined): void {
	pi.registerTool({
		name: "exocom_profile",
		label: "Exocom Profile",
		description: [
			"Report your own optional Exocom presence. `get` reads it, `set` updates the supplied fields,",
			"and `clear` removes it. Capabilities and availability are self-reported metadata only; they",
			"do not prove identity, grant permissions, reserve work, or change tool access. An unset",
			"availability is unknown; a partial update leaves an existing value unchanged. The profile lasts only for this Exocom session.",
		].join(" "),
		parameters: ExocomProfileParams,
		async execute(_toolCallId, params: Static<typeof ExocomProfileParams>): Promise<{
			content: [{ type: "text"; text: string }];
			details: ProfileToolDetails;
		}> {
			const action = params && typeof params === "object" ? (params as { action?: unknown }).action : undefined;
			if (typeof action !== "string" || !["get", "set", "clear"].includes(action)) {
				throw new Error("exocom_profile: action must be get, set, or clear");
			}
			const plane = getPlane();
			if (!plane) throw new Error("exocom is not active for this persona");
			if (params.action === "get") {
				const profile = normalizeExocomProfile(plane.getProfile());
				return { content: [{ type: "text" as const, text: formatProfile(profile) }], details: { action: "get", ...(profile ? { profile } : {}) } satisfies ProfileToolDetails };
			}
			if (params.action === "clear") {
				plane.setProfile(undefined);
				return { content: [{ type: "text" as const, text: "Profile cleared; availability is unknown." }], details: { action: "clear" } satisfies ProfileToolDetails };
			}
			if (params.capabilities === undefined && params.availability === undefined) {
				throw new Error("exocom_profile set needs at least one of { capabilities, availability }");
			}
			const current = normalizeExocomProfile(plane.getProfile());
			const next = normalizeExocomProfile({
				capabilities: params.capabilities ?? current?.capabilities ?? [],
				...(params.availability ?? current?.availability
					? { availability: params.availability ?? current?.availability }
					: {}),
			});
			if (!next) throw new Error("exocom_profile set needs at least one visible capability or an availability value");
			plane.setProfile(next);
			return {
				content: [{ type: "text" as const, text: formatProfile(next) }],
				details: { action: "set", profile: next } satisfies ProfileToolDetails,
			};
		},
		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "get";
			return new Text(theme.fg("toolTitle", theme.bold(`Exocom Profile ${action}`)), 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			if (context?.isError || result.isError) return renderLiteralToolResult(result, { expanded }, theme, context);
			const details = result.details as unknown as ProfileToolDetails | undefined;
			if (!details || !["get", "set", "clear"].includes(details.action)) {
				return renderLiteralToolResult(result, { expanded }, theme, { isError: true });
			}
			return renderLiteralToolResult({
				...result,
				content: [{ type: "text", text: actionText(details) }],
			}, { expanded }, theme);
		},
	});
}
