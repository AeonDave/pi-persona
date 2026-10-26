import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { fenceUntrusted } from "../../../src/core/fence.ts";
import { PersistenceNudge } from "../../../src/core/nudge.ts";
import { AsyncRunTracker, buildCompletionReport, renderCompletion } from "../../../src/engine/async.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { Semaphore } from "../../../src/orchestration/parallel.ts";
import { strategyCatalog } from "../../../src/orchestration/strategy.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { parsePersona, type Persona } from "../../../src/persona/persona.ts";
import { createBackgroundRuns, type TrackedRun } from "../../../src/tools/background-run.ts";
import { registerCouncilTool, type CouncilToolDeps } from "../../../src/tools/council.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";
import { ChildUsageLedger } from "../../../src/ui/usage.ts";

/** Capture the registered `council` tool (schema + description) without a real Pi host. */
function councilTool(): { description: string; parameters: { properties: Record<string, { description?: string }> } } {
	const tools = new Map<string, { description: string; parameters: unknown }>();
	const pi = { registerTool: (tool: { name: string; description: string; parameters: unknown }) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	const deps = {
		get lastCtx() {
			return undefined;
		},
		set lastCtx(_v: undefined) {},
		controller: { activePersona: undefined },
		personas: [] as Persona[],
		runStrategyVisible: async () => undefined,
		runs: {},
		drainBusBlock: () => "",
	} as unknown as CouncilToolDeps;
	registerCouncilTool(pi, deps);
	const tool = tools.get("council");
	assert.ok(tool, "the council tool is registered");
	return tool as unknown as { description: string; parameters: { properties: Record<string, { description?: string }> } };
}

test("the council description is proportionate: it does not mandate a council before every decision", () => {
	const { description } = councilTool();
	assert.doesNotMatch(description, /before any significant choice/i);
	assert.match(description, /not before every decision/i);
});

test("the council description names when NOT to convene and which sibling tool does that work", () => {
	const { description } = councilTool();
	assert.match(description, /do not use/i);
	assert.match(description, /`delegate`/);
	assert.doesNotMatch(description, /get work done/i);
});

test("the council description tells the truth about where it runs: background and one wake interactive, inline headless", () => {
	const { description } = councilTool();
	assert.match(description, /background/i);
	assert.match(description, /ONE follow-up carries the ruling/);
	assert.match(description, /never poll/i);
	assert.match(description, /headless sessions return the ruling inline/i);
	assert.doesNotMatch(description, /runs in the foreground/i, "the old claim is false for an interactive session now");
});

test("the council description explains the decision patterns it supports", () => {
	const { description } = councilTool();
	for (const pattern of [/judge/i, /critique/i, /debate/i, /synthesi[sz]e/i]) {
		assert.match(description, pattern);
	}
});

test("the council description teaches problem class -> method from the registry, so it cannot drift", () => {
	const { description } = councilTool();
	assert.ok(description.includes(strategyCatalog()), "one generated line per registered strategy");
	assert.doesNotMatch(description, /Patterns:/, "the hand-written pattern list is gone");
	assert.match(description, /`\*` = required/, "starred params are explained");
	assert.ok(description.length < 2600, `the description is ${description.length} chars — it should stay proportionate`);
});

test("the council description does not imply a separate judge tool", () => {
	const { description } = councilTool();
	assert.doesNotMatch(description, /judge tool/i);
	assert.doesNotMatch(description, /use the `judge`/i);
});

test("the council description documents the ad-hoc members override", () => {
	const { description, parameters } = councilTool();
	assert.match(description, /members/i);
	assert.match(parameters.properties.members?.description ?? "", /agent/i);
});

// ── a council is ONE tracked run: receipt + one wake interactive, joined inline headless ─────────────

const ruling = (output: string, over: Partial<AgentResult> = {}): AgentResult => ({ agent: "council", output, usage: emptyUsage(), ok: true, ...over });
const councilPersona = (name: string, fm: string): Persona => parsePersona(`---\nname: ${name}\npersona: true\n${fm}\n---\nBODY`, `${name}.md`)!;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function councilHarness(opts: { result?: AgentResult | ((tracked?: TrackedRun) => Promise<AgentResult | undefined>); active?: Persona; personas?: Persona[]; launchSnapshot?: () => unknown } = {}) {
	let tool: any;
	const tracker = new AsyncRunTracker();
	const stopRegistry = new Map<string, () => void>();
	const discarded: string[] = [];
	const calls: Array<{ orch: any; task: string; tracked: TrackedRun | undefined }> = [];
	const notes: string[] = [];
	const runs = createBackgroundRuns({
		tracker,
		agentTree: new AgentTree(),
		stopRegistry,
		slots: new Semaphore(4),
		completionNotifier: { discard: (pred) => { for (const r of tracker.list()) if (pred(r)) discarded.push(r.id); } },
		startPeek: () => {},
		childUsage: new ChildUsageLedger(),
		publishPersonaCost: () => {},
	});
	const deps = {
		lastCtx: undefined,
		controller: { activePersona: opts.active },
		personas: opts.personas ?? (opts.active ? [opts.active] : []),
		launchSnapshot: opts.launchSnapshot ?? (() => ({ participants: [] })),
		runStrategyVisible: async (_ctx: unknown, orch: any, task: string, _label: string, tracked?: TrackedRun) => {
			calls.push({ orch, task, tracked });
			const r = opts.result ?? ruling("THE RULING");
			return typeof r === "function" ? r(tracked) : r;
		},
		runs,
		drainBusBlock: () => "",
	} as unknown as CouncilToolDeps;
	registerCouncilTool({ registerTool: (definition: unknown) => { tool = definition; } } as unknown as ExtensionAPI, deps);
	const ui = { notify: (message: string) => { notes.push(message); } };
	return {
		tool,
		tracker,
		stopRegistry,
		discarded,
		calls,
		notes,
		interactive: (params: Record<string, unknown>) => tool.execute("c1", params, undefined, undefined, { hasUI: true, ui }),
		headless: (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("c1", params, signal, undefined, { ui }),
	};
}

test("judge launch card persists every lens model and full requested effort without consulting later settings", async () => {
	const participants = ["BREAK", "PI_PERSONA_RESULT_READER_TOKEN", "HEAD"].map((role, index) => ({
		key: role, label: `reviewer · ${role}`, agent: "reviewer", model: `openai/model-${index}`,
		modelSource: "inline", thinkingRequested: "xhigh", setupPending: false,
	}));
	participants.push({ key: "judge", label: "arbiter", agent: "arbiter", model: "openai/judge", modelSource: "agent", thinkingRequested: "max", setupPending: false });
	let reads = 0;
	const h = councilHarness({ launchSnapshot: () => { reads++; return { participants }; } });
	const receipt = await h.interactive({ question: "q", strategy: "judge", members: [
		{ agent: "reviewer", role: "BREAK", model: "openai/model-0", thinking: "xhigh" },
		{ agent: "reviewer", role: "PI_PERSONA_RESULT_READER_TOKEN", model: "openai/model-1", thinking: "xhigh" },
		{ agent: "reviewer", role: "HEAD", model: "openai/model-2", thinking: "xhigh" },
	], params: { judge: "arbiter" } });
	assert.equal(reads, 1);
	assert.deepEqual(receipt.details.launch.participants, participants);
	participants[0]!.model = "changed/later";
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	const expanded = h.tool.renderResult(receipt, { expanded: true }, theme).render(200).join("\n");
	for (const model of ["openai/model-0", "openai/model-1", "openai/model-2", "openai/judge"]) assert.ok(expanded.includes(model), expanded);
	assert.match(expanded, /requested effort xhigh/);
	assert.match(expanded, /requested effort max/);
	assert.doesNotMatch(expanded, /changed\/later/);
	assert.equal(reads, 1, "history rendering never rereads model settings");
	const collapsed = h.tool.renderResult(receipt, { expanded: false }, theme).render(200).join("\n");
	assert.match(collapsed, /openai\/model-0.*requested effort xhigh/);
	assert.match(collapsed, /\+1 more/);
	for (const width of [1, 12, 24, 80]) {
		const lines = h.tool.renderResult(receipt, { expanded: false }, theme).render(width);
		assert.ok(lines.every((line: string) => line.length <= width), `launch rows fit ${width} columns`);
	}
	const callBeforeResult = h.tool.renderCall({}, theme).render(200).join("\n");
	h.tool.renderResult(receipt, { expanded: false }, theme);
	const call = h.tool.renderCall({}, theme).render(200).join("\n");
	assert.equal(call, callBeforeResult, "native call-before-result ordering needs no later repaint");
	assert.match(call, /profile defaults/);
	assert.doesNotMatch(call, /pending/);
	assert.equal(reads, 1);
});

test("metadata lookup errors are explicit and cannot block a council launch", async () => {
	const h = councilHarness({ launchSnapshot: () => { throw new Error("catalog unavailable"); } });
	const receipt = await h.interactive({ question: "q", strategy: "fanout", members: ["reviewer"] });
	assert.equal(receipt.isError, false);
	assert.deepEqual(receipt.details.launch, { participants: [], unavailable: true });
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	assert.match(h.tool.renderResult(receipt, { expanded: false }, theme).render(120).join("\n"), /metadata unavailable/);
});

test("a malformed inline effort never throws from the pre-execution council call renderer", async () => {
	const h = councilHarness();
	const params = { question: "q", strategy: "fanout", members: [{ agent: "reviewer", thinking: "ultra" }] };
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	assert.doesNotThrow(() => h.tool.renderCall(params, theme).render(80));
	assert.doesNotThrow(() => h.tool.renderCall({ ...params, members: "reviewer" }, theme).render(80));
	const result = await h.interactive(params);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /thinking/);
});

test("a failed settled council still shows its saved requested models and effort", async () => {
	const h = councilHarness({ result: ruling("partial review", { ok: false, error: "provider unavailable" }), launchSnapshot: () => ({ participants: [
		{ key: "reviewer", label: "reviewer", agent: "reviewer", model: "openai/requested", modelSource: "inline", thinkingRequested: "xhigh", setupPending: false },
	] }) });
	const result = await h.headless({ question: "q", strategy: "fanout", members: ["reviewer"] });
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	const rendered = h.tool.renderResult(result, { expanded: false }, theme).render(200).join("\n");
	assert.match(rendered, /council failed/);
	assert.match(rendered, /requested model openai\/requested.*requested effort xhigh/);
});

test("pending council setup stays immediate and explicit while its original snapshot survives headless settlement", async () => {
	const launchSnapshot = () => ({ participants: [{ key: "reviewer", label: "reviewer", agent: "reviewer", model: "openai/default", modelSource: "session", thinkingRequested: "off", setupPending: true }] });
	const h = councilHarness({ launchSnapshot });
	const receipt = await h.interactive({ question: "q", strategy: "fanout", members: ["reviewer"] });
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	const text = h.tool.renderResult(receipt, { expanded: false }, theme).render(200).join("\n");
	assert.match(text, /model pending/);
	assert.match(text, /openai\/default/);
	assert.match(text, /requested effort off/);
	const inline = await h.headless({ question: "q", strategy: "fanout", members: ["reviewer"] });
	assert.deepEqual(inline.details.launch, launchSnapshot());
});

test("an interactive council returns a receipt at once, then settles as ONE run whose single wake carries the ruling", async () => {
	let release!: (r: AgentResult) => void;
	const h = councilHarness({ result: () => new Promise<AgentResult>((resolve) => { release = resolve; }) });
	const receipt = await h.interactive({ question: "ship or hold?", strategy: "magi", roster: "magi" });

	assert.equal(receipt.isError, false);
	const id = receipt.details.runId as string;
	assert.equal(receipt.content[0].text.startsWith(`Launched council ${id} (magi · magi) in the background`), true);
	assert.match(receipt.content[0].text, /woken ONCE with the ruling/);
	assert.match(receipt.content[0].text, /never sleep, poll, peek, or arm a timer/);
	assert.doesNotMatch(receipt.content[0].text, /THE RULING/, "the ruling is not in the receipt");
	assert.equal(h.stopRegistry.has(`async:${id}`), true);
	await tick();
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0]!.tracked?.rootId, `async:${id}`);

	release(ruling("THE RULING\n[BLOCKED] cannot decide"));
	await tick();
	const settled = h.tracker.peek(id)!;
	assert.equal(settled.status, "done");
	const wake = renderCompletion([settled], fenceUntrusted, (text) => new PersistenceNudge().scan(text));
	assert.match(wake, /✅ run-\S+ \(council-magi\) done/);
	assert.match(wake, /THE RULING/);
	assert.match(wake, /\[BLOCKED\] cannot decide/);
	assert.ok(new PersistenceNudge().scan("[BLOCKED] cannot decide"), "the counterweight exists for this marker");
	assert.ok(wake.length > renderCompletion([settled], fenceUntrusted, () => undefined).length, "…and a BLOCKED ruling on the completion path carries it");
});

