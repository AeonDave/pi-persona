#!/usr/bin/env node
/**
 * Exercise pi-persona's settings command through the real Pi SDK, without an operator profile or
 * provider requests. Pass an alternate host module specifier (for example an absolute Pi package
 * entry) to qualify another installed SDK:
 *
 *   node --import tsx scripts/settings-smoke.mjs
 *   node --import tsx scripts/settings-smoke.mjs "C:\\...\\pi-coding-agent\\dist\\index.js"
 *   node --import tsx scripts/settings-smoke.mjs "C:\\...\\pi-coding-agent\\dist\\index.js" "D:\\...\\pi-persona-mind\\src\\index.ts" "D:\\...\\pi-persona-flow\\src\\extension.ts"
 */

import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST_PACKAGES = ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui", "pi-codemode", "pi-mcp"];
const requestedHost = process.argv[2] ?? "@earendil-works/pi-coding-agent";
const requestedMind = process.argv[3] || undefined;
const requestedFlow = process.argv[4] || undefined;
const disposableFlowIdleMs = 50;
const isExplicitPath = isAbsolute(requestedHost) || requestedHost.startsWith("file:");
const hostEntryUrl = requestedHost.startsWith("file:")
	? new URL(requestedHost)
	: isAbsolute(requestedHost)
		? pathToFileURL(resolve(requestedHost))
		: new URL(import.meta.resolve(requestedHost));
let hostEntryPath = fileURLToPath(hostEntryUrl);
let hostRoot;
if (basename(hostEntryPath) === "index.js" && basename(dirname(hostEntryPath)) === "dist") {
	hostRoot = dirname(dirname(hostEntryPath));
} else if (existsSync(join(hostEntryPath, "package.json"))) {
	hostRoot = hostEntryPath;
	hostEntryPath = join(hostRoot, "dist", "index.js");
} else {
	throw new Error(`Pass a Pi coding-agent package specifier or package entry, got ${requestedHost}`);
}
hostEntryPath = resolve(hostEntryPath);
hostRoot = resolve(hostRoot);
const hostPackage = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
assert.equal(hostPackage.name, "@earendil-works/pi-coding-agent", `Unexpected SDK package at ${hostRoot}`);
const hostModuleUrl = pathToFileURL(hostEntryPath).href;

function hostSubpackageRoot(packageName) {
	const nested = join(hostRoot, "node_modules", "@earendil-works", packageName);
	if (existsSync(join(nested, "package.json"))) return nested;
	const hoisted = join(dirname(hostRoot), packageName);
	if (existsSync(join(hoisted, "package.json"))) return hoisted;
	throw new Error(`Pi host package ${packageName} was not found under ${hostRoot}`);
}

function extensionModuleUrl(value, label) {
	if (value.startsWith("file:")) return new URL(value).href;
	if (!isAbsolute(value)) throw new Error(`${label} extension path must be absolute: ${value}`);
	return pathToFileURL(resolve(value)).href;
}

