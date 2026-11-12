import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineParsedCode } from "../../../src/core/code-outline.ts";
import { selectCodeOutlineGrammar, withParsedCodeOutline } from "../../../src/tools/code-outline-parser.ts";

const bytes = (source: string) => Buffer.from(source, "utf8");
const run = (source: string, filename: string) => withParsedCodeOutline(bytes(source), filename, undefined, (root, selected, byteLength) =>
	outlineParsedCode(root, { filename, bytes: byteLength, language: selected.language, grammar: selected.grammar }));

test("one WASM backend extracts exact Python names and inclusive multiline physical ranges", async () => {
	const result = await run("# def fake():\ndef greet(name):\n    class Helper:\n        def work(self):\n            pass\n", "fixture.py");
	assert.equal(result.language, "Python");
	assert.equal(result.grammar, "python");
	assert.deepEqual(result.symbols.map(({ name, kind, container, startLine, endLine }) => [name, kind, container, startLine, endLine]), [
		["greet", "function", undefined, 2, 5], ["Helper", "class", "greet", 3, 5], ["work", "method", "greet.Helper", 4, 5],
	]);
});

test("one WASM backend extracts Go declarations and receiver methods", async () => {
	const result = await run("// func fake() {}\ntype Box struct{}\ntype BoxOf[T any] struct{}\ntype Reader interface { Read() }\nfunc (b Box) Run() {}\nfunc (b *Box[T]) GenericRun() {}\nfunc Start() {}\n", "fixture.go");
	assert.equal(result.language, "Go");
	assert.equal(result.grammar, "go");
	assert.deepEqual(result.symbols.map(({ name, kind, container, startLine, endLine }) => [name, kind, container, startLine, endLine]), [
		["Box", "struct", undefined, 2, 2], ["BoxOf", "struct", undefined, 3, 3], ["Reader", "interface", undefined, 4, 4], ["Read", "method", "Reader", 4, 4],
		["Run", "method", "Box", 5, 5], ["GenericRun", "method", "Box", 6, 6], ["Start", "function", undefined, 7, 7],
	]);
	const generic = await run("type Box[T any] struct{}\nfunc (b *Box[T]) Run() {}\n", "fixture.go");
	assert.deepEqual(generic.symbols.filter((symbol) => symbol.name === "Run"), [
		{ name: "Run", kind: "method", container: "Box", startLine: 2, endLine: 2 },
	]);
});

test("one WASM backend extracts Rust items and impl methods", async () => {
	const result = await run("// fn fake() {}\nstruct Cache {}\nimpl Cache {\n    pub fn load(&self) {}\n}\nfn start() {}\n", "fixture.rs");
	assert.equal(result.language, "Rust");
	assert.equal(result.grammar, "rust");
	assert.deepEqual(result.symbols.map(({ name, kind, container, startLine, endLine }) => [name, kind, container, startLine, endLine]), [
		["Cache", "struct", undefined, 2, 2], ["load", "method", "Cache", 4, 4], ["start", "function", undefined, 6, 6],
	]);
});

test("one WASM backend extracts C++ qualified methods and declarations", async () => {
	const result = await run("// void fake() {}\ntypedef int (*Callback)(int);\nclass Box {\npublic:\n  void open();\n};\nvoid Box::close() {}\nint start() { return 0; }\n", "fixture.cpp");
	assert.equal(result.language, "C++");
	assert.equal(result.grammar, "cpp");
	assert.deepEqual(result.symbols.map(({ name, kind, container, startLine, endLine }) => [name, kind, container, startLine, endLine]), [
		["Callback", "type", undefined, 2, 2], ["Box", "class", undefined, 3, 6], ["open", "method", "Box", 5, 5], ["close", "method", "Box", 7, 7], ["start", "function", undefined, 8, 8],
	]);
});

test("C uses the C++ grammar and reports C-family syntax without claiming compiler validation", async () => {
	const source = `#include <stdatomic.h>\ntypedef int (*callback)(int);\nstruct S { int x; };\nstatic struct S s = (struct S){ .x = 7 };\nint f(callback cb) { return cb(s.x); }\n#if __STDC_VERSION__ >= 201112L\n_Static_assert(_Generic(1, int: 1, default: 0), "int");\n_Atomic int counter;\n#endif\n`;
	const result = await run(source, "fixture.c");
	assert.equal(result.language, "C-family C syntax");
	assert.equal(result.grammar, "cpp");
	assert.deepEqual(result.symbols.map(({ name, kind }) => [name, kind]), [["callback", "type"], ["S", "struct"], ["f", "function"]]);
});

