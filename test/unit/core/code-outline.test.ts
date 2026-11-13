import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CODE_OUTLINE_MAX_INPUT_BYTES, CODE_OUTLINE_MAX_AST_DEPTH, CODE_OUTLINE_MAX_CONTAINER_DEPTH,
	CODE_OUTLINE_MAX_VISITED_NODES, CODE_OUTLINE_MAX_WORK_UNITS, CODE_OUTLINE_MAX_METADATA_BYTES,
	outlineParsedCode, type OutlineSyntaxNode,
} from "../../../src/core/code-outline.ts";

class FakeNode implements OutlineSyntaxNode {
	readonly type: string;
	readonly text: string;
	readonly startPosition: { row: number; column: number };
	readonly endPosition: { row: number; column: number };
	readonly children: readonly (OutlineSyntaxNode | null)[];
	readonly namedChildren: readonly (OutlineSyntaxNode | null)[];
	readonly childCount: number;
	readonly hasError: boolean;
	readonly isError: boolean;
	readonly isMissing: boolean;
	private readonly fields: Readonly<Record<string, OutlineSyntaxNode>>;
	constructor(type: string, text: string, startPosition: { row: number; column: number }, endPosition: { row: number; column: number }, children: readonly (OutlineSyntaxNode | null)[] = [], fields: Readonly<Record<string, OutlineSyntaxNode>> = {}, flags: { error?: boolean; missing?: boolean } = {}) {
		this.type = type;
		this.text = text;
		this.startPosition = startPosition;
		this.endPosition = endPosition;
		this.children = children;
		this.fields = fields;
		this.namedChildren = children.filter((child) => child !== null);
		this.childCount = children.length;
		this.hasError = flags.error ?? children.some((child) => child?.hasError || child?.isError || child?.isMissing);
		this.isError = flags.error ?? false;
		this.isMissing = flags.missing ?? false;
	}
	childForFieldName(name: string): OutlineSyntaxNode | null { return this.fields[name] ?? null; }
}

const id = (name: string, row: number) => new FakeNode("identifier", name, { row, column: 0 }, { row, column: name.length });
const fn = (name: string, row: number, endRow = row, endColumn = name.length + 2) => {
	const nameNode = id(name, row);
	return new FakeNode("function_declaration", name, { row, column: 0 }, { row: endRow, column: endColumn }, [nameNode], { name: nameNode });
};
const root = (...children: OutlineSyntaxNode[]) => new FakeNode("program", "", { row: 0, column: 0 }, { row: 0, column: 0 }, children);
const options = (overrides: Partial<Parameters<typeof outlineParsedCode>[1]> = {}) => ({
	filename: "fixture.py", bytes: 42, language: "Python", grammar: "python", ...overrides,
});

test("pure outlineParsedCode returns inclusive physical lines and reported grammar metadata", () => {
	const endColumnZero = fn("multi", 0, 3, 0);
	const result = outlineParsedCode(root(endColumnZero), options());
	assert.equal(result.language, "Python");
	assert.equal(result.grammar, "python");
	assert.deepEqual(result.symbols, [{ name: "multi", kind: "function", startLine: 1, endLine: 3 }]);
});

test("pure outlineParsedCode filters query, caps rows, and retains truthful truncation", () => {
	const tree = root(...Array.from({ length: 90 }, (_, index) => fn(`item${index}`, index)));
	const result = outlineParsedCode(tree, options({ query: "ITEM8", limit: 3 }));
	assert.deepEqual(result.symbols.map((symbol) => symbol.name), ["item8", "item80", "item81"]);
	assert.equal(result.totalMatches, 11);
	assert.equal(result.returned, 3);
	assert.equal(result.hasMore, true);
	assert.equal(result.truncated, true);
	assert.throws(() => outlineParsedCode(tree, options({ query: "x".repeat(201) })), /query.*200/i);
	assert.throws(() => outlineParsedCode(tree, options({ limit: 201 })), /limit.*200/i);
	assert.throws(() => outlineParsedCode(tree, options({ bytes: CODE_OUTLINE_MAX_INPUT_BYTES + 1 })), /256 KiB/i);
});

test("pure outlineParsedCode rejects parser error and missing nodes instead of returning empty output", () => {
	const syntaxError = new FakeNode("ERROR", "{", { row: 0, column: 0 }, { row: 0, column: 1 }, [], {}, { error: true });
	const missing = new FakeNode("MISSING", "", { row: 0, column: 1 }, { row: 0, column: 1 }, [], {}, { missing: true });
	assert.throws(() => outlineParsedCode(new FakeNode("program", "", { row: 0, column: 0 }, { row: 0, column: 1 }, [syntaxError], {}, { error: true }), options()), /syntax/i);
	assert.throws(() => outlineParsedCode(root(missing), options()), /syntax/i);
	assert.throws(() => outlineParsedCode(root(fn("run", 0), missing), options({ query: "run", limit: 1 })), /syntax/i);
});

