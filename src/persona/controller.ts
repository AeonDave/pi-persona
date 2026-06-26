/**
 * PersonaController — applies a persona to the host session and restores
 * baselines symmetrically. Drives an injected `PersonaHost` (a subset of the Pi
 * ExtensionAPI) so the snapshot/restore discipline is unit-testable.
 *
 * Invariants (lose-nothing): model/thinking baseline is snapshotted ONCE on the
 * first override and restored when a later persona omits the axis; a
 * declared-but-unavailable model/invalid thinking keeps the current value with
 * no override and no restore; tools are restored from the FULL registry.
 */

import {
	type CapabilityPermissions,
	type EffectiveCapabilities,
	resolveCapabilities,
	type RunLimits,
} from "../core/capabilities.ts";
import { isThinkingLevel, type ThinkingLevel } from "../core/types.ts";
import { type GateResult, gateToolCall } from "./gating.ts";
import { composeSystemPrompt, type Persona } from "./persona.ts";

const DEFAULT_LIMITS: RunLimits = {
	maxChildren: 64,
	maxDepth: 2,
	maxConcurrency: 4,
	timeoutMs: 180_000,
	budgetTokens: 1_000_000,
};

/** Opaque model handle — the controller does not care about its internals. */
export interface ModelHandle {
	provider: string;
	id: string;
}

/** The minimal host surface the controller drives (a subset of ExtensionAPI). */
export interface PersonaHost {
	allToolNames(): string[];
	knownAgents(): string[];
	setActiveTools(names: string[]): void;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	getModel(): ModelHandle | undefined;
	findModel(ref: string): ModelHandle | undefined;
	setModel(model: ModelHandle): void | Promise<void>;
	setStatus(text: string | undefined): void;
}

export class PersonaController {
	private active: Persona | undefined;
	private toolsRestricted = false;
	private baselineModel: ModelHandle | undefined;
	private modelOverridden = false;
	private baselineThinking: ThinkingLevel | undefined;
	private thinkingOverridden = false;

	private readonly host: PersonaHost;
	private readonly delegateDefaultAllow: boolean;
	private readonly limits: RunLimits;
	private caps: EffectiveCapabilities | undefined;

	constructor(host: PersonaHost, delegateDefaultAllow = true, limits: RunLimits = DEFAULT_LIMITS) {
		this.host = host;
		this.delegateDefaultAllow = delegateDefaultAllow;
		this.limits = limits;
	}

	get activePersona(): Persona | undefined {
		return this.active;
	}

	async activate(persona: Persona): Promise<void> {
		this.active = persona;
		this.caps = this.resolveCaps(persona);
		this.host.setStatus(persona.label);
		await this.applyModel(persona);
		this.applyThinking(persona);
		this.applyTools(persona);
	}

	async deactivate(): Promise<void> {
		this.active = undefined;
		this.caps = undefined;
		this.host.setStatus(undefined);
		this.restoreTools();
		await this.restoreModel();
		this.restoreThinking();
	}

	/** For the `before_agent_start` hook: the persona-composed prompt, or undefined. */
	composePrompt(base: string): string | undefined {
		return this.active ? composeSystemPrompt(base, this.active) : undefined;
	}

	/** For the `tool_call` hook: a block result, or undefined to allow. */
	gate(toolName: string, input: unknown): GateResult | undefined {
		return this.active && this.caps ? gateToolCall(this.caps, this.active.label, toolName, input) : undefined;
	}

	/** The active persona's resolved capabilities (for diagnostics / `/doctor`). */
	get capabilities(): EffectiveCapabilities | undefined {
		return this.caps;
	}

	private resolveCaps(persona: Persona): EffectiveCapabilities {
		const permissions: CapabilityPermissions = {};
		if (persona.tools) permissions.tools = persona.tools;
		if (persona.delegate) permissions.delegate = persona.delegate;
		if (persona.skills) permissions.skills = persona.skills;
		return resolveCapabilities({
			allToolNames: this.host.allToolNames(),
			knownAgents: this.host.knownAgents(),
			permissions,
			limits: this.limits,
			delegateDefaultAllow: this.delegateDefaultAllow,
		});
	}

	private async applyModel(persona: Persona): Promise<void> {
		if (persona.model) {
			const model = this.host.findModel(persona.model);
			if (model) {
				if (!this.modelOverridden) {
					this.baselineModel = this.host.getModel();
					this.modelOverridden = true;
				}
				await this.host.setModel(model);
			}
			// declared-but-unavailable → keep current (no override, no restore)
		} else {
			await this.restoreModel();
		}
	}

	private async restoreModel(): Promise<void> {
		if (!this.modelOverridden) return;
		this.modelOverridden = false;
		const baseline = this.baselineModel;
		this.baselineModel = undefined;
		if (baseline) await this.host.setModel(baseline);
	}

	private applyThinking(persona: Persona): void {
		if (persona.thinking !== undefined) {
			if (isThinkingLevel(persona.thinking)) {
				if (!this.thinkingOverridden) {
					this.baselineThinking = this.host.getThinkingLevel();
					this.thinkingOverridden = true;
				}
				this.host.setThinkingLevel(persona.thinking);
			}
			// declared-but-invalid → keep current (no override, no restore)
		} else {
			this.restoreThinking();
		}
	}

	private restoreThinking(): void {
		if (!this.thinkingOverridden) return;
		this.thinkingOverridden = false;
		const baseline = this.baselineThinking;
		this.baselineThinking = undefined;
		if (baseline) this.host.setThinkingLevel(baseline);
	}

	private applyTools(persona: Persona): void {
		if (persona.tools) {
			// Use the resolved capability set so a tools-restricted persona still keeps
			// `delegate` active (unless it explicitly denied it) — delegation is preserved.
			this.host.setActiveTools([...(this.caps?.tools ?? new Set<string>())]);
			this.toolsRestricted = true;
		} else {
			this.restoreTools();
		}
	}

	private restoreTools(): void {
		if (!this.toolsRestricted) return;
		this.host.setActiveTools(this.host.allToolNames());
		this.toolsRestricted = false;
	}
}
