/**
 * Engine construction: in-process vs child, worktree isolation, MCP-child routing, provider fallback.
 */
import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/agent.ts";
import { type ContractDef, DEFAULT_CONTRACT, installedContractNames } from "../core/contract.ts";
import { canCallTool, type RunLimits } from "../core/capabilities.ts";
import type { PiPersonaConfig } from "../core/config.ts";
import { defaultChildThinking } from "../core/leg-thinking.ts";
import type { ModelCostMetadata } from "../core/model-tier.ts";
import { personaModels, type PersonaConfigStore } from "../persona/config-store.ts";
import { participantKey } from "../persona/model-participants.ts";
import type { PersonaController, PersonaHost } from "../persona/controller.ts";
import { type EngineAdapterBroker, type EngineAdapterDeps, makeEngine } from "../engine/adapter.ts";
import { captureStatus, diffStatus, findGitRoot, renderChangeReport } from "../engine/change-report.ts";
import { withModelFallback } from "../engine/fallback.ts";
import { captureWorktreeArtifact, defaultGitExec, describeWorktreeRecovery, type GitExec, withWorktree, worktreePreflight, WorktreeRetainedError } from "../engine/worktree.ts";
import { verifyConversationWorktree } from "../engine/conversation-worktree.ts";
import { formatWorktreeRecovery, WORKTREE_CAPTURE_WARNING } from "../core/worktree-recovery.ts";
import { type InProcessDeps, makeInProcessEngine } from "../engine/inproc.ts";
import { emptyUsage, type ProgressSnapshot } from "../engine/stream.ts";
import type { AgentRunSpec, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
import type { InProcessBus } from "../bus/inproc.ts";
import type { ResultArchiveView } from "../results/retrieval.ts";
import { parseVerification, verificationAllowsBash, type WorktreeVerificationSpec } from "../core/worktree-verification.ts";
import { applyWorktreeVerification, captureVerificationTarget } from "../engine/worktree-verification.ts";
import { combineSignals } from "../engine/signals.ts";

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
	makeBrokerDeps: (ctx: ExtensionContext) => EngineAdapterBroker | undefined;
	userAgentDir: () => string;
	childPiSettingsEnv: () => Record<string, string>;
	runLimits: RunLimits;
	bus: InProcessBus;
	supervisorHandle: string;
	/** The live terminal-result archive (a GETTER: the owning session can change across runs).
	 *  Feeds both engines' reference-handoff preflight + scoped `read_result` readers.
	 *  Absent ⇒ reference-handoff legs fail closed on both engines (no archive to page). */
	resultArchive?: () => ResultArchiveView | undefined;
	/** Breadcrumb for a provider reroute (toast + log); absent ⇒ silent, as before. */
	onFallback?: (info: { from: string; to: string; agent: string }) => void;
	/** Injected git runner for the non-worktree files-changed report (tests only); defaults to
	 *  `defaultGitExec`. */
	gitExec?: GitExec;
	/** Live host shell gate: active tool selection and persona permission must both allow bash. */
	canVerify?: () => boolean;
	verificationShellPath?: () => string | undefined;
}

export type BuildEngine = (
	signal?: AbortSignal,
	onProgress?: (s: ProgressSnapshot) => void,
	engOpts?: {
		async?: boolean;
		/** Wrap the engine in `withModelFallback` (default true). Strategy/flow builds pass
		 *  `false`: there the SDK's own main-model recovery is the ONE reroute, so an arbitrary
		 *  provider must not be substituted underneath a member the user pinned. */
		providerFallback?: boolean;
		/** Trusted companion worker definition, scoped to this engine build; never installed/discovered. */
		agentOverride?: AgentConfig;
		/** Internal tool-less maintenance may revoke communication even for a coaching persona. */
		canUseBus?: false;
	},
) => StrategyEngine;

