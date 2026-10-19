#!/usr/bin/env node
/**
 * Qualify pi-persona against an explicitly installed Pi host, without touching that host or the
 * operator's Pi profile. The source extension is loaded through the host's actual Pi 1.3 SDK;
 * all session state, agent files, model/auth state, and writes live under a fresh temp directory.
 *
 * Usage:
 *   node --import tsx scripts/qualify-host.mjs "C:\\Users\\...\\node_modules\\@earendil-works\\pi-coding-agent"
 */

import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HOST_PACKAGES = ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui", "pi-codemode", "pi-mcp"];
const hostRootArg = process.argv[2];
if (!hostRootArg || !isAbsolute(hostRootArg)) {
	throw new Error("Pass the absolute installed @earendil-works/pi-coding-agent package root as the first argument.");
}

const hostRoot = resolve(hostRootArg);
const hostPackage = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
assert.equal(hostPackage.name, "@earendil-works/pi-coding-agent", `Unexpected host package at ${hostRoot}`);
assert.equal(hostPackage.version, "1.3.0", `Expected installed Pi 1.3.0, found ${hostPackage.version}`);

// Snapshot and isolate the environment before loading any Pi or pi-persona modules. In particular,
// this prevents provider credentials from the parent shell being consulted by host availability
// checks. Keep only ordinary Windows process/temp plumbing, and pin Pi's profile paths to fixtures.
const savedEnv = Object.fromEntries(Object.entries(process.env));
const envWhitelist = new Set(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC"]);
for (const key of Object.keys(process.env)) {
	if (!envWhitelist.has(key)) delete process.env[key];
}
process.env.PI_OFFLINE = "1";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-persona-host-qualification-"));
const workspace = join(tempRoot, "workspace");
const agentDir = join(tempRoot, "agent");
const userPersonaDir = join(agentDir, "persona", "agents");
const projectAgentDir = join(workspace, ".pi", "agents");
let session;
let fetchBefore;
let networkRequests = 0;
let teardownError;

function restoreEnvironment() {
	for (const key of Object.keys(process.env)) delete process.env[key];
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("");
}

function assertUnderTemp(path) {
	const normalized = resolve(path);
	const normalizedTemp = resolve(tmpdir());
	assert.equal(dirname(normalized), normalizedTemp, `Refusing to clean a path outside the OS temp root: ${normalized}`);
	assert.ok(normalized.split(/[\\/]/).at(-1)?.startsWith("pi-persona-host-qualification-"), "Unexpected temporary root name");
}

async function scaffold() {
	await mkdir(userPersonaDir, { recursive: true });
	await mkdir(projectAgentDir, { recursive: true });
	await mkdir(join(workspace, ".pi"), { recursive: true });

	await writeFile(join(userPersonaDir, "host-smoke.md"), `---\nname: host-smoke\nlabel: Host smoke\npersona: true\n---\nA hermetic Pi host qualification supervisor.\n`, "utf8");
	await writeFile(join(userPersonaDir, "no-auth-model.md"), `---\nname: no-auth-model\npersona: true\nmodel: ${missingRef}\n---\nA fixture with a deliberately unavailable provider credential.\n`, "utf8");
	await writeFile(join(userPersonaDir, "magi.md"), `---\nname: magi\nlabel: MAGI profile fixture\npersona: true\ncouncil:\n  strategy: magi\n  roster: magi\n  params:\n    reflect: false\n---\nA borrowed council profile. It is never activated by this qualification.\n`, "utf8");
	for (const agent of ["melchior", "balthasar", "casper"]) {
		await writeFile(join(projectAgentDir, `${agent}.md`), `---\nname: ${agent}\n---\nA local faux-backed council worker fixture.\n`, "utf8");
	}
	await writeFile(join(workspace, ".pi", "teams.yaml"), "magi: [melchior, balthasar, casper]\n", "utf8");
}

function rpcUi(selectCalls, notifications) {
	const theme = new Proxy({}, {
		get: () => (...args) => args.at(-1) ?? "",
	});
	return {
		select: async (title, options) => {
			selectCalls.push({ title, options: [...options] });
			return options.includes(mainRef) ? mainRef : undefined;
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
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

const mainProviderId = "pi13-qualification-faux";
const mainModelId = "local";
const mainRef = `${mainProviderId}/${mainModelId}`;
const missingProviderId = "pi13-qualification-no-auth";
const missingModelId = "stale";
const missingRef = `${missingProviderId}/${missingModelId}`;

const routedPackages = new Set();
registerHooks({
	resolve(specifier, context, nextResolve) {
		for (const packageName of HOST_PACKAGES) {
			const bare = `@earendil-works/${packageName}`;
			if (specifier === bare) {
				const packageRoot = packageName === "pi-coding-agent"
					? hostRoot
					: join(hostRoot, "node_modules", "@earendil-works", packageName);
				routedPackages.add(bare);
				return nextResolve(pathToFileURL(join(packageRoot, "dist/index.js")).href, context);
			}
		}
		return nextResolve(specifier, context);
	},
});

try {
	await scaffold();
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	// A hard network tripwire backs up Pi's offline runtime setting. Requests are counted, never sent.
	fetchBefore = globalThis.fetch;
	globalThis.fetch = async () => {
		networkRequests++;
		throw new Error("Qualification network tripwire: outbound fetch is disabled.");
	};

	const host = await import(pathToFileURL(join(hostRoot, "dist", "index.js")).href);
	const piAiRoot = join(hostRoot, "node_modules", "@earendil-works", "pi-ai");
	const faux = await import(pathToFileURL(join(piAiRoot, "dist", "providers", "faux.js")).href);
	const extensionUrl = new URL("../src/extension.ts", import.meta.url);
	const { default: piPersona } = await import(extensionUrl.href);
	assert.ok(routedPackages.has("@earendil-works/pi-coding-agent"), "Source extension did not resolve Pi APIs through the installed host");

	const calls = [];
	const notifications = [];
	let customBeforeAgentStarts = 0;
	const observer = (pi) => {
		pi.on("before_agent_start", () => { customBeforeAgentStarts++; });
	};
	const settingsManager = host.SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false },
	});
	const resourceLoader = new host.DefaultResourceLoader({
		cwd: workspace,
		agentDir,
		settingsManager,
		extensionFactories: [piPersona, observer],
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	// Credentials are a private in-memory map: the host cannot read or write the operator's auth.json.
	const credentialMap = new Map();
	const credentialStore = {
		async read(providerId) { return credentialMap.get(providerId); },
		async list() { return [...credentialMap].map(([providerId, value]) => ({ providerId, type: value.type })); },
		async modify(providerId, update) {
			const next = await update(credentialMap.get(providerId));
			if (next !== undefined) credentialMap.set(providerId, next);
			return next;
		},
		async delete(providerId) { credentialMap.delete(providerId); },
	};
	const runtime = await host.ModelRuntime.create({
		credentials: credentialStore,
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const mainFaux = faux.fauxProvider({
		provider: mainProviderId,
		models: [{ id: mainModelId, name: "Qualification local faux" }],
	});
	const missingFaux = faux.fauxProvider({
		provider: missingProviderId,
		models: [{ id: missingModelId, name: "Qualification missing auth" }],
	});
	const noAuthProvider = {
		...missingFaux.provider,
		auth: { apiKey: { name: "Qualification intentionally absent", resolve: async () => undefined } },
	};
	runtime.registerNativeProvider(mainFaux.provider);
	runtime.registerNativeProvider(noAuthProvider);
	await runtime.setRuntimeApiKey(mainProviderId, "synthetic-key-never-transmitted");
	assert.ok(runtime.getModel(mainProviderId, mainModelId), "Local faux model was not registered");
	assert.ok(runtime.getModel(missingProviderId, missingModelId), "No-auth fixture model was not registered");

	const model = runtime.getModel(mainProviderId, mainModelId);
	const sessionManager = host.SessionManager.inMemory(workspace);
	const { session: createdSession } = await host.createAgentSession({
		cwd: workspace,
		agentDir,
		model,
		modelRuntime: runtime,
		resourceLoader,
		sessionManager,
		settingsManager,
	});
	session = createdSession;
	await session.bindExtensions({ uiContext: rpcUi(calls, notifications), mode: "rpc" });

	// A refused host model switch must be visible and must not replace the actual session model.
	await session.prompt("/persona no-auth-model");
	assert.equal(session.model?.provider, mainProviderId);
	assert.ok(notifications.some((entry) => /authentication is not configured/.test(entry.message)), "A refused persona model switch went unreported");

	// Activate the caller fixture, then repair the separate MAGI profile through the real host
	// slash-command dispatch. It selects the same local model for every core without a model request.
	await session.prompt("/persona host-smoke");
	await session.prompt("/persona models magi");
	assert.equal(mainFaux.state.callCount, 0, "The model picker unexpectedly made a model request");
	assert.equal(calls.length, 3, `Expected 3 actual RPC selections, got ${calls.length}`);
	assert.ok(calls.every((call) => call.options.includes(mainRef)), "The local faux model was not in every picker result");
	assert.ok(notifications.some((entry) => entry.message.includes("updated 3 model assignment(s) for \"host-smoke\"")), "The command did not confirm the caller's three assignments");
	const savedAssignments = JSON.parse(await readFile(join(agentDir, "persona", "config.json"), "utf8"));
	assert.deepEqual(savedAssignments["host-smoke"]?.models, {
		melchior: mainRef,
		balthasar: mainRef,
		casper: mainRef,
	}, "Model assignments were not persisted under the active caller persona");
	assert.equal(savedAssignments.magi, undefined, "The borrowed MAGI profile was modified instead of the active caller");

	mainFaux.setResponses([
		faux.fauxAssistantMessage("Pi 1.3 custom-message hook completed."),
		faux.fauxAssistantMessage(faux.fauxToolCall("council", {
			question: "Verify local recovery from a deliberately unconfigured council model.",
			persona: "magi",
			members: [{ agent: "melchior", model: missingRef }],
			params: { reflect: false },
		}, { id: "pi13-qualification-council" }), { stopReason: "toolUse" }),
		faux.fauxAssistantMessage(JSON.stringify({ result: "Recovered locally", vote: "approve", confidence: 1, stance: "approve" })),
		faux.fauxAssistantMessage("The local council recovery completed."),
	]);
	const hooksBeforeCustomMessage = customBeforeAgentStarts;
	await session.sendCustomMessage({
		customType: "pi13-host-qualification",
		content: "Exercise the actual before_agent_start hook for a custom message.",
		display: false,
		details: {},
	}, { triggerTurn: true });
	await session.agent.waitForIdle();
	const customHookDelta = customBeforeAgentStarts - hooksBeforeCustomMessage;
	assert.equal(customHookDelta, 1, "Pi did not dispatch the custom message through before_agent_start exactly once");

	await session.prompt("Exercise the configured MAGI council now.");
	assert.equal(mainFaux.state.callCount, 4, `Expected supervisor + recovered-leg faux request count 4, got ${mainFaux.state.callCount}`);
	assert.equal(missingFaux.state.callCount, 0, "A provider with no configured API key reached its faux request stream");
	assert.equal(networkRequests, 0, "A network request escaped the offline qualification harness");

	const councilResult = session.sessionManager.getBranch()
		.map((entry) => entry.type === "message" ? entry.message : undefined)
		.find((message) => message?.role === "toolResult" && message.toolName === "council");
	assert.ok(councilResult, "The real session transcript did not contain a council tool result");
	const councilText = textOf(councilResult.content);
	assert.equal(councilResult.isError, false, councilText);
	assert.equal(councilResult.details?.ok, true, "The recovered council must produce a valid ruling, not merely mention recovery");
	const disclosure = `1 core recovered on ${mainRef}`;
	assert.equal(councilText.split(disclosure).length - 1, 1, `Recovery disclosure was not present exactly once: ${councilText}`);
	assert.ok(councilText.includes("Recovered locally"), `Council did not return the fake local response: ${councilText}`);
	assert.ok(routedPackages.has("@earendil-works/pi-coding-agent"), "Installed host route was not observed");

	const summary = {
		status: "PASS",
		host: hostPackage.name,
		version: hostPackage.version,
		checks: {
			installedHostRoute: true,
			unauthenticatedPersonaSwitchRejected: true,
			activeCallerPickerSelections: calls.length,
			persistedAssignments: Object.keys(savedAssignments["host-smoke"].models).length,
			customBeforeAgentStartEvents: customHookDelta,
			missingAuthProviderRequests: missingFaux.state.callCount,
			recoveryDisclosureOccurrences: 1,
		},
		requests: {
			localFaux: mainFaux.state.callCount,
			missingAuthFaux: missingFaux.state.callCount,
			network: networkRequests,
		},
	};
	process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
	process.stderr.write(`${JSON.stringify({ status: "FAIL", host: hostPackage.name, version: hostPackage.version, error: error instanceof Error ? error.message : String(error) })}\n`);
	if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
	process.exitCode = 1;
} finally {
	if (session) {
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
	try {
		assertUnderTemp(tempRoot);
		await rm(tempRoot, { recursive: true, force: true });
	} catch (error) {
		teardownError ??= error;
	}
	restoreEnvironment();
	if (teardownError) {
		process.stderr.write(`Qualification teardown warning: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}\n`);
		process.exitCode = 1;
	}
}