test("an interactive council with a failed ruling keeps the unresolved review reachable through the completion", async () => {
	const h = councilHarness({ result: ruling("last draft\n\nUNRESOLVED CRITIQUE: x", { ok: false, error: "critic-loop exhausted", failureKind: "agent" }) });
	const receipt = await h.interactive({ question: "q", strategy: "critic-loop", roster: "repair" });
	await tick();

	const settled = h.tracker.peek(receipt.details.runId as string)!;
	assert.equal(settled.status, "failed");
	const report = buildCompletionReport([settled], fenceUntrusted);
	assert.match(report, /critic-loop exhausted/);
	assert.match(report, /UNRESOLVED CRITIQUE: x/);
});

test("persona defaults still resolve exactly as before when the call omits strategy, roster and params", async () => {
	const persona = councilPersona("builder", "council:\n  strategy: critic-loop\n  roster: repair\n  params: { rounds: 3 }");
	for (const mode of ["interactive", "headless"] as const) {
		const h = councilHarness({ active: persona });
		await h[mode]({ question: "build it" });
		await tick();
		assert.deepEqual(h.calls[0]?.orch, { mode: "strategy", strategy: "critic-loop", roster: "repair", params: { rounds: 3 } }, `${mode}: the persona's own method`);
		assert.equal(h.calls[0]?.task, "build it");
	}

	// a per-call override still wins, merging params over the persona's
	const overridden = councilHarness({ active: persona });
	await overridden.interactive({ question: "build it", params: { rounds: 1 } });
	await tick();
	assert.deepEqual(overridden.calls[0]?.orch.params, { rounds: 1 });

	// and borrowing another persona's declared council by name keeps working in the background
	const solo = councilPersona("solo", "tools: [read]");
	const judge = councilPersona("arbiter", "council:\n  strategy: judge\n  roster: magi\n  params: { judge: reviewer }");
	const borrowed = councilHarness({ active: solo, personas: [solo, judge] });
	await borrowed.interactive({ question: "pick one", persona: "arbiter" });
	await tick();
	assert.deepEqual(borrowed.calls[0]?.orch, { mode: "strategy", strategy: "judge", roster: "magi", params: { judge: "reviewer" } });
});

