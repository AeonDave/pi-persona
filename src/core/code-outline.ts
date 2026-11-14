export const CODE_OUTLINE_MAX_INPUT_BYTES = 256 * 1024;
export const CODE_OUTLINE_MAX_OUTPUT_BYTES = 16 * 1024;
export const CODE_OUTLINE_DEFAULT_LIMIT = 80;
export const CODE_OUTLINE_MAX_LIMIT = 200;
export const CODE_OUTLINE_MAX_QUERY_LENGTH = 200;
// Root depth is zero. Work charges the root, all main-walk child slots (including
// unnamed children), helper field lookups/steps and helper child-list slots + one
// per list. Slots are charged before allocating arrays, including pending siblings.
// Metadata counts UTF-16 bytes of every symbol's name/kind/container (including
// nonmatches and unreturned rows), plus Rust impl target names and synthetic kind.
export const CODE_OUTLINE_MAX_AST_DEPTH = 256;
export const CODE_OUTLINE_MAX_CONTAINER_DEPTH = 256;
export const CODE_OUTLINE_MAX_VISITED_NODES = 100_000;
export const CODE_OUTLINE_MAX_WORK_UNITS = 100_000;
export const CODE_OUTLINE_MAX_METADATA_BYTES = 4 * 1024 * 1024;

export type CodeSymbolKind = "function" | "class" | "struct" | "method" | "interface" | "type" | "enum" | "namespace" | "arrow";
export interface CodeSymbol {
	name: string;
	kind: CodeSymbolKind;
	container?: string;
	startLine: number;
	endLine: number;
}
export interface CodeOutlineResult {
	path: string;
	bytes: number;
	language: string;
	grammar: string;
	symbols: CodeSymbol[];
	totalMatches: number;
	returned: number;
	hasMore: boolean;
	truncated: boolean;
}

/** Minimal syntax-node shape used by the pure extractor; it contains no parser or filesystem API. */
export interface OutlineSyntaxNode {
	readonly type: string;
	readonly text: string;
	readonly childCount: number;
	readonly namedChildren: readonly (OutlineSyntaxNode | null)[];
	readonly children: readonly (OutlineSyntaxNode | null)[];
	readonly startPosition: { readonly row: number; readonly column: number };
	readonly endPosition: { readonly row: number; readonly column: number };
	readonly hasError: boolean;
	readonly isError: boolean;
	readonly isMissing: boolean;
	childForFieldName(name: string): OutlineSyntaxNode | null;
}

export interface ParsedCodeOutlineOptions {
	filename: string;
	bytes: number;
	language: string;
	grammar: string;
	query?: string;
	limit?: number;
	signal?: AbortSignal;
}

interface FoundSymbol {
	name: string;
	kind: CodeSymbolKind;
	pushContainer: boolean;
	containerOverride?: string;
}

function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Code outline cancelled");
}

function resourceLimit(reason: string): never {
	throw new Error(`Code outline resource limit exceeded: ${reason}. Outline a smaller or less deeply nested source file; query and limit do not relax structural budgets.`);
}

class WalkBudget {
	visited = 0;
	private readonly depths = new WeakMap<OutlineSyntaxNode, number>();
	private work = 0;
	private metadata = 0;
	private readonly signal: AbortSignal | undefined;
	constructor(signal?: AbortSignal) { this.signal = signal; }
	depth(depth: number): void {
		if (depth > CODE_OUTLINE_MAX_AST_DEPTH) resourceLimit(`AST depth exceeds ${CODE_OUTLINE_MAX_AST_DEPTH}`);
	}
	get remainingWork(): number { return CODE_OUTLINE_MAX_WORK_UNITS - this.work; }
	spend(units = 1): void {
		if (units > CODE_OUTLINE_MAX_WORK_UNITS - this.work) resourceLimit(`traversal/helper work exceeds ${CODE_OUTLINE_MAX_WORK_UNITS} units`);
		this.work += units;
		checkAbort(this.signal);
	}
	child(parent: OutlineSyntaxNode, child: OutlineSyntaxNode): void {
		const depth = (this.depths.get(parent) ?? 0) + 1;
		this.depth(depth);
		this.depths.set(child, depth);
	}
	visit(node: OutlineSyntaxNode, depth: number): void {
		this.depth(depth);
		if (++this.visited > CODE_OUTLINE_MAX_VISITED_NODES) resourceLimit(`visited nodes exceed ${CODE_OUTLINE_MAX_VISITED_NODES}`);
		this.depths.set(node, depth);
		// Main-walk child slots are charged before array expansion, including pending
		// siblings and unnamed syntax children. The root has no parent to charge it.
		this.spend(depth === 0 ? 1 : 0);
	}
	chargeMetadata(characters: number): void {
		const bytes = characters * 2;
		if (bytes > CODE_OUTLINE_MAX_METADATA_BYTES - this.metadata) resourceLimit(`symbol metadata exceeds ${CODE_OUTLINE_MAX_METADATA_BYTES} UTF-16 bytes`);
		this.metadata += bytes;
	}
}

