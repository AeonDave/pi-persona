import { test } from "node:test";
import assert from "node:assert/strict";

import { findWriteSetOverlaps, validateParallelWriteSets, writeSetPathError } from "../../../src/core/ownership.ts";

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

// validateParallelWriteSets moved here from tools/delegate.ts (task 13) so a strategy — `map`'s
// `ownership: "enforce"` — can call it without importing a tool module. delegate.ts re-exports it
// unchanged; test/unit/tools/delegate.test.ts keeps covering it from that call site.
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
