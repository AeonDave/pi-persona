import type { EventBus } from "@earendil-works/pi-coding-agent";
import { PERSONA_SETTINGS, validatePreferences, type CompanionPreferenceValues } from "../core/settings.ts";

export const COMPANION_SETTINGS_CHANNEL = "pi-persona:settings:collect:v1";
export interface CompanionSettingsSnapshot {
	mind?: Partial<Pick<CompanionPreferenceValues, "mindCapture" | "mindNudge">>;
	flow?: Partial<Pick<CompanionPreferenceValues, "flowEnabled" | "flowPort" | "flowIdleMs">>;
}

/** Synchronous, optional discovery on Pi's public bus. No plugin import, model request or writer. */
export function collectCompanionSettings(bus: Pick<EventBus, "emit"> | undefined): CompanionSettingsSnapshot {
	const snapshot: CompanionSettingsSnapshot = {};
	if (!bus) return snapshot;
	try {
		bus.emit(COMPANION_SETTINGS_CHANNEL, { add: (id: unknown, values: unknown): void => {
			if (id !== "mind" && id !== "flow") return;
			if (!values || typeof values !== "object" || Array.isArray(values)) return;
			const keys = PERSONA_SETTINGS.filter((setting) => setting.owner === id).map((setting) => setting.id);
			const reportedKeys = Object.keys(values);
			if (reportedKeys.length === 0 || !reportedKeys.every((key) => keys.includes(key as keyof CompanionPreferenceValues))) return;
			try {
				const validated = validatePreferences(values);
				if (id === "mind") snapshot.mind = validated as Partial<Pick<CompanionPreferenceValues, "mindCapture" | "mindNudge">>;
				else snapshot.flow = validated as Partial<Pick<CompanionPreferenceValues, "flowEnabled" | "flowPort" | "flowIdleMs">>;
			} catch { /* A malformed contribution is not an editable settings owner. */ }
		} });
	} catch { /* Keep valid responses if another extension listener throws. */ }
	return snapshot;
}
