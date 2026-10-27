import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PiPersonaConfig } from "../core/config.ts";
import {
	parseSettingInput,
	PERSONA_SETTINGS,
	resolveSettingsValues,
	settingHasEnvironmentOverride,
	type PersonaPreferences,
	type PersonaSetting,
	type SettingId,
} from "../core/settings.ts";
import {
	formatSettingValue,
	PersonaSettingsPanel,
	type SettingsPanelAction,
	type SettingsPanelRow,
} from "../ui/persona-settings.ts";
import { compactInlineText } from "../ui/presentation.ts";
import type { CompanionSettingsSnapshot } from "./companion-settings.ts";

export interface PersonaSettingsDeps {
	file: string;
	activeConfig: PiPersonaConfig;
	read: () => { preferences: PersonaPreferences; lastPersona: string | null };
	write: (patch: {
		preferences?: Partial<Record<SettingId, unknown | null>>;
		lastPersona?: string | null;
	}) => void | Promise<void>;
	env?: Record<string, string | undefined>;
	models: (ctx: ExtensionContext) => Promise<void>;
	diagnostics?: () => string;
	isCurrent?: (ctx: ExtensionContext) => boolean;
	/** Current values supplied only by companions actually loaded in this Pi session. */
	companions?: () => CompanionSettingsSnapshot;
}

interface SettingsSnapshot {
	preferences: PersonaPreferences;
	lastPersona: string | null;
	rows: SettingsPanelRow[];
}

const COMMAND = "persona-settings";

function hasEnvOverride(setting: PersonaSetting, env: Record<string, string | undefined>): boolean {
	return settingHasEnvironmentOverride(setting, env);
}

function safeText(value: string, limit = 320): string {
	return compactInlineText(value, { maxChars: limit });
}

function makeSnapshot(deps: PersonaSettingsDeps): SettingsSnapshot {
	const state = deps.read();
	const env = deps.env ?? process.env;
	const preferences = state.preferences;
	const saved = preferences as Record<string, unknown>;
	const companions = deps.companions?.() ?? {};
	const active = { ...deps.activeConfig, ...companions.mind, ...companions.flow } as unknown as Record<string, unknown>;
	const next = resolveSettingsValues(preferences, env) as unknown as Record<string, unknown>;
	const rows = PERSONA_SETTINGS.filter((setting) => !setting.owner ||
		(companions[setting.owner] !== undefined && Object.hasOwn(companions[setting.owner]!, setting.id))).map((setting): SettingsPanelRow => {
		const hasSavedValue = Object.hasOwn(saved, setting.id);
		const locked = hasEnvOverride(setting, env);
		return {
			id: setting.id,
			group: setting.group,
			label: setting.label,
			description: setting.description,
			kind: setting.kind,
			...(setting.choices ? { choices: setting.choices } : {}),
			activeValue: setting.unavailableReason && Object.hasOwn(setting, "unavailableValue") ? setting.unavailableValue : active[setting.id],
			savedValue: hasSavedValue ? saved[setting.id] : undefined,
			hasSavedValue,
			source: locked ? "environment" : hasSavedValue ? "saved" : "default",
			locked,
			...(setting.unavailableReason ? { unavailableReason: setting.unavailableReason } :
				!equalSettingValues(setting.id, next[setting.id], active[setting.id]) ? { pendingReload: true } : {}),
			applyWhen: setting.applyWhen,
			...(setting.min !== undefined ? { min: setting.min } : {}),
			...(setting.max !== undefined ? { max: setting.max } : {}),
		};
	});
	return { preferences, lastPersona: state.lastPersona, rows };
}

function settingById(id: SettingId): PersonaSetting | undefined {
	return PERSONA_SETTINGS.find((setting) => setting.id === id);
}

