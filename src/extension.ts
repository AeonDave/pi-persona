import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-persona — the single ExtensionFactory.
 *
 * Wiring is added incrementally following the v0.1 build order
 * (core → child engine → persona/delegate → strategy SDK → ...). Read the binding
 * implementation guardrails under docs/superpowers/specs/ before extending this.
 */
export default function piPersona(_pi: ExtensionAPI): void {
	// v0.1 WIP — modules are wired here as they land.
}
