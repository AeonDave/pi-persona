import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EffectiveCapabilities } from "../../../src/core/capabilities.ts";
import { IDENTITY_CONTEXT_CUSTOM_TYPE, IDENTITY_ENTRY_CUSTOM_TYPE } from "../../../src/core/session-identity.ts";
import { installIdentity, type IdentityHost } from "../../../src/extension/identity.ts";

type AnyFn = (...args: any[]) => any;

function makeContext(sessionId = "session-a", entries: unknown[] = []): ExtensionContext {
	return {
		cwd: "D:/workspace",
		mode: "json",
		hasUI: false,
		ui: { setStatus: () => {} },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => entries,
		} as never,
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