// Do not let the host or extension inspect the operator profile, shell credentials, or any
// inherited pi-persona switch. Both Pi agent-dir spellings are pinned to this disposable fixture.
const savedEnv = Object.fromEntries(Object.entries(process.env));
const envWhitelist = new Set(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC"]);
for (const key of Object.keys(process.env)) {
	if (!envWhitelist.has(key)) delete process.env[key];
}
process.env.PI_OFFLINE = "1";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-persona-settings-smoke-"));
const workspace = join(tempRoot, "workspace");
const agentDir = join(tempRoot, "agent");
const userPersonaDir = join(agentDir, "persona", "agents");
const projectAgentDir = join(workspace, ".pi", "agents");
const legacyConfigPath = join(agentDir, "persona", "config.json");
const legacyStatePath = join(agentDir, "persona", "state.json");
const settingsPath = join(agentDir, "persona", "settings.json");
const modelRef = "persona-settings-smoke-faux/local";
process.env.PI_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
// Keep Flow's service and descriptor entirely inside this disposable profile. Do not set Mind
// overrides: its effective values must come from the loaded extension's own settings snapshot.
if (requestedFlow) {
	process.env.PI_PERSONA_FLOW_PORT = "0";
	process.env.PI_PERSONA_FLOW_IDLE_MS = String(disposableFlowIdleMs);
}
const flowDescriptorPath = join(agentDir, "persona-flow", "service-v1", "service.json");

const sessions = [];
let fetchBefore;
let remoteNetworkRequests = 0;
let loopbackRequests = 0;
let teardownError;
let successResult;
let fauxCallCount = () => 0;
let flowServicePid;
let selections = [];
let notifications = [];
let tuiSelections = [];
let tuiNotifications = [];
let tuiRenderWidths = [];
let tuiPanelRenderWidths = [];
let tuiCustomCalls = 0;

function restoreEnvironment() {
	for (const key of Object.keys(process.env)) delete process.env[key];
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

function assertTempRoot(path) {
	const normalized = resolve(path);
	const normalizedParent = resolve(tmpdir());
	const fold = (value) => process.platform === "win32" ? value.toLowerCase() : value;
	assert.equal(fold(dirname(normalized)), fold(normalizedParent), `Refusing to remove outside the temp directory: ${normalized}`);
	assert.ok(basename(normalized).startsWith("pi-persona-settings-smoke-"), `Unexpected cleanup target: ${normalized}`);
}

function bounded(promise, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 12_000); }),
	]).finally(() => clearTimeout(timer));
}

async function optionalFile(file) {
	try { return await readFile(file); }
	catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function waitForFlowDescriptor(timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await readFile(flowDescriptorPath, "utf8"));
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Flow service descriptor did not appear within ${timeoutMs} ms: ${flowDescriptorPath}`);
}

async function waitForFlowShutdown(pid, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const descriptorPresent = existsSync(flowDescriptorPath);
		let processPresent = false;
		if (pid !== undefined) {
			try { process.kill(pid, 0); processPresent = true; }
			catch (error) {
				const code = error?.code;
				if (code === "EPERM") processPresent = true;
				else if (code !== "ESRCH") throw error;
			}
		}
		if (!descriptorPresent && !processPresent) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Flow service shutdown exceeded ${timeoutMs} ms (descriptor=${existsSync(flowDescriptorPath)}, pid=${pid ?? "unknown"})`);
}

function rpcUi(selections, notifications, overrides = {}) {
	let settingsMenus = 0;
	let modelMenus = 0;
	return {
		select: async (title, options) => {
			let choice;
			if (title === "Persona settings") {
				settingsMenus++;
				if (settingsMenus === 1) choice = options.find((option) => option.includes("[engine]"));
				else if (settingsMenus === 2) choice = "Models";
				else if (requestedMind && settingsMenus === 3) choice = options.find((option) => option.includes("[mindCapture]"));
				else choice = "Close";
			} else if (title.startsWith("Sub-agent engine ·")) {
				choice = "Edit";
			} else if (title.startsWith("Edit Sub-agent engine")) {
				choice = "child";
			} else if (title.startsWith("Memory capture mode ·")) {
				choice = "Edit";
			} else if (title.startsWith("Edit Memory capture mode ·")) {
				choice = "prompt";
			} else if (title === "Persona model owner") {
				choice = options.find((option) => option.includes("(owner)"));
			} else if (title === "Council profile") {
				choice = options.find((option) => option.includes("(magi)"));
			} else if (title.startsWith("Model settings ·")) {
				modelMenus++;
				choice = modelMenus === 1 ? options.find((option) => option.includes("casper")) : "Done";
			} else if (title.startsWith("Edit participant ·")) {
				choice = options.find((option) => option.includes("Set or change model"));
			} else if (title.startsWith("Model for ")) {
				choice = options.find((option) => option === modelRef);
			} else {
				throw new Error(`Unexpected RPC selection: ${title} (${options.join(", ")})`);
			}
			assert.ok(choice, `No planned choice for ${title}: ${options.join(", ")}`);
			selections.push({ title, choice });
			return choice;
		},
		confirm: async () => false,
		input: async () => undefined,
		notify: (message, level) => notifications.push({ message: String(message), level }),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: new Proxy({}, { get: () => (...args) => args.at(-1) ?? "" }),
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		...overrides,
	};
}

