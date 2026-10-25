import assert from "node:assert/strict";
import { test } from "node:test";
import { registerExocomProfileTool } from "../../../src/tools/exocom-profile.ts";

test("exocom_profile rejects unknown actions before mutating the profile", async () => {
	const tools = new Map<string, any>();
	let profile: unknown = { availability: "away" };
	registerExocomProfileTool({ registerTool: (tool: any) => tools.set(tool.name, tool) } as never, () => ({
		getProfile: () => profile,
		setProfile: (next: unknown) => { profile = next; },
	}) as never);
	const tool = tools.get("exocom_profile");
	assert.ok(tool);

	await assert.rejects(() => tool.execute("c", { action: "bogus", availability: "busy" }), /action/i);
	assert.deepEqual(profile, { availability: "away" });
});

test("exocom_profile partial set preserves the existing availability", async () => {
	const tools = new Map<string, any>();
	let profile: unknown = { availability: "away" };
	registerExocomProfileTool({ registerTool: (tool: any) => tools.set(tool.name, tool) } as never, () => ({
		getProfile: () => profile,
		setProfile: (next: unknown) => { profile = next; },
	}) as never);
	await tools.get("exocom_profile").execute("c", { action: "set", capabilities: ["Rust"] });
	assert.deepEqual(profile, { capabilities: ["Rust"], availability: "away" });
});
