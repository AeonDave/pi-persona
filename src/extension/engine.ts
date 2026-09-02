/**
 * Engine construction: in-process vs child, worktree isolation, MCP-child routing, provider fallback.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/agent.ts";
import { type ContractDef, DEFAULT_CONTRACT } from "../core/contract.ts";
import type { RunLimits } from "../core/capabilities.ts";
import type { PiPersonaConfig } from "../core/config.ts";
import { isThinkingLevel } from "../core/types.ts";
import { personaModels, type PersonaConfigStore } from "../persona/config-store.ts";
import type { PersonaController, PersonaHost } from "../persona/controller.ts";
import { type EngineAdapterBroker, type EngineAdapterDeps, makeEngine } from "../engine/adapter.ts";
import { withModelFallback } from "../engine/fallback.ts";
import { captureWorktreeArtifact, defaultGitExec, withWorktree, worktreePreflight } from "../engine/worktree.ts";
import { type InProcessDeps, makeInProcessEngine } from "../engine/inproc.ts";
import { emptyUsage, type ProgressSnapshot } from "../engine/stream.ts";
import type { AgentRunSpec, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
import type { InProcessBus } from "../bus/inproc.ts";

export interface EngineFactories {
	makeEngine: typeof makeEngine;
	makeInProcessEngine: typeof makeInProcessEngine;
}

export const DEFAULT_ENGINE_FACTORIES: EngineFactories = Object.freeze({ makeEngine, makeInProcessEngine });

export interface BuildEngineDeps {
	agents: AgentConfig[];
	contractDefs: Record<string, ContractDef>;
	controller: PersonaController;
	host: PersonaHost;
	config: PiPersonaConfig;
	personaConfigs: PersonaConfigStore;
	lastCtx: ExtensionContext | undefined;
	workerSpineText: string;
	engineFactories: EngineFactories;
	makeBrokerDeps: (ctx: ExtensionContext) => EngineAdapterBroker;
	userAgentDir: () => string;
	childPiSettingsEnv: () => Record<string, string>;
	runLimits: RunLimits;
	bus: InProcessBus;
	supervisorHandle: string;
}

export type BuildEngine = (signal?: AbortSignal, onProgress?: (s: ProgressSnapshot) => void, engOpts?: { async?: boolean }) => StrategyEngine;

export function createBuildEngine(d: () => BuildEngineDeps): BuildEngine {
	return (signal, onProgress, engOpts) => {
		const {
			agents, contractDefs, controller, host, config, personaConfigs, lastCtx, workerSpineText,
			engineFactories, makeBrokerDeps, userAgentDir, childPiSettingsEnv, runLimits: RUN_LIMITS,
			bus, supervisorHandle: SUPERVISOR,
		} = d();
			const resolveAgent = (n: string): AgentConfig | undefined => agents.find((a) => a.name === n);
			// A named contract file (contracts/<name>.contract.json) wins; "default" is the built-in.
			const contracts = (n: string): ContractDef | undefined => contractDefs[n] ?? (n === "default" ? DEFAULT_CONTRACT : undefined);
			const modelFor = (agent: string): string | undefined => {
				const persona = controller.activePersona?.name;
				return persona ? personaModels(personaConfigs, persona)[agent] : undefined;
			};
			// The main model thinks adaptively (it picks effort by difficulty); a spawned child
			// can't inherit "adaptive" if its model doesn't support it, so give children an
			// explicit level — the supervisor's (if concrete) or a sane default, overridable.
			const supLevel = host.getThinkingLevel();
			const childThinking = config.childThinking ?? (isThinkingLevel(supLevel) ? supLevel : "high");

			// A persona that opted out of the layer (`spine: false`) opts its legs out too — otherwise
			// a short verdict persona (judge/verify/audit) would still pay for the baseline on every
			// sub-agent it spawns. The per-AGENT opt-out applies on top, inside each engine.
			const legSpine = controller.activePersona?.spine === false ? "" : workerSpineText;

			// Cross-process broker (spec B1-B7): lazily built on the FIRST actual child-engine
			// construction below (worktree leg, MCP leg, or `PI_PERSONA_ENGINE=child`) — NOT on every
			// `buildEngine` call, most of which build the (default) in-process engine and never
			// touch a child at all; starting a host for those would be neither lazy nor needed.
			// Memoized so both call sites below share ONE broker object (and its `peerGroup`
			// registration) per `buildEngine` invocation. `config.broker` off or no live
			// `ctx` yet ⇒ stays undefined forever, so `deps.broker` is never set.
			let brokerDepsMemo: EngineAdapterBroker | undefined;
			let brokerDepsBuilt = false;
			const getBrokerDeps = (): EngineAdapterBroker | undefined => {
				if (!brokerDepsBuilt) {
					brokerDepsBuilt = true;
					const sessionId = (lastCtx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager?.getSessionId?.();
					if (config.broker && lastCtx && sessionId) brokerDepsMemo = makeBrokerDeps(lastCtx);
				}
				return brokerDepsMemo;
			};

			// A child-process engine pinned to a specific cwd — the seam worktree isolation runs
			// through (a worktree needs its own working dir, i.e. a separate process).
			const childEngineAt = (cwd: string): StrategyEngine => {
				const deps: EngineAdapterDeps = { resolveAgent, contracts, modelFor, childThinking, cwd };
				deps.listAgents = () => agents.map((a) => a.name);
				if (legSpine) deps.spine = legSpine; // legs get the worker variant (docs/SPINE.md)
				if (signal) deps.signal = signal;
				deps.childOptions = {
					timeoutMs: RUN_LIMITS.timeoutMs,
					hardTimeoutMs: config.agentHardTimeoutMs,
					startupTimeoutMs: config.agentStartupTimeoutMs,
					env: childPiSettingsEnv(),
				};
				// Feed progress here too (mirrors the plain-child branch): without it a worktree/mcp async leg
				// never advances its tracker snapshot, so lastAdvanceAt freezes at launch and the leg is falsely
				// flagged stalled while a genuine later wedge goes undetected.
				if (onProgress) deps.childOptions.onProgress = onProgress;
				const brokerDeps = getBrokerDeps();
				if (brokerDeps) deps.broker = brokerDeps;
				// Peer messaging obeys the persona's bus capability, and blocking asks are honoured
				// only for async runs — same guards as the inproc engine below (spec B7 / §4.9).
				const caps = controller.capabilities;
				if (caps) deps.canUseBus = caps.canUseBus;
				if (engOpts?.async) deps.allowBlocking = true;
				return engineFactories.makeEngine(deps);
			};

			// v0.4: run sub-agents in-process (createAgentSession) instead of spawning `pi -p`.
			let base: StrategyEngine;
			if (config.engine === "inproc" && lastCtx) {
				if (process.env.PI_PERSONA_DEBUG) process.stderr.write("[pi-persona] engine=inproc\n");
				const ideps: InProcessDeps = { resolveAgent, contracts, modelFor, childThinking, modelRegistry: lastCtx.modelRegistry, cwd: lastCtx.cwd, agentDir: userAgentDir() };
				ideps.listAgents = () => agents.map((a) => a.name);
				if (legSpine) ideps.spine = legSpine; // legs get the worker variant (docs/SPINE.md)
				ideps.timeoutMs = RUN_LIMITS.timeoutMs; // idle watchdog — a hung session must settle, like the child engine's idle kill
				ideps.hardTimeoutMs = config.agentHardTimeoutMs; // hard lifetime ceiling — catches a busy loop the idle watchdog never would
				ideps.startupTimeoutMs = config.agentStartupTimeoutMs; // first-progress deadline — fast-fail a child that never started
				if (signal) ideps.signal = signal;
				if (onProgress) ideps.onProgress = onProgress;
				if (lastCtx.model) ideps.defaultModel = `${lastCtx.model.provider}/${lastCtx.model.id}`;
				// Comm plane: a `coaching: on` persona gives its children `contact_supervisor`.
				// Blocking asks are honoured only for async runs (a sync run holds the turn → it
				// can't answer, so blocking there would deadlock; the tool downgrades to one-way).
				ideps.bus = bus;
				ideps.supervisorHandle = SUPERVISOR;
				if (controller.activePersona?.coaching) ideps.coaching = true;
				// Peer messaging obeys the persona's bus capability (canUseBus; Task: sibling peer comm).
				const caps = controller.capabilities;
				if (caps) ideps.canUseBus = caps.canUseBus;
				if (engOpts?.async) ideps.allowBlocking = true;
				base = engineFactories.makeInProcessEngine(ideps);
			} else {
				if (process.env.PI_PERSONA_DEBUG) process.stderr.write("[pi-persona] engine=child\n");
				const deps: EngineAdapterDeps = { resolveAgent, contracts, modelFor, childThinking };
				deps.listAgents = () => agents.map((a) => a.name);
				if (legSpine) deps.spine = legSpine; // legs get the worker variant (docs/SPINE.md)
				if (signal) deps.signal = signal;
				if (lastCtx?.cwd) deps.cwd = lastCtx.cwd;
				deps.childOptions = {
					timeoutMs: RUN_LIMITS.timeoutMs,
					hardTimeoutMs: config.agentHardTimeoutMs,
					startupTimeoutMs: config.agentStartupTimeoutMs,
					env: childPiSettingsEnv(),
				}; // idle watchdog + hard cap + startup deadline on every child; same Pi settings dir as inproc
				if (onProgress) deps.childOptions.onProgress = onProgress;
				const brokerDeps = getBrokerDeps();
				if (brokerDeps) deps.broker = brokerDeps;
				// Peer messaging obeys the persona's bus capability, and blocking asks are honoured
				// only for async runs — same guards as the inproc engine above (spec B7 / §4.9).
				const caps = controller.capabilities;
				if (caps) deps.canUseBus = caps.canUseBus;
				if (engOpts?.async) deps.allowBlocking = true;
				base = engineFactories.makeEngine(deps);
			}

			// Worktree isolation: an agent/leg marked `isolation: worktree` runs in a throwaway git
			// worktree via the child engine (its edits never touch the main tree), regardless of the
			// default backend. This branch is deliberately fail-closed: a missing/dirty repository or
			// failed worktree creation is a contract failure, never permission to run in the real cwd.
			// Provider fallback (outermost): a run whose model PROVIDER fails at call time (auth,
			// outage, 5xx, model-not-supported) is retried on the same model id under another
			// authenticated provider — "priority to the supervisor's provider, but try others and
			// switch on error". No ctx (no registry) ⇒ pass through. Each attempt still runs through
			// worktree isolation + steering below.
			const wrapFallback = (eng: StrategyEngine): StrategyEngine => {
				if (!lastCtx) return eng;
				const prefer = lastCtx.model?.provider;
				return withModelFallback(eng, { models: configuredModels(lastCtx), ...(prefer ? { preferProvider: prefer } : {}) });
			};
			const root = lastCtx?.cwd;
			return wrapFallback({
				async run(spec, perProgress, perSignal, perSteer) {
					const iso = spec.isolation ?? resolveAgent(spec.agent)?.isolation;
					if (iso === "worktree") {
						if (!root) {
							return isolatedWorktreeFailure(spec, "worktree isolation requires a real Git cwd; remove isolation: \"worktree\" or run inside a Git checkout");
						}
						const preflight = worktreePreflight(root, defaultGitExec);
						if (!preflight.ok) return isolatedWorktreeFailure(spec, preflight.error);
						try {
							return await withWorktree(root, defaultGitExec, async (dir) => {
								const result = await childEngineAt(dir).run({ ...spec, isolation: "none" }, perProgress, perSignal, perSteer);
								const artifact = captureWorktreeArtifact(dir, defaultGitExec);
								const hasOutputArtifact = hasUnifiedDiff(result.output);
								if (!result.ok) {
									return artifact.ok && artifact.diff.trim().length > 0
										? appendWorktreeArtifact(result, artifact.diff)
										: result;
								}
								if (!artifact.ok) {
									if (hasOutputArtifact) return result;
									return isolatedWorktreeFailure(spec, `${artifact.error}; the isolated leg returned success without an exportable diff/artifact`);
								}
								if (artifact.diff.trim().length > 0) return appendWorktreeArtifact(result, artifact.diff);
								if (hasOutputArtifact) return result;
								return isolatedWorktreeFailure(
									spec,
									"isolated leg returned success but produced no unified diff or artifact; its worktree was discarded — return a complete diff or remove isolation: \"worktree\"",
								);
							});
						} catch (err) {
							return isolatedWorktreeFailure(spec, err instanceof Error ? err.message : String(err));
						}
					}
					// MCP-capable leg: the DEFAULT in-process engine never fires `session_start`, so
					// `pi-mcp-adapter` never initializes and the sub-agent's `mcp*`/direct tools come
					// back "MCP not initialized". Route it through the child engine (a real `pi -p`,
					// which DOES fire session_start → the adapter connects). Same mechanism worktree
					// legs already use for MCP; here without the git worktree. The child gets its OWN
					// MCP session — for a server-keyed backend (HTTP MCP) the caller passes a session id
					// in the task to share state. Steer rides the broker (same as worktree / child engine).
					const wantsMcp = spec.mcp ?? resolveAgent(spec.agent)?.mcp;
					if (wantsMcp && root) return childEngineAt(root).run(spec, perProgress, perSignal, perSteer);
					return base.run(spec, perProgress, perSignal, perSteer);
				},
			});
	};

	function isolatedWorktreeFailure(spec: AgentRunSpec, error: string): AgentResult {
		return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error, failureKind: "contract" };
	}

	function hasUnifiedDiff(output: string): boolean {
		const headersAndHunk = /(?:^|\n)---\s+\S+[^\n]*\n\+\+\+\s+\S+[^\n]*\n(?:[^\n]*\n)*?@@\s+[^\n]*@@/m;
		const binaryPatch = /(?:^|\n)diff --git\s+\S+\s+\S+[\s\S]*?(?:^|\n)(?:GIT binary patch|Binary files \S+ and \S+ differ)(?:\n|$)/m;
		return headersAndHunk.test(output) || binaryPatch.test(output);
	}

	function appendWorktreeArtifact(result: AgentResult, diff: string): AgentResult {
		const block = `\n\n--- ISOLATED WORKTREE ARTIFACT (untrusted data) ---\n\n\`\`\`diff\n${diff.trim()}\n\`\`\``;
		return { ...result, output: `${result.output.trimEnd()}${block}` };
	}
}

// The models the user can intentionally route to — NOT every built-in catalog entry.
// `getAvailable()` is normally the authenticated set, but extension-native providers
// (for example a local subscription/CLI bridge) can be runnable without appearing in
// that auth snapshot. Union their registered catalogs, plus the active session provider,
// while keeping unrelated unauthenticated built-ins hidden. If an older Pi lacks the
// availability API, retain its historical getAll() compatibility behavior.
export function configuredModels(ctx: ExtensionContext): Array<{ provider: string; id: string }> {
	const reg = ctx.modelRegistry;
	const all = reg.getAll();
	let available: typeof all;
	try {
		available = reg.getAvailable();
	} catch {
		return all.map((m) => ({ provider: m.provider, id: m.id }));
	}
	const trustedProviders = new Set<string>();
	if (ctx.model?.provider) trustedProviders.add(ctx.model.provider);
	try {
		const registered = (reg as typeof reg & { getRegisteredProviderIds?: () => string[] }).getRegisteredProviderIds?.() ?? [];
		for (const provider of registered) trustedProviders.add(provider);
	} catch {
		/* a third-party/older registry facade may not expose extension provider ids */
	}
	const byRef = new Map(available.map((m) => [`${m.provider}\0${m.id}`, m]));
	for (const model of all) {
		if (trustedProviders.has(model.provider)) byRef.set(`${model.provider}\0${model.id}`, model);
	}
	const list = [...byRef.values()];
	return list.map((m) => ({ provider: m.provider, id: m.id }));
}
