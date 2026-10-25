/**
 * Real-provider, two independent SDK-session Exocom collaboration smoke.
 * LIVE_MODEL=provider/id node --import tsx scripts/exocom-collaboration-smoke.mjs
 * Uses only a disposable workspace/profile. Credentials/models are copied there;
 * the operator profile is never mutated. No child agents or write claims are used.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const modelRef = process.env.LIVE_MODEL?.trim();
if (!modelRef?.includes("/")) {
	console.error("Refusing real model calls: set LIVE_MODEL=provider/id explicitly.");
	process.exit(2);
}
const thinking = process.env.LIVE_THINKING ?? "xhigh";
const sourceProfile = process.env.PI_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const savedEnv = { ...process.env };
const root = mkdtempSync(join(tmpdir(), "pi-persona-collaboration-smoke-"));
const workspace = join(root, "workspace");
const agentDir = join(root, "agent");
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });
for (const file of ["auth.json", "models.json"]) {
	const source = join(sourceProfile, file);
	if (existsSync(source)) cpSync(source, join(agentDir, file));
}
for (const key of Object.keys(process.env)) if (key.startsWith("PI_PERSONA_")) delete process.env[key];
Object.assign(process.env, {
	PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_PERSONA_EXOCOM: "1",
	PI_PERSONA_SEED: "off", PI_PERSONA_PERSIST: "off", PI_PERSONA_NUDGE: "off", PI_PERSONA_BROKER: "off",
});
const fixture = "alpha=19\nbeta=23\n";
writeFileSync(join(workspace, "fixture.txt"), fixture);
const sessions = [];
const timeline = [];
const started = Date.now();
const deadline = started + 180_000;
let teardownError;
const note = (message) => {
	const text = `+${((Date.now() - started) / 1000).toFixed(1)}s ${message}`;
	timeline.push(text);
	console.log(text);
};
const pendingChecks = new Set();
function checkWaiters() { for (const check of [...pendingChecks]) check(); }
function until(predicate, label) {
	return new Promise((resolveWait, reject) => {
		const timer = setTimeout(() => settle(new Error(`Deadline: ${label}`)), Math.max(1, deadline - Date.now()));
		const check = () => {
			try { if (predicate()) settle(); } catch (error) { settle(error); }
		};
		function settle(error) {
			clearTimeout(timer);
			pendingChecks.delete(check);
			if (error) reject(error); else resolveWait();
		}
		pendingChecks.add(check);
		check();
	});
}
async function bounded(promise, label) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), Math.max(1, deadline - Date.now()));
		})]);
	} finally { clearTimeout(timer); }
}
function ui(notifications) {
	const no = () => {};
	return {
		select: async () => undefined, confirm: async () => false, input: async () => undefined,
		notify: (message, level) => notifications.push({ message: String(message), level }),
		onTerminalInput: () => no, setStatus: no, setWorkingMessage: no, setWorkingVisible: no,
		setWorkingIndicator: no, setHiddenThinkingLabel: no, setWidget: no, setFooter: no,
		setHeader: no, setTitle: no, custom: async () => undefined, pasteToEditor: no,
		setEditorText: no, getEditorText: () => "", editor: async () => undefined,
		addAutocompleteProvider: no, setEditorComponent: no, getEditorComponent: () => undefined,
		theme: new Proxy({}, { get: () => (...args) => args.at(-1) ?? "" }), getAllThemes: () => [],
		getTheme: () => undefined, setTheme: () => ({ success: true }), getToolsExpanded: () => false,
		setToolsExpanded: no,
	};
}

try {
	const host = await import("@earendil-works/pi-coding-agent");
	const { default: persona } = await import("../src/extension.ts");
	const { ledgerPath, workspaceHash } = await import("../src/exocom/paths.ts");
	const { loadLedger } = await import("../src/exocom/ledger.ts");
	const { readAll } = await import("../src/exocom/registry.ts");
	host.initTheme(undefined, false);
	const hash = workspaceHash(workspace);
	const ledgerFile = ledgerPath(agentDir, hash);
	const ledger = () => loadLedger(ledgerFile);
	const [provider, ...modelParts] = modelRef.split("/");
	const modelId = modelParts.join("/");
	async function open(label, tools) {
		const notifications = [];
		const settingsManager = host.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const loader = new host.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager,
			extensionFactories: [persona], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
		await loader.reload();
		const runtime = await host.ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, `${label}-models.json`),
			allowModelNetwork: false });
		const model = runtime.getModel(provider, modelId);
		assert.ok(model, `${modelRef} is unavailable in the isolated configured host`);
		const { session } = await host.createAgentSession({ cwd: workspace, agentDir, modelRuntime: runtime, model,
			thinkingLevel: thinking, resourceLoader: loader, settingsManager, sessionManager: host.SessionManager.inMemory(workspace) });
		const record = { label, session, notifications, calls: [], ends: 0, wakes: [] };
		sessions.push(record);
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				record.calls.push({ id: event.toolCallId, name: event.toolName, args: event.args });
				note(`${label} tool ${event.toolName} ${event.args?.action ?? ""}`);
			}
			if (event.type === "tool_execution_end") {
				const call = record.calls.findLast((entry) => entry.id === event.toolCallId);
				if (call) Object.assign(call, { result: event.result, isError: event.isError === true });
				if (event.isError) note(`${label} tool error ${event.toolName}: ${JSON.stringify(event.result).slice(0, 350)}`);
			}
			if (event.type === "message_end" && event.message?.role === "custom" && event.message.customType === "exocom_received") {
				record.wakes.push(event.message);
				note(`${label} optional peer wake`);
			}
			if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
				note(`${label} provider error: ${String(event.message.errorMessage).slice(0, 350)}`);
			}
			if (event.type === "agent_end") { record.ends++; note(`${label} agent_end #${record.ends}`); }
			checkWaiters();
		});
		await session.bindExtensions({ uiContext: ui(notifications), mode: "rpc" });
		session.setActiveToolsByName(tools);
		assert.equal(session.model.provider, provider);
		assert.equal(session.model.id, modelId);
		assert.equal(session.thinkingLevel, thinking, "Host did not apply requested thinking level");
		return record;
	}
	note(`model=${modelRef} thinking=${thinking}; disposable independent sessions`);
	const a = await bounded(open("coordinator", ["exocom_name", "exocom_list", "exocom_task", "exocom_offer", "exocom_publish"]), "open coordinator");
	const b = await bounded(open("reader", ["read", "exocom_name", "exocom_list", "exocom_task", "exocom_publish"]), "open reader");
	assert.equal(readAll(agentDir, hash).length, 2, "Both independent sessions must publish presence");
	const bPrompt = [
		"You are an independently authorized participant in a bounded Exocom smoke test. Use exocom_name to name yourself SmokeReader.",
		"For now, end your turn with READY. Do not create tasks or send messages.",
		"Standing authorization for a later OPTIONAL invitation: voluntarily inspect only the readonly task whose work_key is arithmetic-smoke.",
		"On that automatic invitation wake: use exocom_task list, then get with the exact work_key+task_id you observed. If it is open and readonly, take it once.",
		"Read fixture.txt using read. Compute alpha+beta. Publish one short evidence excerpt for that same task_id containing the exact token SMOKE_SUM=42 and the two source values.",
		"Finish the same task_id with outcome done and a short note. Then end the turn. Never create claims or asks, poll, sleep, delegate, or write files.",
	].join("\n");
	await bounded(b.session.prompt(bPrompt), "reader standing authorization");
	const aPrompt = [
		"This is a bounded Exocom smoke test. Name yourself SmokeCoordinator with exocom_name, then use exocom_list to discover SmokeReader.",
		"Create exactly one READONLY task using exocom_task create: work_key arithmetic-smoke, write_set [], description 'Inspect fixture.txt readonly, compute alpha+beta, and publish a short evidence excerpt; do not modify files.'",
		"Use the returned task_id to send one exocom_offer to SmokeReader's exact qualified target from exocom_list. This is optional collaboration, not an ask.",
		"Then end this turn. Do not take the task yourself, poll, sleep, write, ask, delegate, or send any additional messages.",
	].join("\n");
	await bounded(a.session.prompt(aPrompt), "coordinator task+offer");
	await until(() => ledger().collaboration?.tasks.some((task) => task.created.work_key === "arithmetic-smoke" && task.finished?.outcome === "done") && b.ends >= 2, "reader completes invitation");
	await bounded(b.session.agent.waitForIdle(), "reader idle");
	const state = ledger();
	const task = state.collaboration.tasks.find((entry) => entry.created.work_key === "arithmetic-smoke");
	assert.ok(task);
	assert.notEqual(task.created.from_session, task.taken.from_session, "Independent peer must take coordinator's task");
	assert.equal(task.taken.from_session, b.session.sessionManager.getSessionId());
	assert.equal(task.finished.from_session, task.taken.from_session);
	assert.equal(task.finished.task_id, task.created.msg_id);
	assert.deepEqual(task.created.write_set, []);
	assert.equal(state.claims.length, 0);
	assert.equal(state.asks.length, 0, "Optional invitation must not create an ask gate");
	assert.equal(state.askIds.length, 0, "The scenario must never have created a durable ask");
	assert.equal(state.collaboration.offers.length, 1);
	assert.equal(b.wakes.length, 1, "Exactly one optional-offer wake expected");
	const excerpt = state.collaboration.evidence.find((entry) => entry.task_id === task.created.msg_id);
	assert.ok(excerpt?.excerpt.includes("SMOKE_SUM=42"), "Ledger must contain model-published arithmetic evidence");
	assert.match(excerpt.excerpt, /\b19\b/);
	assert.match(excerpt.excerpt, /\b23\b/);
	assert.equal(excerpt.from_session, task.taken.from_session);
	const succeeded = (record, name, action) => record.calls.filter((call) => call.name === name && (!action || call.args.action === action) && call.result && !call.isError);
	assert.equal(succeeded(a, "exocom_task", "create").length, 1);
	assert.equal(succeeded(a, "exocom_offer").length, 1);
	for (const action of ["list", "get", "take", "finish"]) assert.equal(succeeded(b, "exocom_task", action).length, 1, `Reader actual ${action} event required exactly once`);
	assert.equal(succeeded(b, "read").length, 1);
	assert.equal(resolve(workspace, succeeded(b, "read")[0].args.path), join(workspace, "fixture.txt"), "Actual model read must target the isolated fixture");
	assert.equal(succeeded(b, "exocom_publish", "publish").length, 1);
	assert.ok(sessions.every((record) => record.calls.every((call) => !call.isError)), "No failed tool calls are accepted as smoke success");
	assert.equal(readFileSync(join(workspace, "fixture.txt"), "utf8"), fixture);
	note(`PASS actual discovery→create→offer→automatic wake→get→take→read→publish→done; zero claims/asks; evidence=${excerpt.msg_id}`);
} catch (error) {
	console.error(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
	for (const record of sessions) console.error(`${record.label} diagnostics: ${JSON.stringify({ ends: record.ends, calls: record.calls.map((call) => ({ name: call.name, action: call.args?.action, isError: call.isError, ...(call.isError ? { args: call.args } : {}) })), notifications: record.notifications }).slice(-5000)}`);
	process.exitCode = 1;
} finally {
	for (const { session, label } of sessions) {
		try {
			await session.abort();
			await session.agent.waitForIdle();
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			note(`${label} session_shutdown joined`);
		} catch (error) { teardownError ??= error; }
		finally { session.dispose(); }
	}
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	assert.equal(resolve(dirname(root)), resolve(tmpdir()), "Cleanup target must be directly under temp");
	assert.ok(basename(root).startsWith("pi-persona-collaboration-smoke-"));
	rmSync(root, { recursive: true, force: true });
	if (teardownError) { console.error(`Shutdown failed: ${String(teardownError)}`); process.exitCode = 1; }
}
