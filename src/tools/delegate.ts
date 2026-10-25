/**
 * The `delegate` tool's pure core: parameter coercion and validation, the task → run-spec mapping,
 * and the anti-loop ledger. A task may carry `skills`/`model`/`tools` to spawn a *dynamic* sub-agent
 * (e.g. the generic `operator` specialised by the skills it loads). Capability gating happens
 * upstream in the `tool_call` hook; launching and settling live in `delegate-tool.ts`.
 */

import { cappedList } from "../core/format.ts";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../core/types.ts";
import { sanitizeDisplayLabel } from "../core/display-label.ts";
import { type AgentRunSpec, type InfrastructureFailure, isInfrastructureFailure, isPositiveFiniteMs } from "../orchestration/sdk.ts";

export interface DelegateTask {
	agent: string;
	task: string;
	/** Structured hand-off context. The integration layer may validate this before spawning. */
	brief?: Partial<DelegationBrief>;
	/** A friendly display name (the loader's choice), to tell sub-agents apart. */
	name?: string;
	/** Skills the sub-agent must load first (dynamic specialisation). */
	skills?: string[];
	/** Model override for this sub-agent. */
	model?: string;
	/** Requested effort for this leg; overrides agent and shared child defaults. Pi clamps it. */
	thinking?: ThinkingLevel;
	/** Tool allowlist override for this sub-agent. */
	tools?: string[];
	/** Extra system-prompt text: an ON-THE-FLY specialist persona, appended to the
	 *  agent's own prompt (prompt-level only — capabilities are still the gate). */
	role?: string;
	/** Run this task in an isolated git worktree (edits never touch the main tree). */
	isolation?: "none" | "worktree";
	/** Route this task through the child engine so the sub-agent's MCP (`mcp*`/direct)
	 *  tools initialize and work (the in-process engine leaves them "not initialized"). */
	mcp?: boolean;
	/** Per-leg override (ms) of the shared idle-timeout ceiling — lets ONE legitimately quiet
	 *  leg wait longer between progress events without changing its siblings' idle window. Ignored
	 *  unless a finite, positive number (junk/≤0 falls back to the engine's default). */
	timeoutMs?: number;
	/** Files/directories this leg may modify. Parallel overlap is rejected before spawning. */
	writeSet?: string[];
	/** Output contract enforced by the engine (for example `finding`). */
	outputContract?: string;
}

export interface DelegateParams {
	agent?: string;
	task?: string;
	brief?: Partial<DelegationBrief>;
	name?: string;
	skills?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	role?: string;
	isolation?: "none" | "worktree";
	mcp?: boolean;
	/** Per-leg override (ms) of the shared idle-timeout ceiling (single mode). Ignored unless a
	 *  finite, positive number (junk/≤0 falls back to the engine's default). */
	timeoutMs?: number;
	writeSet?: string[];
	outputContract?: string;
	tasks?: DelegateTask[];
	concurrency?: number;
}

/** Structured cold-start context that any persona policy may require. */
export interface DelegationBrief {
	objective: string;
	scopeRoe: string;
	position: string;
	constraints: string | readonly string[];
	requiredArtifacts: string | readonly string[];
	stopConditions: string | readonly string[];
}

const BRIEF_FIELDS = ["objective", "scopeRoe", "position", "constraints", "requiredArtifacts", "stopConditions"] as const;

