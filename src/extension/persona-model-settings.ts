/**
 * Interactive editor for per-persona model assignments. This module owns only the settings flow;
 * the extension supplies discovery, the existing participant resolver, and the canonical store.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelsRefreshResult } from "@earendil-works/pi-ai";

import type { ModelParticipant } from "../persona/model-participants.ts";
import { compactInlineText } from "../ui/presentation.ts";
import { ModelPicker, orderModelRefs, type ModelPickerMetadata } from "../ui/model-picker.ts";

export interface PersonaModelOwner {
	name: string;
	label: string;
}

export interface PersonaModelProfile {
	name: string;
	label: string;
}

export interface PersonaModelSettingsDeps {
	/** Persona/profile whose saved assignment scope the user is editing. */
	owners: () => readonly PersonaModelOwner[];
	/** Current active persona, used only to mark the first owner option. */
	activeOwner: () => string | undefined;
	/** Named council profiles this owner may inspect; undefined means the owner's own profile. */
	profiles: (owner: string) => readonly PersonaModelProfile[];
	/** Existing participant collector/resolver, including roster and auxiliary actors. */
	participants: (owner: string, profile: string | undefined) => readonly ModelParticipant[];
	/** Current saved assignment map for this owner. */
	saved: (owner: string) => Readonly<Record<string, string>>;
	/** Applies a key patch; null means delete that exact saved assignment. */
	write: (owner: string, patch: Record<string, string | null>) => void;
	/** Session/persona liveness guard supplied by the extension. */
	isCurrent?: (ctx: ExtensionContext) => boolean;
	/** Refresh adapter supplied by the catalog owner to keep derived discovery caches consistent. */
	refreshCatalog?: (signal: AbortSignal) => Promise<ModelsRefreshResult | undefined>;
}

const DONE = "Done";
const BACK = "Back";
const REFRESH = "Refresh available model catalog";

/**
 * Edit model assignments for a chosen owner without activating it. All changes are staged until
 * the user explicitly chooses Done; canceling any dialog or changing sessions drops the draft.
 */
