import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateNativeTools, cliRemovedToolNames, cliToolLoadoutIsExplicit, nativeToolNames, nativeToolsForHostDefaults, withNativeToolDefaults } from "../../../src/extension/native-tools.ts";

test("native tools include only host-registered tools and platform PowerShell", () => {
	const tools = ["read", "bash", "grep", "find", "ls", "powershell"].map((name) => ({ name, sourceInfo: { source: "builtin" } }));
	assert.deepEqual(nativeToolNames(tools, "win32"), ["grep", "find", "ls", "powershell"]);
	assert.deepEqual(nativeToolNames(tools, "linux"), ["grep", "find", "ls"]);
	assert.deepEqual(nativeToolNames([{ name: "read", sourceInfo: { source: "builtin" } }], "win32"), []);
	assert.deepEqual(nativeToolNames([{ name: "grep", sourceInfo: { source: "extension" } }], "win32"), [], "never activates an extension override as if it were the host implementation");
});

test("activation only adds existing host tools, leaves custom overrides untouched, and preserves active names", () => {
	let active = ["read", "bash", "edit", "write"];
	let writes = 0;
	const pi = {
		getAllTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"].map((name) => ({ name, sourceInfo: { source: "builtin" } })),
		getActiveTools: () => active,
		getSettings: () => ({}),
		setActiveTools: (names: string[]) => { active = names; writes++; },
	};
	activateNativeTools(pi as unknown as ExtensionAPI, "linux");
	assert.deepEqual(active, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	assert.equal(writes, 1);
	activateNativeTools(pi as unknown as ExtensionAPI, "linux");
	assert.equal(writes, 1, "already active host tools are left alone");
	const custom = { ...pi, getAllTools: () => [{ name: "grep", sourceInfo: { source: "extension" } }] };
	activateNativeTools(custom as unknown as ExtensionAPI, "linux");
	assert.equal(writes, 1, "custom override is not touched or activated");
});

test("native activation preserves a loadout with builtins disabled", () => {
	let writes = 0;
	const pi = {
		getAllTools: () => ["grep", "find", "ls"].map((name) => ({ name, sourceInfo: { source: "builtin" } })),
		getActiveTools: () => ["extension-tool"],
		getSettings: () => ({}),
		setActiveTools: () => { writes++; },
	};
	activateNativeTools(pi as unknown as ExtensionAPI, "linux");
	assert.equal(writes, 0);
});

test("an extension tool named read is not evidence that builtin tools are enabled", () => {
	let writes = 0;
	const pi = {
		getAllTools: () => [{ name: "read", sourceInfo: { source: "extension" } }, { name: "grep", sourceInfo: { source: "builtin" } }],
		getActiveTools: () => ["read"], getSettings: () => ({}), setActiveTools: () => { writes++; },
	};
	activateNativeTools(pi as unknown as ExtensionAPI, "linux");
	assert.equal(writes, 0);
});

test("a partial explicit base-tool loadout does not restore default native tools", () => {
	let active = ["read"];
	let writes = 0;
	const pi = {
		getAllTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name, sourceInfo: { source: "builtin" } })),
		getActiveTools: () => active,
		getSettings: () => ({}),
		setActiveTools: (names: string[]) => { active = names; writes++; },
	};
	activateNativeTools(pi as unknown as ExtensionAPI, "linux");
	assert.deepEqual(active, ["read"], "SDK noTools:'builtin' with tools:['+read'] must keep its explicit loadout");
	assert.equal(writes, 0);
});

test("native activation preserves an explicit Pi CLI tool allowlist", () => {
	const previousArgv = process.argv;
	let active = ["read", "bash", "edit", "write"];
	let writes = 0;
	const pi = {
		getAllTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name, sourceInfo: { source: "builtin" } })),
		getActiveTools: () => active,
		getSettings: () => ({}),
		setActiveTools: (names: string[]) => { active = names; writes++; },
	};
	try {
		process.argv = [...previousArgv, "--tools", "read,bash,edit,write"];
		activateNativeTools(pi as unknown as ExtensionAPI, "linux");
		assert.deepEqual(active, ["read", "bash", "edit", "write"]);
		assert.equal(writes, 0);
	} finally {
		process.argv = previousArgv;
	}
});

test("native defaults augment only an absent grant, never an explicit allowlist", () => {
	assert.deepEqual(withNativeToolDefaults(undefined, ["grep", "find", "ls"]), ["+grep", "+find", "+ls"]);
	assert.deepEqual(withNativeToolDefaults([], ["grep"]), []);
	assert.deepEqual(withNativeToolDefaults(["read"], ["grep"]), ["read"]);
	assert.deepEqual(withNativeToolDefaults(["+grep", "-ls"], ["grep", "find", "ls"]), ["+grep", "-ls"]);
	assert.deepEqual(nativeToolsForHostDefaults(undefined, ["grep", "find"]), ["grep", "find"]);
	assert.deepEqual(nativeToolsForHostDefaults(["read", "bash"], ["grep", "find"]), []);
	assert.deepEqual([...cliRemovedToolNames(["pi", "--tools", "+grep,-ls", "--other"])], ["ls"]);
	assert.deepEqual([...cliRemovedToolNames(["pi", "--tools", "+read, -grep", "--other"])], ["grep"]);
	assert.deepEqual([...cliRemovedToolNames(["pi", "--tools=+read,\t-grep "])], ["grep"]);
	assert.deepEqual([...cliRemovedToolNames(["pi", "-t", "+read, -grep"])], ["grep"]);
	assert.deepEqual([...cliRemovedToolNames(["pi", "-t=+read,\t-grep "])], ["grep"]);
	assert.equal(cliToolLoadoutIsExplicit(["pi", "--tools", "read,bash"]), true);
	assert.equal(cliToolLoadoutIsExplicit(["pi", "-t=read,bash"]), true);
	assert.equal(cliToolLoadoutIsExplicit(["pi", "--no-builtin-tools"]), true);
	assert.equal(cliToolLoadoutIsExplicit(["pi", "--other"]), false);
});