function briefText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function briefItems(value: unknown): string[] {
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

/** Render the brief in a fixed order so a cold-start worker receives identical context every time. */
export function renderDelegationBrief(brief: Partial<DelegationBrief> | undefined): string {
	if (!brief) return "";
	const lines = [
		"[DELEGATION BRIEF]",
		`Objective: ${briefText(brief.objective) || "(missing)"}`,
		`Scope / Rules of Engagement: ${briefText(brief.scopeRoe) || "(missing)"}`,
		`Position: ${briefText(brief.position) || "(missing)"}`,
		"Constraints:",
		...briefItems(brief.constraints).map((item) => `- ${item}`),
		"Required artifacts:",
		...briefItems(brief.requiredArtifacts).map((item) => `- ${item}`),
		"Stop conditions:",
		...briefItems(brief.stopConditions).map((item) => `- ${item}`),
		"[/DELEGATION BRIEF]",
	];
	return lines.join("\n");
}

/**
 * Pure, actionable validation for a policy-enabled integration layer. It intentionally does not
 * reject ordinary backwards-compatible delegate calls; callers opt into this check when they
 * require an evidence-grade hand-off.
 */
export function validateDelegationBrief(params: DelegateParams): string | undefined {
	const targets: Array<{ label: string; brief: Partial<DelegationBrief> | undefined }> = [];
	if (params.tasks && params.tasks.length > 0) {
		params.tasks.forEach((task, index) => targets.push({ label: `tasks[${index}] (${task.agent || "(missing agent)"})`, brief: task.brief }));
	} else if (params.agent !== undefined || params.task !== undefined) {
		targets.push({ label: `agent "${params.agent ?? "(missing)"}"`, brief: params.brief });
	}
	for (const target of targets) {
		const missing = BRIEF_FIELDS.filter((field) => {
			const value = target.brief?.[field];
			return field === "constraints" || field === "requiredArtifacts" || field === "stopConditions"
				? briefItems(value).length === 0
				: briefText(value).length === 0;
		});
		if (missing.length > 0) {
			return (
				`delegate: ${target.label} requires a complete brief; missing or empty: ${missing.join(", ")}. ` +
				`Provide all fields (${BRIEF_FIELDS.join(", ")}) before spawning the policy-controlled leg. ` +
				(params.tasks && params.tasks.length > 0
					? "Put a separate complete brief in every tasks[].brief, including read-only workers; a top-level brief is single-mode only. Correct the batch before retrying."
					: "Put the structured brief in the brief field alongside agent and task; task prose does not replace it.")
			);
		}
	}
	return undefined;
}

function unwrapJsonish(value: unknown, label: string): { ok: true; value: unknown } | { ok: false; error: string } {
	let current = value;
	for (let depth = 0; depth < 2; depth++) {
		if (typeof current !== "string") return { ok: true, value: current };
		const trimmed = current.trim();
		if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return { ok: true, value: current };
		try {
			current = JSON.parse(trimmed);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `delegate: ${label} looks like JSON but did not parse (${detail}). Pass a real array/object, not a string.` };
		}
	}
	return { ok: true, value: current };
}

function coerceStringList(value: unknown, label: string): { ok: true; value?: string[] } | { ok: false; error: string } {
	if (value === undefined) return { ok: true };
	const parsed = unwrapJsonish(value, label);
	if (!parsed.ok) return parsed;
	if (parsed.value === undefined) return { ok: true };
	if (typeof parsed.value === "string") {
		const trimmed = parsed.value.trim();
		return { ok: true, value: trimmed ? [trimmed] : [] };
	}
	if (!Array.isArray(parsed.value)) return { ok: false, error: `delegate: ${label} must be an array of strings.` };
	const out: string[] = [];
	for (let i = 0; i < parsed.value.length; i++) {
		const item = parsed.value[i];
		if (typeof item !== "string") return { ok: false, error: `delegate: ${label}[${i}] must be a string.` };
		out.push(item);
	}
	return { ok: true, value: out };
}

function coerceBriefField(value: unknown, label: string): { ok: true; value?: Partial<DelegationBrief> } | { ok: false; error: string } {
	if (value === undefined) return { ok: true };
	const parsed = unwrapJsonish(value, label);
	if (!parsed.ok) return parsed;
	if (parsed.value === undefined) return { ok: true };
	if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
		return { ok: false, error: `delegate: ${label} must be an object.` };
	}
	const brief = { ...(parsed.value as Record<string, unknown>) };
	for (const field of ["objective", "scopeRoe", "position"] as const) {
		if (typeof brief[field] !== "string") {
			return { ok: false, error: `delegate: ${label}.${field} must be a string.` };
		}
	}
	for (const field of ["constraints", "requiredArtifacts", "stopConditions"] as const) {
		const list = coerceStringList(brief[field], `${label}.${field}`);
		if (!list.ok) return list;
		if (list.value === undefined) return { ok: false, error: `delegate: ${label}.${field} is required.` };
		brief[field] = list.value;
	}
	return { ok: true, value: brief as Partial<DelegationBrief> };
}

