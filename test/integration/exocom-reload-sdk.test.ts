import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import piPersona from "../../src/extension.ts";
import { ExocomPlane } from "../../src/exocom/plane.ts";
import { endpoint, workspaceHash } from "../../src/exocom/paths.ts";

function ui(): ExtensionUIContext {
	return {
		select: async () => undefined, confirm: async () => false, input: async () => undefined,
		notify: () => {}, onTerminalInput: () => () => {}, setStatus: () => {}, setWorkingMessage: () => {},
		setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {}, setWidget: () => {},
		setFooter: () => {}, setHeader: () => {}, setTitle: () => {}, custom: async <T>() => undefined as T,
		pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "", editor: async () => undefined,
		addAutocompleteProvider: () => {}, setEditorComponent: () => {}, getEditorComponent: () => undefined,
		theme: {} as ExtensionUIContext["theme"], getAllThemes: () => [], getTheme: () => undefined,
		setTheme: () => ({ success: true }), getToolsExpanded: () => false, setToolsExpanded: () => {},
	};
}

test("an accepted peer message queued during a turn survives same-session reload exactly once", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "exocom-reload-sdk-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	const previous = { ...process.env };
	Object.assign(process.env, { PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_PERSONA_EXOCOM: "1", PI_PERSONA_SEED: "off", PI_PERSONA_PERSIST: "off" });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let started!: () => void;
	const busy = new Promise<void>((resolve) => { started = resolve; });
	let holdRestoredSettlement = false;
	let releaseSettlement!: () => void;
	const settlementGate = new Promise<void>((resolve) => { releaseSettlement = resolve; });
	let settlementReached!: () => void;
	const settling = new Promise<void>((resolve) => { settlementReached = resolve; });
	let firstId = "";
	let queuedId = "";
	const senderId = `reload-sender-${process.pid}`;
	const senderTarget = `ReloadSender@${createHash("sha256").update(senderId).digest("hex").slice(0, 24)}`;
	const faux = fauxProvider({ provider: "exocom-reload-offline", models: [{ id: "local" }] });
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("exocom_send", { target: senderTarget, message: "first reply", in_reply_to: firstId }, { id: "first-reply" }), { stopReason: "toolUse" }),
		() => fauxAssistantMessage("first reply sent"),
		async () => { started(); await gate; return fauxAssistantMessage("busy turn finished"); },
		() => fauxAssistantMessage(fauxToolCall("exocom_send", { target: senderTarget, message: "reply after reload", in_reply_to: queuedId }, { id: "restored-reply" }), { stopReason: "toolUse" }),
		() => { holdRestoredSettlement = true; return fauxAssistantMessage("received"); },
	]);
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("exocom-reload-offline", "synthetic-key-never-transmitted");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, extensionFactories: [piPersona, (pi) => {
		// A companion may still be finishing its settlement work after the inner agent is idle.
		pi.on("agent_before_settle", async () => {
			if (!holdRestoredSettlement) return;
			holdRestoredSettlement = false;
			settlementReached();
			await settlementGate;
		});
	}], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
	await loader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, model: faux.models[0]!, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
	const received: string[] = [];
	const diagnostics: string[] = [];
	session.subscribe((event) => {
		if (event.type === "tool_execution_end" && event.isError) diagnostics.push(JSON.stringify(event.result));
		if (event.type === "message_end" && event.message?.role === "custom" && event.message.customType === "exocom_received") received.push(JSON.stringify(event.message));
	});
	const hash = workspaceHash(cwd);
	const replies: Array<{ msg_id: string; in_reply_to?: string; hops: number }> = [];
	const sender = new ExocomPlane({ agentDir, hash, identity: { session_id: senderId, name: "ReloadSender", persona: "", purpose: "", color: "", model: "offline", endpoint: endpoint(agentDir, hash, senderId, process.platform), cwd }, getCard: () => ({ name: "ReloadSender", persona: "", model: "offline", context_pct: 0, inbox: 0 }), onInbound: (msg) => { replies.push(msg); return { accepted: true }; } });
	try {
		await session.bindExtensions({ uiContext: ui(), mode: "rpc" });
		session.setActiveToolsByName(["exocom_send"]);
		await sender.start();
		const receiver = sender.listPeers().find((peer) => peer.session_id === session.sessionManager.getSessionId());
		assert.ok(receiver, "the SDK session registered in the isolated scope");
		firstId = (await sender.send(receiver.target, "start reply chain")).msg_id;
		let deadline = Date.now() + 5000;
		while (replies.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		await session.waitForIdle();
		assert.equal(replies[0]?.in_reply_to, firstId, JSON.stringify({ received, diagnostics }));
		assert.equal(replies[0]?.hops, 1);
		received.length = 0;
		const turn = session.prompt("hold this turn");
		await busy;
		queuedId = (await sender.send(receiver.target, "EXOCOM_RELOAD_PROBE", replies[0]!.msg_id)).msg_id;
		assert.equal(received.length, 0, "the accepted message is held while the supervisor is busy");
		release();
		await turn;
		assert.equal(received.length, 0, "the queued delivery has not fired before reload");
		await session.reload();
		deadline = Date.now() + 5000;
		while (received.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		while (replies.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		await session.agent.waitForIdle();
		await settling;
		assert.equal(session.isStreaming, true, "the inner agent can be idle while the SDK session is still settling");
		const settled = session.waitForIdle();
		releaseSettlement();
		await settled;
		assert.equal(session.isStreaming, false, "reload waits for the complete session, including companion settlement");
		assert.equal(received.length, 1, "one restored peer delivery reaches the session");
		assert.match(received[0]!, /EXOCOM_RELOAD_PROBE/);
		assert.equal(replies[1]?.in_reply_to, queuedId);
		assert.equal(replies[1]?.hops, 3, "reply chain depth survives reload");
		await session.reload();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(received.length, 1, "a second reload does not replay the delivered message");
	} finally {
		release();
		releaseSettlement();
		await sender.stop();
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		await rm(root, { recursive: true, force: true });
	}
});
