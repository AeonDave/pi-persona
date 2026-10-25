import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { registerExocomProfileTool } from "../../../src/tools/exocom-profile.ts";

initTheme("dark");

function mockPi() {
	const tools = new Map<string, any>();
	return { pi: { registerTool: (tool: any) => tools.set(tool.name, tool) } as never, tools };
}

const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

test("exocom_profile registers get, set, and clear actions on a live plane accessor", async () => {
	const m = mockPi();
	let profile: any;
	const plane: any = { getProfile: () => profile, setProfile: (next: unknown) => { profile = next; } };
	let active: any = plane;
	registerExocomProfileTool(m.pi, () => active);
	const tool = m.tools.get("exocom_profile");
	assert.ok(tool);
	assert.equal((await tool.execute("c", { action: "get" })).content[0].text, "No profile reported; availability is unknown.");
	await tool.execute("c", { action: "set", capabilities: ["TypeScript", "Rust"], availability: "available" });
	assert.deepEqual(profile, { capabilities: ["TypeScript", "Rust"], availability: "available" });
	const current = await tool.execute("c", { action: "get" });
	assert.match(current.content[0].text, /self-reported availability: available/i);
	assert.match(current.content[0].text, /TypeScript · Rust/);
	await tool.execute("c", { action: "clear" });
	assert.equal(profile, undefined);
	active = undefined;
	await assert.rejects(() => tool.execute("c", { action: "get" }), /not active/i);
	await assert.rejects(() => tool.execute("c", { action: "set", capabilities: ["Rust"] }), /not active/i);
});

test("exocom_profile requires an update and renders bounded sanitized content", async () => {
	const m = mockPi();
	let profile: any;
	registerExocomProfileTool(m.pi, () => ({ getProfile: () => profile, setProfile: (next: unknown) => { profile = next; } }) as never);
	const tool = m.tools.get("exocom_profile");
	await assert.rejects(() => tool.execute("c", { action: "set" }), /at least one/i);
	await tool.execute("c", { action: "set", capabilities: ["Rust\n<admin>", "x".repeat(100)] });
	assert.deepEqual(profile, { capabilities: ["Rust admin", "x".repeat(48)] });
	const rendered = stripVTControlCharacters(tool.renderResult(
		{ content: [{ type: "text", text: "" }], details: { action: "set", profile } },
		{ expanded: false }, plainTheme,
	).render(60).join("\n"));
	assert.ok(rendered.split("\n").every((line: string) => line.length <= 60));
	assert.match(rendered, /Rust admin/);
	assert.doesNotMatch(rendered, /<admin>|x{49}/);
});
