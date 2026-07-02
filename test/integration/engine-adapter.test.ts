import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import type { AgentConfig } from "../../src/agents/agent.ts";
import { type ContractDef, DEFAULT_CONTRACT } from "../../src/core/contract.ts";
import { makeEngine } from "../../src/engine/adapter.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));
const resolveFake = (args: string[]) => ({ command: process.execPath, args: [FAKE, ...args] });

const SCOUT: AgentConfig = {
	name: "scout",
	systemPrompt: "You are scout.",
	systemPromptMode: "replace",
	source: "x",
	model: "m",
	tools: ["read"],
};

function engine() {
	return makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		contracts: (n) => (n === "default" ? DEFAULT_CONTRACT : undefined),
		childOptions: { resolveInvocation: resolveFake },
	});
}

test("makeEngine runs a named agent and returns its output", async () => {
	const r = await engine().run({ agent: "scout", task: "explore" });
	assert.equal(r.ok, true);
	assert.match(r.output, /echo: Task: explore/);
	assert.equal(r.usage.input, 5);
});

test("makeEngine prepends a skill-load directive when skills are requested (dynamic sub-agent)", async () => {
	const r = await engine().run({ agent: "scout", task: "explore", skills: ["python-patterns", "python-testing"] });
	assert.equal(r.ok, true);
	assert.match(r.output, /Load these skills/);
	assert.match(r.output, /python-patterns/);
});

test("makeEngine applies a per-agent model override from modelFor (spec.model > modelFor > agent default)", async () => {
	const eng = makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		childOptions: { resolveInvocation: resolveFake },
		modelFor: (a) => (a === "scout" ? "prov/override" : undefined),
	});
	const r = await eng.run({ agent: "scout", task: "do [args]" });
	assert.match(r.output, /--model prov\/override/, "modelFor overrides the agent's default model");

	const r2 = await eng.run({ agent: "scout", task: "do [args]", model: "prov/explicit" });
	assert.match(r2.output, /--model prov\/explicit/, "an explicit spec.model wins over modelFor");
});

test("makeEngine streams the child's rolling output via the per-call onProgress", async () => {
	const outputs: string[] = [];
	await engine().run({ agent: "scout", task: "explore" }, (p) => outputs.push(p.output));
	assert.ok(
		outputs.some((o) => o.includes("echo: Task: explore")),
		"onProgress saw the rolling assistant output",
	);
});

test("makeEngine appends an explicit thinking level to the child model (avoids default adaptive)", async () => {
	const eng = makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		childOptions: { resolveInvocation: resolveFake },
		childThinking: "high",
	});
	const r = await eng.run({ agent: "scout", task: "do [args]" });
	assert.match(r.output, /--model m:high/, "thinking appended as model:level");
});

test("makeEngine does not double a thinking suffix already on the model", async () => {
	const eng = makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		childOptions: { resolveInvocation: resolveFake },
		childThinking: "high",
	});
	const r = await eng.run({ agent: "scout", task: "do [args]", model: "prov/x:low" });
	assert.match(r.output, /--model prov\/x:low/);
	assert.doesNotMatch(r.output, /:low:high/);
});

test("makeEngine appends an on-the-fly `role` to the agent's prompt file (child path)", async () => {
	let promptFile = "";
	const eng = makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		childOptions: {
			resolveInvocation: (args) => {
				// Capture the --append-system-prompt file content while it still exists.
				const i = args.indexOf("--append-system-prompt");
				if (i >= 0) promptFile = fs.readFileSync(args[i + 1] as string, "utf8");
				return resolveFake(args);
			},
		},
	});
	const r = await eng.run({ agent: "scout", task: "t", role: "You are a CSS wizard." });
	assert.equal(r.ok, true);
	assert.match(promptFile, /You are scout\./, "the agent's own persona is kept");
	assert.match(promptFile, /CSS wizard/, "the role is appended");
});

test("makeEngine aborts the child when the per-call (UI stop) signal fires", async () => {
	const ac = new AbortController();
	const eng = makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		childOptions: { resolveInvocation: resolveFake, killGraceMs: 200 },
	});
	const p = eng.run({ agent: "scout", task: "wait [sleep]" }, undefined, ac.signal);
	setTimeout(() => ac.abort(), 80);
	const r = await p;
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /abort/i, "an abort surfaces as a failed result");
});

test("makeEngine fails cleanly for an unknown agent", async () => {
	const r = await engine().run({ agent: "ghost", task: "x" });
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /unknown agent/);
});

test("makeEngine validates structured output against the pinned contract", async () => {
	const r = await engine().run({ agent: "scout", task: "do [json]", outputContract: "default" });
	assert.equal(r.ok, true);
	assert.equal(r.structured?.result, "done");
	assert.equal(r.structured?.stance, "approve");
});