test("a headless council is the SAME run joined in the call: the fenced ruling inline, no follow-up", async () => {
	const h = councilHarness({ result: ruling("THE RULING", { structured: { headline: "2-1 to ship", tally: { ship: 2, hold: 1 } } }) });
	const result = await h.headless({ question: "ship or hold?", strategy: "magi", roster: "magi" });

	assert.equal(result.isError, false);
	assert.equal(result.details.runId, undefined, "no receipt in a single-turn session");
	assert.match(result.content[0].text, /THE RULING/);
	assert.match(result.content[0].text, /untrusted/i, "member text is fenced");
	assert.equal(result.details.headline, "2-1 to ship");
	assert.deepEqual(result.details.tally, { ship: 2, hold: 1 });
	assert.equal(h.tracker.list().length, 1);
	assert.deepEqual(h.discarded, [h.tracker.list()[0]!.id], "the inline return replaces the completion follow-up");
});

test("a headless council whose strategy throws is 'council failed: <cause>' exactly as before", async () => {
	const h = councilHarness({ result: () => Promise.reject(new Error('unknown roster "nope" (available teams: magi)')) });
	const result = await h.headless({ question: "q", strategy: "magi", roster: "nope" });
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, 'council failed: unknown roster "nope" (available teams: magi)');
	assert.deepEqual(result.details.launch, { participants: [] }, "the retained launch survives a thrown runner/missing outcome");
});