function lazyChain(depth: number, counters: { children: number; names: number }, type = "internal_module"): OutlineSyntaxNode {
	const name = id("N", 0);
	Object.defineProperty(name, "text", { get() { counters.names++; return "N"; } });
	const node = new FakeNode(type, "", { row: 0, column: 0 }, { row: 0, column: 1 }, [], { name });
	Object.defineProperty(node, "childCount", { value: depth > 0 ? 1 : 0 });
	Object.defineProperty(node, "namedChildren", { get() {
		counters.children++;
		return depth > 0 ? [lazyChain(depth - 1, counters, type)] : [];
	} });
	return node;
}

test("structural rejection bounds lazy deep traversal before name/container expansion regardless of query or limit", () => {
	for (const query of ["", "nonmatch"]) {
		const counters = { children: 0, names: 0 };
		assert.throws(() => outlineParsedCode(lazyChain(8000, counters), options({ query, limit: 1 })), /resource limit.*depth/i);
		assert.ok(counters.children <= CODE_OUTLINE_MAX_AST_DEPTH + 1, JSON.stringify(counters));
		assert.ok(counters.names <= CODE_OUTLINE_MAX_AST_DEPTH + 1, JSON.stringify(counters));
	}
});

test("syntax depth and visited-node ceilings accept the boundary and reject one beyond", () => {
	assert.equal(outlineParsedCode(lazyChain(CODE_OUTLINE_MAX_AST_DEPTH, { children: 0, names: 0 }, "expression"), options()).totalMatches, 0);
	assert.throws(() => outlineParsedCode(lazyChain(CODE_OUTLINE_MAX_AST_DEPTH + 1, { children: 0, names: 0 }, "expression"), options()), /resource limit.*depth/i);
	const leaf = id("x", 0);
	assert.equal(outlineParsedCode(new FakeNode("program", "", { row: 0, column: 0 }, { row: 0, column: 0 }, Array<OutlineSyntaxNode>(CODE_OUTLINE_MAX_VISITED_NODES - 1).fill(leaf)), options()).totalMatches, 0);
	let expanded = false;
	const wide = root();
	Object.defineProperty(wide, "childCount", { value: CODE_OUTLINE_MAX_VISITED_NODES });
	Object.defineProperty(wide, "namedChildren", { get() { expanded = true; throw new Error("must reject before allocating child list"); } });
	assert.throws(() => outlineParsedCode(wide, options({ query: "nonmatch", limit: 1 })), /resource limit.*nodes/i);
	assert.equal(expanded, false);
});

test("aggregate metadata is charged for every declaration before filtering or retaining rows", () => {
	const name = id("n".repeat(1020), 0);
	const declaration = new FakeNode("type_alias_declaration", "", { row: 0, column: 0 }, { row: 0, column: 1 }, [], { name });
	const count = CODE_OUTLINE_MAX_METADATA_BYTES / ((name.text.length + "type".length) * 2);
	const atBudget = root(...Array<OutlineSyntaxNode>(count).fill(declaration));
	assert.equal(outlineParsedCode(atBudget, options({ limit: 1 })).totalMatches, count);
	assert.equal(outlineParsedCode(atBudget, options({ query: "nonmatch", limit: 1 })).totalMatches, 0);
	assert.throws(() => outlineParsedCode(root(...Array<OutlineSyntaxNode>(count + 1).fill(declaration)), options({ query: "nonmatch", limit: 1 })), /resource limit.*metadata/i);
});

test("metadata includes repeated container text and queries still match kinds and containers exactly", () => {
	const name = id("Outer" + "x".repeat(995), 0);
	const declaration = new FakeNode("type_alias_declaration", "", { row: 0, column: 0 }, { row: 0, column: 1 }, [], { name: id("T", 0) });
	const parentBytes = (name.text.length + "namespace".length) * 2;
	const childBytes = (name.text.length + "T".length + "type".length) * 2;
	const count = Math.floor((CODE_OUTLINE_MAX_METADATA_BYTES - parentBytes) / childBytes);
	const tree = (length: number) => new FakeNode("internal_module", "", { row: 0, column: 0 }, { row: 0, column: 1 }, Array<OutlineSyntaxNode>(length).fill(declaration), { name });
	assert.equal(outlineParsedCode(tree(count), options({ query: "type outer", limit: 1 })).totalMatches, count);
	assert.equal(outlineParsedCode(tree(count), options({ query: "TYPE", limit: 1 })).totalMatches, count);
	assert.throws(() => outlineParsedCode(tree(count + 1), options({ query: "nonmatch", limit: 1 })), /resource limit.*metadata/i);
});

