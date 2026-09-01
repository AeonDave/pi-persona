import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../../../src/agents/agent.ts";
import { InProcessBus } from "../../../src/bus/inproc.ts";
import { makeEngine } from "../../../src/engine/adapter.ts";
import { makeInProcessEngine } from "../../../src/engine/inproc.ts";

const FAKE = fileURLToPath(new URL("../../fixtures/fake-pi.mjs", import.meta.url));
const resolveFake = (args: string[]) => ({ command: process.execPath, args: [FAKE, ...args] });

const stubModel = { provider: "stub", id: "m" };
const fakeRegistry = { find: () => stubModel, getAll: () => [stubModel] } as unknown as ModelRegistry;

const agents: Record<string, AgentConfig> = {
	a: { name: "a", model: "stub/m", systemPrompt: "You are a.", source: "x" },
};
const resolveAgent = (n: string): AgentConfig | undefined => agents[n];

test("the child engine and the inproc engine mint bus handles from ONE sequence (no cross-engine collision)", async () => {
	// Both engines register into the SAME session bus (the broker's host bus IS the inproc
	// engine's bus), so a per-module counter makes a mixed inproc+child pair of the same agent
	// share one inbox — and the first to settle unregisters the other, still-running leg.
	const minted: string[] = [];
	const childEngine = makeEngine({
		resolveAgent,
		childOptions: { resolveInvocation: resolveFake },
		broker: {
			endpoint: "pipe:test",
			register: (info) => minted.push(info.handle),
			unregister: () => {},
			steerFrame: () => true,
		},
	});
	await childEngine.run({ agent: "a", task: "t" });

	const bus = new InProcessBus();
	bus.register("supervisor");
	const inprocEngine = makeInProcessEngine({
		resolveAgent,
		modelRegistry: fakeRegistry,
		cwd: ".",
		bus,
		coaching: true,
		createSession: async () => {
			// The handle is registered on the bus before the session is built.
			for (const p of bus.participants()) if (p.startsWith("a#")) minted.push(p);
			return {
				subscribe: () => () => {},
				prompt: async () => {},
				agent: { abort: () => {}, waitForIdle: async () => {}, steer: () => {} },
				dispose: () => {},
			};
		},
	});
	await inprocEngine.run({ agent: "a", task: "t" });

	assert.equal(minted.length, 2, "both engines minted a handle");
	assert.equal(new Set(minted).size, 2, `handles must be unique across engines, got ${minted.join(", ")}`);
});