test("makeEngine pins the contract per run — a mid-run contract change can't affect an in-flight engine", async () => {
	let calls = 0;
	const lenient: ContractDef = { name: "c", fields: { result: { type: "string" } } };
	const strict: ContractDef = {
		name: "c",
		fields: { result: { type: "string" }, mustHave: { type: "string", required: true } },
	};
	const eng = makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		childOptions: { resolveInvocation: resolveFake },
		contracts: () => (calls++ === 0 ? lenient : strict),
	});
	// fake-pi [json] emits {result,confidence,stance} with no `mustHave`.
	const r1 = await eng.run({ agent: "scout", task: "do [json]", outputContract: "c" });
	const r2 = await eng.run({ agent: "scout", task: "do [json]", outputContract: "c" });
	assert.equal(r1.ok, true);
	assert.equal(r2.ok, true, "the second run still validates against the pinned (lenient) contract");
});

test("makeEngine marks a contract failure when output is not valid JSON", async () => {
	const r = await engine().run({ agent: "scout", task: "plain text", outputContract: "default" });
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /contract/);
});

// --- broker wiring (Task 6): default-OFF pin + broker-on env/handle/steer-frame plumbing ---

function makeSpyBroker(endpoint = "fake-broker-endpoint") {
	const calls: string[] = [];
	const registered: Array<{ handle: string; label?: string; group?: string; peers?: boolean }> = [];
	const unregistered: string[] = [];
	const steered: Array<{ handle: string; text: string }> = [];
	return {
		endpoint,
		calls,
		registered,
		unregistered,
		steered,
		register: (info: { handle: string; label?: string; group?: string; peers?: boolean }) => {
			calls.push("register");
			registered.push(info);
		},
		unregister: (handle: string) => {
			calls.push("unregister");
			unregistered.push(handle);
		},
		steerFrame: (handle: string, text: string) => {
			calls.push("steerFrame");
			steered.push({ handle, text });
		},
	};
}

test("makeEngine (broker absent): child env carries NO PI_PERSONA_BUS/PI_PERSONA_HANDLE (default-OFF pin)", async () => {
	const r = await engine().run({ agent: "scout", task: "check [env]" });
	assert.equal(r.ok, true);
	assert.match(r.output, /PI_PERSONA_BUS=unset/);
	assert.match(r.output, /PI_PERSONA_HANDLE=unset/);
	assert.match(r.output, /PI_PERSONA_PEERS=unset/);
});

test("makeEngine (broker present): child env carries PI_PERSONA_BUS/PI_PERSONA_HANDLE, register runs before spawn, unregister runs on settle", async () => {
	const broker = makeSpyBroker();
	const eng = makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		broker,
		childOptions: {
			resolveInvocation: (args) => {
				broker.calls.push("spawn");
				return resolveFake(args);
			},
		},
	});
	const r = await eng.run({ agent: "scout", task: "check [env]" });
	assert.equal(r.ok, true);
	assert.ok(r.output.includes(`PI_PERSONA_BUS=${broker.endpoint}`), "child env carries the broker endpoint");
	assert.match(r.output, /PI_PERSONA_HANDLE=scout#\d+/);
	assert.match(r.output, /PI_PERSONA_PEERS=unset/, "peers env is only set when spec.peers is true");

	assert.equal(broker.registered.length, 1);
	assert.match(broker.registered[0]!.handle, /^scout#\d+$/);
	assert.equal(broker.calls.indexOf("register") < broker.calls.indexOf("spawn"), true, "register runs before spawn");

	assert.deepEqual(broker.unregistered, [broker.registered[0]!.handle], "unregister runs on settle, with the minted handle");
});

test("makeEngine (broker present, spec.peers): child env carries PI_PERSONA_PEERS=1", async () => {
	const broker = makeSpyBroker();
	const eng = makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		broker,
		childOptions: { resolveInvocation: resolveFake },
	});
	const r = await eng.run({ agent: "scout", task: "check [env]", peers: true });
	assert.equal(r.ok, true);
	assert.match(r.output, /PI_PERSONA_PEERS=1/);
	assert.equal(broker.registered[0]?.peers, true);
});

test("makeEngine (broker present): onSteerable routes steer text to broker.steerFrame with the minted handle", async () => {
	const broker = makeSpyBroker();
	const eng = makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		broker,
		childOptions: { resolveInvocation: resolveFake },
	});
	let steer: ((text: string) => void) | undefined;
	const r = await eng.run({ agent: "scout", task: "explore" }, undefined, undefined, (fn) => {
		steer = fn;
	});
	assert.equal(r.ok, true);
	assert.ok(steer, "onSteerable was called with a steer function");
	steer?.("hello from supervisor");
	assert.deepEqual(broker.steered, [{ handle: broker.registered[0]!.handle, text: "hello from supervisor" }]);
});
