import { test } from "node:test";
import assert from "node:assert/strict";

import type { ThinkingLevel } from "../../../src/core/types.ts";
import { type ModelHandle, PersonaController, type PersonaHost } from "../../../src/persona/controller.ts";
import { parsePersona } from "../../../src/persona/persona.ts";

const p = (fm: string) => {
	const persona = parsePersona(`---\n${fm}\n---\nBody text`, "/s");
	if (!persona) throw new Error("bad fixture");
	return persona;
};

class MockHost implements PersonaHost {
	tools = ["read", "grep", "write", "delegate"];
	active = [...this.tools];
	thinking: ThinkingLevel = "medium";
	model: ModelHandle | undefined = { provider: "base", id: "b" };
	status: string | undefined;
	models: Record<string, ModelHandle> = { "prov/x": { provider: "prov", id: "x" } };

	agents = ["scout", "ghost", "builder"];

	allToolNames(): string[] {
		return this.tools;
	}
	knownAgents(): string[] {
		return this.agents;
	}
	setActiveTools(names: string[]): void {
		this.active = names;
	}
	getThinkingLevel(): ThinkingLevel {
		return this.thinking;
	}
	setThinkingLevel(level: ThinkingLevel): void {
		this.thinking = level;
	}
	getModel(): ModelHandle | undefined {
		return this.model;
	}
	findModel(ref: string): ModelHandle | undefined {
		return this.models[ref];
	}
	setModel(model: ModelHandle): void {
		this.model = model;
	}
	setStatus(text: string | undefined): void {
		this.status = text;
	}
}

test("activate restricts tools and sets status; deactivate restores the full registry", async () => {
	const host = new MockHost();
	const c = new PersonaController(host, true);
	await c.activate(p("name: r\nlabel: R\npersona: true\ntools:\n  allow: [read, delegate]"));
	assert.deepEqual(host.active, ["read", "delegate"]);
	assert.equal(host.status, "R");
	await c.deactivate();
	assert.deepEqual(host.active, ["read", "grep", "write", "delegate"]);
	assert.equal(host.status, undefined);
});

test("model + thinking are overridden on activate and restored on deactivate", async () => {
	const host = new MockHost();
	const c = new PersonaController(host, true);
	await c.activate(p("name: m\npersona: true\nmodel: prov/x\nthinking: high"));
	assert.deepEqual(host.model, { provider: "prov", id: "x" });
	assert.equal(host.thinking, "high");
	await c.deactivate();
	assert.deepEqual(host.model, { provider: "base", id: "b" });
	assert.equal(host.thinking, "medium");
});

test("switching to a persona that omits model restores the baseline", async () => {
	const host = new MockHost();
	const c = new PersonaController(host, true);
	await c.activate(p("name: m\npersona: true\nmodel: prov/x"));
	assert.equal(host.model?.id, "x");
	await c.activate(p("name: n\npersona: true"));
	assert.equal(host.model?.id, "b");
});

test("a declared-but-unavailable model keeps the current model (no override, no restore)", async () => {
	const host = new MockHost();
	const c = new PersonaController(host, true);
	await c.activate(p("name: m\npersona: true\nmodel: ghost/none"));
	assert.equal(host.model?.id, "b");
	await c.deactivate();
	assert.equal(host.model?.id, "b");
});

test("gate and composePrompt route through the active persona", async () => {
	const host = new MockHost();
	const c = new PersonaController(host, true);
	await c.activate(p("name: r\npersona: true\ndelegate:\n  allow: [scout]"));
	assert.equal(c.gate("delegate", { agent: "ghost" })?.block, true);
	assert.equal(c.gate("delegate", { agent: "scout" }), undefined);
	assert.match(c.composePrompt("BASE") ?? "", /BASE\n\nBody text/);
});