function formatSettingsReport(deps: PersonaSettingsDeps, snapshot = makeSnapshot(deps)): string {
	const lines = [
		`Persona settings · ${safeText(deps.file, 500)}`,
		`Remembered persona: ${snapshot.lastPersona ? safeText(snapshot.lastPersona, 160) : "none"}`,
	];
	for (const row of snapshot.rows) {
		const saved = row.hasSavedValue ? formatSettingValue(row.savedValue) : "none";
		const env = row.locked ? ` · locked by ${settingById(row.id)?.env ?? "environment"}` : "";
		const pending = row.unavailableReason ? ` · ${row.unavailableReason}` : row.pendingReload ? " · pending /reload" : "";
		lines.push(
			`${row.id}: active=${formatSettingValue(row.activeValue)}; saved=${saved}; source=${row.source}${pending}; applies=${safeText(row.applyWhen, 120)}${env}`,
		);
	}
	if (deps.diagnostics) {
		try {
			const diagnostic = deps.diagnostics();
			if (diagnostic.trim()) lines.push(`Diagnostics: ${safeText(diagnostic, 1000)}`);
		} catch (error) {
			lines.push(`Diagnostics unavailable: ${errorText(error)}`);
		}
	}
	return lines.join("\n");
}

function safeSettingsReport(deps: PersonaSettingsDeps): string {
	try {
		return formatSettingsReport(deps);
	} catch (error) {
		return `Could not read persona settings: ${errorText(error)}.`;
	}
}

function errorText(error: unknown): string {
	return safeText(error instanceof Error ? error.message : String(error), 240) || "unknown error";
}

function report(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.error(message);
}

function preferencesPatch(id: SettingId, value: unknown | null): Partial<Record<SettingId, unknown | null>> {
	return { [id]: value } as Partial<Record<SettingId, unknown | null>>;
}

function rowValue(row: SettingsPanelRow | undefined): unknown {
	if (!row) return undefined;
	return row.hasSavedValue ? row.savedValue : row.activeValue;
}

function equalValues(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
	}
	return false;
}

function equalSettingValues(id: SettingId, left: unknown, right: unknown): boolean {
	const normalize = (value: unknown): unknown => {
		if ((id === "spine" || id === "spineLegs") && typeof value === "string" && value.trim().toLowerCase() === "off") {
			return "";
		}
		return value;
	};
	return equalValues(normalize(left), normalize(right));
}

function isCancelled(ctx: ExtensionCommandContext): boolean {
	return ctx.signal?.aborted === true;
}

function isCurrent(ctx: ExtensionCommandContext, deps: PersonaSettingsDeps): boolean {
	return !deps.isCurrent || deps.isCurrent(ctx);
}

function reportUnavailable(ctx: ExtensionCommandContext): void {
	if (isCancelled(ctx)) report(ctx, "The settings command was cancelled. No setting was saved.", "warning");
	else report(ctx, "The session changed while the settings panel was open. No setting was saved.", "warning");
}

function statusForValue(row: SettingsPanelRow): string {
	if (row.unavailableReason) return row.unavailableReason;
	if (row.locked) {
		const locked = `Environment ${settingById(row.id)?.env ?? "override"} is active and locked.`;
		return row.pendingReload ? `${locked} The running value differs; use /reload to load it (${row.applyWhen}).` : locked;
	}
	if (row.pendingReload) {
		return `Saved value differs from the running value; use /reload to load it (${row.applyWhen}).`;
	}
	return `Changes apply ${row.applyWhen}.`;
}

async function writePreference(
	ctx: ExtensionCommandContext,
	deps: PersonaSettingsDeps,
	id: SettingId,
	value: unknown | null,
): Promise<boolean> {
	if (isCancelled(ctx) || !isCurrent(ctx, deps)) {
		reportUnavailable(ctx);
		return false;
	}
	try {
		await deps.write({ preferences: preferencesPatch(id, value) });
		return true;
	} catch (error) {
		report(ctx, `Could not confirm save for ${id}: ${errorText(error)}. Reopen /persona-settings to verify the stored value.`, "error");
		return false;
	}
}

