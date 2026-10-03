import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeInProcessEngine } from "../../src/engine/inproc.ts";

// Exercise the production factory, not the injected fake-session seam. All provider calls are
// local faux streams; the hermetic preload prevents loading the operator's settings/extensions.
test("Pi 1.0 production in-process factory shares native runtime auth across concurrent legs", { timeout: 15_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-persona-pi1-runtime-"));
	const faux = fauxProvider({ provider: "persona-runtime-test", models: [{ id: "no-bill" }] });
	const runtime = await ModelRuntime.create({ refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("persona-runtime-test", "fake-key-never-transmitted");
	faux.setResponses([fauxAssistantMessage("shared runtime reached"), fauxAssistantMessage("shared runtime reached")]);
	const model = "persona-runtime-test/no-bill";
	const engine = makeInProcessEngine({
		cwd,
		agentDir: cwd,
		modelRegistry: new ModelRegistry(runtime),
		childThinking: "xhigh",
		resolveAgent: (name) => ({ name, model, tools: [], systemPrompt: "Return the supplied answer.", source: "<test>" }),
	});
	const oldDisable = process.env.PI_PERSONA_DISABLE;
	const oldLeg = process.env.PI_PERSONA_LEG;
	try {
		const results = await Promise.all([
			engine.run({ agent: "first", task: "Say shared runtime reached." }),
			engine.run({ agent: "second", task: "Say shared runtime reached." }),
		]);
		for (const result of results) {
			assert.equal(result.ok, true, result.error);
			assert.equal(result.modelUsed, model);
			assert.match(result.output, /shared runtime reached/);
		}
		assert.equal(faux.state.callCount, 2);
		assert.equal(process.env.PI_PERSONA_DISABLE, oldDisable);
		assert.equal(process.env.PI_PERSONA_LEG, oldLeg);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
