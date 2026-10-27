import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
		type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { installIdleCompaction, type IdleCompactionInstallation } from "../../src/extension/idle-compaction.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function fixture(options: {
	mode: ExtensionContext["mode"];
}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-persona-idle-compaction-host-"));
	const faux = fauxProvider({ provider: "idle-compaction-host-faux", models: [{ id: "local", contextWindow: 1_000 }] });
	const answer = () => {
		const message = fauxAssistantMessage("offline answer");
		message.usage.input = 700;
		message.usage.totalTokens = 700;
		return message;
	};
	faux.setResponses(Array.from({ length: 8 }, answer));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
		modelsStorePath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("idle-compaction-host-faux", "synthetic-key-never-transmitted");
	const manager = SessionManager.inMemory(dir);
	for (let i = 0; i < 3; i++) {
		manager.appendMessage({ role: "user", content: `synthetic history ${i} ${"x ".repeat(200)}`, timestamp: 100 + i * 2 });
		manager.appendMessage(answer());
	}
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 16, keepRecentTokens: 1 } });
	let installation!: IdleCompactionInstallation;
	let context!: ExtensionContext;
	let rawInput: ((data: string) => unknown) | undefined;
	let compactCount = 0;
	let releases = 0;
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [(pi) => {
			installation = installIdleCompaction(pi, {
				enabled: true, idleMs: 25, thresholdPercent: 40,
				canCompact: () => true, onReleased: () => { releases++; },
			});
			pi.on("session_start", (_event, ctx) => { context = ctx; });
			pi.on("session_before_compact", (event) => {
				compactCount++;
				return { compaction: { summary: "offline synthetic compaction", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
			});
		}],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model: faux.models[0], modelRuntime: runtime,
		settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: [] });
	await session.bindExtensions({ mode: options.mode, uiContext: {
		onTerminalInput: (handler) => { rawInput = handler; return () => { rawInput = undefined; }; },
		getEditorText: () => "",
	} as ExtensionUIContext });
	return {
		session, installation,
		get hasTerminalSubscription() { return rawInput !== undefined; },
		get context() { return context; },
		get compactCount() { return compactCount; },
		get releases() { return releases; },
		raw(data: string) { rawInput?.(data); },
		async close() {
			try { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
			finally { installation.dispose(); session.dispose(); await rm(dir, { recursive: true, force: true }); }
		},
	};
}

test("real SDK quarantine allocates no terminal subscription and leaves native manual compaction available", async () => {
	for (const mode of ["tui", "rpc"] as const) {
		const h = await fixture({ mode });
		try {
			assert.equal(h.hasTerminalSubscription, false);
			await h.session.prompt("genuine activity while idle compaction is hard blocked");
			assert.ok((h.context.getContextUsage()?.percent ?? 0) > 40);
			h.raw("x");
			await pause(60);
			assert.equal(h.compactCount, 0);
			assert.equal(h.installation.busy, false);
			assert.equal(h.releases, 0);
			await h.session.compact();
			assert.equal(h.compactCount, 1, "operator's manual native compaction still works");
			await h.session.extensionRunner.emit({ type: "agent_settled", aborted: false });
			await pause(60);
			assert.equal(h.compactCount, 1, "manual completion cannot activate a quarantined scheduler");
		} finally { await h.close(); }
	}
});
