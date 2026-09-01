/**
 * Shared provider-error recognition for the engine layer's `failureKind` classification.
 *
 * The fallback decorator (`fallback.ts`) reroutes ONLY `failureKind === "provider"`, so the
 * classification decides whether a failure retries the same model id through another provider
 * route or stops dead. Two producers need the SAME judgment:
 *  - the in-process engine classifies a THROWN error (a provider API rejection often throws
 *    before any stream event fires — but a throw is not automatically a provider fault);
 *  - the child engine classifies a pre-stream death (the provider rejected the request and
 *    `pi` exited non-zero before emitting a single assistant event — evidence lives in
 *    stderr/exit text, not in a stream `error` stop reason).
 *
 * Conservative by design: only patterns that essentially always mean "the provider rejected
 * or broke" classify as provider. Anything ambiguous stays "agent" (terminal), because a
 * wrong reroute burns tokens while a wrong terminal failure is at least honest. Pure.
 */

const PROVIDER_PATTERNS: readonly RegExp[] = [
	/\brate.?limit|\b429\b|too many requests/i,
	/\bquota\b|billing|insufficient.?credits/i,
	/\b401\b|\b403\b|unauthorized|invalid[\s_-]?api[\s_-]?key/i,
	/\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|overloaded|capacity/i,
	/model.{0,24}(not.{0,8}(supported|found|exist)|does not exist)|unsupported.{0,12}model/i,
	/\beconnreset\b|\betimedout\b|\beconnrefused\b|socket hang up|fetch failed/i,
];

/** True when the text is evidence of a PROVIDER-side rejection/outage (not agent behavior). */
export function looksLikeProviderError(text: string): boolean {
	return PROVIDER_PATTERNS.some((re) => re.test(text));
}
