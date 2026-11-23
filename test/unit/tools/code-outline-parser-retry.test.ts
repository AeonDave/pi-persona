import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineParsedCode } from "../../../src/core/code-outline.ts";
import { withParsedCodeOutline } from "../../../src/tools/code-outline-parser.ts";

// Its own file (own process): the runtime and grammar caches must start cold for these cases.
const run = (source: string, filename: string) => withParsedCodeOutline(Buffer.from(source, "utf8"), filename, undefined, (root, selected, byteLength) =>
	outlineParsedCode(root, { filename, bytes: byteLength, language: selected.language, grammar: selected.grammar }));

async function treeSitter() {
	const namespace = await import("@vscode/tree-sitter-wasm");
	return (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
}

test("a transient runtime init failure is not cached: the next call retries and succeeds", async (t) => {
	const runtime = await treeSitter();
	const init = runtime.Parser.init.bind(runtime.Parser);
	let calls = 0;
	t.mock.method(runtime.Parser, "init", (...args: Parameters<typeof init>) => {
		calls++;
		return calls === 1 ? Promise.reject(new Error("EMFILE: too many open files")) : init(...args);
	});
	await assert.rejects(run("def f(): pass\n", "first.py"), /EMFILE/);
	assert.equal((await run("def healthy(): pass\n", "second.py")).symbols[0]?.name, "healthy");
	assert.equal(calls, 2);
});

test("a transient grammar load failure is not cached: the next call for that grammar retries and succeeds", async (t) => {
	const runtime = await treeSitter();
	const load = runtime.Language.load.bind(runtime.Language);
	let calls = 0;
	t.mock.method(runtime.Language, "load", (...args: Parameters<typeof load>) => {
		calls++;
		return calls === 1 ? Promise.reject(new Error("EBUSY: resource busy or locked")) : load(...args);
	});
	await assert.rejects(run("fn start() {}\n", "first.rs"), /EBUSY/);
	assert.equal((await run("fn healthy() {}\n", "second.rs")).symbols[0]?.name, "healthy");
	assert.equal(calls, 2);
	// A grammar that loaded is cached: no further load for it.
	await run("fn again() {}\n", "third.rs");
	assert.equal(calls, 2);
});
