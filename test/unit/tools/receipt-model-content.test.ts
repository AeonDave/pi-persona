/**
 * Byte-identity pins for the model-facing side of every tool whose receipt renderer was trimmed to
 * "new facts only". The renderers may change what the operator sees; the tool result content and
 * the persisted `details` the model and the session file receive must stay exactly these bytes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AsyncRunTracker } from "../../../src/engine/async.ts";
import { TimerScheduler } from "../../../src/core/timer.ts";
import { Semaphore } from "../../../src/orchestration/parallel.ts";
import { createBackgroundRuns } from "../../../src/tools/background-run.ts";
import { registerMonitorTool } from "../../../src/tools/monitor.ts";
import { registerTimerTool } from "../../../src/tools/timer.ts";
import { registerScriptTool } from "../../../src/tools/script.ts";
import { registerCouncilTool } from "../../../src/tools/council.ts";
import { registerFlowTool } from "../../../src/tools/flow.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";
import { ChildUsageLedger } from "../../../src/ui/usage.ts";

const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function capture(register: (api: ExtensionAPI) => void): any {
	let tool: any;
	register({ registerTool: (t: unknown) => { tool = t; }, getSettings: () => ({}) } as unknown as ExtensionAPI);
	return tool;
}

function tools() {
	const monitor = capture((api) => registerMonitorTool(api, {
		lastCtx: undefined, canRun: () => true,
		monitors: { arm: (spec: any) => ({ ok: true as const, entry: { ...spec, id: "monitor-1", startedAtEpochMs: 0, expiresAtEpochMs: 600_000 } }), list: () => [], cancel: () => true },
	} as any));
	const timer = capture((api) => registerTimerTool(api, {
		lastCtx: undefined,
		timerScheduler: new TimerScheduler({ now: () => 1_000_000, setTimer: () => 1, clearTimer: () => {}, onFire: () => {} }),
	}));
	const script = capture((api) => registerScriptTool(api, {
		lastCtx: undefined, canRun: () => true, resolveShell: () => ({ shell: "bash", args: ["-c"], commandTransport: "argv" }),
		scripts: { arm: (spec: any) => ({ ok: true as const, entry: { ...spec, id: "script-1", startedAtEpochMs: 0, expiresAtEpochMs: 600_000 } }), list: () => [], cancel: () => true },
	} as any));
	const runs = () => createBackgroundRuns({
		tracker: new AsyncRunTracker(), agentTree: new AgentTree(), stopRegistry: new Map(), slots: new Semaphore(4),
		completionNotifier: { discard: () => {} }, startPeek: () => {}, childUsage: new ChildUsageLedger(), publishPersonaCost: () => {},
	});
	const council = capture((api) => registerCouncilTool(api, {
		lastCtx: undefined, controller: { activePersona: undefined }, personas: [], launchSnapshot: () => ({ participants: [] }),
		runStrategyVisible: () => new Promise(() => {}), runs: runs(), drainBusBlock: () => "",
	} as any));
	const flow = capture((api) => registerFlowTool(api, {
		lastCtx: undefined, loadFlow: () => ({ ok: true, flow: { name: "gated-build", phases: [{ id: "plan", strategy: "magi" }] } }),
		listFlows: () => ["gated-build"], launchSnapshot: () => ({ participants: [] }), runFlowVisible: () => new Promise(() => {}), runs: runs(),
	} as any));
	return { monitor, timer, script, council, flow };
}

// Captured from git HEAD (94451cf7) before the receipt renderers changed; equality, not a pattern.
const HEAD_RESULTS: Array<[name: keyof ReturnType<typeof tools>, params: Record<string, unknown>, ctx: Record<string, unknown>, json: string]> = [
	["monitor", { action: "arm", command: "node", args: ["watch.mjs"], label: "CI run finished", mode: "exit" }, { cwd: "/repo", hasUI: true },
		'{"content":[{"type":"text","text":"Armed monitor-1 (CI run finished); wakes when this job exits. Deadline 1970-01-01T00:10:00.000Z. Keep this session open. Continue independent work, or end your turn; it wakes you by itself, so never sleep, poll, or arm a `timer` to wait for it."}],"details":{"ok":true,"id":"monitor-1","expiresAtEpochMs":600000,"label":"CI run finished","mode":"exit"}}'],
	["monitor", { action: "arm", command: "node", label: "CI run finished", mode: "output" }, { cwd: "/repo", hasUI: false },
		'{"content":[{"type":"text","text":"Armed monitor-1 (CI run finished); wakes on relevant stdout lines. Deadline 1970-01-01T00:10:00.000Z. Headless pi -p: the process exits when this turn settles, so this watch wakes you only if it fires before then. Do not end your turn expecting it; finish inline, or report the condition as pending."}],"details":{"ok":true,"id":"monitor-1","expiresAtEpochMs":600000,"label":"CI run finished","mode":"output"}}'],
	["timer", { action: "arm", label: "status review", message: "check the batch", delaySeconds: 900 }, { cwd: "/repo", hasUI: true },
		'{"content":[{"type":"text","text":"Armed timer-1 (status review) — fires in 15m 00s [1970-01-01T00:31:40.000Z]. You can end this turn now; keep the session open for the alarm."}],"details":{"action":"arm","id":"timer-1","fireAtEpochMs":1900000,"label":"status review","ok":true},"isError":false}'],
	["timer", { action: "arm", message: "check the batch", delaySeconds: 900 }, { cwd: "/repo", hasUI: true },
		'{"content":[{"type":"text","text":"Armed timer-1 (timer-1) — fires in 15m 00s [1970-01-01T00:31:40.000Z]. You can end this turn now; keep the session open for the alarm."}],"details":{"action":"arm","id":"timer-1","fireAtEpochMs":1900000,"label":"timer-1","ok":true},"isError":false}'],
	["script", { action: "run", code: "npm test", label: "unit tests" }, { cwd: "/repo", hasUI: true },
		'{"content":[{"type":"text","text":"Started script-1 (unit tests); completion wakes you when the script exits. Deadline 1970-01-01T00:10:00.000Z. Keep this session open. Continue independent work, or end your turn; it wakes you by itself. Never sleep or poll to wait for it."}],"details":{"ok":true,"id":"script-1","label":"unit tests","expiresAtEpochMs":600000}}'],
	["council", { question: "ship?", strategy: "debate", roster: "security-board" }, { cwd: "/repo", hasUI: true, ui: { notify() {} } },
		'{"content":[{"type":"text","text":"Launched council run-1 (debate · security-board) in the background — you will be woken ONCE with the ruling (never sleep, poll, peek, or arm a timer for it; end your turn if only it remains)."}],"details":{"runId":"run-1","strategy":"debate","roster":"security-board","launch":{"participants":[],"request":{"task":"ship?"}}},"isError":false}'],
	["flow", { name: "gated-build", task: "ship it" }, { cwd: "/repo", hasUI: true },
		'{"content":[{"type":"text","text":"Launched flow run-1 (gated-build) in the background — you will be woken ONCE when it ends; a checkpoint waits for the operator, not for you (never sleep, poll, peek, or arm a timer for it; end your turn if only it remains)."}],"details":{"runId":"run-1","flow":"gated-build","launch":{"participants":[],"request":{"task":"ship it"}}},"isError":false}'],
];

test("trimmed receipts leave every model-facing tool result and persisted details byte-identical to HEAD", async () => {
	for (const [name, params, ctx, json] of HEAD_RESULTS) {
		const tool = tools()[name];
		const result = await tool.execute("call", params, undefined, undefined, ctx);
		assert.equal(JSON.stringify(result), json, `${name} ${JSON.stringify(params)}`);
		// Rendering the receipt, collapsed and expanded, with and without the call's args, never
		// writes back into the result the session stores and the model reads.
		for (const expanded of [false, true]) {
			for (const context of [{ isError: false }, { isError: false, args: params }]) {
				tool.renderResult(result, { expanded }, plainTheme, context).render(100);
			}
		}
		assert.equal(JSON.stringify(result), json, `${name}: rendering mutated the result`);
		// The literal receipt the model received is still exactly what the expanded card shows.
		const expandedCard = stripVTControlCharacters(tool.renderResult(result, { expanded: true }, plainTheme, { isError: false, args: params }).render(1000).join("\n"));
		assert.ok(expandedCard.replace(/\s+/g, " ").includes(result.content[0].text.replace(/\s+/g, " ")), `${name}: expanded card keeps the delivered text`);
	}
});
