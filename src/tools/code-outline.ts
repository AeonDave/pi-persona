import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fenceUntrusted } from "../core/fence.ts";
import { CODE_OUTLINE_MAX_INPUT_BYTES, CODE_OUTLINE_MAX_OUTPUT_BYTES, outlineParsedCode } from "../core/code-outline.ts";
import { readBoundedRegularFile } from "../io/read-bounded-file.ts";
import { renderOutlineCall, renderOutlineResult } from "../ui/code-outline.ts";

const parameters = Type.Object({
	path: Type.String({ description: "One local JavaScript, TypeScript, Python, Go, Rust, C-family, C# source file; absolute or relative to the current project cwd" }),
	query: Type.Optional(Type.String({ description: "Optional literal, case-insensitive substring of a symbol name, kind, or container" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum symbol rows (default 80)" })),
});

type AuthorizationCheck = () => boolean | Promise<boolean>;

export interface CodeOutlineToolOptions {
	/** Call-time gate supplied by the eventual integration; this module defines no permission policy. */
	authorize?: AuthorizationCheck;
}
export interface CodeOutlineToolDetails {
	symbols: Array<{ name: string; kind: string; container?: string; startLine: number; endLine: number }>;
	totalMatches: number;
	returned: number;
	hasMore: boolean;
	truncated: boolean;
	language: string;
	grammar: string;
	sha256: string;
}

export function makeCodeOutlineTool(options: CodeOutlineToolOptions = {}): ToolDefinition<typeof parameters, CodeOutlineToolDetails> {
	return {
		name: "code_outline",
		label: "Code outline",
		description: "Read one JavaScript, TypeScript, Python, Go, Rust, C-family, or C# source file and return a compact syntax-AST symbol outline. C-family files use the C++ grammar, so C is not compiler-validated. Structural/work/metadata limits reject overly complex files: use a smaller or less deeply nested source file; query/limit do not bypass these limits. Does not dump source or prove runtime behavior.",
		promptSnippet: "Inspect declarations in one supported source file with code_outline",
		parameters,
		renderShell: "self",
		renderCall: renderOutlineCall,
		renderResult: renderOutlineResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (options.authorize && !(await options.authorize())) throw new Error("code_outline is not authorized in this context");
			const target = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
			const bytes = await readBoundedRegularFile(target, { label: "Code outline", maxBytes: CODE_OUTLINE_MAX_INPUT_BYTES, limitLabel: "256 KiB" }, signal);
			if (signal?.aborted) throw new Error("Code outline cancelled");
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const { withParsedCodeOutline } = await import("./code-outline-parser.ts");
			const result = await withParsedCodeOutline(bytes, target, signal, (root, selection, byteLength) => outlineParsedCode(root, {
				filename: target,
				bytes: byteLength,
				language: selection.language,
				grammar: selection.grammar,
				...(params.query === undefined ? {} : { query: params.query }),
				...(params.limit === undefined ? {} : { limit: params.limit }),
				...(signal === undefined ? {} : { signal }),
			}));
			result.path = target;
			const rows = result.symbols.map((symbol) => ({
				text: `${JSON.stringify(symbol.name)} [${symbol.kind}]${symbol.container === undefined ? "" : ` in ${JSON.stringify(symbol.container)}`} L${symbol.startLine}-${symbol.endLine}`,
				value: {
					name: symbol.name,
					kind: symbol.kind,
					...(symbol.container === undefined ? {} : { container: symbol.container }),
					startLine: symbol.startLine,
					endLine: symbol.endLine,
				},
			}));
			const visible: typeof rows = [];
			const header = (count: number, more: boolean) => `${JSON.stringify(result.path)} · ${result.bytes} bytes · language=${JSON.stringify(result.language)} grammar=${JSON.stringify(result.grammar)} · SHA-256 ${sha256} (computed from bytes read; no external match asserted)\n${result.totalMatches} matching symbols; returned ${count}; hasMore=${more}; truncated=${more}`;
			const render = (items: typeof rows, more: boolean) => fenceUntrusted([header(items.length, more), ...items.map((row) => row.text)].join("\n"));
			for (const row of rows) {
				const candidate = [...visible, row];
				const more = result.hasMore || candidate.length < rows.length;
				if (Buffer.byteLength(render(candidate, more), "utf8") > CODE_OUTLINE_MAX_OUTPUT_BYTES) break;
				visible.push(row);
			}
			const outputTruncated = visible.length < rows.length;
			const text = render(visible, result.hasMore || outputTruncated);
			if (signal?.aborted) throw new Error("Code outline cancelled");
			return {
				content: [{ type: "text", text }],
				details: {
					symbols: visible.map((row) => row.value),
					totalMatches: result.totalMatches,
					returned: visible.length,
					hasMore: result.hasMore || outputTruncated,
					truncated: result.truncated || outputTruncated,
					language: result.language,
					grammar: result.grammar,
					sha256,
				},
			};
		},
	};
}