function activeEnvironmentValue(setting: PersonaSetting, deps: PersonaSettingsDeps): boolean {
	return hasEnvOverride(setting, deps.env ?? process.env);
}

async function promptValue(
	ctx: ExtensionCommandContext,
	setting: PersonaSetting,
	currentValue: unknown,
): Promise<unknown | undefined> {
	if (setting.kind === "boolean") {
		const selected = await ctx.ui.select(`Edit ${setting.label}`, ["On", "Off"]);
		if (selected === undefined) return undefined;
		if (selected === "On") return true;
		if (selected === "Off") return false;
		throw new Error(`unexpected choice for ${setting.label}`);
	}
	if (setting.kind === "choice") {
		const choices = setting.choices ?? [];
		const selected = await ctx.ui.select(`Edit ${setting.label} · current ${formatSettingValue(currentValue)}`, [...choices]);
		if (selected === undefined) return undefined;
		return parseSettingInput(setting, selected);
	}
	const placeholder = setting.kind === "string-list"
		? "JSON array or one path per line; commas and semicolons stay literal"
		: setting.kind === "number"
			? "Enter a whole number"
			: "Enter a value";
	const current = setting.kind === "string-list" && Array.isArray(currentValue)
		? JSON.stringify(currentValue)
		: formatSettingValue(currentValue);
	const entered = await ctx.ui.input(`Edit ${setting.label} · current ${current}`, placeholder);
	if (entered === undefined) return undefined;
	return parseSettingInput(setting, entered);
}

async function resetPreference(
	ctx: ExtensionCommandContext,
	deps: PersonaSettingsDeps,
	row: SettingsPanelRow,
): Promise<string> {
	if (!row.hasSavedValue) {
		return row.locked
			? `No saved override exists. ${settingById(row.id)?.env ?? "Environment"} still controls this value.`
			: "No saved override exists; the setting already uses its default source.";
	}
	if (!(await writePreference(ctx, deps, row.id, null))) return "The saved override could not be confirmed; reopen settings to verify.";
	const updated = makeSnapshot(deps).rows.find((candidate) => candidate.id === row.id) ?? row;
	if (updated.unavailableReason) return `Saved override removed. ${updated.unavailableReason}`;
	if (updated.locked) {
		return updated.pendingReload
			? `Saved override removed. ${settingById(row.id)?.env ?? "Environment"} still controls the next value; the running value differs, so use /reload to load it.`
			: `Saved override removed. ${settingById(row.id)?.env ?? "Environment"} still controls the active value.`;
	}
	return updated.pendingReload
		? `Saved override removed. The next-session default differs from the running value; use /reload to load it.`
		: `Saved override removed. The active value already matches its default ${updated.applyWhen}.`;
}

async function applySettingAction(
	ctx: ExtensionCommandContext,
	deps: PersonaSettingsDeps,
	row: SettingsPanelRow,
	action: "edit" | "reset",
): Promise<string | undefined> {
	const setting = settingById(row.id);
	if (!setting) return "The selected setting is no longer in the registry.";
	if (action === "reset") return resetPreference(ctx, deps, row);
	if (setting.unavailableReason) return `Cannot edit this setting. ${setting.unavailableReason}`;
	if (activeEnvironmentValue(setting, deps)) return `Cannot edit this setting while ${setting.env ?? "an environment override"} is set.`;
	let value: unknown | undefined;
	try {
		value = await promptValue(ctx, setting, rowValue(row));
	} catch (error) {
		return `Invalid ${setting.label}: ${errorText(error)}. The saved value was not changed.`;
	}
	if (value === undefined) return undefined;
	if (!(await writePreference(ctx, deps, row.id, value))) return "The save could not be confirmed. Reopen settings to verify the stored value.";
	const updated = makeSnapshot(deps).rows.find((candidate) => candidate.id === row.id);
	const pending = updated?.pendingReload ?? !equalSettingValues(row.id, value, row.activeValue);
	return `Saved ${setting.label}. The running value remains ${formatSettingValue(row.activeValue)}; it applies ${setting.applyWhen}${pending ? "; use Pi's /reload or restart to load the saved preference" : ""}.`;
}

