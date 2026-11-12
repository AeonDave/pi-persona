import { test } from "node:test";
import assert from "node:assert/strict";

import { findWriteSetOverlaps, normalizeWritePath, pathsOverlap, validateParallelWriteSets, writeSetPathError } from "../../../src/core/ownership.ts";

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