function decodedTaskFieldError(bag: Record<string, unknown>, index: number): string | undefined {
	const label = `tasks[${index}]`;
	for (const field of ["agent", "task"] as const) {
		if (typeof bag[field] !== "string") return `delegate: ${label}.${field} must be a string.`;
	}
	for (const field of ["name", "role", "model", "outputContract"] as const) {
		if (bag[field] !== undefined && typeof bag[field] !== "string") {
			return `delegate: ${label}.${field} must be a string.`;
		}
	}
	if (bag.thinking !== undefined && !isThinkingLevel(bag.thinking)) {
		return `delegate: ${label}.thinking must be one of: ${THINKING_LEVELS.join(", ")}.`;
	}
	if (bag.isolation !== undefined && bag.isolation !== "none" && bag.isolation !== "worktree") {
		return `delegate: ${label}.isolation must be "none" or "worktree".`;
	}
	if (bag.mcp !== undefined && typeof bag.mcp !== "boolean") return `delegate: ${label}.mcp must be a boolean.`;
	if (bag.timeoutMs !== undefined && (typeof bag.timeoutMs !== "number" || !Number.isFinite(bag.timeoutMs))) {
		return `delegate: ${label}.timeoutMs must be a finite number.`;
	}
	return undefined;
}

function coerceOneTask(raw: unknown, index: number): { ok: true; task: DelegateTask } | { ok: false; error: string } {
	const parsed = unwrapJsonish(raw, `tasks[${index}]`);
	if (!parsed.ok) return parsed;
	if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
		return { ok: false, error: `delegate: tasks[${index}] must be an object.` };
	}
	const bag = { ...(parsed.value as Record<string, unknown>) };
	const fieldError = decodedTaskFieldError(bag, index);
	if (fieldError) return { ok: false, error: fieldError };
	const brief = coerceBriefField(bag.brief, `tasks[${index}].brief`);
	if (!brief.ok) return brief;
	if (brief.value !== undefined) bag.brief = brief.value;
	const writeSet = coerceStringList(bag.writeSet, `tasks[${index}].writeSet`);
	if (!writeSet.ok) return writeSet;
	if (writeSet.value !== undefined) bag.writeSet = writeSet.value;
	const skills = coerceStringList(bag.skills, `tasks[${index}].skills`);
	if (!skills.ok) return skills;
	if (skills.value !== undefined) bag.skills = skills.value;
	const tools = coerceStringList(bag.tools, `tasks[${index}].tools`);
	if (!tools.ok) return tools;
	if (tools.value !== undefined) bag.tools = tools.value;
	return { ok: true, task: bag as unknown as DelegateTask };
}

function coerceTaskList(value: unknown): { ok: true; value?: DelegateTask[] } | { ok: false; error: string } {
	if (value === undefined) return { ok: true };
	const parsed = unwrapJsonish(value, "tasks");
	if (!parsed.ok) return parsed;
	let list: unknown = parsed.value;
	if (list !== null && typeof list === "object" && !Array.isArray(list)) list = [list];
	if (!Array.isArray(list)) return { ok: false, error: "delegate: tasks must be an array of objects, not a string." };
	const tasks: DelegateTask[] = [];
	for (let i = 0; i < list.length; i++) {
		const task = coerceOneTask(list[i], i);
		if (!task.ok) return task;
		tasks.push(task.task);
	}
	return { ok: true, value: tasks };
}