try {
	await mkdir(userPersonaDir, { recursive: true });
	await mkdir(projectAgentDir, { recursive: true });
	await mkdir(join(workspace, ".pi"), { recursive: true });
	await writeFile(join(userPersonaDir, "host-smoke.md"), "---\nname: host-smoke\nlabel: Host smoke\npersona: true\n---\nA temporary settings smoke persona.\n", "utf8");
	await writeFile(join(userPersonaDir, "owner.md"), "---\nname: owner\nlabel: Non-active owner\npersona: true\n---\nA persona used only as the saved model owner.\n", "utf8");
	await writeFile(join(userPersonaDir, "magi.md"), "---\nname: magi\nlabel: MAGI profile\npersona: true\ncouncil:\n  strategy: magi\n  roster: magi\n  params:\n    reflect: false\n---\nA borrowed model-profile fixture.\n", "utf8");
	for (const agent of ["melchior", "balthasar", "casper"]) {
		await writeFile(join(projectAgentDir, `${agent}.md`), `---\nname: ${agent}\n---\nA local, no-call participant fixture.\n`, "utf8");
	}
	await writeFile(join(workspace, ".pi", "teams.yaml"), "magi: [melchior, balthasar, casper]\n", "utf8");
	await writeFile(legacyConfigPath, JSON.stringify({ "host-smoke": { models: { melchior: modelRef } } }, null, 2), "utf8");
	await writeFile(legacyStatePath, JSON.stringify({ lastPersona: "host-smoke" }, null, 2), "utf8");

	if (isExplicitPath) {
		registerHooks({
			resolve(specifier, context, nextResolve) {
				for (const packageName of HOST_PACKAGES) {
					if (specifier !== `@earendil-works/${packageName}`) continue;
					const packageRoot = packageName === "pi-coding-agent"
						? hostRoot
						: hostSubpackageRoot(packageName);
					return nextResolve(pathToFileURL(join(packageRoot, "dist", "index.js")).href, context);
				}
				return nextResolve(specifier, context);
			},
		});
	}

	const host = await import(hostModuleUrl);
	const piAi = isExplicitPath
		? await import(pathToFileURL(join(hostSubpackageRoot("pi-ai"), "dist", "providers", "faux.js")).href)
		: await import("@earendil-works/pi-ai");
	const piTui = isExplicitPath
		? await import(pathToFileURL(join(hostSubpackageRoot("pi-tui"), "dist", "index.js")).href)
		: await import("@earendil-works/pi-tui");
	const hostTheme = await import(pathToFileURL(join(hostRoot, "dist", "modes", "interactive", "theme", "theme.js")).href);
	const { default: piPersona } = await import(new URL("../src/extension.ts", import.meta.url).href);
	const extensionFactories = [piPersona];
	if (requestedMind) {
		const { default: piMind } = await import(extensionModuleUrl(requestedMind, "Mind"));
		extensionFactories.push(piMind);
	}
	if (requestedFlow) {
		const { default: piFlow } = await import(extensionModuleUrl(requestedFlow, "Flow"));
		extensionFactories.push(piFlow);
	}
	assert.equal(typeof host.DefaultResourceLoader, "function");
	assert.equal(typeof host.createAgentSession, "function");
	assert.equal(typeof piPersona, "function");
	assert.ok(extensionFactories.every((factory) => typeof factory === "function"), "Every requested companion must export a Pi extension factory");
	assert.equal(typeof host.initTheme, "function", "The host exposes its theme initializer");
	assert.equal(typeof piTui.KeybindingsManager, "function", "The host pi-tui package exposes its keybindings manager");
	host.initTheme(undefined, false);
	const actualTheme = hostTheme.theme;
	const keybindings = new piTui.KeybindingsManager(piTui.TUI_KEYBINDINGS);
	piTui.setKeybindings(keybindings);

	fetchBefore = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const target = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
		let url;
		try { url = new URL(target); }
		catch {
			remoteNetworkRequests++;
			throw new Error(`Settings smoke network tripwire: invalid/remote request target ${target}`);
		}
		if (url.protocol === "http:" && url.hostname === "127.0.0.1") {
			loopbackRequests++;
			return fetchBefore(input, init);
		}
		remoteNetworkRequests++;
		throw new Error(`Settings smoke network tripwire: remote request blocked (${url.origin}).`);
	};

	const settingsManager = host.SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false },
	});
	const resourceLoader = new host.DefaultResourceLoader({
		cwd: workspace,
		agentDir,
		settingsManager,
		extensionFactories,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	const credentialsByProvider = new Map();
	const credentials = {
		async read(providerId) { return credentialsByProvider.get(providerId); },
		async list() { return [...credentialsByProvider].map(([providerId, value]) => ({ providerId, type: value.type })); },
		async modify(providerId, update) {
			const next = await update(credentialsByProvider.get(providerId));
			if (next !== undefined) credentialsByProvider.set(providerId, next);
			return next;
		},
		async delete(providerId) { credentialsByProvider.delete(providerId); },
	};
	const runtime = await host.ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStorePath: join(agentDir, "synthetic-models-store.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const faux = piAi.fauxProvider({
		provider: "persona-settings-smoke-faux",
		models: [{ id: "local", name: "Settings smoke local faux" }],
	});
	fauxCallCount = () => faux.state.callCount;
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("persona-settings-smoke-faux", "synthetic-key-never-transmitted");
	await runtime.refresh({ allowNetwork: false, providers: ["persona-settings-smoke-faux"] });
	const model = runtime.getModel("persona-settings-smoke-faux", "local");
	assert.ok(model, "The local faux model must be available to the model settings picker");
	assert.ok(runtime.getAvailableSnapshot().some((entry) => entry.provider === model.provider && entry.id === model.id),
		"The local faux model must be present in Pi's authenticated model snapshot");

	const sessionManager = host.SessionManager.inMemory(workspace);
	const created = await host.createAgentSession({
		cwd: workspace,
		agentDir,
		model,
		modelRuntime: runtime,
		resourceLoader,
		sessionManager,
		settingsManager,
	});
	const session = created.session;
	sessions.push(session);
	selections = [];
	notifications = [];
	const uiContext = rpcUi(selections, notifications);
	await session.bindExtensions({ uiContext, mode: "rpc" });
	let flowDescriptor;
	if (requestedFlow) {
		flowDescriptor = await waitForFlowDescriptor();
		flowServicePid = flowDescriptor.pid;
		const flowUrl = new URL(flowDescriptor.url);
		assert.equal(flowUrl.protocol, "http:", "The disposable Flow descriptor must use local HTTP");
		assert.equal(flowUrl.hostname, "127.0.0.1", "Flow's smoke service must bind to IPv4 loopback only");
		assert.ok(Number(flowUrl.port) > 0 && Number(flowUrl.port) < 65_536, "Flow must publish its assigned ephemeral port");
		assert.notEqual(Number(flowUrl.port), 7874, "PI_PERSONA_FLOW_PORT=0 must not use the shared default port");
		assert.ok(Number.isSafeInteger(flowDescriptor.pid) && flowDescriptor.pid > 0, "Flow descriptor must identify its disposable service process");
	}

	await bounded(session.prompt("/persona-settings show"), "settings show command");
	assert.ok(notifications.some((entry) => entry.message.includes(settingsPath) && entry.message.includes("engine:")),
		"The actual slash command did not report the canonical settings file and resolved setting state");
	const initialSettingsReport = notifications.find((entry) => entry.message.includes(settingsPath) && entry.message.includes("engine:"))?.message;
	assert.ok(initialSettingsReport, "The real settings report should be available for companion assertions");
	const assertShownValue = (id, active) => {
		const row = initialSettingsReport.split(/\r?\n/).find((line) => line.startsWith(`${id}:`));
		assert.ok(row, `Loaded companion setting ${id} is missing from /persona-settings show`);
		assert.ok(row.includes(`active=${active}`), `Unexpected active value for ${id}: ${row}`);
	};
	if (requestedMind) {
		assertShownValue("mindCapture", "auto");
		assertShownValue("mindNudge", "On");
	}
	if (requestedFlow) {
		assertShownValue("flowEnabled", "On");
		assertShownValue("flowPort", "0");
		assertShownValue("flowIdleMs", String(disposableFlowIdleMs));
	}
	const mindLtmPath = join(agentDir, "persona-mind", "memory", "ltm", "host-smoke.json");
	const mindLtmBeforeEdit = requestedMind ? await optionalFile(mindLtmPath) : undefined;

	await bounded(session.prompt("/persona-settings"), "settings editor command");
	const savedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
	if (requestedMind) await bounded(session.prompt("/persona-settings show"), "post-edit settings show command");
	const postEditReport = requestedMind
		? notifications.filter((entry) => entry.message.includes(settingsPath) && entry.message.includes("engine:")).at(-1)?.message
		: undefined;
	assert.equal(savedSettings.version, 1);
	assert.equal(savedSettings.preferences.engine, "child", "The RPC editor did not persist the selected scalar preference");
	if (requestedMind) {
		assert.equal(savedSettings.preferences.mindCapture, "prompt", "The RPC editor did not persist Mind's capture preference in the canonical file");
		const editedMindRow = postEditReport?.split(/\r?\n/).find((line) => line.startsWith("mindCapture:"));
		assert.ok(editedMindRow, "The post-edit report omitted Mind's persisted preference");
		assert.match(editedMindRow, /active=auto; saved=prompt; source=saved · pending \/reload/,
			"Editing a restart-bound Mind preference should preserve the loaded active value and report it pending");
		assert.deepEqual(await optionalFile(mindLtmPath), mindLtmBeforeEdit,
			"Editing the settings preference must not create or mutate captured Mind memory");
	}
	assert.equal(savedSettings.personas["host-smoke"]?.models?.melchior, modelRef, "Legacy model assignment was not preserved");
	assert.equal(savedSettings.personas.owner?.models?.casper, modelRef, "Model selection was not stored under the explicitly selected owner");
	assert.equal(savedSettings.personas.magi, undefined, "The borrowed council profile was modified instead of the selected owner");
	assert.equal(savedSettings.lastPersona, "host-smoke", "Opening model settings changed the remembered/active persona");
	assert.equal(savedSettings.selectionRevision, 0, "Preference/model edits are not persona-selection gestures");
	assert.equal(existsSync(legacyConfigPath), false, "Successfully migrated config.json should no longer be an active store");
	assert.equal(existsSync(legacyStatePath), false, "Successfully migrated state.json should no longer be an active store");
	assert.ok(existsSync(`${legacyConfigPath}.migrated`), "The retired model file should have a recoverable archive");
	assert.ok(existsSync(`${legacyStatePath}.migrated`), "The retired state file should have a recoverable archive");
	assert.ok(selections.some((entry) => entry.title === "Persona model owner" && entry.choice.includes("(owner)")),
		"The model owner was not explicitly selected through the real RPC UI");
	assert.ok(selections.some((entry) => entry.title === "Council profile" && entry.choice.includes("(magi)")),
		"The named council profile was not explicitly selected through the real RPC UI");
	assert.ok(selections.some((entry) => entry.title.startsWith("Model for ") && entry.choice === modelRef),
		"The faux model was not chosen through the actual model picker flow");

	// Exercise the real TUI custom-component factory without a terminal or provider call. This proves
	// component rendering/cancel behavior at narrow and wide widths, not a manual interactive session.
	let tuiSettingsMenus = 0;
	let tuiModelMenus = 0;
	tuiSelections = [];
	tuiNotifications = [];
	tuiRenderWidths = [];
	tuiPanelRenderWidths = [];
	tuiCustomCalls = 0;
	let tuiUi;
	tuiUi = rpcUi(tuiSelections, tuiNotifications, {
		select: async (title, options) => {
			let choice;
			if (title === "Persona settings") choice = ++tuiSettingsMenus === 1 ? "Models" : "Close";
			else if (title === "Persona model owner") choice = options.find((option) => option.includes("(host-smoke)"));
			else if (title === "Council profile") choice = options.find((option) => option.includes("(magi)"));
			else if (title.startsWith("Model settings ·")) choice = ++tuiModelMenus === 1 ? options.find((option) => option.includes("casper")) : "Done";
			else if (title.startsWith("Edit participant ·")) choice = options.find((option) => option.includes("Set or change model"));
			else throw new Error(`Unexpected TUI smoke selection: ${title} (${options.join(", ")})`);
			assert.ok(choice, `No planned TUI choice for ${title}: ${options.join(", ")}`);
			tuiSelections.push({ title, choice });
			return choice;
		},
		theme: actualTheme,
		getTheme: (name) => name === actualTheme.name ? actualTheme : undefined,
		custom: async (factory, options) => {
			tuiCustomCalls++;
			const selectedTheme = tuiUi.getTheme(actualTheme.name) ?? tuiUi.theme;
			const tui = { rows: 24, terminal: { rows: 24 }, requestRender() {} };
			let finish;
			const selected = new Promise((resolveSelection) => { finish = resolveSelection; });
			const component = await factory(tui, selectedTheme, keybindings, (result) => finish(result));
			if (tuiCustomCalls === 1 || tuiCustomCalls === 3) {
				for (const width of tuiCustomCalls === 1 ? [40, 80, 120] : [80]) {
					const lines = component.render(width);
					assert.ok(lines.length > 0, `The settings panel rendered no lines at width ${width}`);
					assert.ok(lines.every((line) => piTui.visibleWidth(line) <= width), `The settings panel overflowed width ${width}`);
					assert.ok(lines.some((line) => piTui.stripTerminalSequences(line).includes("Persona settings")), "The host theme did not render the settings-panel title");
					tuiPanelRenderWidths.push(width);
				}
				component.handleInput(tuiCustomCalls === 1 ? "m" : "\u001b");
				return await selected;
			}
			if (tuiCustomCalls !== 2) throw new Error(`Unexpected custom component invocation ${tuiCustomCalls}`);
			assert.equal(options?.overlay, false, "The model picker is intentionally inline, not an overlay");
			for (const width of [40, 80, 120]) {
				const lines = component.render(width);
				assert.ok(lines.length > 0, `The model picker rendered no lines at width ${width}`);
				assert.ok(lines.every((line) => piTui.visibleWidth(line) <= width), `The model picker overflowed width ${width}`);
				assert.ok(lines.some((line) => piTui.stripTerminalSequences(line).includes("local")), `The model ref was not visible at width ${width}`);
				tuiRenderWidths.push(width);
			}
			component.handleInput("\u001b");
			const result = await selected;
			component.dispose?.();
			assert.equal(result, undefined, "Escape cancels the model selection without choosing an assignment");
			return result;
		},
	});
	const beforeTuiEdit = JSON.parse(await readFile(settingsPath, "utf8"));
	const tuiCreated = await host.createAgentSession({
		cwd: workspace,
		agentDir,
		model,
		modelRuntime: runtime,
		resourceLoader,
		sessionManager: host.SessionManager.inMemory(workspace),
		settingsManager,
	});
	sessions.push(tuiCreated.session);
	await tuiCreated.session.bindExtensions({ uiContext: tuiUi, mode: "tui" });
	await bounded(tuiCreated.session.prompt("/persona-settings"), "TUI settings editor command");
	assert.equal(tuiCustomCalls, 3, "The TUI settings panel and model picker used the extension custom-component factory");
	assert.deepEqual(tuiRenderWidths, [40, 80, 120]);
	assert.deepEqual(tuiPanelRenderWidths, [40, 80, 120, 80]);
	assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), beforeTuiEdit, "Cancelling the TUI picker changed no settings");

	assert.equal(faux.state.callCount, 0, "Settings editing made an LLM/provider request");
	assert.equal(remoteNetworkRequests, 0, "A remote request escaped the offline network tripwire");
	if (requestedFlow) assert.ok(loopbackRequests > 0, "The real Flow attachment should use only allowed loopback HTTP");

	successResult = {
		status: "PASS",
		host: hostPackage.name,
		version: hostPackage.version,
		checks: {
			actualShowCommand: true,
			actualRpcEditor: true,
			preferencePersisted: savedSettings.preferences.engine,
			mindCaptureSavedPendingReload: requestedMind ? savedSettings.preferences.mindCapture === "prompt" : undefined,
			mindMemoryUnchangedAfterSettingsEdit: requestedMind ? true : undefined,
			explicitOwnerAndProfile: true,
			modelPicked: savedSettings.personas.owner.models.casper,
			companionSettingRows: [
				...(requestedMind ? ["mindCapture", "mindNudge"] : []),
				...(requestedFlow ? ["flowEnabled", "flowPort", "flowIdleMs"] : []),
			],
			flowLoopbackDescriptor: flowDescriptor?.url,
			flowDescriptorRemovedOnShutdown: requestedFlow ? true : undefined,
			legacyFilesArchived: true,
			lastPersonaPreserved: savedSettings.lastPersona,
			tuiComponentRenderWidths: tuiRenderWidths,
			tuiCancellationWithoutWrite: true,
			tuiSettingsPanelRenderWidths: tuiPanelRenderWidths,
		},
	};
} catch (error) {
	process.stderr.write(`${JSON.stringify({
		status: "FAIL",
		host: hostPackage.name,
		version: hostPackage.version,
		error: error instanceof Error ? error.message : String(error),
		selections,
		notifications,
		requests: { remote: remoteNetworkRequests, loopback: loopbackRequests },
		tuiSelections,
		tuiNotifications,
		tuiCustomCalls,
		tuiRenderWidths,
		tuiPanelRenderWidths,
	})}\n`);
	if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
	process.exitCode = 1;
} finally {
	for (const session of sessions) {
		try {
			await session.abort();
			await session.agent.waitForIdle();
		} catch (error) {
			teardownError = error;
		}
		try {
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		} catch (error) {
			teardownError ??= error;
		} finally {
			session.dispose();
		}
	}
	if (fetchBefore) globalThis.fetch = fetchBefore;
	let flowStopped = true;
	if (requestedFlow) {
		try { await waitForFlowShutdown(flowServicePid); }
		catch (error) { flowStopped = false; teardownError ??= error; }
	}
	if (fauxCallCount() !== 0 || remoteNetworkRequests !== 0) {
		teardownError ??= new Error(`Offline smoke request invariant failed after shutdown (llm=${fauxCallCount()}, remote=${remoteNetworkRequests})`);
	}
	try {
		if (flowStopped) {
			assertTempRoot(tempRoot);
			await rm(tempRoot, { recursive: true, force: true });
		}
	} catch (error) {
		teardownError ??= error;
	}
	restoreEnvironment();
	if (teardownError) {
		process.stderr.write(`Settings smoke teardown failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}\n`);
		process.exitCode = 1;
	}
}

if (successResult && process.exitCode !== 1) {
	successResult.requests = { llm: fauxCallCount(), remote: remoteNetworkRequests, loopback: loopbackRequests };
	process.stdout.write(`${JSON.stringify(successResult)}\n`);
}