test("container ancestry accepts the last allowed level and nonsymbol nodes never reread names", () => {
	const counters = { children: 0, names: 0 };
	const result = outlineParsedCode(lazyChain(CODE_OUTLINE_MAX_CONTAINER_DEPTH - 1, counters), options({ limit: 1 }));
	assert.equal(result.totalMatches, CODE_OUTLINE_MAX_CONTAINER_DEPTH);
	assert.equal(result.returned, 1);
	assert.equal(counters.names, CODE_OUTLINE_MAX_CONTAINER_DEPTH);
	const name = id("Outer", 0);
	let reads = 0;
	Object.defineProperty(name, "text", { get() { reads++; return "Outer"; } });
	const node = new FakeNode("internal_module", "", { row: 0, column: 0 }, { row: 0, column: 1 }, [lazyChain(200, { children: 0, names: 0 }, "expression")], { name });
	assert.equal(outlineParsedCode(node, options()).totalMatches, 1);
	assert.equal(reads, 1);
});

test("helper declarator, descendant and receiver searches share depth protection", () => {
	for (const type of ["type_definition", "declaration", "method_declaration"]) {
		const counters = { children: 0, names: 0 };
		const chain = lazyChain(8000, counters, type === "type_definition" ? "pointer_declarator" : "expression");
		const receiver = new FakeNode("parameter_declaration", "", { row: 0, column: 0 }, { row: 0, column: 1 }, [], { type: chain });
		const node = new FakeNode(type, "", { row: 0, column: 0 }, { row: 0, column: 1 }, [], { declarator: chain, receiver, name: id("run", 0) });
		assert.throws(() => outlineParsedCode(node, options({ query: "nonmatch", limit: 1 })), /resource limit.*depth/i);
		assert.ok(counters.children <= CODE_OUTLINE_MAX_AST_DEPTH, JSON.stringify(counters));
	}
});

test("shared work ceiling includes helper lookups even when visited-node and metadata limits fit", () => {
	const name = id("T", 0);
	const declaration = new FakeNode("type_alias_declaration", "", { row: 0, column: 0 }, { row: 0, column: 1 }, [], { name });
	const tree = (count: number) => new FakeNode("program", "", { row: 0, column: 0 }, { row: 0, column: 0 }, Array<OutlineSyntaxNode>(count).fill(declaration));
	const count = Math.floor((CODE_OUTLINE_MAX_WORK_UNITS - 1) / 2); // root + child slots + name lookups
	assert.equal(outlineParsedCode(tree(count), options({ query: "nonmatch", limit: 1 })).totalMatches, 0);
	assert.throws(() => outlineParsedCode(tree(count + 1), options({ query: "nonmatch", limit: 1 })), /resource limit.*work/i);
});

test("pending siblings and default-token child arrays cannot escape the shared expansion budget", () => {
	let expansions = 0;
	const broadChain = (): OutlineSyntaxNode => {
		const node = root();
		Object.defineProperty(node, "childCount", { value: 40000 });
		Object.defineProperty(node, "namedChildren", { get() {
			expansions++;
			return [broadChain(), ...Array<OutlineSyntaxNode>(39999).fill(id("x", 0))];
		} });
		return node;
	};
	assert.throws(() => outlineParsedCode(broadChain(), options()), /resource limit.*work/i);
	assert.equal(expansions, 2);
	const exported = new FakeNode("export_statement", "", { row: 0, column: 0 }, { row: 0, column: 1 });
	Object.defineProperty(exported, "childCount", { value: CODE_OUTLINE_MAX_WORK_UNITS });
	Object.defineProperty(exported, "children", { get() { throw new Error("must reject before allocating token array"); } });
	assert.throws(() => outlineParsedCode(exported, options()), /resource limit.*work/i);
});

test("pure outlineParsedCode observes cancellation before and during AST traversal", () => {
	const alreadyAborted = { aborted: true } as AbortSignal;
	assert.throws(() => outlineParsedCode(root(fn("run", 0)), options({ signal: alreadyAborted })), /cancel/i);
	const tree = root(...Array.from({ length: 1100 }, (_, index) => fn(`item${index}`, index)));
	let checks = 0;
	const cancelledDuringWalk = { get aborted() { checks += 1; return checks > 2; } } as AbortSignal;
	assert.throws(() => outlineParsedCode(tree, options({ signal: cancelledDuringWalk })), /cancel/i);
});
