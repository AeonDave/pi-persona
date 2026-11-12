import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language as TreeSitterLanguage, Node, Tree } from "@vscode/tree-sitter-wasm";
import { CODE_OUTLINE_MAX_INPUT_BYTES } from "../core/code-outline.ts";

export interface CodeOutlineGrammar {
	language: string;
	grammar: string;
}

const GRAMMARS_BY_EXTENSION: Readonly<Record<string, CodeOutlineGrammar>> = {
	".js": { language: "JavaScript", grammar: "javascript" },
	".jsx": { language: "JavaScript JSX", grammar: "tsx" },
	".mjs": { language: "JavaScript", grammar: "javascript" },
	".cjs": { language: "JavaScript", grammar: "javascript" },
	".ts": { language: "TypeScript", grammar: "typescript" },
	".mts": { language: "TypeScript", grammar: "typescript" },
	".cts": { language: "TypeScript", grammar: "typescript" },
	".tsx": { language: "TypeScript JSX", grammar: "tsx" },
	".py": { language: "Python", grammar: "python" },
	".pyi": { language: "Python stub", grammar: "python" },
	".go": { language: "Go", grammar: "go" },
	".rs": { language: "Rust", grammar: "rust" },
	".cs": { language: "C#", grammar: "c-sharp" },
	".c": { language: "C-family C syntax", grammar: "cpp" },
	".h": { language: "C-family header (ambiguous)", grammar: "cpp" },
	".cc": { language: "C++", grammar: "cpp" },
	".cpp": { language: "C++", grammar: "cpp" },
	".cxx": { language: "C++", grammar: "cpp" },
	".c++": { language: "C++", grammar: "cpp" },
	".hh": { language: "C++ header", grammar: "cpp" },
	".hpp": { language: "C++ header", grammar: "cpp" },
	".hxx": { language: "C++ header", grammar: "cpp" },
	".h++": { language: "C++ header", grammar: "cpp" },
	".ipp": { language: "C++ header", grammar: "cpp" },
	".inl": { language: "C++ header", grammar: "cpp" },
};

export function selectCodeOutlineGrammar(filename: string): CodeOutlineGrammar {
	const extension = extname(filename).toLowerCase();
	const selected = GRAMMARS_BY_EXTENSION[extension];
	if (!selected) throw new Error(`Unsupported code outline file extension: ${extension || "(none)"}`);
	return selected;
}

function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Code outline cancelled");
}

let runtimePromise: Promise<typeof import("@vscode/tree-sitter-wasm")> | undefined;
type TreeSitterApi = typeof import("@vscode/tree-sitter-wasm");
const languages = new Map<string, Promise<InstanceType<typeof TreeSitterLanguage>>>();

async function loadRuntime(): Promise<TreeSitterApi> {
	if (!runtimePromise) {
		runtimePromise = (async () => {
			const namespace = await import("@vscode/tree-sitter-wasm");
			// The package is CommonJS: its public entry exposes the Web Tree-sitter API on
			// the default object, while its declaration file describes named members.
			const runtime = ((namespace as unknown as { default?: TreeSitterApi }).default ?? namespace) as TreeSitterApi;
			const packageEntry = fileURLToPath(import.meta.resolve("@vscode/tree-sitter-wasm"));
			const wasmDirectory = dirname(packageEntry);
			await runtime.Parser.init({ locateFile: (file) => join(wasmDirectory, file) });
			return runtime;
		})();
	}
	return runtimePromise;
}

async function loadLanguage(grammar: string): Promise<InstanceType<typeof TreeSitterLanguage>> {
	let language = languages.get(grammar);
	if (!language) {
		language = (async () => {
			const runtime = await loadRuntime();
			const packageEntry = fileURLToPath(import.meta.resolve("@vscode/tree-sitter-wasm"));
			return await runtime.Language.load(join(dirname(packageEntry), `tree-sitter-${grammar}.wasm`));
		})();
		languages.set(grammar, language);
	}
	return language;
}

export function withParsedCodeOutline<T>(
	bytes: Uint8Array,
	filename: string,
	signal: AbortSignal | undefined,
	consume: (root: Node, selection: CodeOutlineGrammar, byteLength: number) => T,
): Promise<T> {
	return (async () => {
		if (bytes.byteLength > CODE_OUTLINE_MAX_INPUT_BYTES) throw new Error("Code outline input exceeds 256 KiB");
		checkAbort(signal);
		const selection = selectCodeOutlineGrammar(filename);
		let source: string;
		try {
			source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error("Code outline input is not valid UTF-8");
		}
		checkAbort(signal);
		await loadRuntime();
		checkAbort(signal);
		const language = await loadLanguage(selection.grammar);
		checkAbort(signal);
		const { Parser: TreeSitterParser } = await loadRuntime();
		const parser = new TreeSitterParser();
		let tree: Tree | null = null;
		try {
			parser.setLanguage(language);
			try {
				tree = parser.parse(source);
			} catch (error) {
				throw new Error(`Code outline syntax error: ${error instanceof Error ? error.message : "parse failed"}`);
			}
			if (!tree) throw new Error("Code outline parsing was cancelled or returned no syntax tree");
			checkAbort(signal);
			const result = consume(tree.rootNode, selection, bytes.byteLength);
			checkAbort(signal);
			return result;
		} finally {
			tree?.delete();
			parser.delete();
		}
	})();
}
