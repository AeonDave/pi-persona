/** Stable evidence and verification guidance shared by the supervisor and ordinary worker prompts. */
export const EVIDENCE_GUIDANCE =
	"[pi-persona] Evidence discipline:\n" +
	"- Verification: preserve and inspect the check process's own exit code (use `set -o pipefail` where supported, or separate logs; never let tail, grep or a downstream formatter stand in for that status). If the code is unavailable, report unverified, not pass.\n" +
	"- Provenance: attribute each result to the exact command/API/source observed; a worker's report is a claim, not independent proof.\n" +
	"- Hashes: computed/present is not verified/matched; claim a match only after an expected-versus-actual comparison, and state the comparison's limits.\n" +
	"- Skips: honor explicit project-documented platform allowances; report skipped cases as untested, never passed. Reject unexpected/new skips or weakened checks.";

export interface EvidencePromptWorker {
	source?: string;
	tools?: readonly string[];
	excludeTools?: readonly string[];
	spine?: boolean;
}

/**
 * The private structured-maintenance worker has no tools, denies every tool, and explicitly opts
 * out of the spine. Keep that closed, internal worker prompt lean without exempting agents by name.
 */
export function shouldAppendEvidenceGuidance(worker: EvidencePromptWorker): boolean {
	const privateToollessWorker =
		worker.source?.startsWith("internal:") === true &&
		worker.tools?.length === 0 &&
		worker.excludeTools?.includes("*") === true &&
		worker.spine === false;
	return !privateToollessWorker;
}
