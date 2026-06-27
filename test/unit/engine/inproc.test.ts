import { test } from "node:test";
import assert from "node:assert/strict";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../../../src/agents/agent.ts";
import { DEFAULT_CONTRACT } from "../../../src/core/contract.ts";
import { type CreateInProcSession, type InProcSession, makeInProcessEngine } from "../../../src/engine/inproc.ts";

// A stub registry: one model, resolvable by provider/id or bare id.
const stubModel = { provider: "stub", id: "m" };
const fakeRegistry = { find: () => stubModel, getAll: () => [stubModel] } as unknown as ModelRegistry;

const agents: Record<string, AgentConfig> = {
	a: { name: "a", model: "stub/m", systemPrompt: "You are a.", systemPromptMode: "replace", source: "x" },
};
const resolveAgent = (n: string): AgentConfig | undefined => agents[n];
const contracts = (n: string) => (n === "default" ? DEFAULT_CONTRACT : undefined);

interface Spy {
	aborted?: boolean;
	disableDuringCreate?: string | undefined;
	steered?: unknown[];
}

/** A fake in-process session that replays scripted events when prompted. */
function fakeSessions(events: unknown[], spy?: Spy): CreateInProcSession {
	return async () => {
		if (spy) spy.disableDuringCreate = process.env.PI_PERSONA_DISABLE;
		let listener: ((e: unknown) => void) | undefined;
		const session: InProcSession = {
			subscribe: (l) => {
				listener = l;
				return () => {
					listener = undefined;
				};
			},
			prompt: async () => {
				for (const e of events) listener?.(e);
			},
			agent: {
				abort: () => {
					if (spy) spy.aborted = true;
				},
				waitForIdle: async () => {},
				steer: (m) => {
					if (spy) (spy.steered ??= []).push(m);
				},
			},
			dispose: () => {},
		};
		return session;
	};
}

const msgEnd = (text: string, usage?: Record<string, unknown>): unknown => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end", ...(usage ? { usage } : {}) },
});
const update = (text: string): unknown => ({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });

test("inproc engine folds the session event stream into output + usage (no live model)", async () => {
	const spy: Spy = {};
	const engine = makeInProcessEngine({
		resolveAgent,
		contracts,
		modelRegistry: fakeRegistry,
		cwd: ".",
		createSession: fakeSessions([update("thinking…"), msgEnd("final answer", { input: 10, output: 5, totalTokens: 100 })], spy),
	});
	const r = await engine.run({ agent: "a", task: "do it" });
	assert.equal(r.ok, true);
	assert.equal(r.output, "final answer");
	assert.equal(r.usage.input, 10);
	assert.equal(r.usage.output, 5);
	assert.equal(spy.disableDuringCreate, "1", "PI_PERSONA_DISABLE set while the sub-session is built (fork-bomb guard)");
});

test("inproc engine restores PI_PERSONA_DISABLE after the sub-session is built", async () => {
	const before = process.env.PI_PERSONA_DISABLE;
	const engine = makeInProcessEngine({ resolveAgent, contracts, modelRegistry: fakeRegistry, cwd: ".", createSession: fakeSessions([msgEnd("x")]) });
	await engine.run({ agent: "a", task: "t" });
	assert.equal(process.env.PI_PERSONA_DISABLE, before, "env restored to its prior value");
});

test("inproc engine validates the output contract in-process (fenced JSON parses)", async () => {
	const engine = makeInProcessEngine({
		resolveAgent,
		contracts,
		modelRegistry: fakeRegistry,
		cwd: ".",
		createSession: fakeSessions([msgEnd('```json\n{"result":"ok","vote":"json","confidence":0.9}\n```')]),
	});
	const r = await engine.run({ agent: "a", task: "decide", outputContract: "default" });
	assert.equal(r.ok, true);
	assert.equal(r.structured?.vote, "json");
});

test("inproc engine reports an unknown agent and an unresolvable model", async () => {
	const engine = makeInProcessEngine({ resolveAgent, contracts, modelRegistry: fakeRegistry, cwd: ".", createSession: fakeSessions([]) });
	const unknown = await engine.run({ agent: "nope", task: "t" });
	assert.equal(unknown.ok, false);
	assert.match(unknown.error ?? "", /unknown agent/);

	const noModel = makeInProcessEngine({
		resolveAgent,
		contracts,
		cwd: ".",
		modelRegistry: { find: () => undefined, getAll: () => [] } as unknown as ModelRegistry,
		createSession: fakeSessions([msgEnd("x")]),
	});
	const r = await noModel.run({ agent: "a", task: "t", model: "ghost/model" });
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /model not found/);
});

test("inproc engine aborts via signal → agent.abort() and a /abort/ error", async () => {
	const spy: Spy = {};
	const ac = new AbortController();
	ac.abort();
	const engine = makeInProcessEngine({ resolveAgent, contracts, modelRegistry: fakeRegistry, cwd: ".", createSession: fakeSessions([msgEnd("x")], spy) });
	const r = await engine.run({ agent: "a", task: "t" }, undefined, ac.signal);
	assert.equal(spy.aborted, true, "agent.abort() called on abort");
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /abort/);
});

test("inproc engine exposes a steer handle that injects a user message into the running agent", async () => {
	const spy: Spy = {};
	let gotHandle = false;
	const engine = makeInProcessEngine({ resolveAgent, contracts, modelRegistry: fakeRegistry, cwd: ".", createSession: fakeSessions([msgEnd("ok")], spy) });
	await engine.run({ agent: "a", task: "t" }, undefined, undefined, (steer) => {
		gotHandle = true;
		steer("redirect: focus on errors");
	});
	assert.equal(gotHandle, true, "onSteerable fired with a steer handle");
	assert.equal(spy.steered?.length, 1, "the steer reached session.agent.steer");
	assert.match(JSON.stringify(spy.steered?.[0]), /redirect: focus on errors/);
});

test("inproc engine streams the rolling partial via per-call onProgress", async () => {
	const seen: string[] = [];
	const engine = makeInProcessEngine({
		resolveAgent,
		contracts,
		modelRegistry: fakeRegistry,
		cwd: ".",
		createSession: fakeSessions([update("partial one"), msgEnd("done")]),
	});
	await engine.run({ agent: "a", task: "t" }, (p) => seen.push(p.output));
	assert.ok(seen.some((o) => /partial one/.test(o)), "progress saw the streaming partial");
});
