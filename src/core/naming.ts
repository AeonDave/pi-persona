/**
 * Shared invitation for invented call-signs. Both planes use it:
 *   - intercom / `delegate`: a fresh label per leg (`<call-sign>-<purpose>`)
 *   - exocom / `exocom_name`: this instance's display handle
 *
 * Lists *kinds* of invention, never example handles — models copy examples.
 * Pure module (no Pi imports).
 */
export const CALL_SIGN_PROMPT =
	"Invent a short distinctive call-sign from whatever this moment suggests — a mood, a joke, a snack, the weather, a place, a song fragment, a half-remembered character, a tool on the bench. Anything that fits. One or two words, or a compact compound. Fresh every time; never reuse a handle.";

/** Tool-schema / standing-brief hint for a delegated intercom leg. */
export function inventedLegNameHint(): string {
	return `${CALL_SIGN_PROMPT} Then hyphen the purpose of this leg (\`<call-sign>-<purpose>\`). A new invention every leg. A UI label only, not a task description.`;
}

/** Tool-schema / per-turn hint for this instance's exocom handle. */
export function inventedExocomNameHint(): string {
	return `${CALL_SIGN_PROMPT} Set it with exocom_name before you speak.`;
}

/** Local widget: mark this instance without using "you" as the identity. */
export function exocomSelfWidgetLabel(namedByModel: boolean, name: string, persona = ""): string {
	return `${exocomSelfStatusLabel(namedByModel, name, persona)} (you)`;
}

/** Status / telemetry displayName: invented call-sign, else the persona, else the registry placeholder. */
export function exocomSelfStatusLabel(namedByModel: boolean, name: string, persona = ""): string {
	const invented = name.trim();
	if (namedByModel && invented) return invented;
	const role = persona.trim();
	return role || "unnamed";
}
