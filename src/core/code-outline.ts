export const CODE_OUTLINE_MAX_INPUT_BYTES = 256 * 1024;
export const CODE_OUTLINE_MAX_OUTPUT_BYTES = 16 * 1024;
export const CODE_OUTLINE_DEFAULT_LIMIT = 80;
export const CODE_OUTLINE_MAX_LIMIT = 200;
export const CODE_OUTLINE_MAX_QUERY_LENGTH = 200;

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

function field(node: OutlineSyntaxNode, name: string): OutlineSyntaxNode | undefined {
	return node.childForFieldName(name) ?? undefined;
}

function namedChildren(node: OutlineSyntaxNode): OutlineSyntaxNode[] {
	return node.namedChildren.filter((child): child is OutlineSyntaxNode => child !== null);
}

function textName(node: OutlineSyntaxNode | undefined): string | undefined {
	const name = node?.text.trim();
	return name ? name : undefined;
}

function decodeQuotedName(text: string): string {
	const body = text.slice(1, -1);
	return body.replace(/\\([\\'"`])/g, "$1");
}

function literalComputedName(node: OutlineSyntaxNode): string | undefined {
	if (node.type !== "computed_property_name") return textName(node);
	const child = namedChildren(node)[0];
	if (!child) return undefined;
	if (["string", "string_literal"].includes(child.type) && child.text.length >= 2) return decodeQuotedName(child.text);
	if (["number", "number_literal", "numeric_literal"].includes(child.type)) return child.text.replaceAll("_", "");
	return undefined;
}

function identifierName(node: OutlineSyntaxNode | undefined): string | undefined {
	if (!node) return undefined;
	if (["identifier", "property_identifier", "private_property_identifier", "type_identifier", "field_identifier", "namespace_identifier", "operator_name"].includes(node.type)) return textName(node);
	if (node.type === "qualified_identifier") {
		return identifierName(field(node, "name") ?? namedChildren(node).at(-1));
	}
	if (["pointer_declarator", "reference_declarator", "parenthesized_declarator", "function_declarator", "array_declarator", "abstract_function_declarator", "abstract_pointer_declarator"].includes(node.type)) {
		return identifierName(field(node, "declarator") ?? namedChildren(node)[0]);
	}
	return undefined;
}

function qualifiedContainer(node: OutlineSyntaxNode | undefined): string | undefined {
	if (node?.type !== "qualified_identifier") return undefined;
	const scope = textName(field(node, "scope"));
	return scope?.replaceAll("::", ".");
}

function goReceiverContainer(node: OutlineSyntaxNode): string | undefined {
	const receiver = field(node, "receiver");
	if (!receiver) return undefined;
	const parameter = receiver.type === "parameter_declaration" ? receiver : namedChildren(receiver).find((child) => child.type === "parameter_declaration");
	const type = field(parameter ?? receiver, "type");
	if (!type) return undefined;
	const receiverBaseType = (current: OutlineSyntaxNode): string | undefined => {
		if (current.type === "type_identifier") return textName(current);
		if (current.type === "generic_type") return textName(field(current, "type"));
		for (const child of namedChildren(current)) {
			const found = receiverBaseType(child);
			if (found) return found;
		}
		return undefined;
	};
	return receiverBaseType(type);
}

function cDeclaratorName(node: OutlineSyntaxNode | undefined): { name?: string; container?: string } {
	if (!node) return {};
	if (node.type === "qualified_identifier") {
		const name = identifierName(field(node, "name") ?? namedChildren(node).at(-1));
		const container = qualifiedContainer(node);
		return { ...(name ? { name } : {}), ...(container ? { container } : {}) };
	}
	if (node.type === "function_declarator") return cDeclaratorName(field(node, "declarator") ?? namedChildren(node)[0]);
	if (["pointer_declarator", "reference_declarator", "parenthesized_declarator", "array_declarator"].includes(node.type)) {
		return cDeclaratorName(field(node, "declarator") ?? namedChildren(node)[0]);
	}
	const name = identifierName(node);
	return name ? { name } : {};
}

function firstDescendant(node: OutlineSyntaxNode, predicate: (candidate: OutlineSyntaxNode) => boolean): OutlineSyntaxNode | undefined {
	const pending = [...namedChildren(node)].reverse();
	while (pending.length > 0) {
		const candidate = pending.pop()!;
		if (predicate(candidate)) return candidate;
		pending.push(...namedChildren(candidate).reverse());
	}
	return undefined;
}

function cppMemberDeclarator(node: OutlineSyntaxNode): OutlineSyntaxNode | undefined {
	const declarator = field(node, "declarator");
	if (!declarator) return undefined;
	const functionDecl = declarator.type === "function_declarator" ? declarator : firstDescendant(declarator, (candidate) => candidate.type === "function_declarator");
	if (!functionDecl) return undefined;
	// A pointer-to-function data member is not a method. Ordinary methods have a direct
	// identifier/qualified-identifier path beneath function_declarator.
	const inner = field(functionDecl, "declarator") ?? namedChildren(functionDecl)[0];
	if (!inner || ["parenthesized_declarator", "pointer_declarator", "reference_declarator"].includes(inner.type)) return undefined;
	return functionDecl;
}

function isCppFunctionDeclaration(node: OutlineSyntaxNode): OutlineSyntaxNode | undefined {
	const declarator = field(node, "declarator");
	if (!declarator) return undefined;
	const functionDecl = declarator.type === "function_declarator" ? declarator : firstDescendant(declarator, (candidate) => candidate.type === "function_declarator");
	if (!functionDecl) return undefined;
	const inner = field(functionDecl, "declarator") ?? namedChildren(functionDecl)[0];
	if (!inner || ["parenthesized_declarator", "pointer_declarator", "reference_declarator"].includes(inner.type)) return undefined;
	return functionDecl;
}

function classify(node: OutlineSyntaxNode, containers: readonly { name: string; kind: CodeSymbolKind }[], cppTypeContext: boolean): FoundSymbol | undefined {
	const type = node.type;
	const named = (kind: CodeSymbolKind, pushContainer = true): FoundSymbol | undefined => {
		const name = textName(field(node, "name"));
		return name ? { name, kind, pushContainer } : undefined;
	};

	if (type === "method_declaration" && field(node, "receiver")) {
		const name = textName(field(node, "name"));
		const containerOverride = goReceiverContainer(node);
		return name ? { name, kind: "method", pushContainer: true, ...(containerOverride ? { containerOverride } : {}) } : undefined;
	}
	if (["function_definition", "function_declaration", "generator_function_declaration", "function_signature", "function_item", "function_signature_item", "local_function_statement"].includes(type)) {
		const declarator = field(node, "declarator");
		if (type === "function_definition" && declarator) {
			const functionDecl = isCppFunctionDeclaration(node);
			const name = cDeclaratorName(functionDecl ?? declarator);
			if (!name.name) return undefined;
			if (name.container) return { name: name.name, kind: "method", pushContainer: true, containerOverride: name.container };
			const enclosing = containers.at(-1);
			return { name: name.name, kind: enclosing && ["class", "struct", "interface"].includes(enclosing.kind) ? "method" : "function", pushContainer: true };
		}
		const name = textName(field(node, "name"));
		if (!name) return undefined;
		const enclosing = containers.at(-1);
		const kind: CodeSymbolKind = (type === "function_item" || type === "function_definition" || type === "function_declaration") && enclosing && ["class", "struct", "interface"].includes(enclosing.kind) ? "method" : type === "local_function_statement" && enclosing && ["class", "struct"].includes(enclosing.kind) ? "method" : "function";
		return { name, kind, pushContainer: true };
	}

	if (["class_declaration", "class_definition"].includes(type)) return named("class");
	if (type === "class_specifier" && field(node, "body")) return named("class");
	if (["struct_declaration", "struct_item", "record_struct_declaration"].includes(type)) return named("struct");
	if (type === "struct_specifier" && field(node, "body")) return named("struct");
	if (["interface_declaration", "interface_item", "trait_item"].includes(type)) return named("interface");
	if (["type_alias_declaration", "type_item", "delegate_declaration"].includes(type)) return named("type");
	if (["enum_declaration", "enum_item"].includes(type)) return named("enum");
	if (type === "enum_specifier" && field(node, "body")) return named("enum");
	if (["namespace_declaration", "file_scoped_namespace_declaration", "namespace_definition", "internal_module", "module", "mod_item"].includes(type)) return named("namespace");
	if (type === "record_declaration") return named("class");

	if (type === "impl_item") return undefined; // its target is added as a synthetic lexical container during traversal
	if (type === "type_spec") {
		const name = textName(field(node, "name"));
		const definition = field(node, "type");
		if (!name || !definition) return undefined;
		const kind = definition.type === "struct_type" ? "struct" : definition.type === "interface_type" ? "interface" : "type";
		return { name, kind, pushContainer: true };
	}
	if (type === "type_definition") {
		const name = cDeclaratorName(field(node, "declarator"));
		return name.name ? { name: name.name, kind: "type", pushContainer: true } : undefined;
	}
	if (["method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration"].includes(type)) {
		const name = textName(field(node, "name"));
		return name ? { name, kind: "method", pushContainer: true } : undefined;
	}
	if (["method_definition", "method_signature", "method_elem"].includes(type)) {
		const nameNode = field(node, "name");
		const name = nameNode ? literalComputedName(nameNode) : undefined;
		if (!name) return undefined;
		return { name, kind: "method", pushContainer: true };
	}
	if (["field_declaration", "declaration"].includes(type)) {
		if (cppTypeContext) {
			const functionDecl = cppMemberDeclarator(node);
			if (!functionDecl) return undefined;
			const declared = cDeclaratorName(functionDecl);
			return declared.name ? { name: declared.name, kind: "method", pushContainer: true } : undefined;
		}
		if (type === "declaration") {
			const functionDecl = isCppFunctionDeclaration(node);
			if (!functionDecl) return undefined;
			const declared = cDeclaratorName(functionDecl);
			if (!declared.name) return undefined;
			return declared.container
				? { name: declared.name, kind: "method", pushContainer: true, containerOverride: declared.container }
				: { name: declared.name, kind: "function", pushContainer: true };
		}
	}
	if (type === "variable_declarator") {
		const value = field(node, "value") ?? field(node, "init");
		const name = textName(field(node, "name"));
		if (!name || !value) return undefined;
		if (["arrow_function", "arrow_function_expression"].includes(value.type)) return { name, kind: "arrow", pushContainer: true };
		if (["class", "class_expression"].includes(value.type)) return { name, kind: "class", pushContainer: true };
		return undefined;
	}
	if (["field_definition", "public_field_definition", "property_declaration"].includes(type)) {
		const value = field(node, "value");
		if (!value || !["arrow_function", "arrow_function_expression"].includes(value.type)) return undefined;
		const key = field(node, "name") ?? field(node, "declarator");
		const name = key ? literalComputedName(key) : undefined;
		return name ? { name, kind: "arrow", pushContainer: false } : undefined;
	}
	return undefined;
}

function hasDefaultToken(node: OutlineSyntaxNode): boolean {
	return node.children.some((child) => child?.type === "default");
}

function syntheticDefault(node: OutlineSyntaxNode): FoundSymbol | undefined {
	if (node.type !== "export_statement" || !hasDefaultToken(node)) return undefined;
	const value = field(node, "value") ?? field(node, "declaration");
	if (!value) return undefined;
	const types: Record<string, CodeSymbolKind> = {
		function_expression: "function", generator_function: "function", class: "class", class_expression: "class",
		arrow_function: "arrow", arrow_function_expression: "arrow",
	};
	const kind = types[value.type];
	if (!kind || field(value, "name")) return undefined;
	return { name: `<default ${kind}>`, kind, pushContainer: false };
}

function inclusiveEndLine(node: OutlineSyntaxNode): number {
	const end = node.endPosition;
	// Tree-sitter's end point is exclusive. A column-zero end is the beginning of the
	// next physical line, so the declaration ends on the preceding row, not the next.
	return end.row + (end.column === 0 ? 0 : 1);
}

function findSymbols(root: OutlineSyntaxNode, signal?: AbortSignal): CodeSymbol[] {
	const symbols: CodeSymbol[] = [];
	type Frame = { node: OutlineSyntaxNode; containers: readonly { name: string; kind: CodeSymbolKind }[]; cppTypeContext: boolean };
	const pending: Frame[] = [{ node: root, containers: [], cppTypeContext: false }];
	let count = 0;
	while (pending.length > 0) {
		if ((count++ & 0x3ff) === 0) checkAbort(signal);
		const { node, containers, cppTypeContext } = pending.pop()!;
		if (node.isError || node.isMissing) throw new Error("Code outline syntax error: parser returned an ERROR or missing AST node");
		const found = classify(node, containers, cppTypeContext);
		const override = found?.containerOverride;
		const parentContainer = override ?? containers.map((part) => part.name).join(".");
		if (found && node.startPosition && node.endPosition) {
			symbols.push({
				name: found.name,
				kind: found.kind,
				...(parentContainer ? { container: parentContainer } : {}),
				startLine: node.startPosition.row + 1,
				endLine: inclusiveEndLine(node),
			});
		}
		const synthetic = syntheticDefault(node);
		const syntheticNode = synthetic ? (field(node, "value") ?? field(node, "declaration")) : undefined;
		if (synthetic && syntheticNode) {
			symbols.push({ name: synthetic.name, kind: synthetic.kind, startLine: syntheticNode.startPosition.row + 1, endLine: inclusiveEndLine(syntheticNode) });
		}
		let nextContainers = found?.pushContainer ? [...containers, { name: found.name, kind: found.kind }] : containers;
		if (node.type === "impl_item") {
			const target = textName(field(node, "type"));
			if (target) nextContainers = [...containers, { name: target, kind: "class" }];
		}
		const nextCppContext = ["function_definition", "function_declaration", "function_declarator", "function_item"].includes(node.type)
			? false
			: cppTypeContext || ["class_specifier", "struct_specifier"].includes(node.type);
		const children = namedChildren(node);
		for (let index = children.length - 1; index >= 0; index--) {
			const child = children[index];
			if (child) pending.push({ node: child, containers: nextContainers, cppTypeContext: nextCppContext });
		}
	}
	return symbols;
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
	const all = findSymbols(root, options.signal).filter((symbol) =>
		!needle || `${symbol.name} ${symbol.kind} ${symbol.container ?? ""}`.toLowerCase().includes(needle));
	checkAbort(options.signal);
	const selected = all.slice(0, limit);
	return {
		path: options.filename,
		bytes: options.bytes,
		language: options.language,
		grammar: options.grammar,
		symbols: selected,
		totalMatches: all.length,
		returned: selected.length,
		hasMore: all.length > selected.length,
		truncated: all.length > selected.length,
	};
}
