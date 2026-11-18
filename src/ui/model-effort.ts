/** The one display rule for a worker's model and reasoning effort, shared by every surface that
 * names a model: launch cards, live tree/widget rows, F9 rows and headers, Exocom peer rows.
 *
 * The effort is always the FULL Pi level name (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
 * `max`) — no row is narrow enough to need a compact form, so none exists. Honesty rules:
 *  - unknown (nothing requested, nothing observed) ⇒ the segment is OMITTED, never a placeholder;
 *  - a known `off` is a real level and is shown like any other;
 *  - an observed level that differs from the requested one renders `requested→observed`;
 *  - an observed level with no known request renders alone (it is what ran, not an invention).
 * Invalid input renders nothing: render paths never throw. Pure. */
import { isThinkingLevel, type ThinkingLevel } from "../core/types.ts";

export function effortText(requested: ThinkingLevel | undefined, effective?: ThinkingLevel): string {
	const req = isThinkingLevel(requested) ? requested : undefined;
	const obs = isThinkingLevel(effective) ? effective : undefined;
	if (req === undefined) return obs ?? "";
	return obs !== undefined && obs !== req ? `${req}→${obs}` : req;
}

/** `haiku-5 · medium`: the display model (already shortened by the caller where the surface wants
 *  it) followed by its effort; either part may be absent. */
export function modelEffortText(model: string | undefined, requested: ThinkingLevel | undefined, effective?: ThinkingLevel): string {
	return [model?.trim(), effortText(requested, effective)].filter((part): part is string => !!part).join(" · ");
}