export function createBuildEngine(d: () => BuildEngineDeps): BuildEngine {
	return (signal, onProgress, engOpts) => {
		const {
			agents, contractDefs, controller, host, config, personaConfigs, lastCtx, workerSpineText,
			engineFactories, makeBrokerDeps, userAgentDir, childPiSettingsEnv, runLimits: RUN_LIMITS,
			bus, supervisorHandle: SUPERVISOR, onFallback, resultArchive,
		} = d();
			const resolveAgent = (n: string): AgentConfig | undefined => engOpts?.agentOverride?.name === n ? engOpts.agentOverride : agents.find((a) => a.name === n);
			// A named contract file (contracts/<name>.contract.json) wins; "default" is the built-in.
			const contracts = (n: string): ContractDef | undefined => contractDefs[n] ?? (n === "default" ? DEFAULT_CONTRACT : undefined);
			const contractNames = (): string[] => installedContractNames(contractDefs);
			// A per-persona model assignment. The lookup key MUST match the one the picker saved
			// (`persona/model-participants.ts`): a role member's own key first, then the bare agent
			// key, so assignments saved before roles existed keep applying.
			const persona = controller.activePersona?.name;
			const savedModels = persona ? personaModels(personaConfigs, persona) : undefined;
			const modelFor = (agent: string, role?: string): string | undefined => {
				const trimmed = role?.trim();
				if (trimmed) {
					const own = savedModels?.[participantKey(agent, trimmed)];
					if (own) return own;
				}
				return savedModels?.[agent];
			};
			// The main model thinks adaptively (it picks effort by difficulty); a spawned child
			// can't inherit "adaptive" if its model doesn't support it, so give children an
			// explicit level — the supervisor's (if concrete) or a sane default, overridable.
			const childThinking = defaultChildThinking(config.childThinking, host.getThinkingLevel());

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
					const sessionId = lastCtx?.sessionManager.getSessionId();
					if (config.broker && lastCtx && sessionId) brokerDepsMemo = makeBrokerDeps(lastCtx);
				}
				return brokerDepsMemo;
			};

			// A child-process engine pinned to a specific cwd — the seam worktree isolation runs
			// through (a worktree needs its own working dir, i.e. a separate process).
			const childEngineAt = (cwd: string): StrategyEngine => {
				const deps: EngineAdapterDeps = { resolveAgent, contracts, modelFor, childThinking, cwd, memoryPersona: persona ?? null };
				deps.listAgents = () => agents.map((a) => a.name);
				deps.listContracts = contractNames;
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
				// Reference-handoff legs page the owning session's terminal archive (strict preflight
				// + scoped reader); the getter is read at LEG time so a mid-run session switch is seen.
				if (resultArchive !== undefined) deps.resultArchive = resultArchive;
				// Peer messaging obeys the persona's bus capability, and blocking asks are honoured
				// only for async runs — same guards as the inproc engine below (spec B7 / §4.9).
				const caps = controller.capabilities;
				if (engOpts?.canUseBus === false) deps.canUseBus = false;
				else if (caps) deps.canUseBus = caps.canUseBus;
				if (engOpts?.async) deps.allowBlocking = true;
				return engineFactories.makeEngine(deps);
			};

			// v0.4: run sub-agents in-process (createAgentSession) instead of spawning `pi -p`.
			let base: StrategyEngine;
			if (config.engine === "inproc" && lastCtx) {
				if (process.env.PI_PERSONA_DEBUG) process.stderr.write("[pi-persona] engine=inproc\n");
				const ideps: InProcessDeps = { resolveAgent, contracts, modelFor, childThinking, modelRegistry: lastCtx.modelRegistry, cwd: lastCtx.cwd, agentDir: userAgentDir(), memoryPersona: persona ?? null };
				ideps.listAgents = () => agents.map((a) => a.name);
				ideps.listContracts = contractNames;
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
				if (resultArchive !== undefined) ideps.resultArchive = resultArchive;
				if (controller.activePersona?.coaching) ideps.coaching = true;
				// Peer messaging obeys the persona's bus capability (canUseBus; Task: sibling peer comm).
				const caps = controller.capabilities;
				if (engOpts?.canUseBus === false) ideps.canUseBus = false;
				else if (caps) ideps.canUseBus = caps.canUseBus;
				if (engOpts?.async) ideps.allowBlocking = true;
				base = engineFactories.makeInProcessEngine(ideps);
			} else {
				if (process.env.PI_PERSONA_DEBUG) process.stderr.write("[pi-persona] engine=child\n");
				const deps: EngineAdapterDeps = { resolveAgent, contracts, modelFor, childThinking, memoryPersona: persona ?? null };
				deps.listAgents = () => agents.map((a) => a.name);
				deps.listContracts = contractNames;
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
				if (resultArchive !== undefined) deps.resultArchive = resultArchive;
				// Peer messaging obeys the persona's bus capability, and blocking asks are honoured
				// only for async runs — same guards as the inproc engine above (spec B7 / §4.9).
				const caps = controller.capabilities;
				if (engOpts?.canUseBus === false) deps.canUseBus = false;
				else if (caps) deps.canUseBus = caps.canUseBus;
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
				if (engOpts?.providerFallback === false) return eng; // the SDK owns recovery there
				if (!lastCtx) return eng;
				const prefer = lastCtx.model?.provider;
				return withModelFallback(eng, {
					models: configuredModels(lastCtx),
					...(prefer ? { preferProvider: prefer } : {}),
					...(onFallback ? { onFallback } : {}),
				});
			};
			const root = lastCtx?.cwd;
			const gitExec = d().gitExec ?? defaultGitExec;
			// Files-changed report for a leg that does NOT run in its own worktree: it shares the
			// real checkout, so the only honest signal is "what did `git status` see change while
			// this leg ran" — a before/after snapshot, not a private diff (see change-report.ts).
			// Skipped for the worktree path below, which already returns a real diff artifact, and
			// for the whole feature when `PI_PERSONA_LEG_CHANGE_REPORT` is off.
			//
			// The repository root is resolved ONCE here (a pure filesystem walk, no process spawn)
			// and threaded into BOTH captures as their `knownGitRoot` — each then skips its own
			// walk AND its `rev-parse` liveness gate, so a leg pays for exactly two `git status`
			// spawns (one at launch, one at settle) instead of four.
			const withChangeReport = async (run: () => Promise<AgentResult>, spec: AgentRunSpec): Promise<AgentResult> => {
				if (!root || config.changeReport === false) return run();
				const gitRoot = findGitRoot(root);
				if (!gitRoot) return run();
				const before = await captureStatus(gitRoot, gitExec, gitRoot);
				const result = await run();
				if (!before) return result;
				const after = await captureStatus(gitRoot, gitExec, gitRoot);
				if (!after) return result;
				const block = renderChangeReport(diffStatus(before, after), spec.writeSet);
				return block ? appendBlock(result, block) : result;
			};
			return wrapFallback({
				async run(spec, perProgress, perSignal, perSteer) {
					const beforeStart = (result: AgentResult): AgentResult => spec.session ? { ...result, sessionSaved: false, sessionQuiescent: true } : result;
					const iso = spec.isolation ?? resolveAgent(spec.agent)?.isolation;
					let verification: WorktreeVerificationSpec | undefined;
					const canVerify = (): boolean => {
						const current = d();
						const caps = current.controller.capabilities;
						return current.canVerify?.() === true && (!caps || canCallTool(caps, "bash"));
					};
					if (spec.verification !== undefined) {
						const parsed = parseVerification(spec.verification);
						if (!parsed.ok) return beforeStart(isolatedWorktreeFailure(spec, parsed.error));
						verification = Object.freeze(parsed.value);
						if (iso !== "worktree") return beforeStart(isolatedWorktreeFailure(spec, "verification requires worktree isolation"));
						const agent = resolveAgent(spec.agent);
						if (!canVerify() || !verificationAllowsBash(spec.tools ?? agent?.tools, undefined, agent?.excludeTools)) return beforeStart(isolatedWorktreeFailure(spec, "verification requires effective bash permission for the supervisor and worker"));
					}
					if (spec.session?.resume && spec.session.worktree && iso !== "worktree") {
						return { ...isolatedWorktreeFailure(spec, "A retained worktree conversation must resume with worktree isolation"), sessionSaved: false, sessionQuiescent: true };
					}
					if (iso === "worktree") {
						if (!root) {
							return beforeStart(isolatedWorktreeFailure(spec, "worktree isolation requires a real Git cwd; remove isolation: \"worktree\" or run inside a Git checkout"));
						}
						const resumed = spec.session?.resume === true;
						const previousWorktree = spec.session?.worktree;
						if (resumed) {
							if (!previousWorktree) return { ...isolatedWorktreeFailure(spec, "The retained worktree is missing; cannot continue an isolated worker"), sessionSaved: false, sessionQuiescent: true };
							const verified = await verifyConversationWorktree(previousWorktree, root);
							if (!verified.ok) return { ...isolatedWorktreeFailure(spec, verified.error), sessionSaved: false, sessionQuiescent: true };
						} else {
							const preflight = await worktreePreflight(root, defaultGitExec);
							if (!preflight.ok) return beforeStart(isolatedWorktreeFailure(spec, preflight.error));
						}
						const runWorktree = async (dir: string, baseCommit: string) => {
								const workerDefaults = verification ? SettingsManager.create(dir, userAgentDir()).getDefaultTools() : undefined;
								const workerAllowed = (): boolean => {
									const agent = resolveAgent(spec.agent);
									return verificationAllowsBash(spec.tools ?? agent?.tools, workerDefaults, agent?.excludeTools);
								};
								if (verification && !workerAllowed()) return { cleanup: "remove" as const, value: beforeStart(isolatedWorktreeFailure(spec, "verification requires bash in the worker's effective host defaults")) };
								const target = verification ? await captureVerificationTarget(dir) : undefined;
								let result = await childEngineAt(dir).run({ ...spec, isolation: "none" }, perProgress, perSignal, perSteer);
								const workerOk = result.ok;
								// Only worker prose may supply a fallback patch; verification output is never an artifact.
								const hasOutputArtifact = hasUnifiedDiff(result.output);
								let verificationCanExport = true;
								if (verification && target) {
									const verificationSignal = combineSignals(signal, perSignal);
									const shellPath = d().verificationShellPath?.();
									const verified = await applyWorktreeVerification(verification, { path: dir, baseCommit, root }, target, result, { allowed: () => canVerify() && workerAllowed(), ...(verificationSignal ? { signal: verificationSignal } : {}), ...(shellPath ? { shellPath } : {}) });
									result = verified.result;
									verificationCanExport = verified.canExport;
								}
								if ((spec.session && result.sessionQuiescent !== true) || !verificationCanExport) {
									const worktreeRecovery = await describeWorktreeRecovery(dir, baseCommit, "The isolated worker or verification process may still be writing, or its directory identity changed; retained without capturing an artifact");
									const notice = formatWorktreeRecovery(worktreeRecovery);
									return { cleanup: "retain" as const, value: { ...result, ...(result.ok ? { ok: false, failureKind: "agent" as const, error: notice } : {}), sessionSaved: false, worktreeRecovery, output: `${notice}\n\n${result.output}`.trimEnd() } };
								}
								const artifact = await captureWorktreeArtifact(dir, baseCommit, defaultGitExec).catch((error: unknown) => ({
									ok: false as const,
									error: error instanceof Error ? error.message : String(error),
								}));
								if (!artifact.ok) {
									if (spec.session) result.sessionSaved = false;
									const worktreeRecovery = await describeWorktreeRecovery(dir, baseCommit, `Worktree artifact capture failed: ${artifact.error}`);
									const notice = formatWorktreeRecovery(worktreeRecovery);
									const output = `${notice}\n\n${result.output}`.trimEnd();
									if (!result.ok) {
										return { cleanup: "retain" as const, value: { ...result, output, worktreeRecovery, error: `${result.error ?? "isolated worker failed"}; ${notice}` } };
									}
									if (hasOutputArtifact) {
										return { cleanup: "retain" as const, value: prependWorktreeCaptureWarning({ ...result, output, worktreeRecovery }) };
									}
									return { cleanup: "retain" as const, value: { ...result, output, worktreeRecovery, ok: false, failureKind: "contract" as const, error: `${notice} The isolated leg returned success without an exportable diff/artifact.` } };
								}
								if (!result.ok) {
									// Verification runs only after a successful worker, so a ran-and-failed check is never a
									// provider failure: every requested-verification failure except a worker's provider error retains.
									if (resumed || (verification && result.failureKind !== "provider")) {
										const reason = result.verification && workerOk
											? `Worktree verification ${result.verification.status}; retained for recovery`
											: `Isolated worker did not complete${result.verification ? "; verification did not run" : ""}; retained for recovery`;
										const worktreeRecovery = await describeWorktreeRecovery(dir, baseCommit, reason);
										const notice = formatWorktreeRecovery(worktreeRecovery);
										const reported = artifact.diff.trim() ? appendWorktreeArtifact(result, artifact.diff) : result;
										return { cleanup: "retain" as const, value: { ...reported, ...(reported.ok ? { ok: false, failureKind: "agent" as const, error: notice } : {}), sessionSaved: false, worktreeRecovery, output: `${notice}\n\n${reported.output}`.trimEnd() } };
									}
									return { cleanup: "remove" as const, value: artifact.diff.trim().length > 0 ? appendWorktreeArtifact(result, artifact.diff) : result };
								}
								if (resumed && (!result.sessionSaved || !result.sessionQuiescent || (!artifact.diff.trim() && !hasOutputArtifact))) {
									const worktreeRecovery = await describeWorktreeRecovery(dir, baseCommit, "The continued worker could not be safely retained as a conversation");
									const notice = formatWorktreeRecovery(worktreeRecovery);
									const reported = artifact.diff.trim() ? appendWorktreeArtifact(result, artifact.diff) : result;
									return { cleanup: "retain" as const, value: { ...reported, ok: false, failureKind: "contract" as const, sessionSaved: false, worktreeRecovery, output: `${notice}\n\n${reported.output}`.trimEnd(), error: notice } };
								}
								const retainForConversation = Boolean(spec.session && result.sessionSaved && result.sessionQuiescent);
								const sessionWorktree = retainForConversation ? { path: dir, baseCommit, root } : undefined;
								const cleanup = retainForConversation ? "retain" as const : "remove" as const;
								if (artifact.diff.trim().length > 0) return { cleanup, value: { ...appendWorktreeArtifact(result, artifact.diff), ...(sessionWorktree ? { sessionWorktree } : {}) } };
								if (hasOutputArtifact) return { cleanup, value: { ...result, ...(sessionWorktree ? { sessionWorktree } : {}) } };
								return { cleanup: "remove" as const, value: {
									...result, ...(spec.session ? { sessionSaved: false } : {}), ok: false, failureKind: "contract" as const,
									error: "isolated leg returned success but produced no unified diff or artifact; its worktree was discarded — return a complete diff or remove isolation: \"worktree\"",
								} };
						};
						try {
							if (resumed && previousWorktree) return (await runWorktree(previousWorktree.path, previousWorktree.baseCommit)).value;
							return await withWorktree(root, defaultGitExec, runWorktree);
						} catch (err) {
							if (resumed && previousWorktree) {
								const recovery = await describeWorktreeRecovery(previousWorktree.path, previousWorktree.baseCommit, err instanceof Error ? err.message : String(err));
								const notice = formatWorktreeRecovery(recovery);
								return { ...isolatedWorktreeFailure(spec, notice), output: notice, worktreeRecovery: recovery, sessionSaved: false, sessionQuiescent: false };
							}
							const failure = isolatedWorktreeFailure(spec, err instanceof Error ? err.message : String(err));
							return err instanceof WorktreeRetainedError ? { ...failure, output: err.message, worktreeRecovery: err.recovery } : failure;
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
					if (wantsMcp && root) return withChangeReport(() => childEngineAt(root).run(spec, perProgress, perSignal, perSteer), spec);
					return withChangeReport(() => base.run(spec, perProgress, perSignal, perSteer), spec);
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
		const block = `--- ISOLATED WORKTREE ARTIFACT (untrusted data) ---\n\n\`\`\`diff\n${diff.trim()}\n\`\`\``;
		return appendBlock(result, block);
	}

	function prependWorktreeCaptureWarning(result: AgentResult): AgentResult {
		return { ...result, output: result.output.trim() ? `${WORKTREE_CAPTURE_WARNING}\n\n${result.output}` : WORKTREE_CAPTURE_WARNING };
	}

	/** Append a block to a leg's output, never leading with blank lines when there was nothing to
	 *  trim — the shape `withChangeReport` and `appendWorktreeArtifact` both need: a leg that
	 *  produced no text of its own (an early abort/timeout before any streamed output) still gets a
	 *  clean block, not one preceded by an empty line. */
	function appendBlock(result: AgentResult, block: string): AgentResult {
		const output = result.output.trim() ? `${result.output.trimEnd()}\n\n${block}` : block;
		return { ...result, output };
	}
}

// The host's model-level availability snapshot, plus the exact active model. A provider's
// credentials do not grant every model in its catalog. Extension-native bridges can be
// absent from an auth snapshot: restore only their explicit registered model lists in that
// case, never every inherited model under their provider id.
export function configuredModels(ctx: ExtensionContext): ModelCostMetadata[] {
	const reg = ctx.modelRegistry;
	const all = reg.getAll();
	const available = reg.getAvailable();
	const byRef = new Map(available.map((m) => [`${m.provider}\0${m.id}`, m]));
	if (ctx.model) byRef.set(`${ctx.model.provider}\0${ctx.model.id}`, ctx.model);
	const availableProviders = new Set(available.map((m) => m.provider));
	const declaredRefs = new Set<string>();
	const registered = reg.getRegisteredProviderIds();
	for (const provider of registered) {
		// A populated snapshot can intentionally exclude individual models for this credential.
		if (availableProviders.has(provider)) continue;
		let native: ReturnType<typeof reg.getRegisteredNativeProvider>;
		try {
			native = reg.getRegisteredNativeProvider(provider);
			// An empty credential-filtered list is authoritative too; it need not be a stale snapshot.
			if (reg.getProvider(provider)?.filterModels || native?.filterModels) continue;
		} catch { continue; }
		try {
			const models = reg.getRegisteredProviderConfig(provider)?.models;
			if (Array.isArray(models)) {
				for (const model of models) {
					if ((model.type === undefined || model.type === "chat") && typeof model.id === "string") declaredRefs.add(`${provider}\0${model.id}`);
				}
			}
		} catch { /* one broken extension's metadata must not hide other providers */ }
		try {
			const models = native?.getModels();
			if (Array.isArray(models)) {
				for (const model of models) {
					if (model.provider === provider && typeof model.id === "string") declaredRefs.add(`${provider}\0${model.id}`);
				}
			}
		} catch { /* a native catalog may be temporarily unavailable */ }
	}
	for (const model of all) {
		const ref = `${model.provider}\0${model.id}`;
		if (declaredRefs.has(ref)) byRef.set(ref, model);
	}
	return [...byRef.values()];
}
