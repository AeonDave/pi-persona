import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerAgentCommand, type AgentMessageTarget } from "../../../src/extension/agent-command.ts";

function harness(initial: AgentMessageTarget[] = []) {
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	let targets = initial;
	let accepted = true;
	let opened = 0;
	const sent: Array<[string, string]> = [];
	const notices: string[] = [];
	registerAgentCommand({ registerCommand: (_name, definition) => { command = definition; } }, {
		targets: () => targets,
		open: async () => { opened++; },
		send: (id, message) => { sent.push([id, message]); return accepted; },
	});
	const ctx = { ui: { notify: (message: string) => { notices.push(message); } } as unknown as ExtensionCommandContext["ui"] } as ExtensionCommandContext;
	return {
		run: (args: string) => command!.handler(args, ctx),
		complete: (prefix: string) => command!.getArgumentCompletions!(prefix),
		sent, notices, opened: () => opened,
		setTargets: (value: AgentMessageTarget[]) => { targets = value; },
		refuse: () => { accepted = false; },
	};
}

const worker = (id: string, name: string, sendable = true): AgentMessageTarget => ({ id, nodeId: id, name, label: name, sendable });

test("a council leaf routes by its exact engine handle rather than rebuilding its display id", async () => {
	const h = harness([{ ...worker("run-1/reviewer", "Review"), nodeId: "async:run-1/reviewer" }]);
	await h.run("send run-1/reviewer Check the result");
	assert.deepEqual(h.sent, [["async:run-1/reviewer", "Check the result"]]);
});

test("agents without arguments opens the existing inspector; direct messages use the same worker control", async () => {
	const h = harness([worker("run-1", "Copper")]);
	await h.run("");
	assert.equal(h.opened(), 1);
	await h.run("send Copper Check the parser\nKeep the public API.");
	assert.deepEqual(h.sent, [["run-1", "Check the parser\nKeep the public API."]]);
	assert.match(h.notices.at(-1)!, /accepted.*Copper/i);
});

test("exact routing ids disambiguate aliases and quoted aliases preserve spaces", async () => {
	const h = harness([worker("run-1", "Copper"), worker("run-2", "Copper"), worker("phase/x", "Source reader")]);
	await h.run("send Copper check");
	assert.equal(h.sent.length, 0);
	assert.match(h.notices.at(-1)!, /ambiguous.*run-1.*run-2/i);
	await h.run("send run-2 check");
	await h.run('send "Source reader" read this');
	assert.deepEqual(h.sent, [["run-2", "check"], ["phase/x", "read this"]]);
});

test("missing, settled and raced targets never fall through or restart a worker", async () => {
	const h = harness([worker("run-1", "Copper", false)]);
	await h.run("send Unknown check");
	assert.match(h.notices.at(-1)!, /unknown worker/i);
	await h.run("send Copper check");
	assert.match(h.notices.at(-1)!, /not accepting/i);
	assert.equal(h.sent.length, 0);
	await h.run("send run-1 check");
	assert.equal(h.sent.length, 0);
	h.setTargets([worker("run-1", "Copper")]);
	h.refuse();
	await h.run("send Copper check");
	assert.match(h.notices.at(-1)!, /not accepted/i);
});

test("malformed and oversized messages are rejected before delivery", async () => {
	const h = harness([worker("run-1", "Copper")]);
	for (const input of ["send", "send Copper", 'send "Copper check', "send Copper " + "x".repeat(8_001), "bogus Copper check"]) await h.run(input);
	assert.equal(h.sent.length, 0);
	assert.equal(h.notices.length, 5);
});

test("autocomplete uses current stable ids with display names, excluding unavailable workers", async () => {
	const h = harness([worker("run-1", "Copper"), worker("phase/x y", "Source reader"), worker("run-2", "Done", false)]);
	const choices = await h.complete("send ");
	assert.deepEqual(choices?.map((item) => item.value), ["send run-1 ", 'send "phase/x y" ']);
	assert.match(choices![0]!.label, /Copper/);
	h.setTargets([]);
	assert.equal(await h.complete("send "), null);
});

test("autocomplete escapes control characters in inserted ids and still routes them exactly", async () => {
	const id = "phase/\u001b[31m\u009bworker";
	const h = harness([worker(id, "Worker")]);
	const choice = (await h.complete("send "))![0]!;
	assert.doesNotMatch(choice.value, /[\u0000-\u001f\u007f-\u009f]/);
	await h.run(choice.value + "check");
	assert.deepEqual(h.sent, [[id, "check"]]);
});
