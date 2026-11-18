import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export const SESSION_CONTRACT_ENV = "PI_PERSONA_SESSION_CONTRACT";
export const SESSION_CONTRACT_ERROR_MARKER = "[pi-persona:session-contract] ";
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

function fingerprint(pi: ExtensionAPI, options: NormalizedBuildSystemPromptOptions): string {
	const tools = pi.getAllTools().map((tool) => ({
		name: tool.name, description: tool.description, parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines, reachesTools: tool.reachesTools,
		exposure: tool.exposure, namespace: tool.namespace, annotations: tool.annotations,
	})).sort((a, b) => a.name.localeCompare(b.name));
	const skills = options.skills.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath, baseDir: skill.baseDir, disableModelInvocation: skill.disableModelInvocation })).sort((a, b) => a.name.localeCompare(b.name));
	const stable = {
		activeTools: [...pi.getActiveTools()].sort(), tools, skills,
		selectedTools: options.selectedTools, hiddenTools: options.hiddenTools,
		toolSnippets: options.toolSnippets, toolGuidelines: options.toolGuidelines, promptGuidelines: options.promptGuidelines,
		customPrompt: options.customPrompt, forceSystemPrompt: options.forceSystemPrompt,
		appendSystemPrompt: options.appendSystemPrompt, contextFiles: options.contextFiles,
		selectedSkillsSection: options.sections.skills,
	};
	return createHash("sha256").update(canonical(stable)).digest("hex");
}

/** Install only for explicitly persisted worker sessions; ordinary workers never call this. */
export function installSessionContract(pi: ExtensionAPI, resume: boolean, options: { onFailure?: (message: string) => void } = {}): { getFailure(): string | undefined } {
	let promptOptions: NormalizedBuildSystemPromptOptions | undefined;
	let failure: string | undefined;
	let established: string | undefined;
	const fail = (message: string, ctx: Pick<ExtensionContext, "abort">): void => {
		try {
			if (failure === undefined) { failure = message; options.onFailure?.(message); }
		} finally { ctx.abort(); }
	};
	pi.on("before_agent_start", (event) => { promptOptions = event.systemPromptOptions; });
	pi.on("agent_start", (_event, ctx) => {
		if (failure) return ctx.abort();
		try {
			if (!promptOptions) return fail("Worker contract prompt options are missing", ctx);
			const actual = fingerprint(pi, promptOptions);
			if (established === undefined) {
				const matches = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === SESSION_CONTRACT_ENTRY);
				if (resume) {
					const data = matches.length === 1 && matches[0]?.type === "custom" ? matches[0].data as { version?: unknown; sha256?: unknown } | undefined : undefined;
					if (data?.version !== 1 || typeof data.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.sha256)) return fail("Worker session contract is missing or invalid", ctx);
					established = data.sha256;
				} else {
					if (matches.length !== 0) return fail("Fresh worker session already has a contract", ctx);
					pi.appendEntry(SESSION_CONTRACT_ENTRY, { version: 1, sha256: actual });
					established = actual;
				}
			}
			if (actual !== established) fail("Worker session contract changed: effective skills, tools or prompt configuration differ", ctx);
		} catch (error) {
			fail(`Cannot verify worker session contract: ${error instanceof Error ? error.message : String(error)}`, ctx);
		}
	});
	return { getFailure: () => failure };
}

/** Spawn-local entry; missing or invalid private mode fails closed before inference. */
export default function sessionContractExtension(pi: ExtensionAPI): void {
	const mode = process.env[SESSION_CONTRACT_ENV];
	const report = (message: string): void => {
		process.stderr.write(`${SESSION_CONTRACT_ERROR_MARKER}${message.replace(/[\r\n]/g, " ")}\n`);
		process.exitCode = 1;
	};
	if (mode !== "fresh" && mode !== "resume") {
		pi.on("before_agent_start", (_event, ctx) => { report("Invalid worker session contract mode"); ctx.abort(); });
		return;
	}
	installSessionContract(pi, mode === "resume", { onFailure: report });
}