/**
 * Models often stringify nested `tasks`/`brief`/`writeSet`. Unwrap JSON text so a 9k-character
 * string is not validated as `tasks.0` (first character) or rendered as `parallel (9445)`.
 */
export function coerceDelegateParams(raw: unknown): { ok: true; params: DelegateParams } | { ok: false; error: string } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: "delegate: arguments must be an object." };
	}
	const bag = { ...(raw as Record<string, unknown>) };
	if (bag.thinking !== undefined && !isThinkingLevel(bag.thinking)) {
		return { ok: false, error: `delegate: thinking must be one of: ${THINKING_LEVELS.join(", ")}.` };
	}
	const tasks = coerceTaskList(bag.tasks);
	if (!tasks.ok) return tasks;
	if (tasks.value !== undefined) bag.tasks = tasks.value;
	const brief = coerceBriefField(bag.brief, "brief");
	if (!brief.ok) return brief;
	if (brief.value !== undefined) bag.brief = brief.value;
	const writeSet = coerceStringList(bag.writeSet, "writeSet");
	if (!writeSet.ok) return writeSet;
	if (writeSet.value !== undefined) bag.writeSet = writeSet.value;
	const skills = coerceStringList(bag.skills, "skills");
	if (!skills.ok) return skills;
	if (skills.value !== undefined) bag.skills = skills.value;
	const tools = coerceStringList(bag.tools, "tools");
	if (!tools.ok) return tools;
	if (tools.value !== undefined) bag.tools = tools.value;
	return { ok: true, params: bag as DelegateParams };
}

/** Short model name for display: drop provider + `claude-`; model ids remain opaque. */
export function shortModel(ref: string | undefined): string {
	if (!ref) return "";
	const base = ref.split("/").pop() ?? ref;
	return base.replace(/^claude-/, "");
}

/** The bare display NAME for a sub-agent (no model suffix): the loader's name, or a codename
 *  for a generic operator, else the agent's own name. Exported so a caller that folds in the
 *  model itself (e.g. the async tree node, `AsyncRun.label`). */
export function nameFor(t: { agent: string; name?: string }, index: number): string {
	// No catalog of call-signs: an unnamed generic operator stays the agent name, disambiguated
	// by index. The model is supposed to invent `<call-sign>-<purpose>` itself; this is only the
	// honest fallback when it doesn't.
	const fallback = t.agent === "operator" && index > 0 ? `operator-${index + 1}` : t.agent;
	return sanitizeDisplayLabel(t.name?.trim() || fallback, fallback);
}

/** Normalize an LLM-authored concurrency request once for scheduling and policy gates.
 * Fractional/non-finite inputs fail toward serialization instead of rounding up. */
export function normalizeDelegateConcurrency(value: number | undefined, maximum: number): number {
	const ceiling = Math.max(1, Number.isFinite(maximum) ? Math.floor(maximum) : 1);
	if (value === undefined) return ceiling;
	if (!Number.isFinite(value)) return 1;
	return Math.min(ceiling, Math.max(1, Math.floor(value)));
}

/** Map a task to the run-spec fields the engine accepts — the single source of truth for the
 *  delegate path's field mapping (a second copy is how a per-leg knob like `timeoutMs` silently
 *  misses one launch route). */
export function specOf(t: DelegateTask, index = 0): AgentRunSpec {
	const renderedBrief = renderDelegationBrief(t.brief);
	const spec: AgentRunSpec = {
		agent: t.agent,
		name: nameFor(t, index),
		task: renderedBrief ? `${t.task}\n\n${renderedBrief}` : t.task,
	};
	if (t.skills && t.skills.length > 0) spec.skills = t.skills;
	if (t.model) spec.model = t.model;
	if (t.thinking !== undefined) spec.thinking = t.thinking;
	if (t.tools !== undefined) spec.tools = t.tools;
	if (t.role?.trim()) spec.role = t.role.trim();
	if (t.outputContract?.trim()) spec.outputContract = t.outputContract.trim();
	if (t.isolation !== undefined) spec.isolation = t.isolation;
	if (t.mcp !== undefined) spec.mcp = t.mcp;
	if (isPositiveFiniteMs(t.timeoutMs)) spec.timeoutMs = t.timeoutMs;
	if (t.writeSet && t.writeSet.length > 0) spec.writeSet = [...t.writeSet];
	return spec;
}