test("standalone TypeScript uses its grammar and indexes interfaces, types, enums and functions", async () => {
	const result = await run("export interface Reader { read(): string }\nexport type Options = { enabled: boolean };\nexport enum Mode { On, Off }\nexport function open() {}\n", "fixture.ts");
	assert.equal(result.language, "TypeScript");
	assert.equal(result.grammar, "typescript");
	assert.deepEqual(result.symbols.map(({ name, kind, startLine, endLine }) => [name, kind, startLine, endLine]), [
		["Reader", "interface", 1, 1], ["read", "method", 1, 1], ["Options", "type", 2, 2], ["Mode", "enum", 3, 3], ["open", "function", 4, 4],
	]);
});

test("one WASM backend extracts C# namespace, type, method and inclusive ranges", async () => {
	const result = await run("namespace N {\n  class Worker {\n    void Run() {\n    }\n  }\n}\n", "fixture.cs");
	assert.equal(result.language, "C#");
	assert.equal(result.grammar, "c-sharp");
	assert.deepEqual(result.symbols.map(({ name, kind, container, startLine, endLine }) => [name, kind, container, startLine, endLine]), [
		["N", "namespace", undefined, 1, 6], ["Worker", "class", "N", 2, 5], ["Run", "method", "N.Worker", 3, 4],
	]);
});

test("JS/TS/TSX keep overloads, anonymous defaults, computed-name rules and fake declaration regressions", async () => {
	const tsx = `// function fake() {}\nconst text = "function nope() {}";\nnamespace Outer { export interface Contract { run(): void } export class Worker { async run(value: string): Promise<void> {} } }\nexport function overloaded(value: string): string;\nexport function overloaded(value: string) { return value; }\nconst render = (x: string) => <div>{x}</div>;`;
	const result = await run(tsx, "fixture.tsx");
	assert.deepEqual(result.symbols.map(({ name, kind, container }) => [name, kind, container]), [
		["Outer", "namespace", undefined], ["Contract", "interface", "Outer"], ["run", "method", "Outer.Contract"],
		["Worker", "class", "Outer"], ["run", "method", "Outer.Worker"], ["overloaded", "function", undefined],
		["overloaded", "function", undefined], ["render", "arrow", undefined],
	]);
	for (const [source, name, kind] of [["export default function() {}", "<default function>", "function"], ["export default class {}", "<default class>", "class"], ["export default () => 1", "<default arrow>", "arrow"]] as const) {
		const defaults = await run(source, "fixture.js");
		assert.deepEqual(defaults.symbols.map((symbol) => [symbol.name, symbol.kind]), [[name, kind]]);
	}
	const computed = await run("class C { [key]() {} ['literal']() {} [42]() {} ordinary() {} }", "fixture.js");
	assert.deepEqual(computed.symbols.map((symbol) => symbol.name), ["C", "literal", "42", "ordinary"]);
});

test("language selection is explicit and unsupported extensions fail without a regex fallback", async () => {
	assert.deepEqual(selectCodeOutlineGrammar("x.c"), { language: "C-family C syntax", grammar: "cpp" });
	assert.deepEqual(selectCodeOutlineGrammar("x.h"), { language: "C-family header (ambiguous)", grammar: "cpp" });
	assert.throws(() => selectCodeOutlineGrammar("x.vb"), /Unsupported code outline file extension/);
	await assert.rejects(run("function {", "bad.js"), /syntax/i);
	await assert.rejects(withParsedCodeOutline(Buffer.from([0xff]), "bad.py", undefined, () => true), /valid UTF-8/i);
	await assert.rejects(withParsedCodeOutline(Buffer.alloc(256 * 1024 + 1), "large.py", undefined, () => true), /256 KiB/i);
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(withParsedCodeOutline(bytes("def f(): pass"), "cancel.py", aborted.signal, () => true), /cancel/i);
});
