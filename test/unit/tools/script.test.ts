import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerScriptTool } from "../../../src/tools/script.ts";

function harness(allowed = true, shell = { shell: "bash", args: ["-c"] as string[], commandTransport: "argv" as "argv" | "stdin" }) {
	let tool: any;
	const specs: any[] = [];
	const stopped: string[] = [];
	const shellPaths: (string | undefined)[] = [];
	registerScriptTool({ registerTool: (value: any) => { tool = value; }, getSettings: () => ({ shellPath: "/configured/bash" }) } as ExtensionAPI, {
		lastCtx: undefined, canRun: () => allowed, resolveShell: (shellPath) => { shellPaths.push(shellPath); return shell; },
		scripts: {
			arm: (spec: any) => { specs.push(spec); return { ok: true as const, entry: { ...spec, id: "script-1", startedAtEpochMs: 0, expiresAtEpochMs: 60_000 } }; },
			list: () => [], cancel: (id: string) => { stopped.push(id); return true; },
		},
	});
	return { tool, specs, stopped, shellPaths, run: (params: any, signal?: AbortSignal, hasUI = true) => tool.execute("id", params, signal, undefined, { cwd: "workspace", hasUI }) };
}

test("script launches literal argv or inline shell source without blocking", async () => {
	const h = harness();
	assert.equal((await h.run({ action: "run", command: "python", args: ["-c", "print('ok')"], label: "python" })).details.ok, true);
	assert.deepEqual(h.specs[0].args, ["-c", "print('ok')"]);
	assert.equal(h.specs[0].mode, "exit");
	assert.equal(h.specs[0].cwd, "workspace");
	const result = await h.run({ action: "run", code: "npm test\nprintf done", label: "tests" });
	assert.deepEqual(h.specs[1].args, ["-c", "npm test\nprintf done"]);
	assert.deepEqual(h.shellPaths, ["/configured/bash"]);
	assert.match(result.content[0].text, /end your turn/i);
});

test("script respects the host shell stdin transport", async () => {
	const h = harness(true, { shell: "bash.exe", args: ["-s"], commandTransport: "stdin" });
	await h.run({ action: "run", code: "npm test", label: "test" });
	assert.deepEqual(h.specs[0].args, ["-s"]);
	assert.equal(h.specs[0].stdin, "npm test");
});

test("headless script receipts describe shutdown honestly instead of promising a later wake", async () => {
	const h = harness();
	const result = await h.run({ action: "run", command: "node", label: "job" }, undefined, false);
	assert.match(result.content[0].text, /Headless pi -p: the process exits when this turn settles/);
	assert.doesNotMatch(result.content[0].text, /completion wakes you when/i);
});

test("script start cards show label and countdown, with the complete literal receipt on expansion", async () => {
	const h = harness();
	const result = await h.run({ action: "run", command: "node", label: "build project" });
	result.details.expiresAtEpochMs = Date.now() + 60_000;
	const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
	const render = (expanded: boolean) => h.tool.renderResult(result, { expanded }, theme).render(180).join("\n");
	assert.match(render(false), /^started build project · deadline in /);
	assert.doesNotMatch(render(false), /Started script-1|wakes you|1970-/);
	assert.match(render(true), /Started script-1/);
	assert.match(render(true), /end your\s+turn/);
});

test("script validates ambiguous commands and checks permission and cancellation before launch", async () => {
	const h = harness();
	for (const params of [
		{ action: "run", command: "node", code: "npm test", label: "bad" },
		{ action: "run", code: "npm test", args: ["arg"], label: "bad" },
		{ action: "run", label: "bad" },
		{ action: "run", code: " ", label: "bad" },
		{ action: "run", command: "node", label: "bad", timeoutSeconds: NaN },
	]) assert.equal((await h.run(params)).details.ok, false);
	assert.equal((await h.run({ action: "run", code: "npm test", label: "bad" }, AbortSignal.abort())).details.ok, false);
	assert.equal(h.specs.length, 0);
	const denied = harness(false);
	assert.equal((await denied.run({ action: "run", code: "npm test", label: "bad" })).details.ok, false);
	assert.equal((await denied.run({ action: "stop", id: "script-1" })).details.ok, true);
	assert.deepEqual(denied.stopped, ["script-1"]);
});