export async function openPersonaModelSettings(ctx: ExtensionContext, deps: PersonaModelSettingsDeps): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Persona model settings require an interactive TUI or RPC UI; no assignments changed.", "warning");
		return;
	}

	const owners = deps.owners();
	if (owners.length === 0) {
		ctx.ui.notify("No personas are installed yet. Run /persona seed, then reopen persona settings.", "info");
		return;
	}

	const isCurrent = (): boolean => !ctx.signal?.aborted && (deps.isCurrent?.(ctx) ?? true);
	const activeOwner = deps.activeOwner();
	const orderedOwners = [...owners].sort((left, right) => Number(right.name === activeOwner) - Number(left.name === activeOwner));
	const ownerOptions = orderedOwners.map((owner, index) => {
		const active = owner.name === activeOwner ? " · active" : "";
		return `${index + 1}. ${safeInline(owner.label, 70)} (${safeInline(owner.name, 48)})${active}`;
	});
	const ownerChoice = await select(ctx, "Persona model owner", ownerOptions);
	if (ownerChoice === undefined) return;
	if (!isCurrent()) return sessionChanged(ctx);
	const ownerIndex = ownerOptions.indexOf(ownerChoice);
	const owner = orderedOwners[ownerIndex];
	if (!owner) return;

	const profiles = deps.profiles(owner.name);
	const profileChoices: Array<{ profile: string | undefined; option: string }> = [
		{ profile: undefined, option: `1. Current profile (${safeInline(owner.name, 48)})` },
		...profiles.map((profile, index) => ({
			profile: profile.name,
			option: `${index + 2}. ${safeInline(profile.label, 70)} (${safeInline(profile.name, 48)})`,
		})),
	];
	const profileChoice = await select(ctx, "Council profile", profileChoices.map((entry) => entry.option));
	if (profileChoice === undefined) return;
	if (!isCurrent()) return sessionChanged(ctx);
	const selectedProfile = profileChoices.find((entry) => entry.option === profileChoice);
	if (!selectedProfile) return;

	const profile = selectedProfile.profile;
	const staged: Record<string, string | null> = {};
	const getParticipants = (): readonly ModelParticipant[] => deps.participants(owner.name, profile);

	for (;;) {
		if (!isCurrent()) return sessionChanged(ctx);
		let participants: readonly ModelParticipant[];
		try {
			participants = getParticipants();
		} catch (error) {
			if (!isCurrent()) return sessionChanged(ctx);
			ctx.ui.notify(`Could not resolve model participants (${safeInline(errorMessage(error), 160)}); no assignments were written.`, "error");
			return;
		}
		const saved = deps.saved(owner.name);
		const knownKeys = new Set<string>();
		for (const participant of participants) {
			knownKeys.add(participant.key);
			knownKeys.add(participant.agent);
		}
		const staleKeys = Object.keys(saved).filter((key) => !knownKeys.has(key) && staged[key] === undefined);
		const rows = participants.map((participant, index) => participantRow(participant, saved, staged, index));
		const otherAssignmentsOption = staleKeys.length > 0 ? `Manage other saved assignments (${staleKeys.length})…` : undefined;
		const mainOptions = [...rows.map((row) => row.option), ...(otherAssignmentsOption ? [otherAssignmentsOption] : []), REFRESH, DONE];
		const choice = await select(ctx, `Model settings · ${safeInline(owner.label, 48)}${profile ? ` · ${safeInline(profile, 40)}` : " · current profile"}`, mainOptions);
		if (choice === undefined) return; // cancel discards the entire staged patch
		if (!isCurrent()) return sessionChanged(ctx);
		if (choice === DONE) {
			const patch = Object.fromEntries(Object.entries(staged));
			if (Object.keys(patch).length === 0) return;
			try {
				if (!isCurrent()) return sessionChanged(ctx);
				deps.write(owner.name, patch);
				ctx.ui.notify(`Saved ${Object.keys(patch).length} model assignment change(s) for "${safeInline(owner.name, 48)}"; applies to future runs.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not save persona model settings (${safeInline(errorMessage(error), 180)}); previous assignments were kept.`, "error");
			}
			return;
		}
		if (choice === REFRESH) {
			if (!(await refreshCatalog(ctx, isCurrent, deps.refreshCatalog))) return;
			continue;
		}
		if (otherAssignmentsOption && choice === otherAssignmentsOption) {
			if (staleKeys.length === 0) continue;
			const staleOptions = staleKeys.map((key, index) => `${index + 1}. ${displayAssignmentKey(key, index)} · ${safeInline(saved[key] ?? "", 90)}`);
			const staleChoice = await select(ctx, "Other saved assignment", staleOptions);
			if (staleChoice === undefined) return;
			if (!isCurrent()) return sessionChanged(ctx);
			const index = staleOptions.indexOf(staleChoice);
			const key = staleKeys[index];
			if (key !== undefined) staged[key] = null;
			continue;
		}

		const rowIndex = rows.findIndex((row) => row.option === choice);
		const participant = participants[rowIndex];
		if (!participant) continue;
		if (participant.source === "inline") {
			ctx.ui.notify(`"${safeInline(participant.label, 80)}" is pinned inline and is read-only here.`, "info");
			continue;
		}

		const directExists = effectiveSavedValue(participant.key, saved, staged) !== undefined;
		const sharedExists = participant.key !== participant.agent && effectiveSavedValue(participant.agent, saved, staged) !== undefined;
		const actions = [`Set or change model for "${safeInline(participant.label, 80)}"`];
		if (directExists) actions.push("Reset this participant's saved assignment");
		if (sharedExists) actions.push(`Reset shared agent assignment (${safeInline(participant.agent, 48)})`);
		actions.push(BACK);
		const action = await select(ctx, `Edit participant · ${safeInline(participant.label, 80)}`, actions);
		if (action === undefined) return;
		if (!isCurrent()) return sessionChanged(ctx);
		if (action === BACK) continue;
		if (action === "Reset this participant's saved assignment") {
			staged[participant.key] = null;
			continue;
		}
		if (action.startsWith("Reset shared agent assignment")) {
			staged[participant.agent] = null;
			continue;
		}
		if (action !== actions[0]) continue;

		const models = availableModels(ctx);
		const modelRefs = orderModelRefs(models.map((model) => `${model.provider}/${model.id}`), ctx.model?.provider);
		if (modelRefs.length === 0) {
			ctx.ui.notify("No authenticated models are available. Use /login, then choose Set or change again; saved assignments were kept.", "warning");
			continue;
		}
		const current = rows[rowIndex]!;
		const modelTitle = compactInlineText(
			`Model for ${participant.label} · current: ${current.model} (${current.source})`,
			{ maxChars: 180 },
		);
		let modelChoice: string | undefined;
		try {
			modelChoice = ctx.mode === "tui"
				? await ctx.ui.custom<string | undefined>(
						(tui, theme, keybindings, done) => new ModelPicker(tui, theme, modelTitle, modelRefs, ctx.model?.provider, done, {
							models,
							...(current.currentRef !== undefined ? { currentRef: current.currentRef } : {}),
							...(keybindings ? { keybindings } : {}),
						}),
						{ overlay: false },
					)
				: await select(ctx, modelTitle, modelRefs);
		} catch {
			return; // a dismissed/broken picker must not commit partial edits
		}
		if (modelChoice === undefined) return;
		if (!isCurrent()) return sessionChanged(ctx);
		if (modelRefs.includes(modelChoice)) staged[participant.key] = modelChoice;
		else return; // treat an unknown provider/model choice as a cancelled dialog
	}
}