async function runTui(ctx: ExtensionCommandContext, deps: PersonaSettingsDeps): Promise<void> {
	let initialQuery = "";
	let selectedId: SettingId | undefined;
	let notice: string | undefined;
	for (;;) {
		if (isCancelled(ctx) || !isCurrent(ctx, deps)) {
			reportUnavailable(ctx);
			return;
		}
		let snapshot: SettingsSnapshot;
		try {
			snapshot = makeSnapshot(deps);
		} catch (error) {
			report(ctx, `Could not read persona settings: ${errorText(error)}.`, "error");
			return;
		}
		let panel: PersonaSettingsPanel | undefined;
		const action = await ctx.ui.custom<SettingsPanelAction>((tui, theme, keybindings, done) => {
			panel = new PersonaSettingsPanel(tui, theme, keybindings, {
				file: deps.file,
				lastPersona: snapshot.lastPersona,
				rows: snapshot.rows,
				...(notice ? { notice } : {}),
				initialQuery,
				...(selectedId ? { initialSelectedId: selectedId } : {}),
			}, done);
			return panel;
		});
		const view = panel?.viewState;
		initialQuery = view?.query ?? initialQuery;
		selectedId = view?.selectedId ?? selectedId;
		notice = undefined;
		if (isCancelled(ctx) || !isCurrent(ctx, deps)) {
			reportUnavailable(ctx);
			return;
		}
		if (!action || action.type === "close") return;
		if (action.type === "models") {
			await deps.models(ctx);
			notice = "Model assignments were handled by the existing Models selector.";
			continue;
		}
		if (action.type === "diagnostics") {
			try {
				report(ctx, deps.diagnostics?.() || "No diagnostics are available.");
			} catch (error) {
				report(ctx, `Diagnostics unavailable: ${errorText(error)}`, "error");
			}
			continue;
		}
		const row = snapshot.rows.find((candidate) => candidate.id === action.id);
		if (!row) {
			notice = "That setting is no longer available.";
			continue;
		}
		notice = await applySettingAction(ctx, deps, row, action.type);
		if (isCancelled(ctx) || !isCurrent(ctx, deps)) {
			if (!notice?.startsWith("The save could not be confirmed") && !notice?.startsWith("The saved override could not be confirmed")) reportUnavailable(ctx);
			return;
		}
		if (notice && !notice.startsWith("Saved ") && !notice.startsWith("The save could not be confirmed")) {
			// Errors and locks are also visible in the panel; command-level notifications make them
			// available to hosts that do not preserve a dismissed custom component.
			if (notice.startsWith("Invalid ") || notice.startsWith("Cannot ") || notice.startsWith("The saved override could not")) {
				report(ctx, notice, "warning");
			}
		}
	}
}

function rpcOption(row: SettingsPanelRow): string {
	return `${row.label} [${row.id}] · ${formatSettingValue(row.activeValue)}`;
}

