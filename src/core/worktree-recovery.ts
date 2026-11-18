/** Runtime-owned recovery location when an isolated worktree could not be exported. */
export interface WorktreeRecovery { path: string; baseCommit: string; reason: string; availability: "retained" | "unavailable" }

/** Identity of the retained isolated checkout for a continued worker. */
export interface ConversationWorktree { path: string; baseCommit: string; root: string }

export const WORKTREE_CAPTURE_WARNING = "⚠ Worktree artifact capture failed; the following patch is worker-provided and was not verified against the worktree state.";

export function formatWorktreeLocation(recovery: WorktreeRecovery): string {
	const location = recovery.availability === "retained" ? `retained at ${recovery.path}` : `unavailable at ${recovery.path}`;
	return `Isolated worktree ${location} (base commit ${recovery.baseCommit})`;
}

export function formatWorktreeRecovery(recovery: WorktreeRecovery): string {
	return `${formatWorktreeLocation(recovery)}; ${recovery.reason}.`;
}
