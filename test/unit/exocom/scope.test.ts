import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { selectExocomScope } from "../../../src/exocom/scope.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), name));
	dirs.push(dir);
	return dir;
}

test("bare Exocom selects and publishes the current workspace", async () => {
	const agentDir = await temp("exo-scope-agent-");
	const workspace = await temp("exo-scope-project-");
	const scope = selectExocomScope(agentDir, workspace);

	assert.equal(scope.scopeWorkspaceId, scope.homeWorkspaceId);
	assert.equal(scope.scopeCode, scope.homeWorkspaceCode);
	assert.equal(scope.homeWorkspaceLabel, workspace.split(/[\\/]/).at(-1));
	assert.equal(scope.joined, false);
});

test("a join code selects another workspace while retaining the Pi's actual home workspace", async () => {
	const agentDir = await temp("exo-scope-agent-");
	const teamWorkspace = await temp("exo-scope-team-");
	const externalWorkspace = await temp("exo-scope-corpus-");
	const team = selectExocomScope(agentDir, teamWorkspace);
	const joined = selectExocomScope(agentDir, externalWorkspace, team.scopeCode);

	assert.equal(joined.scopeWorkspaceId, team.scopeWorkspaceId);
	assert.equal(joined.scopeCode, team.scopeCode);
	assert.notEqual(joined.homeWorkspaceId, joined.scopeWorkspaceId);
	assert.notEqual(joined.homeWorkspaceCode, joined.scopeCode);
	assert.equal(joined.homeWorkspaceLabel, externalWorkspace.split(/[\\/]/).at(-1));
	assert.equal(joined.joined, true);
});

test("an unknown join code fails closed instead of falling back to the current workspace", async () => {
	const agentDir = await temp("exo-scope-agent-");
	const workspace = await temp("exo-scope-project-");
	assert.throws(() => selectExocomScope(agentDir, workspace, "Ab0T"), /unknown Exocom join code "Ab0T"/);
});