test("aborting a headless council call stops the run it joined: the old tool signal still ends it", async () => {
	const h = councilHarness({
		result: (tracked) => new Promise<AgentResult>((resolve) => {
			tracked!.signal.addEventListener("abort", () => resolve(ruling("partial ruling", { ok: false, error: "cancelled", failureKind: "abort" })), { once: true });
		}),
	});
	const ac = new AbortController();
	const pending = h.headless({ question: "q", strategy: "magi", roster: "magi" }, ac.signal) as Promise<{ isError: boolean; details: { failureKind?: string } }>;
	await tick();
	ac.abort();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.equal(result.details.failureKind, "abort");
});

test("a headless council aborted before it convened names the cause instead of returning an empty ruling", async () => {
	const h = councilHarness();
	const ac = new AbortController();
	ac.abort();
	const result = await h.headless({ question: "q", strategy: "magi", roster: "magi" }, ac.signal);

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /run aborted/);
	assert.equal(result.details.failureKind, "abort");
	await tick();
	assert.equal(h.calls.length, 0, "the strategy never started");
});

test("an unknown param on an interactive council still warns the operator and tells the model in the receipt", async () => {
	const h = councilHarness();
	const receipt = await h.interactive({ question: "q", strategy: "magi", roster: "magi", params: { bogus: 1 } });
	assert.ok(h.notes.some((n) => /ignoring unknown param\(s\) \[bogus\]/.test(n)));
	assert.match(receipt.content[0].text, /ignoring unknown param\(s\) \[bogus\]/);
});

