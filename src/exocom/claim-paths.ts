/** Exocom peers share one host, so two spellings that the host filesystem treats as one file must
 *  conflict. `core/ownership` folds case only for Windows-syntax paths because delegate plans may
 *  cross machines; exocom comparisons additionally fold on the default case-insensitive hosts.
 *  Only comparison inputs are folded: stored and displayed paths keep their original spelling. */
export function foldsClaimPathCase(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" || platform === "darwin";
}

export function comparableClaimPath(path: string, fold: boolean): string {
	return fold ? path.toLowerCase() : path;
}
