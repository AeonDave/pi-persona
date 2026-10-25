import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { MEMORY_OWNER_EVENT, MEMORY_OWNER_CHANGED_EVENT, type CompanionMemoryOwner } from "../../../src/core/companion.ts";
import { installMemoryOwner, installFrozenMemoryOwner } from "../../../src/extension/memory-owner.ts";

test("live memory ownership is native-session-bound, readiness-aware and independent of persistence", () => {
	const events = createEventBus(); let persona: string | null = "live-first";
	const manager = SessionManager.inMemory();
	const changes: CompanionMemoryOwner[] = [];
	events.on(MEMORY_OWNER_CHANGED_EVENT, (owner) => { changes.push(owner as CompanionMemoryOwner); });
	const control = installMemoryOwner({ events } as never, () => persona);
	const query = (sessionId = manager.getSessionId()) => {
		let result: CompanionMemoryOwner | undefined;
		events.emit(MEMORY_OWNER_EVENT, { version: 1, sessionId, respond: (owner: CompanionMemoryOwner) => { result = owner; } });
		return result;
	};
	assert.equal(query()?.ready, false);
	const finishStart = control.start(manager); assert.equal(query()?.ready, false);
	finishStart(); assert.equal(query()?.persona, "live-first");
	persona = "persist-off-new-selection"; control.changed();
	assert.equal(query()?.persona, "persist-off-new-selection");
	assert.equal(query("foreign-session")?.ready, false);
	assert.equal(changes.at(-1)?.persona, persona);
	manager.newSession(); assert.equal(query()?.ready, false);
	control.stop(); assert.equal(changes.at(-1)?.ready, false);
});

test("a delayed startup cannot mark a replacement native memory owner ready", () => {
	const events = createEventBus(); const first = SessionManager.inMemory(); const second = SessionManager.inMemory();
	const owner = installMemoryOwner({ events } as never, () => "current");
	const finishFirst = owner.start(first);
	const finishSecond = owner.start(second);
	const query = () => {
		let result: CompanionMemoryOwner | undefined;
		events.emit(MEMORY_OWNER_EVENT, { version: 1, sessionId: second.getSessionId(), respond: (value: CompanionMemoryOwner) => { result = value; } });
		return result;
	};
	finishFirst(); assert.equal(query()?.ready, false);
	finishSecond(); assert.equal(query()?.ready, true);
});

test("frozen delegated owners live on disjoint child event buses and never borrow global settings", () => {
	const one = createEventBus(); const two = createEventBus();
	const first = SessionManager.inMemory(); const second = SessionManager.inMemory();
	const makePi = (events: ReturnType<typeof createEventBus>) => ({ events, on() {} });
	installFrozenMemoryOwner(makePi(one) as never, first, "persona-one");
	installFrozenMemoryOwner(makePi(two) as never, second, "persona-two");
	for (const [events, manager, expected] of [[one, first, "persona-one"], [two, second, "persona-two"]] as const) {
		let owner: CompanionMemoryOwner | undefined;
		events.emit(MEMORY_OWNER_EVENT, { version: 1, sessionId: manager.getSessionId(), respond: (value: CompanionMemoryOwner) => { owner = value; } });
		assert.equal(owner?.ready, true); assert.equal(owner?.persona, expected);
	}
});
