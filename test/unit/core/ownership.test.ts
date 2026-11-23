import { test } from "node:test";
import assert from "node:assert/strict";

import { findLiveWriteConflicts, findWriteSetOverlaps, normalizeWritePath, pathsOverlap, validateParallelWriteSets, writeSetPathError } from "../../../src/core/ownership.ts";

test("findWriteSetOverlaps rejects equal and ancestor/descendant paths with Windows normalization", () => {
	const tasks = [
		{ agent: "a", writeSet: ["Src\\App.ts"] },
		{ agent: "b", writeSet: ["src/app.ts", "src/other"] },
		{ agent: "c", writeSet: ["src"] },
	];
	assert.equal(findWriteSetOverlaps(tasks).length, 4);
});

test("findWriteSetOverlaps allows distinct siblings", () => {
	assert.deepEqual(findWriteSetOverlaps([
		{ agent: "a", writeSet: ["src/a.ts"] },
		{ agent: "b", writeSet: ["src/b.ts"] },
	]), []);
});

test("writeSetPathError rejects ownership outside the repository", () => {
	for (const path of ["../outside", "/absolute/path", "C:\\absolute\\path"]) {
		assert.match(writeSetPathError(path) ?? "", /repository-relative|outside|absolute/i);
	}
	assert.equal(writeSetPathError("src/a.ts"), undefined);
	assert.equal(writeSetPathError("."), undefined);
});

test("ownership rejects Windows drive-relative paths on every host", () => {
	for (const path of ["C:foo", "c:src/file.ts", "C:", " D:../outside "]) {
		assert.match(writeSetPathError(path) ?? "", /repository-relative/, path);
		assert.match(validateParallelWriteSets([{ agent: "a", writeSet: [path] }]) ?? "", /repository-relative/, path);
	}
});

test("Windows drive syntax stays distinct from POSIX paths and preserves absolute drive roots", () => {
	assert.deepEqual(normalizeWritePath("C:Src/App.ts"), { value: "c:src/app.ts", windows: true });
	assert.deepEqual(normalizeWritePath("C:/"), { value: "c:/", windows: true });
	assert.equal(pathsOverlap(normalizeWritePath("C:/"), normalizeWritePath("c:/src/file.ts")), true);
	assert.equal(pathsOverlap(normalizeWritePath("C:/"), normalizeWritePath("c:src/file.ts")), false);
	assert.equal(writeSetPathError("src/module.ts"), undefined);
	assert.equal(writeSetPathError("src\\module.ts"), undefined);
	assert.deepEqual(normalizeWritePath("SRC/module.ts"), { value: "SRC/module.ts", windows: false });
});

test("case-folding is per-path syntax, not host platform: POSIX-style names stay case-sensitive", () => {
	// On a Windows host the old code folded EVERY path, so these two distinct ownership
	// names were falsely reported as overlapping. The answer must be host-independent.
	assert.deepEqual(findWriteSetOverlaps([
		{ agent: "a", writeSet: ["SRC/app.ts"] },
		{ agent: "b", writeSet: ["src/app.ts"] },
	]), []);
	// Windows syntax (backslash) still folds, on any host.
	assert.equal(findWriteSetOverlaps([
		{ agent: "a", writeSet: ["SRC\\app.ts"] },
		{ agent: "b", writeSet: ["src\\app.ts"] },
	]).length, 1);
});

test("write-set normalization treats repository root markers as ancestors", () => {
	assert.equal(findWriteSetOverlaps([{ agent: "a", writeSet: ["."] }, { agent: "b", writeSet: ["src/file.ts"] }]).length, 1);
});

// Strategies and tools share this core helper without importing from one another. The delegate
// tool behavior tests also exercise it directly from this module.
test("validateParallelWriteSets rejects a parallel writeSet overlap and names both paths", () => {
	const owners = [
		{ agent: "a", writeSet: ["src/a.ts"] },
		{ agent: "b", writeSet: ["src/a.ts"] },
	];
	const error = validateParallelWriteSets(owners) ?? "";
	assert.match(error, /overlap/i);
	assert.match(error, /src\/a\.ts/);
});

test("validateParallelWriteSets allows distinct siblings and ignores an owner with no writeSet", () => {
	assert.equal(
		validateParallelWriteSets([
			{ agent: "a", writeSet: ["src/a.ts"] },
			{ agent: "b" },
			{ agent: "c", writeSet: ["src/c.ts"] },
		]),
		undefined,
	);
});

test("findLiveWriteConflicts: a new writer beside a live one needs both owned and disjoint", () => {
	const live = [{ id: "run-1", agent: "operator", writeSet: ["src/a"] }];
	assert.deepEqual(findLiveWriteConflicts([{ agent: "operator", writeSet: ["src/b.ts"] }], live), [], "disjoint owners may run side by side");
	assert.deepEqual(findLiveWriteConflicts([], live), [], "no new writer, nothing to check");
	assert.deepEqual(findLiveWriteConflicts([{ agent: "operator" }], []), [], "no live writer, nothing to check");

	assert.deepEqual(findLiveWriteConflicts([{ agent: "operator", writeSet: ["src/a/deep.ts"] }], live), [
		{ kind: "overlap", index: 0, run: live[0], newPath: "src/a/deep.ts", livePath: "src/a" },
	], "a descendant of a live writer's path collides");
	assert.deepEqual(findLiveWriteConflicts([{ agent: "fixer" }, { agent: "docs", writeSet: [" "] }], live), [
		{ kind: "unowned-new", index: 0 },
		{ kind: "unowned-new", index: 1 },
	], "a new writer without a usable writeSet could touch anything");

	const unowned = { id: "run-2", agent: "worker" };
	assert.deepEqual(findLiveWriteConflicts([{ agent: "operator", writeSet: ["docs"] }], [unowned, ...live]), [
		{ kind: "unowned-live", run: unowned },
	], "a live writer without a writeSet blocks every other writer until it settles");
});

test("writeSetPathError rejects * and ? wildcards that the literal-segment overlap check cannot reason about", () => {
	for (const path of ["src/*.ts", "src/**", "*", "src/a?.ts", "src\\*.ts"]) {
		assert.match(writeSetPathError(path) ?? "", /wildcard/, path);
	}
	// Brackets and braces are legitimate file names (Next.js routes), not wildcards here.
	for (const path of ["app/[id]/page.tsx", "src/{a}.ts"]) assert.equal(writeSetPathError(path), undefined, path);
	assert.equal(
		validateParallelWriteSets([{ agent: "a", writeSet: ["src/*.ts"] }, { agent: "b", writeSet: ["src/index.ts"] }]),
		'delegate: task[0] ("a") writeSet path "src/*.ts" is a wildcard pattern; list exact files or directories.',
	);
});
