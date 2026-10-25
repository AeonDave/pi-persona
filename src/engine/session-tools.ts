/** Preserve absent/default and explicit empty grants when adding runtime-owned custom tools. */
export function mergeSessionToolAllowlist(tools: readonly string[] | undefined, customNames: readonly string[]): string[] | undefined {
	if (tools === undefined) return undefined;
	if (tools.length === 0) return [];
	return [...new Set([...tools, ...customNames])];
}
