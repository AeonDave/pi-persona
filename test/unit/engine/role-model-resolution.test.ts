/**
 * The picker's ROLE-keyed assignment has to reach the leg it was made for. These pin the two
 * engines' side of that seam: `modelFor(agent, role)` is consulted with the run's own role, and a
 * role's own assignment beats the bare agent's — while every other behaviour (the thinking-level
 * suffix, the resolved-model metadata, the failure classification) is untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../../../src/agents/agent.ts";
import { participantKey } from "../../../src/persona/model-participants.ts";
import { makeEngine } from "../../../src/engine/adapter.ts";
import { makeInProcessEngine } from "../../../src/engine/inproc.ts";

const SECURITY = "Focus ONLY on the SECURITY lens";
// The SAME derivation the picker writes under (`persona/model-participants.ts`) — imported, never
// re-implemented here, so a change to the key shape cannot silently pass both sides of the seam.
const saved = { reviewer: "p/legacy", [participantKey("reviewer", SECURITY)]: "p/security" };
const modelFor = (agent: string, role?: string): string | undefined => {
	const own = role?.trim() ? saved[participantKey(agent, role)] : undefined;
	return own ?? saved[agent as keyof typeof saved];
};

const agents: Record<string, AgentConfig> = { reviewer: { name: "reviewer", model: "p/frontmatter", systemPrompt: "x", source: "s" } };
const resolveAgent = (n: string): AgentConfig | undefined => agents[n];

test("inproc: a role member runs on its own assignment, and modelUsed still reports what ran", async () => {
	const stub = { provider: "p", id: "security" };
	const registry = {
		find: (provider: string, id: string) => ({ provider, id }),
		getAll: () => [stub],
		runtime: { getAuth: async () => undefined, getModel: () => stub, stream: () => undefined },
	} as unknown as ModelRegistry;
	const used: string[] = [];
	const engine = makeInProcessEngine({
		resolveAgent,
		modelRegistry: registry,
		cwd: ".",
		modelFor,
		createSession: (opts) => {
			used.push(String(opts.model ?? ""));
			let listener: ((e: unknown) => void) | undefined;
			return {
				subscribe: (l: (e: unknown) => void) => { listener = l; return () => { listener = undefined; }; },
				prompt: async () => {
					listener?.({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end", usage: { input: 1, output: 1 } },
					});
				},
				agent: { abort: () => {}, waitForIdle: async () => {}, steer: () => {} },
				dispose: () => {},
			} as never;
		},
	});

	const own = await engine.run({ agent: "reviewer", task: "review", role: SECURITY });
	assert.equal(own.ok, true);
	assert.equal(own.modelUsed, "p/security", "the role's own assignment reached the session");

	// A role with no assignment of its own inherits the agent's — same key the picker wrote.
	const inherited = await engine.run({ agent: "reviewer", task: "review", role: "PERFORMANCE LENS" });
	assert.equal(inherited.modelUsed, "p/legacy");

	// An explicit spec.model still wins over every assignment (unchanged precedence).
	const pinned = await engine.run({ agent: "reviewer", task: "review", role: SECURITY, model: "p/explicit" });
	assert.equal(pinned.modelUsed, "p/explicit");
	assert.equal(used.length, 3);
});

test("child adapter: the role's own assignment becomes the child's model, not the agent's default", async () => {
	let argv = "";
	const engine = makeEngine({
		resolveAgent,
		modelFor,
		childOptions: {
			resolveInvocation: (args) => {
				argv = args.join(" ");
				return { command: process.execPath, args: ["-e", `process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"ok"}],stopReason:"end"}}))`] };
			},
		},
	});
	const r = await engine.run({ agent: "reviewer", task: "review", role: SECURITY });
	assert.equal(r.ok, true);
	assert.match(argv, /p\/security/, `the child must be spawned with the role's model, got: ${argv}`);
	assert.doesNotMatch(argv, /p\/legacy|p\/frontmatter/);
});