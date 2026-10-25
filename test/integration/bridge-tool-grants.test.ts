import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installBridge } from "../../src/bridge.ts";
import { InProcessBus } from "../../src/bus/inproc.ts";
import { brokerEndpoint } from "../../src/bus/broker/paths.ts";
import { startBrokerHost } from "../../src/bus/broker/host.ts";
import { makeBrokerClient } from "../../src/bus/broker/client.ts";
import { mergeSessionToolAllowlist } from "../../src/engine/session-tools.ts";

test("real Pi SDK keeps granted bridge tools callable under plain allowlists and preserves every denial", { timeout: 20_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-persona-bridge-grants-"));
	const endpoint = brokerEndpoint(randomUUID());
	if (process.platform !== "win32") await mkdir(dirname(endpoint), { recursive: true });
	const bus = new InProcessBus();
	bus.register("supervisor");
	const host = await startBrokerHost({ endpoint, bus, supervisorHandle: "supervisor" });
	const faux = fauxProvider({ provider: "bridge-grants-test", models: [{ id: "local" }] });
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
		modelsStorePath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	const cases: Array<{ name: string; tools?: string[]; peers: boolean; bus: boolean; exclude?: string[]; expected: string[] }> = [
		{ name: "plain read grant", tools: ["read"], peers: true, bus: true, expected: ["contact_peer", "contact_supervisor"] },
		{ name: "peer opt-out", peers: false, bus: true, expected: ["contact_supervisor"] },
		{ name: "deny-all allowlist", tools: [], peers: true, bus: true, expected: [] },
		{ name: "supervisor explicit exclude", tools: ["read"], peers: true, bus: true, exclude: ["contact_supervisor"], expected: ["contact_peer"] },
		{ name: "communication glob exclude", tools: ["read"], peers: true, bus: true, exclude: ["contact_*"], expected: [] },
		{ name: "absent allowlist bus denied", peers: true, bus: false, expected: [] },
	];
	try {
		for (const [index, scenario] of cases.entries()) {
			const handle = `bridge-sdk-${index}`;
			let markRegistered!: () => void;
			const registered = new Promise<void>((resolve) => { markRegistered = resolve; });
			let activateBridge!: () => void;
			const bridgeActivation = new Promise<void>((resolve) => { activateBridge = resolve; });
			host.expect(handle);
			const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
				noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [(pi) => { pi.on("session_start", (_event, ctx) => installBridge(pi, ctx, { env: {
					PI_PERSONA_BUS: endpoint, PI_PERSONA_HANDLE: handle, PI_PERSONA_PEERS: scenario.peers ? "1" : "0",
					PI_PERSONA_BUS_TOOLS: scenario.bus ? "on" : "off",
				}, makeClient: (deps) => {
					const client = makeBrokerClient(deps);
					if (index === 0) {
						const register = client.register.bind(client);
						client.register = async () => {
							await register();
							markRegistered();
							// Expose the real host/client readiness gap deterministically: host registration
							// alone cannot prove the bridge has observed its acknowledgement.
							await bridgeActivation;
						};
					}
					return client;
				} })); }],
			});
			await loader.reload();
			const custom = scenario.bus ? ["contact_supervisor", ...(scenario.peers ? ["contact_peer"] : [])] : [];
			const tools = mergeSessionToolAllowlist(scenario.tools, custom);
			const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model: faux.models[0]!, modelRuntime: runtime,
				settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir),
				...(tools !== undefined ? { tools } : {}), ...(scenario.exclude ? { excludeTools: scenario.exclude } : {}),
			});
			try {
				await session.bindExtensions({ mode: "rpc" });
				assert.deepEqual(session.getActiveToolNames().filter((name) => name.startsWith("contact_")).sort(), scenario.expected, scenario.name);
				const callable = session.agent.state.tools.filter((tool) => tool.name.startsWith("contact_"));
				assert.deepEqual(callable.map((tool) => tool.name).sort(), scenario.expected, `${scenario.name}: actual model-callable schemas`);
				if (index === 0) {
					await registered;
					assert.ok(host.connectedHandles().includes(handle));
					const contact = callable.find((tool) => tool.name === "contact_supervisor")!;
					const premature = await contact.execute("before-ready", { kind: "progress", message: "before bridge readiness" });
					assert.equal((premature.details as { delivered: boolean }).delivered, false, "a host-side handle is insufficient client readiness evidence");
					assert.equal(bus.hasPending("supervisor"), false);
					// This native tool path awaits bridgeReady and the peer-list round trip. Use that
					// acknowledgement before sending once; never retry an unconfirmed progress send.
					const peers = callable.find((tool) => tool.name === "contact_peer")!;
					const ready = peers.execute("ready", { action: "list" });
					activateBridge();
					await ready;
					const receipt = await contact.execute("proof", { kind: "progress", message: "offline bridge proof" });
					assert.equal((receipt.details as { delivered: boolean }).delivered, true);
					const deadline = Date.now() + 3000;
					while (!bus.hasPending("supervisor")) {
						if (Date.now() > deadline) throw new Error("supervisor received no progress");
						await new Promise((resolve) => setTimeout(resolve, 5));
					}
					assert.match(JSON.stringify(bus.take("supervisor")), /offline bridge proof/);
				}
			} finally {
				activateBridge();
				await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
				host.forget(handle);
			}
		}
		assert.equal(faux.state.callCount, 0, "no model requests or provider spend");
	} finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
});
