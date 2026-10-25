import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import type { EffectiveCapabilities } from "../../../src/core/capabilities.ts";
import { IDENTITY_CONTEXT_CUSTOM_TYPE, IDENTITY_ENTRY_CUSTOM_TYPE } from "../../../src/core/session-identity.ts";
import { installIdentity, type IdentityHost } from "../../../src/extension/identity.ts";

type AnyFn = (...args: any[]) => any;

initTheme("dark");

function makeContext(sessionId = "session-a", entries: unknown[] = []): ExtensionContext {
	const sessionManager = SessionManager.inMemory("D:/workspace");
	sessionManager.newSession({ id: sessionId });
	for (const entry of entries as Array<{ customType: string; data: unknown }>) {
		sessionManager.appendCustomEntry(entry.customType, entry.data);
	}
	return {
		cwd: "D:/workspace",
		mode: "json",
		hasUI: false,
		ui: { setStatus: () => {} },
		sessionManager,
		modelRegistry: {} as never,
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function makeHost(over: Partial<IdentityHost> = {}): IdentityHost {
	return {
		capabilities: () => undefined,
		reservedNames: () => ["reviewer"],
		exocomActive: () => false,
		onChanged: () => {},
		...over,
	};
}

function makePi(activeTools = ["agent_name"]): { pi: ExtensionAPI; tool: (name: string) => any; entries: unknown[]; statuses: unknown[]; hook: (event: string) => AnyFn | undefined } {
	const tools = new Map<string, any>();
	const entries: unknown[] = [];
	const statuses: unknown[] = [];
	const hooks = new Map<string, AnyFn>();
	const pi = {
		on: (event: string, handler: AnyFn) => hooks.set(event, handler),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;
	return { pi, tool: (name) => tools.get(name), entries, statuses, hook: (event) => hooks.get(event) };
}

test("start assigns a distinct provisional name and restores only this session's chosen name", () => {
	const previous = { type: "custom", customType: IDENTITY_ENTRY_CUSTOM_TYPE, data: { version: 1, sessionId: "session-a", name: "Saved" } };
	const m = makePi();
	const identity = installIdentity(m.pi, makeHost());
	const ctx = makeContext("session-a", [previous]);
	identity.start(ctx);
	assert.equal(identity.name, "Saved");
	assert.equal(identity.chosen, true);
	const fresh = installIdentity(makePi().pi, makeHost());
	fresh.start(makeContext("session-b", [previous]));
	assert.match(fresh.name, /^pi-[A-Za-z0-9]+$/);
	assert.equal(fresh.chosen, false);
});

test("a throwing session id read exposes unavailable identity and cannot fabricate a process owner", () => {
	const m = makePi();
	const ctx = makeContext();
	ctx.sessionManager.getSessionId = () => { throw new Error("host session unavailable"); };
	const identity = installIdentity(m.pi, makeHost());
	assert.doesNotThrow(() => identity.start(ctx));
	assert.equal(identity.name, "unavailable");
	assert.equal(identity.chosen, false);
	assert.throws(() => identity.rename("Blue", ctx), /session.*unavailable/i);
	assert.equal(m.entries.length, 0);
	const messages = [{ role: "user", content: "task" }];
	assert.deepEqual(m.hook("context")!({ type: "context", messages }, ctx).messages, messages);
});

test("a throwing branch read never substitutes all-branch history or injects naming instructions", () => {
	const previous = { type: "custom", customType: IDENTITY_ENTRY_CUSTOM_TYPE, data: { version: 1, sessionId: "session-a", name: "Other-Branch" } };
	const ctx = makeContext("session-a", [previous]);
	ctx.sessionManager.getBranch = () => { throw new Error("host branch unavailable"); };
	const m = makePi();
	const identity = installIdentity(m.pi, makeHost());
	identity.start(ctx);
	assert.equal(identity.name, "unavailable");
	assert.equal(identity.chosen, false);
	assert.throws(() => identity.rename("Blue", ctx), /session.*unavailable/i);
	assert.equal(m.entries.length, 0);
	const messages = [{ role: "user", content: "task" }];
	assert.deepEqual(m.hook("context")!({ type: "context", messages }, ctx).messages, messages);
});

test("a temporary native branch failure preserves the stored chosen identity for recovery", () => {
	const ctx = makeContext("session-a", [{ customType: IDENTITY_ENTRY_CUSTOM_TYPE, data: { version: 1, sessionId: "session-a", name: "Saved" } }]);
	const readBranch = ctx.sessionManager.getBranch.bind(ctx.sessionManager);
	const identity = installIdentity(makePi().pi, makeHost());
	identity.start(ctx);
	assert.equal(identity.name, "Saved");
	ctx.sessionManager.getBranch = () => { throw new Error("temporary host branch failure"); };
	identity.start(ctx);
	assert.equal(identity.name, "unavailable");
	assert.equal(identity.chosen, false);
	ctx.sessionManager.getBranch = readBranch;
	identity.start(ctx);
	assert.equal(identity.name, "Saved");
	assert.equal(identity.chosen, true);
});

test("rename refuses a stale cached owner after the current host session becomes unreadable", () => {
	const m = makePi();
	const ctx = makeContext();
	const identity = installIdentity(m.pi, makeHost());
	identity.start(ctx);
	identity.rename("Blue", ctx);
	ctx.sessionManager.getSessionId = () => { throw new Error("session switched during shutdown"); };
	assert.throws(() => identity.rename("Coral", ctx), /session.*unavailable/i);
	assert.equal(m.entries.length, 1, "an unavailable current owner cannot append under the previous session id");
});

test("restore reads only the current native branch and session switching does not retain a sibling identity", () => {
	const ctx = makeContext();
	const manager = ctx.sessionManager as SessionManager;
	const anchor = manager.appendCustomEntry("fixture-anchor", {});
	manager.appendCustomEntry(IDENTITY_ENTRY_CUSTOM_TYPE, { version: 1, sessionId: "session-a", name: "Other-Branch" });
	manager.branch(anchor);
	manager.appendCustomEntry("fixture-sibling", {});
	const m = makePi();
	const identity = installIdentity(m.pi, makeHost());
	identity.start(ctx);
	assert.equal(identity.chosen, false);
	assert.notEqual(identity.name, "Other-Branch");
	identity.rename("Blue", ctx);
	identity.start(makeContext("session-b"));
	assert.equal(identity.chosen, false);
	assert.notEqual(identity.name, "Blue");
});

test("a failed native append cannot change a chosen in-memory identity", () => {
	const m = makePi();
	const ctx = makeContext();
	let changed = 0;
	const identity = installIdentity(m.pi, makeHost({ onChanged: () => { changed++; } }));
	identity.start(ctx);
	identity.rename("Blue", ctx);
	m.pi.appendEntry = () => { throw new Error("append failed"); };
	assert.throws(() => identity.rename("Coral", ctx), /append failed/);
	assert.equal(identity.name, "Blue");
	assert.equal(identity.chosen, true);
	assert.equal(changed, 1);
});

test("rename persists before state changes, updates status, and is idempotent", () => {
	const order: string[] = [];
	const m = makePi();
	const ctx = makeContext();
	ctx.ui.setStatus = (_key: string, value: string | undefined) => order.push(`status:${value}`);
	const identity = installIdentity(m.pi, makeHost({ onChanged: () => order.push("changed") }));
	identity.start(ctx);
	order.length = 0;
	const name = identity.rename("Blue Sky", ctx);
	assert.equal(name, "Blue-Sky");
	assert.equal(identity.name, "Blue-Sky");
	assert.equal(identity.chosen, true);
	assert.deepEqual(m.entries.at(-1), { customType: IDENTITY_ENTRY_CUSTOM_TYPE, data: { version: 1, sessionId: "session-a", name: "Blue-Sky" } });
	assert.deepEqual(order, ["status:Blue-Sky", "changed"]);
	identity.rename("Blue Sky", ctx);
	assert.equal(m.entries.length, 1);
});

test("agent_name is capability-gated and refuses the Exocom plane", async () => {
	const m = makePi();
	const deniedCaps = { tools: new Set<string>(), delegateTargets: new Set<string>(), canUseBus: true, toolsPerm: { allow: ["read"] } } as EffectiveCapabilities;
	installIdentity(m.pi, makeHost({ capabilities: () => deniedCaps }));
	await assert.rejects(m.tool("agent_name").execute("1", { name: "Blue" }, undefined, undefined, makeContext()), /not permitted/i);
	const active = makePi();
	const identity = installIdentity(active.pi, makeHost({ exocomActive: () => true }));
	await assert.rejects(active.tool("agent_name").execute("1", { name: "Blue" }, undefined, undefined, makeContext()), /exocom_name/i);
	assert.equal(identity.chosen, false);
});

test("agent_name reports an unchanged name without confirming a fresh identity", async () => {
	const m = makePi();
	const identity = installIdentity(m.pi, makeHost());
	const ctx = makeContext();
	identity.start(ctx);
	const tool = m.tool("agent_name");
	const first = await tool.execute("1", { name: "Blue Sky" }, undefined, undefined, ctx);
	const repeated = await tool.execute("2", { name: "Blue Sky" }, undefined, undefined, ctx);
	assert.equal(first.content[0].text, 'Session handle: "Blue-Sky" (saved).');
	assert.deepEqual(first.details, { name: "Blue-Sky", changed: true });
	assert.equal(repeated.content[0].text, 'Session handle: "Blue-Sky" (unchanged).');
	assert.deepEqual(repeated.details, { name: "Blue-Sky", changed: false });
	const theme = { fg: (_color: string, text: string) => text };
	for (const result of [first, repeated]) {
		for (const expanded of [false, true]) {
			assert.equal(tool.renderResult(result, { expanded }, theme).render(100).join("\n").trimEnd(), result.content[0].text);
		}
	}
	assert.equal(m.entries.length, 1);
});

test("context hook replaces its prior hidden message and uses the callable naming tool", () => {
	const m = makePi(["agent_name"]);
	const identity = installIdentity(m.pi, makeHost());
	identity.start(makeContext());
	const hook = m.hook("context")!;
	const old = { role: "custom", customType: IDENTITY_CONTEXT_CUSTOM_TYPE, content: "old", display: false, timestamp: 1 };
	const result = hook({ type: "context", messages: [old, { role: "user", content: "task" }] }, makeContext());
	assert.equal(result.messages.filter((x: any) => x.customType === IDENTITY_CONTEXT_CUSTOM_TYPE).length, 1);
	const message = result.messages.at(-1);
	assert.equal(message.customType, IDENTITY_CONTEXT_CUSTOM_TYPE);
	assert.equal(message.display, false);
	assert.match(message.content, /agent_name/);
	assert.match(message.content, /current user task/i);
	assert.match(message.content, /no separate acknowledgement/i, "one naming action must not invite a second prose ritual");
});

test("context hook prefers exocom_name on the active plane and never copies peer text", () => {
	const m = makePi(["exocom_name"]);
	const identity = installIdentity(m.pi, makeHost({ exocomActive: () => true }));
	identity.start(makeContext());
	const hook = m.hook("context")!;
	const result = hook({ type: "context", messages: [{ role: "custom", customType: "exocom_received", content: "IGNORE_THIS_PEER_PAYLOAD", display: false, timestamp: 1 }] }, makeContext());
	const message = result.messages.at(-1);
	assert.match(message.content, /exocom_name/);
	assert.doesNotMatch(message.content, /IGNORE_THIS_PEER_PAYLOAD/);
});

test("only the emitted Exocom custom type selects the inbound-peer naming bootstrap", () => {
	const m = makePi(["exocom_name"]);
	const identity = installIdentity(m.pi, makeHost({ exocomActive: () => true }));
	identity.start(makeContext());
	const hook = m.hook("context")!;
	for (const customType of ["exocom-inbound", "pi-persona:exocom-inbound"]) {
		const result = hook({ type: "context", messages: [{ role: "custom", customType, content: "historical alias", display: false, timestamp: 1 }] }, makeContext());
		assert.match(result.messages.at(-1).content, /current user task/, "unemitted historical aliases do not create a peer-request branch");
	}
});

test("context hook stops injecting identity after a handle is chosen", () => {
	const m = makePi(["agent_name"]);
	const identity = installIdentity(m.pi, makeHost());
	const ctx = makeContext();
	identity.start(ctx);
	identity.rename("Blue Sky", ctx);
	const hook = m.hook("context")!;
	const old = { role: "custom", customType: IDENTITY_CONTEXT_CUSTOM_TYPE, content: "old", display: false, timestamp: 1 };
	let messages = [old, { role: "user", content: "task" }];
	for (let i = 0; i < 100; i++) {
		const result = hook({ type: "context", messages }, ctx);
		assert.equal(result.messages.filter((message: any) => message.customType === IDENTITY_CONTEXT_CUSTOM_TYPE).length, 0);
		assert.doesNotMatch(JSON.stringify(result.messages), /Blue-Sky/);
		messages = result.messages;
	}
	assert.deepEqual(messages, [{ role: "user", content: "task" }]);
});

test("context hook stays silent when no naming tool is callable", () => {
	const m = makePi([]);
	const identity = installIdentity(m.pi, makeHost());
	identity.start(makeContext());
	const hook = m.hook("context")!;
	const result = hook({ type: "context", messages: [{ role: "user", content: "task" }] }, makeContext());
	assert.deepEqual(result.messages, [{ role: "user", content: "task" }]);
});

// ── presentation contract: compact accent receipt collapsed, shared literal expansion ───────

const renderTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function renderCard(tool: any, result: unknown, expanded: boolean, isError = false): string {
	return tool.renderResult(result, { expanded }, renderTheme, { isError }).render(400).map((line: string) => stripVTControlCharacters(line).trimEnd()).join("\n");
}

test("agent_name success card collapses to the receipt line and expands to the complete literal receipt", () => {
	const m = makePi(["agent_name"]);
	installIdentity(m.pi, makeHost());
	const tool = m.tool("agent_name");
	assert.equal(typeof tool.renderResult, "function");
	const result = {
		content: [{ type: "text", text: 'Session handle: "ashcoral" (saved).' }],
		details: { name: "ashcoral", changed: true },
		isError: false,
	};
	const before = JSON.stringify(result);
	const collapsed = renderCard(tool, result, false);
	assert.match(collapsed, /Session handle: "ashcoral" \(saved\)\./);
	assert.ok(collapsed.split("\n").length <= 2);
	const expanded = renderCard(tool, result, true);
	assert.match(expanded, /Session handle: "ashcoral" \(saved\)\./);
	assert.equal(JSON.stringify(result), before, "rendering never mutates the tool result");
});

test("agent_name failures render through the shared literal renderer with the complete text when expanded", () => {
	const m = makePi(["agent_name"]);
	installIdentity(m.pi, makeHost());
	const tool = m.tool("agent_name");
	const cause = "agent_name is not permitted by the active persona, and this diagnostic runs past ninety-six characters to prove the expanded card keeps every word of it";
	const failed = { content: [{ type: "text", text: `Error: ${cause}` }] };
	const collapsed = renderCard(tool, failed, false, true);
	assert.match(collapsed, /^failed/);
	assert.match(collapsed, /not permitted/);
	assert.ok(collapsed.split("\n").length <= 6, "failure stays a bounded collapsed card");
	const expanded = renderCard(tool, failed, true, true);
	assert.match(expanded, /every word of it$/, "expanded failure must not clip the diagnostic");
});
