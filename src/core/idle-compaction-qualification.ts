/** Release qualification, never a preference or a guessed future host-version threshold. */
export interface IdleCompactionQualification {
	readonly qualified: boolean;
	readonly reason: string;
	readonly issue: string;
}

/**
 * Pi 1.4.0 can clear a newer native compaction controller while an earlier request
 * settles, including when an extension vetoes overlapping public hooks.
 * Unlock only in a future Persona release after the upstream fix passes the real
 * host lifecycle qualification. An environment variable or saved preference cannot
 * override this gate; an upstream version change alone is not qualification.
 */
export const IDLE_COMPACTION_QUALIFICATION: IdleCompactionQualification = Object.freeze({
	qualified: false,
	reason: "Unavailable: waiting for a qualified upstream Pi compaction lifecycle fix. Saved preferences and environment variables cannot enable it.",
	issue: "https://github.com/earendil-works/pi/issues/7738#issuecomment-6436968518",
});