function participantRow(
	participant: ModelParticipant,
	saved: Readonly<Record<string, string>>,
	staged: Readonly<Record<string, string | null>>,
	index: number,
): { option: string; model: string; source: string; currentRef?: string } {
	const hasPendingDirect = Object.prototype.hasOwnProperty.call(staged, participant.key);
	const pendingDirect = hasPendingDirect ? staged[participant.key] : undefined;
	const hasPendingShared = participant.key !== participant.agent && Object.prototype.hasOwnProperty.call(staged, participant.agent);
	const pendingShared = hasPendingShared ? staged[participant.agent] : undefined;
	const directSaved = effectiveSavedValue(participant.key, saved, staged);
	const sharedSaved = participant.key !== participant.agent ? effectiveSavedValue(participant.agent, saved, staged) : undefined;
	let model: string;
	let source: string;
	let currentRef: string | undefined;
	if (typeof pendingDirect === "string") {
		model = pendingDirect;
		currentRef = pendingDirect;
		source = "assignment (pending)";
	} else if (pendingDirect === null) {
		if (sharedSaved) {
			model = sharedSaved;
			currentRef = sharedSaved;
			source = "shared assignment (pending fallback)";
		} else {
			model = "resolve lower precedence next run";
			source = "pending reset";
		}
	} else if (typeof pendingShared === "string" && !directSaved && participant.source !== "inline") {
		model = pendingShared;
		currentRef = pendingShared;
		source = "shared assignment (pending)";
	} else if (hasPendingShared && pendingShared === null && !directSaved) {
		model = "resolve lower precedence next run";
		source = "shared reset pending";
	} else {
		model = participant.model ?? "none";
		currentRef = participant.model;
		source = participant.source;
	}
	const sharedNote = !directSaved && sharedSaved
		? ` · shared ${safeInline(participant.agent, 40)}=${safeInline(sharedSaved, 70)}`
		: hasPendingShared && pendingShared === null && directSaved
			? ` · shared ${safeInline(participant.agent, 40)} reset pending`
			: "";
	const pendingNote = hasPendingDirect && pendingDirect === null ? " · pending reset"
		: hasPendingShared && pendingShared === null ? " · shared reset pending"
			: "";
	const option = `${index + 1}. ${safeInline(participant.label, 80)} · ${safeInline(model, 90)} (${safeInline(source, 24)})${sharedNote}${pendingNote}`;
	return { option: compactInlineText(option, { maxChars: 200 }), model, source,
		...(currentRef !== undefined ? { currentRef } : {}) };
}

function effectiveSavedValue(
	key: string,
	saved: Readonly<Record<string, string>>,
	staged: Readonly<Record<string, string | null>>,
): string | undefined {
	if (Object.prototype.hasOwnProperty.call(staged, key)) return staged[key] ?? undefined;
	return saved[key];
}

function availableModels(ctx: ExtensionContext): ModelPickerMetadata[] {
	try {
		const unique = new Map<string, ModelPickerMetadata>();
		for (const model of ctx.modelRegistry.getAvailable()) {
			if (typeof model.provider !== "string" || !model.provider.trim() || typeof model.id !== "string" || !model.id.trim()) continue;
			unique.set(`${model.provider}/${model.id}`, model);
		}
		return [...unique.values()];
	} catch {
		return [];
	}
}

async function refreshCatalog(ctx: ExtensionContext, isCurrent: () => boolean, refresh?: PersonaModelSettingsDeps["refreshCatalog"]): Promise<boolean> {
	if (!ctx.modelRegistry.refresh) {
		ctx.ui.notify("This Pi host cannot explicitly refresh the model catalog; existing assignments were kept.", "warning");
		return true;
	}
	const deadline = AbortSignal.timeout(20_000);
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
	try {
		const result = await (refresh ? refresh(signal) : ctx.modelRegistry.refresh({ signal }));
		if (ctx.signal?.aborted) {
			ctx.ui.notify("Model catalog refresh was cancelled; saved assignments were kept.", "info");
			return false;
		}
		if (!isCurrent()) {
			sessionChanged(ctx);
			return false;
		}
		if (signal.aborted || result?.aborted) {
			ctx.ui.notify("Model catalog refresh was cancelled or timed out; saved assignments were kept.", "warning");
			return true;
		}
		if (result?.errors.size) {
			const providers = compactInlineText([...result.errors.keys()].join(", "), { maxChars: 120 });
			ctx.ui.notify(`Model catalog refresh incomplete for ${providers}; saved assignments were kept.`, "warning");
			return true;
		}
		ctx.ui.notify("Model catalog refreshed. Choose a participant to edit; existing assignments are unchanged.", "info");
		return true;
	} catch (error) {
		ctx.ui.notify(`Model catalog refresh failed (${safeInline(errorMessage(error), 150)}); saved assignments were kept.`, "warning");
		return true;
	}
}

async function select(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
	return ctx.ui.select(title, options);
}

function displayAssignmentKey(key: string, index: number): string {
	// Current keys are agent names or agent#32-hex-digest. Do not surface arbitrary legacy text that
	// might contain an old role prompt; keep a safe stable-looking label for those records instead.
	if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:#[a-f0-9]{32})?$/.test(key)) return key;
	return `legacy-key-${index + 1}`;
}

function safeInline(value: string, maxChars: number): string {
	return compactInlineText(value, { maxChars });
}

function sessionChanged(ctx: ExtensionContext): void {
	ctx.ui.notify("Persona model settings: the session changed, the command was cancelled, or the active persona changed; no staged assignments were written.", "warning");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
