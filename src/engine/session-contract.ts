import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export const SESSION_CONTRACT_ENV = "PI_PERSONA_SESSION_CONTRACT";
export const SESSION_CONTRACT_ERROR_MARKER = "[pi-persona:session-contract] ";
export const SESSION_CONTRACT_START_REJECTION_MARKER = "[pi-persona:session-contract:resume-start] ";
export const SESSION_CONTRACT_ENTRY = "pi-persona-worker-contract";

/** Stable JSON canonicalization: object key insertion order is not part of the contract. */
function canonical(value: unknown): string {
	const encode = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(encode);
		if (item && typeof item === "object") {
			return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined && typeof v !== "function").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, encode(v)]));
		}
		return item;
	};
	return JSON.stringify(encode(value));
}

function digest(value: object): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

function fingerprint(pi: ExtensionAPI, options: NormalizedBuildSystemPromptOptions) {
	const tools = pi.getAllTools().map((tool) => ({
		name: tool.name, description: tool.description, parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines, reachesTools: tool.reachesTools,
		exposure: tool.exposure, namespace: tool.namespace, annotations: tool.annotations,
	})).sort((a, b) => a.name.localeCompare(b.name));
	const skills = options.skills.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath, baseDir: skill.baseDir, disableModelInvocation: skill.disableModelInvocation })).sort((a, b) => a.name.localeCompare(b.name));
	const groups = {
		"tool selection": { activeTools: [...pi.getActiveTools()].sort(), selectedTools: options.selectedTools, hiddenTools: options.hiddenTools },
		"tool definitions": { tools, toolSnippets: options.toolSnippets, toolGuidelines: options.toolGuidelines },
		"skill catalog": { skills },
		"selected skill instructions": { selectedSkillsSection: options.sections.skills },
		"prompt configuration": {
			promptGuidelines: options.promptGuidelines, customPrompt: options.customPrompt, forceSystemPrompt: options.forceSystemPrompt,
			appendSystemPrompt: options.appendSystemPrompt, contextFiles: options.contextFiles,
		},
	};
	// Keep the canonical v1 payload across persisted sessions. Group digests only explain a rejection.
	return {
		sha256: digest(Object.assign({}, ...Object.values(groups))),
		components: Object.fromEntries(Object.entries(groups).map(([name, fields]) => [name, digest(fields)])),
	};
}

function describeMismatch(actual: Record<string, string>, stored: unknown): string {
	if (stored && typeof stored === "object" && !Array.isArray(stored)) {
		const fields = stored as Record<string, unknown>;
		const names = Object.keys(actual);
		if (names.every((name) => typeof fields[name] === "string" && /^[0-9a-f]{64}$/.test(fields[name]))) {
			const changed = names.filter((name) => actual[name] !== fields[name]);
			if (changed.length) return changed.join(", ");
		}
	}
	return "effective skills, tools or prompt configuration differ";
}

/** Install only for explicitly persisted worker sessions; ordinary workers never call this. */
export function installSessionContract(pi: ExtensionAPI, resume: boolean, options: { onFailure?: (message: string, rejectedAtStart: boolean) => void } = {}): {
	getFailure(): string | undefined;
	wasResumeRejectedAtStart(): boolean;
} {
	let promptOptions: NormalizedBuildSystemPromptOptions | undefined;
	let failure: string | undefined;
	let established: string | undefined;
	let components: unknown;
	let starts = 0;
	let rejectedAtStart = false;
	const fail = (message: string, ctx: Pick<ExtensionContext, "abort">): void => {
		try {
			if (failure === undefined) {
				failure = message;
				// Pi awaits the first agent_start before sending the first inference request. Later
				// agent starts can follow completed turns, which must never be rolled back.
				rejectedAtStart = resume && starts === 1;
				options.onFailure?.(message, rejectedAtStart);
			}
		} finally { ctx.abort(); }
	};
	pi.on("before_agent_start", (event) => { promptOptions = event.systemPromptOptions; });
	pi.on("agent_start", (_event, ctx) => {
		if (failure) return ctx.abort();
		starts++;
		try {
			if (!promptOptions) return fail("Worker contract prompt options are missing", ctx);
			const actual = fingerprint(pi, promptOptions);
			if (established === undefined) {
				const matches = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === SESSION_CONTRACT_ENTRY);
				if (resume) {
					const data = matches.length === 1 && matches[0]?.type === "custom" ? matches[0].data as { version?: unknown; sha256?: unknown; components?: unknown } | undefined : undefined;
					if (data?.version !== 1 || typeof data.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.sha256)) return fail("Worker session contract is missing or invalid", ctx);
					established = data.sha256;
					components = data.components;
				} else {
					if (matches.length !== 0) return fail("Fresh worker session already has a contract", ctx);
					pi.appendEntry(SESSION_CONTRACT_ENTRY, { version: 1, ...actual });
					established = actual.sha256;
					components = actual.components;
				}
			}
			if (actual.sha256 !== established) fail(`Worker session contract changed: ${describeMismatch(actual.components, components)}`, ctx);
		} catch (error) {
			fail(`Cannot verify worker session contract: ${error instanceof Error ? error.message : String(error)}`, ctx);
		}
	});
	return { getFailure: () => failure, wasResumeRejectedAtStart: () => rejectedAtStart };
}

/** Spawn-local entry; missing or invalid private mode fails closed before inference. */
export default function sessionContractExtension(pi: ExtensionAPI): void {
	const mode = process.env[SESSION_CONTRACT_ENV];
	const report = (message: string, rejectedAtStart = false): void => {
		const marker = rejectedAtStart ? SESSION_CONTRACT_START_REJECTION_MARKER : SESSION_CONTRACT_ERROR_MARKER;
		process.stderr.write(`${marker}${message.replace(/[\r\n]/g, " ")}\n`);
		process.exitCode = 1;
	};
	if (mode !== "fresh" && mode !== "resume") {
		pi.on("before_agent_start", (_event, ctx) => { report("Invalid worker session contract mode"); ctx.abort(); });
		return;
	}
	installSessionContract(pi, mode === "resume", { onFailure: report });
}