async function runRpc(ctx: ExtensionCommandContext, deps: PersonaSettingsDeps): Promise<void> {
	let query = "";
	for (;;) {
		if (isCancelled(ctx) || !isCurrent(ctx, deps)) {
			reportUnavailable(ctx);
			return;
		}
		let snapshot: SettingsSnapshot;
		try {
			snapshot = makeSnapshot(deps);
		} catch (error) {
			report(ctx, `Could not read persona settings: ${errorText(error)}.`, "error");
			return;
		}
		const visibleRows = query
			? snapshot.rows.filter((row) => `${row.id} ${row.group} ${row.label} ${row.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
			: snapshot.rows;
		const settings = visibleRows.map(rpcOption);
		const mainOptions = [...settings, "Search settings", "Models", "Diagnostics", "Close"];
		const chosen = await ctx.ui.select(`Persona settings${query ? ` · filter ${query}` : ""}`, mainOptions);
		if (isCancelled(ctx) || !isCurrent(ctx, deps)) {
			reportUnavailable(ctx);
			return;
		}
		if (chosen === undefined || chosen === "Close") return;
		if (chosen === "Search settings") {
			const next = await ctx.ui.input("Filter settings by name or description", query || "clear to show all settings");
			if (isCancelled(ctx) || !isCurrent(ctx, deps)) {
				reportUnavailable(ctx);
				return;
			}
			if (next !== undefined) query = next.trim();
			continue;
		}
		if (chosen === "Models") {
			await deps.models(ctx);
			continue;
		}
		if (chosen === "Diagnostics") {
			try {
				report(ctx, deps.diagnostics?.() || "No diagnostics are available.");
			} catch (error) {
				report(ctx, `Diagnostics unavailable: ${errorText(error)}`, "error");
			}
			continue;
		}
		const row = visibleRows.find((candidate) => rpcOption(candidate) === chosen);
		if (!row) continue;
		const action = await ctx.ui.select(`${row.label} · ${statusForValue(row)}`, ["Edit", "Reset saved override", "Details", "Back"]);
		if (isCancelled(ctx) || !isCurrent(ctx, deps)) {
			reportUnavailable(ctx);
			return;
		}
		if (action === undefined || action === "Back") continue;
		if (action === "Details") {
			report(ctx, `${row.label}\n${row.description}\nActive now: ${formatSettingValue(row.activeValue)}\nSaved override: ${row.hasSavedValue ? formatSettingValue(row.savedValue) : "none"}\nSource: ${row.locked ? "environment · locked" : row.source}\nStatus: ${statusForValue(row)}\nApplies: ${row.applyWhen}`);
			continue;
		}
		const result = await applySettingAction(ctx, deps, row, action === "Edit" ? "edit" : "reset");
		if (isCancelled(ctx) || !isCurrent(ctx, deps)) {
			if (!result?.startsWith("The save could not be confirmed") && !result?.startsWith("The saved override could not be confirmed")) reportUnavailable(ctx);
			return;
		}
		if (result && !result.startsWith("The save could not be confirmed") && !result.startsWith("The saved override could not be confirmed")) {
			report(ctx, result, result.startsWith("Invalid ") || result.startsWith("Cannot ") ? "warning" : "info");
		}
	}
}

function formatShowMode(ctx: ExtensionCommandContext, deps: PersonaSettingsDeps): void {
	const status = safeSettingsReport(deps);
	report(ctx, status, status.startsWith("Could not read ") ? "error" : "info");
}

/** Register the separate, registry-driven Persona settings command. */
export function registerPersonaSettings(pi: ExtensionAPI, deps: PersonaSettingsDeps): void {
	pi.registerCommand(COMMAND, {
		description: "Open pi-persona's settings panel; use /persona-settings show for a read-only report",
		handler: async (args, ctx) => {
			const initialSessionId = ctx.sessionManager.getSessionId();
			const commandDeps: PersonaSettingsDeps = {
				...deps,
				isCurrent: (currentCtx) =>
					currentCtx.sessionManager.getSessionId() === initialSessionId &&
					(!deps.isCurrent || deps.isCurrent(currentCtx)),
			};
			const command = args.trim();
			if (command === "show") {
				formatShowMode(ctx, commandDeps);
				return;
			}
			if (command !== "") {
				report(ctx, "Usage: /persona-settings [show]", "warning");
				return;
			}
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
				report(ctx, `Persona settings are read-only in ${ctx.mode} mode. Run /persona-settings in the TUI or RPC UI to edit them.\n\n${safeSettingsReport(commandDeps)}`, "warning");
				return;
			}
			if (ctx.mode === "tui") await runTui(ctx, commandDeps);
			else await runRpc(ctx, commandDeps);
		},
	});
}
