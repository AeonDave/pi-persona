/**
 * Naming hints for two independent identity scopes:
 *   - intercom / `delegate`: the supervisor invents a fresh label per leg
 *   - exocom / `exocom_name`: the top-level instance derives its own handle from its task
 *
 * Neither path carries a catalog of example handles. Pure module (no Pi imports).
 */
import { sanitizeDisplayLabel } from "./display-label.ts";

/** Both engines use identical bounded identity metadata without changing routing handles. */
export function assignedIdentityPrompt(name: string | undefined): string | undefined {
	if (!name?.trim()) return undefined;
	const safe = sanitizeDisplayLabel(name, "agent");
	return `Your supervisor assigned the following name for this run. Keep it; your agent template describes your role.\n[pi-persona assigned identity]\n${JSON.stringify({ name: safe })}\n[/pi-persona assigned identity]`;
}

export const CALL_SIGN_PROMPT =
	"Invent a short distinctive call-sign from whatever this moment suggests — a mood, a joke, a snack, the weather, a place, a song fragment, a half-remembered character, a tool on the bench. Anything that fits. One or two words, or a compact compound. Fresh every time; never reuse a handle.";

/** Tool-schema / standing-brief hint for a delegated intercom leg. */
export function inventedLegNameHint(): string {
	return `${CALL_SIGN_PROMPT} Then hyphen the purpose of this leg (\`<call-sign>-<purpose>\`). A new invention every leg. A UI label only, not a task description.`;
}

/** Tool-schema / per-turn hint for this instance's exocom handle. */
export function inventedExocomNameHint(): string {
	return (
		"Invent a short distinctive call-sign inspired by the current task or inbound peer request that triggered this turn; " +
		"use one or two words or a compact compound, with no built-in list or catalog. Your persona describes your role, not your personal name. " +
		"Keep this identity across turns and persona changes."
	);
}

/** Local widget: mark this instance without using "you" as the identity. */
export function exocomSelfWidgetLabel(namedByModel: boolean, name: string, persona = ""): string {
	return `${exocomSelfStatusLabel(namedByModel, name, persona)} (you)`;
}

/** Status / telemetry identity stays separate from the persona, including provisional labels. */
export function exocomSelfStatusLabel(_namedByModel: boolean, name: string, _persona = ""): string {
	return name.trim() || "unnamed";
}
