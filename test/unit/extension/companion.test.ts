import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import piPersona, { inFlightAgentCount } from "../../../src/extension.ts";
import { ACTIVITY_EVENT, COMPANION_EVENT, parseCompanionActivity, type CompanionPresence } from "../../../src/core/companion.ts";
import { installActivityIngress } from "../../../src/extension/companion.ts";
import { AgentTree, isNonAgentNode, renderAgentTreeSummary, runningAnnotation } from "../../../src/ui/agent-tree.ts";

const activity = { version: 1, producerId: "pi-persona-mind", activityId: "operation-1", sessionId: "session-one", phase: "inspect", state: "running", target: "project" };

test("loaded Persona responds before its disable guard and distinguishes a real delegated leg", () => {
	const beforeDisable = process.env.PI_PERSONA_DISABLE;
	const beforeLeg = process.env.PI_PERSONA_LEG;
	try {
		process.env.PI_PERSONA_DISABLE = "1";
		for (const leg of [false, true]) {
			if (leg) process.env.PI_PERSONA_LEG = "1"; else delete process.env.PI_PERSONA_LEG;
			const events = createEventBus();
			piPersona({ events } as never);
			let presence: CompanionPresence | undefined;
			events.emit(COMPANION_EVENT, { version: 1, respond: (value: CompanionPresence) => { presence = value; } });
			assert.equal(presence?.role, leg ? "leg" : "disabled");
			assert.equal(presence?.capabilities.memory, leg ? 1 : false);
			assert.equal(presence?.capabilities.activity, false);
		}
	} finally {
		if (beforeDisable === undefined) delete process.env.PI_PERSONA_DISABLE; else process.env.PI_PERSONA_DISABLE = beforeDisable;
		if (beforeLeg === undefined) delete process.env.PI_PERSONA_LEG; else process.env.PI_PERSONA_LEG = beforeLeg;
	}
});

test("activity contract rejects invented execution metadata and invalid phase states", () => {
	assert.ok(parseCompanionActivity(activity));
	assert.equal(parseCompanionActivity({ ...activity, model: "fake/model" }), undefined);
	assert.equal(parseCompanionActivity({ ...activity, phase: "inspect", state: "staged" }), undefined);
	assert.equal(parseCompanionActivity({ ...activity, producerId: "other" }), undefined);
});

test("activity ingress is bound to native owner and projects honest nonagent rows", () => {
	const events = createEventBus(); const tree = new AgentTree(() => 1000);
	const ingress = installActivityIngress({ events } as never, tree, () => 1000);
	const manager = SessionManager.inMemory();
	const ctx = { sessionManager: manager } as unknown as ExtensionContext;
	const payload = { ...activity, sessionId: manager.getSessionId() };
	events.emit(ACTIVITY_EVENT, payload); assert.equal(tree.snapshot().length, 0);
	ingress.start(ctx);
	events.emit(ACTIVITY_EVENT, { ...payload, sessionId: "foreign" }); assert.equal(tree.snapshot().length, 0);
	events.emit(ACTIVITY_EVENT, payload);
	const node = tree.snapshot()[0]!;
	assert.equal(node.label, "Mind"); assert.equal(node.kind, "activity");
	assert.equal(node.model, undefined); assert.equal(node.thinking, undefined);
	assert.equal(isNonAgentNode(node), true); assert.equal(inFlightAgentCount([node]), 0);
	assert.doesNotMatch(runningAnnotation(node, 999999, 1) ?? "", /stalled/);
	events.emit(ACTIVITY_EVENT, { ...payload, state: "done" });
	assert.equal(tree.snapshot()[0]?.status, "done", "completed local work remains visible without a fake delay");
	events.emit(ACTIVITY_EVENT, payload);
	assert.equal(tree.snapshot()[0]?.status, "done", "late running update cannot reopen a completed operation");
	manager.newSession();
	events.emit(ACTIVITY_EVENT, { ...payload, activityId: "old-owner" });
	assert.equal(tree.snapshot().length, 1);
	ingress.stop(); assert.equal(tree.snapshot().length, 0);
	events.emit(ACTIVITY_EVENT, payload); assert.equal(tree.snapshot().length, 0);
});

test("activity rows remain bounded and visible below an agent fanout", () => {
	const events = createEventBus(); const tree = new AgentTree(() => 1000);
	const ingress = installActivityIngress({ events } as never, tree, () => 1000);
	const manager = SessionManager.inMemory(); ingress.start({ sessionManager: manager } as unknown as ExtensionContext);
	for (let i = 0; i < 12; i++) tree.add({ id: `agent-${i}`, label: `agent ${i}` });
	for (let i = 0; i < 20; i++) events.emit(ACTIVITY_EVENT, { ...activity, activityId: `op-${i}`, sessionId: manager.getSessionId(), phase: "stage", state: "staged" });
	assert.equal(tree.snapshot().filter((node) => node.kind === "activity").length, 8);
	assert.match(renderAgentTreeSummary(tree.snapshot(), 8).join("\n"), /Mind/);
	assert.equal(inFlightAgentCount(tree.snapshot()), 12);
	ingress.stop(); assert.equal(tree.snapshot().length, 12);
});
