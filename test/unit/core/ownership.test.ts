import { test } from "node:test";
import assert from "node:assert/strict";

import { findWriteSetOverlaps, writeSetPathError } from "../../../src/core/ownership.ts";

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

test("write-set normalization treats repository root markers as ancestors", () => {
	assert.equal(findWriteSetOverlaps([{ agent: "a", writeSet: ["."] }, { agent: "b", writeSet: ["src/file.ts"] }]).length, 1);
});
