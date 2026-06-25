/**
 * Resource discovery precedence/shadowing — the pure merge logic.
 *
 * Pure module. Filesystem listing lives in a thin adapter; this resolves the
 * precedence (builtin < user < project, later wins) and records every shadowed
 * loser so `/doctor` can explain exactly which file won and what it hid.
 */

export interface DiscoveredFile {
	name: string;
	path: string;
	scope: string;
}

export interface MergeResult {
	resolved: DiscoveredFile[];
	/** Files that were overridden by a higher-precedence same-named file. */
	shadowed: DiscoveredFile[];
}

/** Merge discovery layers given in increasing precedence order (later wins). */
export function mergeByPrecedence(layers: DiscoveredFile[][]): MergeResult {
	const winner = new Map<string, DiscoveredFile>();
	const shadowed: DiscoveredFile[] = [];
	for (const layer of layers) {
		for (const file of layer) {
			const prev = winner.get(file.name);
			if (prev) shadowed.push(prev);
			winner.set(file.name, file);
		}
	}
	return { resolved: [...winner.values()], shadowed };
}
