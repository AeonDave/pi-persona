import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxProvider } from "@earendil-works/pi-ai";
import { AgentSessionRuntime, createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import piPersona from "../../src/extension.ts";
import { TelemetryProducer } from "../../src/telemetry/producer.ts";

test("native runtime shutdown cannot restart Persona telemetry when startup authentication completes during teardown", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "persona-startup-shutdown-"));
	const previousDefault = process.env.PI_PERSONA_DEFAULT;
	const previousPersist = process.env.PI_PERSONA_PERSIST;
	process.env.PI_PERSONA_DEFAULT = "alpha";
	process.env.PI_PERSONA_PERSIST = "off";
	let releaseModel!: () => void;
	let modelStarted!: () => void;
	const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
	const modelEntered = new Promise<void>((resolve) => { modelStarted = resolve; });
	let releaseShutdown!: () => void;
	let shutdownStarted!: () => void;
	const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
	const shutdownEntered = new Promise<void>((resolve) => { shutdownStarted = resolve; });
	const producers: TelemetryProducer[] = [];
	const originalStart = TelemetryProducer.prototype.start;
	t.mock.method(TelemetryProducer.prototype, "start", function (this: TelemetryProducer, instance: Parameters<TelemetryProducer["start"]>[0]) {
		producers.push(this);
		originalStart.call(this, instance);
	});
	let owner: AgentSessionRuntime | undefined;
	let starting: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	try {
		await mkdir(join(dir, ".pi", "agents"), { recursive: true });
		await writeFile(join(dir, ".pi", "agents", "alpha.md"), "---\nname: alpha\npersona: true\nmodel: startup-faux/local\n---\nStartup persona.\n");
		const faux = fauxProvider({ provider: "startup-faux", models: [{ id: "local" }] });
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
		runtime.registerNativeProvider(faux.provider);
		await runtime.setRuntimeApiKey("startup-faux", "synthetic-key-never-transmitted");
		const services = await createAgentSessionServices({
			cwd: dir, agentDir: dir, modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [(pi) => {
					const setModel = pi.setModel;
					pi.setModel = async (model) => { modelStarted(); await modelGate; return setModel(model); };
					piPersona(pi);
					// Pi allows another extension's asynchronous shutdown cleanup to remain in flight
					// after Persona has torn down, before invalidating the shared extension context.
					pi.on("session_shutdown", async () => { shutdownStarted(); await shutdownGate; });
				}],
			},
		});
		const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), model: faux.models[0]!, tools: [] });
		owner = new AgentSessionRuntime(session, services, async () => { throw new Error("No session replacement in this test"); });
		starting = session.bindExtensions({ mode: "rpc" });
		await modelEntered;
		closing = owner.dispose();
		await shutdownEntered;
		assert.equal(producers.length, 0, "startup has not created telemetry before the model selection settles");
		releaseModel();
		await starting;
		assert.equal(producers.length, 0, "a late startup continuation must not create a telemetry writer and heartbeat after shutdown");
		assert.equal(faux.state.callCount, 0);
	} finally {
		releaseModel();
		releaseShutdown();
		await starting?.catch(() => {});
		if (closing) await closing;
		else await owner?.dispose();
		for (const producer of producers) await producer.stop("test-cleanup");
		if (previousDefault === undefined) delete process.env.PI_PERSONA_DEFAULT; else process.env.PI_PERSONA_DEFAULT = previousDefault;
		if (previousPersist === undefined) delete process.env.PI_PERSONA_PERSIST; else process.env.PI_PERSONA_PERSIST = previousPersist;
		await rm(dir, { recursive: true, force: true });
	}
});