/**
 * Anti-loop ledger — the RUNTIME guard behind "do not re-issue the same failing
 * delegation" (never prompt-only, per the capability guardrails). Tracks consecutive
 * failures per (agent, model, task): after {@link MAX_IDENTICAL_FAILURES} identical
 * failures the delegation is vetoed before anything spawns, so a supervisor that
 * ignores the guidance physically cannot burn tokens on the same dead end. Changing
 * the model or the task is a NEW key — "retry once with a different model" stays open.
 */
export const MAX_IDENTICAL_FAILURES = 2;

/** The fields a delegation is keyed on — always `agent+model+task`; `role`/`tools`/`isolation`
 *  additionally fold into the key when {@link DelegationLedger}'s `ledgerV2` is on. */
export interface DelegationKeyInput {
	agent: string;
	model?: string;
	task: string;
	role?: string;
	tools?: string[];
	isolation?: string;
}

/** The ledger's view of a task or run spec: just the key fields, absent when unset. */
export function keyInputOf(t: Pick<DelegateTask, "agent" | "task" | "model" | "role" | "tools" | "isolation">): DelegationKeyInput {
	return {
		agent: t.agent,
		task: t.task,
		...(t.model ? { model: t.model } : {}),
		...(t.role ? { role: t.role } : {}),
		...(t.tools !== undefined ? { tools: t.tools } : {}),
		...(t.isolation ? { isolation: t.isolation } : {}),
	};
}

export class DelegationLedger {
	private readonly failures = new Map<string, number>();
	private readonly maxKeys = 200;
	private readonly ledgerV2: boolean;

	/** `ledgerV2` (PI_PERSONA_LEDGER_V2, default false) widens the veto key — see {@link key}. */
	constructor(opts?: { ledgerV2?: boolean }) {
		this.ledgerV2 = opts?.ledgerV2 ?? false;
	}

	/** OFF (default): EXACTLY today's `agent+model+task` key — the observable veto *behavior*
	 *  is preserved (record and vet always route through this SAME function, so whatever
	 *  separator is in play cancels out on both sides), though the key *bytes* did change
	 *  (NUL → space → `\x1f` across this batch). ON: additionally folds in `role` + a
	 *  stable-sorted `tools` join + `isolation`, so a genuine retry that changes only one of
	 *  those isn't falsely vetoed as "identical". `role` is trimmed and `isolation` is
	 *  collapsed to just "worktree" vs. everything else — normalized HERE, not by the caller
	 *  — so a record() fed a normalized spec (e.g. the async fan-out, post-`specOf()`) and a
	 *  vet() fed raw params (e.g. `isolation: "none"`, an untrimmed `role`) key IDENTICALLY;
	 *  otherwise the 2-strike veto could silently never fire for that class of retry. */
	private key(t: DelegationKeyInput): string {
		const SEP = "\x1f"; // collision-proof (no field can contain it) without making git see the file as binary (NUL did)
		const base = `${t.agent}${SEP}${t.model ?? ""}${SEP}${t.task}`;
		if (!this.ledgerV2) return base;
		const role = t.role?.trim() ?? "";
		const toolsKey = t.tools === undefined ? "<session-default>" : JSON.stringify([...t.tools].sort());
		const isolation = t.isolation === "worktree" ? "worktree" : "";
		return `${base}${SEP}${role}${SEP}${toolsKey}${SEP}${isolation}`;
	}

