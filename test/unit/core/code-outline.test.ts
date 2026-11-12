import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_OUTLINE_MAX_INPUT_BYTES, outlineParsedCode, type OutlineSyntaxNode } from "../../../src/core/code-outline.ts";

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
});

test("pure outlineParsedCode observes cancellation before and during AST traversal", () => {
	const alreadyAborted = { aborted: true } as AbortSignal;
	assert.throws(() => outlineParsedCode(root(fn("run", 0)), options({ signal: alreadyAborted })), /cancel/i);
	const tree = root(...Array.from({ length: 1100 }, (_, index) => fn(`item${index}`, index)));
	let checks = 0;
	const cancelledDuringWalk = { get aborted() { checks += 1; return checks > 2; } } as AbortSignal;
	assert.throws(() => outlineParsedCode(tree, options({ signal: cancelledDuringWalk })), /cancel/i);
});
