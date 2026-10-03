import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeInProcessEngine } from "../../src/engine/inproc.ts";
import { makeSDK } from "../../src/orchestration/sdk.ts";
import { makeRoster } from "../../src/orchestration/roster.ts";

// Real Pi sessions and the production engine, with a local native faux provider. Every resource
// and credential/cache path is temporary; no operator credentials or cloud calls are involved.
for (const selection of ["inline pin", "role assignment"] as const) {
	test(`production Pi SDK recovers a failed ${selection} once on the main model`, { timeout: 15_000 }, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-persona-main-recovery-"));
		const oldDisable = process.env.PI_PERSONA_DISABLE;
		const oldLeg = process.env.PI_PERSONA_LEG;
		try {
			// Disable host-owned retries so this test observes only pi-persona's single recovery.
			await writeFile(join(cwd, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
			const faux = fauxProvider({
				provider: "persona-main-recovery-test",
				models: [{ id: "unreachable" }, { id: "main" }],
			});
			const runtime = await ModelRuntime.create({
				authPath: join(cwd, "synthetic-auth.json"),
				modelsPath: null,
				modelsStorePath: join(cwd, "synthetic-models-store.json"),
				refreshOnCreate: false,
				allowModelNetwork: false,
			});
			runtime.registerNativeProvider(faux.provider);
			await runtime.setRuntimeApiKey("persona-main-recovery-test", "synthetic-key-never-transmitted");
			faux.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "404: synthetic model not found" }),
				fauxAssistantMessage("Main model recovered the same specialized participant."),
			]);
			const broken = "persona-main-recovery-test/unreachable";
			const main = "persona-main-recovery-test/main";
			const role = "Evaluate the SECURITY boundaries without changing files.";
			const seenRoles: Array<string | undefined> = [];
			const engine = makeInProcessEngine({
				cwd,
				agentDir: cwd,
				modelRegistry: new ModelRegistry(runtime),
				childThinking: "xhigh",
				modelFor: (_agent, assignedRole) => {
					seenRoles.push(assignedRole);
					return assignedRole === role ? broken : main;
				},
				resolveAgent: (name) => ({ name, tools: [], systemPrompt: "Return the supplied answer.", source: "<test>" }),
			});
			const notices: Array<{ agent: string; from?: string; to: string; key: string }> = [];
			const sdk = makeSDK({
				engine,
				roster: makeRoster({}),
				limits: { maxChildren: 2, maxConcurrency: 1, budgetTokens: 0, timeoutMs: 15_000 },
				sessionModel: main,
				onModelFallback: (notice) => notices.push(notice),
			});
			const result = await sdk.agent({
				agent: "reviewer",
				role,
				task: "Return the supplied answer.",
				...(selection === "inline pin" ? { model: broken } : {}),
			});
			assert.equal(result.ok, true, result.error);
			assert.equal(result.modelUsed, main);
			assert.deepEqual(result.modelRecovery, { from: broken, to: main });
			assert.match(result.output, /Main model recovered/);
			assert.equal(faux.state.callCount, 2, "one failed request and one recovery, with no host retry loop");
			assert.equal(notices.length, 1);
			assert.equal(notices[0]?.to, main);
			if (selection === "role assignment") assert.deepEqual(seenRoles, [role]);
			assert.equal(process.env.PI_PERSONA_DISABLE, oldDisable);
			assert.equal(process.env.PI_PERSONA_LEG, oldLeg);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
}
