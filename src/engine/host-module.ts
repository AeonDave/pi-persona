/** A missing hashed chunk in Pi's own bundle is a local host problem, not a provider outage.
 * Pure and deliberately narrow: ordinary missing packages or a worker's own imports get no hint. */
export function piHostModuleHint(error: string): string | undefined {
	const normalized = error.replaceAll("\\", "/");
	const match = /Cannot find module (["'])([^"'\r\n]+\/@earendil-works\/pi-coding-agent\/dist\/bundle\/chunks\/[A-Za-z0-9_-]+-[A-Z0-9]{8}\.js)\1 imported from ([^\r\n]+)/.exec(normalized);
	const missing = match?.[2];
	const importer = match?.[3]?.trim();
	if (!missing || !importer) return undefined;
	const directory = missing.slice(0, missing.lastIndexOf("/") + 1);
	if (!importer.startsWith(directory) || !/^[^/]+\.js$/.test(importer.slice(directory.length))) return undefined;
	return "A local Pi host bundle module could not load; the host may have been updated in place while this session was running. Retry in a fresh Pi process with the same provider/model; only if the fresh process also fails, repair the Pi installation. Switching provider/model does not repair a missing local module.";
}
