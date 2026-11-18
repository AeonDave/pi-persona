import { canCallTool, type EffectiveCapabilities } from "../core/capabilities.ts";

export function parseExocomCommand(args: string): "status" | "help" | "invalid" {
	const value = args.trim();
	if (!value || value === "status") return "status";
	return value === "help" ? "help" : "invalid";
}

/** Explain an inactive plane using the same capability predicates as its lifecycle gate. */
export function resolveExocomUnavailable(input: {
	requested: boolean;
	activationError?: string | undefined;
	capabilities?: EffectiveCapabilities | undefined;
	startupError?: string | undefined;
}): string {
	if (input.activationError) return `exocom: ${input.activationError}. Restart with a valid --exocom=CODE.`;
	if (!input.requested) return "exocom: not requested. Restart with --exocom for this workspace or --exocom=CODE to join another scope.";
	if (input.capabilities && !input.capabilities.canUseBus) return "exocom: the active persona denies the bus. Select a persona that permits intercom.";
	if (input.capabilities && !canCallTool(input.capabilities, "exocom_answer") && !canCallTool(input.capabilities, "exocom_decline")) {
		return "exocom: the active persona denies both exocom_answer and exocom_decline. Allow at least one to join.";
	}
	if (input.startupError) return `exocom: failed to start: ${input.startupError}`;
	return "exocom: starting or unavailable. Check again with /exocom status.";
}