test("a hostile unknown-param key reaches the operator toast one bounded line, and the model payload unchanged", async () => {
	const h = councilHarness();
	const hostileKey = `bad\nkey\x1b[31m-${"z".repeat(300)}`;
	const receipt = await h.interactive({ question: "q", strategy: "magi", roster: "magi", params: { [hostileKey]: 1 } });
	const toast = h.notes.find((n) => n.includes("ignoring unknown param"));
	assert.ok(toast, "the operator warning still fires");
	assert.doesNotMatch(toast, /\n|\r/, "the toast is a single line");
	assert.doesNotMatch(toast, /\x1b\[/, "terminal escapes are stripped from the toast");
	assert.ok(toast.length <= 200, `the toast is bounded (${toast.length} chars)`);
	// The model-facing payload keeps the raw note byte-identical — only presentation was bounded.
	assert.match(receipt.content[0].text, new RegExp(hostileKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// ── a call that cannot run fails IMMEDIATELY, before a run, tree row or model picker exists ──────────

test("a strategy that requires a param fails at once when the call omits it: no run, no strategy start", async () => {
	for (const mode of ["interactive", "headless"] as const) {
		for (const strategy of ["judge", "compete"]) {
			const h = councilHarness();
			const result = await h[mode]({ question: "pick one", strategy, roster: "magi" });
			assert.equal(result.isError, true, `${mode} ${strategy}`);
			assert.ok(result.content[0].text.startsWith(`council failed: "${strategy}" requires params.judge`));
			assert.equal(h.calls.length, 0, "the strategy never started");
			assert.equal(h.tracker.list().length, 0, "nothing was launched");
			assert.equal(h.stopRegistry.size, 0);
		}
	}
});

test("an unknown strategy is still the run's to report, not an up-front refusal (the model picker may need to open first)", async () => {
	const h = councilHarness();
	const receipt = await h.interactive({ question: "q", strategy: "no-such-strategy", roster: "magi" });
	assert.equal(receipt.isError, false);
	assert.equal(h.tracker.list().length, 1, "the run was launched; it reports the unknown strategy itself");
});

test("a supplied required param (name, inline member or persona default) launches; a per-call switch does not inherit the old one", async () => {
	const named = councilHarness();
	assert.equal((await named.interactive({ question: "q", strategy: "judge", roster: "magi", params: { judge: "reviewer" } })).isError, false);
	const inline = councilHarness();
	assert.equal((await inline.interactive({ question: "q", strategy: "compete", roster: "repair", params: { judge: { agent: "reviewer", role: "tiebreak" } } })).isError, false);

	const judgePersona = councilPersona("arbiter", "council:\n  strategy: judge\n  roster: magi\n  params: { judge: reviewer, contract: default }");
	const byDefault = councilHarness({ active: judgePersona });
	assert.equal((await byDefault.interactive({ question: "the persona's own method" })).isError, false, "persona defaults resolve exactly as today");

	// params belong to the profile's strategy: switching to one that needs its own is the caller's to supply
	const switched = councilHarness({ active: councilPersona("voter", "council:\n  strategy: magi\n  roster: magi") });
	const rejected = await switched.interactive({ question: "q", strategy: "judge" });
	assert.equal(rejected.isError, true);
	assert.match(rejected.content[0].text, /requires params\.judge/);
});
