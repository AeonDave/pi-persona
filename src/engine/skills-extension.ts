/** Private child-process entry. Loaded only for a selected-skills leg. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSelectedSkills, SELECTED_SKILLS_ENV, SELECTED_SKILLS_ERROR_MARKER } from "./skills.ts";

export default function selectedSkillsExtension(pi: ExtensionAPI): void {
	let names: string[];
	try {
		const parsed: unknown = JSON.parse(process.env[SELECTED_SKILLS_ENV] ?? "null");
		if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === "string") || parsed.length === 0) throw new Error("Invalid selected skill names");
		names = parsed;
	} catch {
		// A malformed spawn-local contract must never start a provider request.
		names = [""];
	}
	try {
		installSelectedSkills(pi, names, { onFailure(message) {
			process.stderr.write(`${SELECTED_SKILLS_ERROR_MARKER}${message.replace(/[\r\n]/g, " ")}\n`);
			process.exitCode = 1;
		} });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pi.on("before_agent_start", (_event, ctx) => {
			process.stderr.write(`${SELECTED_SKILLS_ERROR_MARKER}${message.replace(/[\r\n]/g, " ")}\n`);
			process.exitCode = 1;
			ctx.abort();
		});
	}
}