function field(node: OutlineSyntaxNode, name: string, budget: WalkBudget): OutlineSyntaxNode | undefined {
	budget.spend();
	const child = node.childForFieldName(name) ?? undefined;
	if (child) budget.child(node, child);
	return child;
}

function namedChildren(node: OutlineSyntaxNode, budget: WalkBudget, mainWalk = false): OutlineSyntaxNode[] {
	// Check the parser's cheap count BEFORE its array getter allocates wrappers. Unnamed
	// children conservatively count towards the width/work guard, too.
	if (node.childCount > CODE_OUTLINE_MAX_VISITED_NODES - budget.visited) resourceLimit(`child-list nodes exceed ${CODE_OUTLINE_MAX_VISITED_NODES}`);
	if (node.childCount > budget.remainingWork) resourceLimit(`traversal/helper work exceeds ${CODE_OUTLINE_MAX_WORK_UNITS} units`);
	budget.spend(node.childCount + (mainWalk ? 0 : 1));
	const children = node.namedChildren.filter((child): child is OutlineSyntaxNode => child !== null);
	for (const child of children) budget.child(node, child);
	return children;
}

function textName(node: OutlineSyntaxNode | undefined): string | undefined {
	const name = node?.text.trim();
	return name ? name : undefined;
}

function decodeQuotedName(text: string): string {
	const body = text.slice(1, -1);
	return body.replace(/\\([\\'"`])/g, "$1");
}

function literalComputedName(node: OutlineSyntaxNode, budget: WalkBudget): string | undefined {
	if (node.type !== "computed_property_name") return textName(node);
	const child = namedChildren(node, budget)[0];
	if (!child) return undefined;
	if (["string", "string_literal"].includes(child.type) && child.text.length >= 2) return decodeQuotedName(child.text);
	if (["number", "number_literal", "numeric_literal"].includes(child.type)) return child.text.replaceAll("_", "");
	return undefined;
}

function identifierName(node: OutlineSyntaxNode | undefined, budget: WalkBudget): string | undefined {
	while (node) {
		budget.spend();
		if (["identifier", "property_identifier", "private_property_identifier", "type_identifier", "field_identifier", "namespace_identifier", "operator_name"].includes(node.type)) return textName(node);
		if (node.type === "qualified_identifier") node = field(node, "name", budget) ?? namedChildren(node, budget).at(-1);
		else if (["pointer_declarator", "reference_declarator", "parenthesized_declarator", "function_declarator", "array_declarator", "abstract_function_declarator", "abstract_pointer_declarator"].includes(node.type)) node = field(node, "declarator", budget) ?? namedChildren(node, budget)[0];
		else return undefined;
	}
	return undefined;
}

function qualifiedContainer(node: OutlineSyntaxNode | undefined, budget: WalkBudget): string | undefined {
	if (node?.type !== "qualified_identifier") return undefined;
	const scope = textName(field(node, "scope", budget));
	return scope?.replaceAll("::", ".");
}

function goReceiverContainer(node: OutlineSyntaxNode, budget: WalkBudget): string | undefined {
	const receiver = field(node, "receiver", budget);
	if (!receiver) return undefined;
	const parameter = receiver.type === "parameter_declaration" ? receiver : namedChildren(receiver, budget).find((child) => child.type === "parameter_declaration");
	const type = field(parameter ?? receiver, "type", budget);
	if (!type) return undefined;
	const receiverBaseType = (current: OutlineSyntaxNode): string | undefined => {
		budget.spend();
		if (current.type === "type_identifier") return textName(current);
		if (current.type === "generic_type") return textName(field(current, "type", budget));
		for (const child of namedChildren(current, budget)) {
			const found = receiverBaseType(child);
			if (found) return found;
		}
		return undefined;
	};
	return receiverBaseType(type);
}

function cDeclaratorName(node: OutlineSyntaxNode | undefined, budget: WalkBudget): { name?: string; container?: string } {
	while (node) {
		budget.spend();
		if (node.type === "qualified_identifier") {
			const name = identifierName(field(node, "name", budget) ?? namedChildren(node, budget).at(-1), budget);
			const container = qualifiedContainer(node, budget);
			return { ...(name ? { name } : {}), ...(container ? { container } : {}) };
		}
		if (["function_declarator", "pointer_declarator", "reference_declarator", "parenthesized_declarator", "array_declarator"].includes(node.type)) node = field(node, "declarator", budget) ?? namedChildren(node, budget)[0];
		else {
			const name = identifierName(node, budget);
			return name ? { name } : {};
		}
	}
	return {};
}

function firstDescendant(node: OutlineSyntaxNode, predicate: (candidate: OutlineSyntaxNode) => boolean, budget: WalkBudget): OutlineSyntaxNode | undefined {
	const pending = [{ children: namedChildren(node, budget), index: 0 }];
	while (pending.length > 0) {
		const frame = pending.at(-1)!;
		const candidate = frame.children[frame.index++];
		if (!candidate) { pending.pop(); continue; }
		budget.spend();
		if (predicate(candidate)) return candidate;
		pending.push({ children: namedChildren(candidate, budget), index: 0 });
	}
	return undefined;
}

function cppMemberDeclarator(node: OutlineSyntaxNode, budget: WalkBudget): OutlineSyntaxNode | undefined {
	return isCppFunctionDeclaration(node, budget);
}

function isCppFunctionDeclaration(node: OutlineSyntaxNode, budget: WalkBudget): OutlineSyntaxNode | undefined {
	const declarator = field(node, "declarator", budget);
	if (!declarator) return undefined;
	const functionDecl = declarator.type === "function_declarator" ? declarator : firstDescendant(declarator, (candidate) => candidate.type === "function_declarator", budget);
	if (!functionDecl) return undefined;
	// A pointer-to-function data member is not a method. Ordinary methods have a direct
	// identifier/qualified-identifier path beneath function_declarator.
	const inner = field(functionDecl, "declarator", budget) ?? namedChildren(functionDecl, budget)[0];
	if (!inner || ["parenthesized_declarator", "pointer_declarator", "reference_declarator"].includes(inner.type)) return undefined;
	return functionDecl;
}

interface Container {
	name: string;
	kind: CodeSymbolKind;
	parent: Container | undefined;
	depth: number;
	length: number;
}

function classify(node: OutlineSyntaxNode, containers: Container | undefined, cppTypeContext: boolean, budget: WalkBudget): FoundSymbol | undefined {
	const type = node.type;
	const named = (kind: CodeSymbolKind, pushContainer = true): FoundSymbol | undefined => {
		const name = textName(field(node, "name", budget));
		return name ? { name, kind, pushContainer } : undefined;
	};

	if (type === "method_declaration" && field(node, "receiver", budget)) {
		const name = textName(field(node, "name", budget));
		const containerOverride = goReceiverContainer(node, budget);
		return name ? { name, kind: "method", pushContainer: true, ...(containerOverride ? { containerOverride } : {}) } : undefined;
	}
	if (["function_definition", "function_declaration", "generator_function_declaration", "function_signature", "function_item", "function_signature_item", "local_function_statement"].includes(type)) {
		const declarator = field(node, "declarator", budget);
		if (type === "function_definition" && declarator) {
			const functionDecl = isCppFunctionDeclaration(node, budget);
			const name = cDeclaratorName(functionDecl ?? declarator, budget);
			if (!name.name) return undefined;
			if (name.container) return { name: name.name, kind: "method", pushContainer: true, containerOverride: name.container };
			const enclosing = containers;
			return { name: name.name, kind: enclosing && ["class", "struct", "interface"].includes(enclosing.kind) ? "method" : "function", pushContainer: true };
		}
		const name = textName(field(node, "name", budget));
		if (!name) return undefined;
		const enclosing = containers;
		const kind: CodeSymbolKind = (type === "function_item" || type === "function_definition" || type === "function_declaration") && enclosing && ["class", "struct", "interface"].includes(enclosing.kind) ? "method" : type === "local_function_statement" && enclosing && ["class", "struct"].includes(enclosing.kind) ? "method" : "function";
		return { name, kind, pushContainer: true };
	}

	if (["class_declaration", "class_definition"].includes(type)) return named("class");
	if (type === "class_specifier" && field(node, "body", budget)) return named("class");
	if (["struct_declaration", "struct_item", "record_struct_declaration"].includes(type)) return named("struct");
	if (type === "struct_specifier" && field(node, "body", budget)) return named("struct");
	if (["interface_declaration", "interface_item", "trait_item"].includes(type)) return named("interface");
	if (["type_alias_declaration", "type_item", "delegate_declaration"].includes(type)) return named("type");
	if (["enum_declaration", "enum_item"].includes(type)) return named("enum");
	if (type === "enum_specifier" && field(node, "body", budget)) return named("enum");
	if (["namespace_declaration", "file_scoped_namespace_declaration", "namespace_definition", "internal_module", "module", "mod_item"].includes(type)) return named("namespace");
	if (type === "record_declaration") return named("class");

	if (type === "impl_item") return undefined; // its target is added as a synthetic lexical container during traversal
	if (type === "type_spec") {
		const name = textName(field(node, "name", budget));
		const definition = field(node, "type", budget);
		if (!name || !definition) return undefined;
		const kind = definition.type === "struct_type" ? "struct" : definition.type === "interface_type" ? "interface" : "type";
		return { name, kind, pushContainer: true };
	}
	if (type === "type_definition") {
		const name = cDeclaratorName(field(node, "declarator", budget), budget);
		return name.name ? { name: name.name, kind: "type", pushContainer: true } : undefined;
	}
	if (["method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration"].includes(type)) {
		const name = textName(field(node, "name", budget));
		return name ? { name, kind: "method", pushContainer: true } : undefined;
	}
	if (["method_definition", "method_signature", "method_elem"].includes(type)) {
		const nameNode = field(node, "name", budget);
		const name = nameNode ? literalComputedName(nameNode, budget) : undefined;
		if (!name) return undefined;
		return { name, kind: "method", pushContainer: true };
	}
	if (["field_declaration", "declaration"].includes(type)) {
		if (cppTypeContext) {
			const functionDecl = cppMemberDeclarator(node, budget);
			if (!functionDecl) return undefined;
			const declared = cDeclaratorName(functionDecl, budget);
			return declared.name ? { name: declared.name, kind: "method", pushContainer: true } : undefined;
		}
		if (type === "declaration") {
			const functionDecl = isCppFunctionDeclaration(node, budget);
			if (!functionDecl) return undefined;
			const declared = cDeclaratorName(functionDecl, budget);
			if (!declared.name) return undefined;
			return declared.container
				? { name: declared.name, kind: "method", pushContainer: true, containerOverride: declared.container }
				: { name: declared.name, kind: "function", pushContainer: true };
		}
	}
	if (type === "variable_declarator") {
		const value = field(node, "value", budget) ?? field(node, "init", budget);
		const name = textName(field(node, "name", budget));
		if (!name || !value) return undefined;
		if (["arrow_function", "arrow_function_expression"].includes(value.type)) return { name, kind: "arrow", pushContainer: true };
		if (["class", "class_expression"].includes(value.type)) return { name, kind: "class", pushContainer: true };
		return undefined;
	}
	if (["field_definition", "public_field_definition", "property_declaration"].includes(type)) {
		const value = field(node, "value", budget);
		if (!value || !["arrow_function", "arrow_function_expression"].includes(value.type)) return undefined;
		const key = field(node, "name", budget) ?? field(node, "declarator", budget);
		const name = key ? literalComputedName(key, budget) : undefined;
		return name ? { name, kind: "arrow", pushContainer: false } : undefined;
	}
	return undefined;
}

function hasDefaultToken(node: OutlineSyntaxNode, budget: WalkBudget): boolean {
	budget.spend(node.childCount + 1); // Check before the parser allocates the children array.
	return node.children.some((child) => child?.type === "default");
}

function syntheticDefault(node: OutlineSyntaxNode, budget: WalkBudget): FoundSymbol | undefined {
	if (node.type !== "export_statement" || !hasDefaultToken(node, budget)) return undefined;
	const value = field(node, "value", budget) ?? field(node, "declaration", budget);
	if (!value) return undefined;
	const types: Record<string, CodeSymbolKind> = {
		function_expression: "function", generator_function: "function", class: "class", class_expression: "class",
		arrow_function: "arrow", arrow_function_expression: "arrow",
	};
	const kind = types[value.type];
	if (!kind || field(value, "name", budget)) return undefined;
	return { name: `<default ${kind}>`, kind, pushContainer: false };
}

function inclusiveEndLine(node: OutlineSyntaxNode): number {
	const end = node.endPosition;
	// Tree-sitter's end point is exclusive. A column-zero end is the beginning of the
	// next physical line, so the declaration ends on the preceding row, not the next.
	return end.row + (end.column === 0 ? 0 : 1);
}

function pushContainer(parent: Container | undefined, name: string, kind: CodeSymbolKind): Container {
	const depth = (parent?.depth ?? 0) + 1;
	if (depth > CODE_OUTLINE_MAX_CONTAINER_DEPTH) resourceLimit(`container depth exceeds ${CODE_OUTLINE_MAX_CONTAINER_DEPTH}`);
	return { name, kind, parent, depth, length: name.length + (parent ? parent.length + 1 : 0) };
}

function containerText(container: Container | undefined): string {
	const parts: string[] = [];
	for (let part = container; part; part = part.parent) parts.push(part.name);
	return parts.reverse().join(".");
}

function findSymbols(root: OutlineSyntaxNode, needle: string, limit: number, signal?: AbortSignal): { symbols: CodeSymbol[]; totalMatches: number } {
	const symbols: CodeSymbol[] = [];
	let totalMatches = 0;
	const budget = new WalkBudget(signal);
	const emit = (found: FoundSymbol, node: OutlineSyntaxNode, containers?: Container): void => {
		const containerLength = found.containerOverride?.length ?? containers?.length ?? 0;
		// Charge BEFORE joining ancestry, query folding, or allocating a symbol record.
		budget.chargeMetadata(found.name.length + found.kind.length + containerLength);
		if (!needle && symbols.length >= limit) { totalMatches++; return; }
		const container = found.containerOverride ?? containerText(containers);
		if (needle && !`${found.name} ${found.kind} ${container}`.toLowerCase().includes(needle)) return;
		totalMatches++;
		if (symbols.length < limit) symbols.push({
			name: found.name, kind: found.kind, ...(container ? { container } : {}),
			startLine: node.startPosition.row + 1, endLine: inclusiveEndLine(node),
		});
	};
	type Frame = { nodes: readonly OutlineSyntaxNode[]; index: number; depth: number; containers: Container | undefined; cppTypeContext: boolean };
	// Child-index frames avoid an unbounded pending-frame fan-out. Ancestry is linked,
	// not copied, and its full text is materialized only for declarations after charging.
	const pending: Frame[] = [{ nodes: [root], index: 0, depth: 0, containers: undefined, cppTypeContext: false }];
	while (pending.length > 0) {
		const frame = pending.at(-1)!;
		const node = frame.nodes[frame.index++];
		if (!node) { pending.pop(); continue; }
		budget.visit(node, frame.depth);
		const { containers, cppTypeContext } = frame;
		if (node.isError || node.isMissing) throw new Error("Code outline syntax error: parser returned an ERROR or missing AST node");
		const found = classify(node, containers, cppTypeContext, budget);
		if (found) emit(found, node, containers);
		const synthetic = syntheticDefault(node, budget);
		const syntheticNode = synthetic ? (field(node, "value", budget) ?? field(node, "declaration", budget)) : undefined;
		if (synthetic && syntheticNode) emit(synthetic, syntheticNode);
		let nextContainers = found?.pushContainer ? pushContainer(containers, found.name, found.kind) : containers;
		if (node.type === "impl_item") {
			const target = textName(field(node, "type", budget));
			if (target) {
				budget.chargeMetadata(target.length + "class".length);
				nextContainers = pushContainer(containers, target, "class");
			}
		}
		const nextCppContext = ["function_definition", "function_declaration", "function_declarator", "function_item"].includes(node.type)
			? false
			: cppTypeContext || ["class_specifier", "struct_specifier"].includes(node.type);
		if (node.childCount > 0) budget.depth(frame.depth + 1);
		const children = namedChildren(node, budget, true);
		if (children.length > 0) pending.push({ nodes: children, index: 0, depth: frame.depth + 1, containers: nextContainers, cppTypeContext: nextCppContext });
	}
	return { symbols, totalMatches };
}

export function outlineParsedCode(root: OutlineSyntaxNode, options: ParsedCodeOutlineOptions): CodeOutlineResult {
	const query = options.query ?? "";
	const limit = options.limit ?? CODE_OUTLINE_DEFAULT_LIMIT;
	if (query.length > CODE_OUTLINE_MAX_QUERY_LENGTH) throw new Error("Code outline query must be at most 200 characters");
	if (!Number.isInteger(limit) || limit < 1 || limit > CODE_OUTLINE_MAX_LIMIT) throw new Error("Code outline limit must be an integer from 1 to 200");
	if (options.bytes > CODE_OUTLINE_MAX_INPUT_BYTES) throw new Error("Code outline input exceeds 256 KiB");
	checkAbort(options.signal);
	if (root.hasError) throw new Error("Code outline syntax error: source contains parser errors or missing syntax nodes");
	const needle = query.toLowerCase();
	const { symbols: selected, totalMatches } = findSymbols(root, needle, limit, options.signal);
	checkAbort(options.signal);
	return {
		path: options.filename,
		bytes: options.bytes,
		language: options.language,
		grammar: options.grammar,
		symbols: selected,
		totalMatches,
		returned: selected.length,
		hasMore: totalMatches > selected.length,
		truncated: totalMatches > selected.length,
	};
}
