import { parseFrontmatter, type ExtensionAPI, type ExtensionContext, type NormalizedBuildSystemPromptOptions, type Skill } from "@earendil-works/pi-coding-agent";
import { readBoundedRegularFile } from "../io/read-bounded-file.ts";

export const SELECTED_SKILLS_ENV = "PI_PERSONA_SELECTED_SKILLS";
export const SELECTED_SKILLS_ERROR_MARKER = "[pi-persona:selected-skills] ";
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_NAMES_BYTES = 8 * 1024;
const OPAQUE_PROMPT_ERROR = "Selected skills cannot be installed with an opaque system prompt override";

export class SelectedSkillsError extends Error {
	constructor(message: string) { super(message); this.name = "SelectedSkillsError"; }
}

/** Bound the spawn-local environment and reject malformed names before process creation. */
export function encodeSelectedSkills(names: readonly string[]): string {
	if (names.some((name) => typeof name !== "string" || !name.trim() || name !== name.trim() || /[\x00-\x1f\x7f-\x9f]/.test(name))) {
		throw new SelectedSkillsError("Selected skill names must be nonempty exact names without control characters");
	}
	const encoded = JSON.stringify([...new Set(names)]);
	if (Buffer.byteLength(encoded, "utf8") > MAX_NAMES_BYTES) throw new SelectedSkillsError("Selected skill names exceed the 8 KiB limit");
	return encoded;
}

async function readBounded(skill: Skill, signal?: AbortSignal): Promise<{ text: string; bytes: number }> {
	const label = `Selected skill ${JSON.stringify(skill.name)}`;
	const data = await readBoundedRegularFile(skill.filePath, { label, maxBytes: MAX_SKILL_BYTES, limitLabel: "64 KiB" }, signal);
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
	catch { throw new SelectedSkillsError(`${label} is not valid UTF-8`); }
	const { frontmatter, body } = parseFrontmatter(text);
	if (frontmatter["disable-model-invocation"] === true) throw new SelectedSkillsError(`${label} is disabled for model invocation`);
	if (typeof frontmatter.name === "string" && frontmatter.name !== skill.name) throw new SelectedSkillsError(`${label} name changed to ${JSON.stringify(frontmatter.name)}`);
	return { text: body, bytes: data.length };
}

export function installSelectedSkills(
	pi: ExtensionAPI,
	names: readonly string[],
	options: { signal?: AbortSignal; onFailure?: (message: string) => void } = {},
): { getFailure(): string | undefined } {
	const frozen = JSON.parse(encodeSelectedSkills(names)) as string[];
	let failure: string | undefined;
	let prepared: Promise<string> | undefined;
	if (frozen.length === 0) return { getFailure: () => failure };
	let promptOptions: NormalizedBuildSystemPromptOptions | undefined;
	let preparedSection: string | undefined;
	const fail = (error: unknown, ctx: Pick<ExtensionContext, "abort">): void => {
		try {
			if (failure === undefined) {
				failure = error instanceof Error ? error.message : String(error);
				options.onFailure?.(failure);
			}
		} finally { ctx.abort(); }
	};
	pi.on("before_agent_start", async (event, ctx) => {
		promptOptions = event.systemPromptOptions;
		try {
			if (promptOptions.forceSystemPrompt !== undefined) throw new SelectedSkillsError(OPAQUE_PROMPT_ERROR);
			prepared ??= (async () => {
				let total = 0;
				const sections: string[] = [];
				for (const name of frozen) {
					const skill = event.systemPromptOptions.skills.find((entry) => entry.name === name);
					if (!skill) throw new SelectedSkillsError(`Selected skill ${JSON.stringify(name)} is unavailable in this worker`);
					if (skill.disableModelInvocation) throw new SelectedSkillsError(`Selected skill ${JSON.stringify(name)} is disabled for model invocation`);
					let body: { text: string; bytes: number };
					try { body = await readBounded(skill, options.signal ?? ctx.signal); }
					catch (error) {
						if (error instanceof SelectedSkillsError) throw error;
						throw new SelectedSkillsError(`Cannot read selected skill ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`);
					}
					total += body.bytes;
					if (total > MAX_TOTAL_BYTES) throw new SelectedSkillsError("Selected skills exceed the 256 KiB aggregate limit");
					sections.push(`Skill ${JSON.stringify(name)}; location ${JSON.stringify(skill.filePath)}; references relative to ${JSON.stringify(skill.baseDir)}:\n${body.text}`);
				}
				return `Selected skill instructions (already loaded; use the stated directory for relative references):\n\n${sections.join("\n\n")}`;
			})();
			preparedSection = await prepared;
			promptOptions.sections.skills = preparedSection;
		} catch (error) {
			fail(error, ctx);
		}
	});
	// Pi awaits agent_start after every before_agent_start handler and before the first request.
	// Check the final shared options, including handlers that replace the sections object.
	pi.on("agent_start", (_event, ctx) => {
		if (failure !== undefined) return ctx.abort();
		if (promptOptions?.forceSystemPrompt !== undefined) return fail(OPAQUE_PROMPT_ERROR, ctx);
		if (preparedSection === undefined || promptOptions?.sections.skills !== preparedSection) {
			fail("Selected skills section was replaced before the provider request", ctx);
		}
	});
	return { getFailure: () => failure };
}
