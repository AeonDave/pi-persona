import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SEARCH_TOOLS = ["grep", "find", "ls"] as const;
const WINDOWS_TOOLS = ["powershell"] as const;
const BASE_DEFAULTS = ["read", "bash", "edit", "write"] as const;

/** Host-native tools that exist in this session and are appropriate for this OS. */
export function nativeToolNames(
	tools: readonly { name: string; sourceInfo: { source: string } }[],
	platform: string,
): string[] {
	const available = new Set(tools.filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name));
	return [...SEARCH_TOOLS, ...(platform === "win32" ? WINDOWS_TOOLS : [])].filter((name) => available.has(name));
}

/** Add native defaults only when the agent definition did not explicitly choose a tool set. */
export function withNativeToolDefaults(tools: readonly string[] | undefined, names: readonly string[]): string[] | undefined {
	if (tools !== undefined || names.length === 0) return tools === undefined ? undefined : [...tools];
	return names.map((name) => `+${name}`);
}

/** A configured defaultTools list is an explicit host choice; only augment Pi's implicit defaults. */
export function nativeToolsForHostDefaults(defaultTools: readonly string[] | undefined, names: readonly string[]): string[] {
	return defaultTools === undefined ? [...names] : [];
}

/** Preserve explicit `--tools -name` removals, which Pi exposes only in the active loadout. */
export function cliRemovedToolNames(argv: readonly string[]): ReadonlySet<string> {
	const removed = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		const list = arg === "--tools" || arg === "-t"
			? argv[++i]
			: arg.startsWith("--tools=")
				? arg.slice("--tools=".length)
				: arg.startsWith("-t=")
					? arg.slice("-t=".length)
					: undefined;
		if (!list) continue;
		for (const rawEntry of list.split(",")) {
			const entry = rawEntry.trim();
			if (entry.startsWith("-") && entry.length > 1 && !entry.startsWith("--")) removed.add(entry.slice(1));
		}
	}
	return removed;
}

/** Enable Pi's own inactive OS/search tools. Pi remains the source of their definitions,
 * execution, renderers, cancellation, output limits, and CLI/exclusion clamps. */
export function activateNativeTools(pi: ExtensionAPI, platform = process.platform): void {
	// Pi 1.5.2 provides both APIs; the runtime guard keeps narrowly mocked extension contexts
	// inert and avoids trying discovery before the extension runner has bound.
	if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function" || typeof pi.getSettings !== "function") return;
	const hostTools = pi.getAllTools();
	const available = nativeToolNames(hostTools, platform);
	const cliRemoved = cliRemovedToolNames(process.argv);
	const names = nativeToolsForHostDefaults(pi.getSettings().defaultTools, available).filter((name) => !cliRemoved.has(name));
	if (names.length === 0) return;
	const active = pi.getActiveTools();
	// Pi does not expose the SDK's `noTools: "builtin"` through ExtensionAPI. With no base
	// default active, preserve the host's intentionally empty built-in loadout instead of
	// turning registered-but-disabled native tools back on.
	if (!BASE_DEFAULTS.some((name) => active.includes(name) && hostTools.some((tool) => tool.name === name && tool.sourceInfo.source === "builtin"))) return;
	if (names.every((name) => active.includes(name))) return;
	pi.setActiveTools([...new Set([...active, ...names])]);
}
