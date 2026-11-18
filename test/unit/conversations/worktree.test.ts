import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeConversationWorktree, verifyConversationWorktree } from "../../../src/engine/conversation-worktree.ts";

test("only a registered worktree belonging to the exact repository can be reused or removed", async () => {
	const root = mkdtempSync(join(tmpdir(), "persona-worktree-test-"));
	const worktree = mkdtempSync(join(tmpdir(), "pi-persona-wt-"));
	const other = mkdtempSync(join(tmpdir(), "persona-worktree-other-"));
	const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
	try {
		git("-C", root, "init", "-q");
		writeFileSync(join(root, "file"), "initial");
		git("-C", root, "add", "file");
		git("-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		const baseCommit = git("-C", root, "rev-parse", "HEAD").trim();
		git("-C", root, "worktree", "add", "--detach", worktree, "HEAD");
		const record = { root: realpathSync(root), path: realpathSync(worktree), baseCommit };
		assert.equal((await verifyConversationWorktree(record, root)).ok, true);
		assert.equal((await verifyConversationWorktree(record, other)).ok, false);
		assert.equal((await verifyConversationWorktree({ ...record, baseCommit: "0".repeat(40) }, root)).ok, false);
		assert.equal((await verifyConversationWorktree({ ...record, path: root }, root)).ok, false);
		writeFileSync(join(worktree, "file"), "modified");
		assert.equal((await removeConversationWorktree(record, root)).ok, true);
		assert.equal((await verifyConversationWorktree(record, root)).ok, false);
	} finally {
		rmSync(worktree, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	}
});

test("a symlink cannot masquerade as a conversation worktree", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "persona-worktree-link-test-"));
	const link = join(tmpdir(), `pi-persona-wt-link-${process.pid}-${Date.now()}`);
	try {
		try { symlinkSync(root, link, "junction"); } catch { t.skip("symlink creation unavailable"); return; }
		const result = await verifyConversationWorktree({ root, path: link, baseCommit: "a".repeat(40) }, root);
		assert.equal(result.ok, false);
	} finally { rmSync(link, { force: true }); rmSync(root, { recursive: true, force: true }); }
});