	/** Record a settled delegation; success clears the key (it may be retried again later). */
	record(t: DelegationKeyInput, ok: boolean): void {
		const k = this.key(t);
		if (ok) {
			this.failures.delete(k);
			return;
		}
		this.failures.set(k, (this.failures.get(k) ?? 0) + 1);
		// Bounded: evict the oldest key (Map preserves insertion order).
		if (this.failures.size > this.maxKeys) {
			const oldest = this.failures.keys().next().value;
			if (oldest !== undefined) this.failures.delete(oldest);
		}
	}

	/** A veto message when any task already failed identically MAX times, else undefined. */
	vet(tasks: DelegationKeyInput[]): string | undefined {
		const blocked = tasks.filter((t) => (this.failures.get(this.key(t)) ?? 0) >= MAX_IDENTICAL_FAILURES);
		if (blocked.length === 0) return undefined;
		const who = blocked.map((t) => `"${t.agent}"${t.model ? ` (${t.model})` : ""}`).join(", ");
		return (
			`delegate: this exact delegation to ${who} already failed ${MAX_IDENTICAL_FAILURES}× — nothing was spawned. ` +
			"Change the approach: a different model, a reworded/smaller task, another agent — or report the blocker to the user."
		);
	}
}

/**
 * Is a settled delegation EVIDENCE against re-issuing it — i.e. worth a strike toward the
 * {@link MAX_IDENTICAL_FAILURES} permanent veto? Two outcomes are terminal without being evidence:
 * an operator abort is cancellation, and an engine REJECTION is the harness breaking (see
 * {@link isInfrastructureFailure}) — a full disk or a crashed adapter says nothing about whether the
 * delegation was a good idea, and two of them would blacklist a task that was never really attempted.
 */
export function shouldRecordDelegationOutcome(result: Partial<InfrastructureFailure>): boolean {
	return result.failureKind !== "abort" && !isInfrastructureFailure(result);
}

/** Quote each name for an inline error list: `"a", "b"`. */
function quoted(names: string[]): string {
	return names.map((n) => `"${n}"`).join(", ");
}

/**
 * Pre-spawn agent validation for the `delegate` tool — mirrors the model-name path
 * (extension.ts's `resolveDelegateModels`): a wrong agent name must return a SELF-CORRECTING
 * error naming the installed agents BEFORE anything spawns, instead of the engine's late bare
 * failure. Nothing spawns ⇒ nothing is recorded, so a typo never counts toward the
 * {@link DelegationLedger} veto. Empty registry ⇒ the fresh-install guidance (opt-in seeding
 * means a new install has zero agents while the tool is already advertised).
 */
export function unknownAgentError(requested: string[], installed: string[]): string | undefined {
	const unknown = [...new Set(requested.filter((n) => !installed.includes(n)))];
	if (unknown.length === 0) return undefined;
	const who = quoted(unknown);
	if (installed.length === 0) {
		return (
			`delegate: no sub-agents are installed, so ${who} cannot run — nothing was spawned. ` +
			"Ask the user to run `/persona seed` once (it installs the bundled agents), or add agent files under `.pi/agents/`."
		);
	}
	return (
		`delegate: unknown agent(s) ${who} — nothing was spawned. Installed agents: ${cappedList(installed, 16)}. ` +
		"Pick one of those, or shape `operator` on the fly with `role` + `skills`."
	);
}

/** Pre-spawn contract validation (same all-or-nothing rule as `unknownAgentError`): a spec that
 *  names an output contract that is not installed is rejected before ANY leg spawns, with the
 *  installed names so the caller can self-correct — and never counts as a ledger strike. */
export function unknownContractError(requested: Array<string | undefined>, installed: string[]): string | undefined {
	const wanted = [...new Set(requested.map((n) => n?.trim()).filter((n): n is string => Boolean(n)))];
	const unknown = wanted.filter((n) => !installed.includes(n));
	if (unknown.length === 0) return undefined;
	return (
		`delegate: unknown output contract(s) ${quoted(unknown)} — nothing was spawned. Installed contracts: ${cappedList(installed, 16)}. ` +
		"`outputContract` takes a contract NAME; omit it for free-form output and describe the report shape in `requiredArtifacts`."
	);
}
