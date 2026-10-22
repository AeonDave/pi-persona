import { test } from "node:test";
import assert from "node:assert/strict";

import { piHostModuleHint } from "../../../src/engine/host-module.ts";

const chunks = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/";
const missing = "openai-responses-KCCCXI3B.js";
const importer = "chunk-66G7ITPS.js";
const error = (directory: string) => `Cannot find module '${directory}${missing}' imported from ${directory}${importer}`;

test("the Pi host module hint recognizes the same bundle import on Windows, POSIX and file URLs", () => {
	for (const directory of [chunks, `${String.raw`C:\Program Files\Pi\node_modules\@earendil-works\pi-coding-agent\dist\bundle\chunks`}\\`, `file://${chunks}`]) {
		const hint = piHostModuleHint(error(directory));
		assert.ok(hint, directory);
		assert.match(hint, /may have been updated in place/, "the update cause is qualified, not asserted from an error alone");
	}
});

test("the Pi host module hint excludes worker imports, other packages and unrelated failures", () => {
	for (const text of [
		"Cannot find module '/project/tool.js' imported from /project/main.js",
		error(chunks.replace("pi-coding-agent", "another-package")),
		error(chunks).replace(`${chunks}${importer}`, "/project/main.js"),
		error(chunks).replace(missing, "openai-responses.js"),
		`ENOENT: no such file or directory, open '${chunks}${missing}'`,
		"Cannot find package '@earendil-works/pi-coding-agent' imported from /project/main.js",
		"429 rate limit exceeded",
	]) {
		assert.equal(piHostModuleHint(text), undefined, text);
	}
});
