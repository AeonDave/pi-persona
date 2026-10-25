import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeInProcessEngine } from "../../src/engine/inproc.ts";

// The production factory constructs a real SDK session and observes its clamp. Cancel at the
// steerable boundary BEFORE prompt(): no provider call, credentials, network or live delegation.
test("production inproc factory exposes SDK effort readback after both upward and downward host clamping", { timeout: 15_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-persona-leg-thinking-"));
	try {
		await writeFile(join(cwd, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
		const faux = fauxProvider({ provider: "leg-thinking-test", models: [{ id: "clamped", reasoning: true }] });
		faux.models[0].thinkingLevelMap = { off: null, minimal: null, low: null, xhigh: null, max: null };
		const runtime = await ModelRuntime.create({
			authPath: join(cwd, "empty-auth.json"), modelsPath: null,
			modelsStorePath: join(cwd, "empty-models.json"), refreshOnCreate: false, allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		const engine = makeInProcessEngine({
			cwd, agentDir: cwd, modelRegistry: new ModelRegistry(runtime),
			resolveAgent: (name) => ({ name, model: "leg-thinking-test/clamped", tools: [], systemPrompt: "", source: "<test>" }),
		});
		for (const [requested, observed] of [["low", "medium"], ["high", "high"], ["xhigh", "high"]] as const) {
			const ac = new AbortController();
			const result = await engine.run({ agent: "a", task: "must never reach a provider", thinking: requested }, undefined, ac.signal, () => ac.abort());
			assert.equal(result.failureKind, "abort");
			assert.equal(result.thinkingRequested, requested);
			assert.equal(result.thinkingEffective, observed, "readback comes from the real Pi session, not the request");
		}
		assert.equal(faux.state.callCount, 0, "factory/readback test must never invoke even a synthetic provider");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
