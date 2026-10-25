import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ActivityRows } from "../../../src/ui/activity-rows.ts";
import { AgentTree, renderAgentTreeSummary } from "../../../src/ui/agent-tree.ts";
import { AgentOverlay } from "../../../src/ui/agent-overlay.ts";
import type { CompanionActivity } from "../../../src/core/companion.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const tui = { requestRender() {} } as unknown as TUI;

export function activityFixture(): AgentTree {
	const tree = new AgentTree(() => 0);
	tree.add({ id: "worker", kind: "subagent", label: "worker", model: "openai/gpt-6-luna", thinking: "xhigh", detail: "verified build", startedAt: 90_000, lastAdvanceAt: 90_000 });
	tree.add({ id: "monitor:1", kind: "monitor", label: "build monitor", dueAt: 200_000 });
	tree.add({ id: "timer:1", kind: "timer", label: "review timer", dueAt: 160_000 });
	const rows = new ActivityRows();
	const states: CompanionActivity["state"][] = ["running", "staged", "done", "failed"];
	for (const [index, state] of states.entries()) {
		const event: CompanionActivity = { version: 1, producerId: "pi-persona-mind", activityId: `op-${index}`, sessionId: "native-session", phase: state === "staged" ? "stage" : state === "done" ? "apply" : "inspect", state, target: "project" };
		tree.add(rows.accept(event, 90_000)!.node);
	}
	return tree;
}

test("Mind work, staged, completed and failed rows render honestly beside an agent and wake sources", (t) => {
	const tree = activityFixture();
	for (const width of [80, 36]) {
		const lines = new Text(renderAgentTreeSummary(tree.snapshot(), 8, { now: 100_000, stallMs: 1_000 }).join("\n"), 0, 0).render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		const view = lines.join("\n");
		assert.equal((view.match(/Mind/g) ?? []).length, 4);
		assert.match(view, /inspecting/); assert.match(view, /prepared/); assert.match(view, /applied/); assert.match(view, /failed/);
		assert.match(view, /fires\s+in/); assert.match(view, /deadline\s+in/);
		assert.doesNotMatch(lines.filter((line) => /Mind/.test(line)).join("\n"), /stalled|waiting for supervisor|tok|xh|gpt/);
		const overlay = new AgentOverlay(tree, tui, theme, () => {}, { now: () => 100_000, stallMs: 1_000, canStop: () => true, canSteer: () => true });
		t.after(() => overlay.dispose());
		assert.ok(overlay.render(width).every((line) => visibleWidth(line) <= width));
		const view80 = overlay.render(80).join("\n");
		assert.equal((view80.match(/Mind/g) ?? []).length, 4);
		assert.doesNotMatch(view80, /X stop all/, "one real worker plus local/wake rows is still one agent");
	}
});

test("Mind cannot be stopped or steered even when a broad adapter claims handles", (t) => {
	const tree = new AgentTree(() => 0);
	const rows = new ActivityRows();
	tree.add(rows.accept({ version: 1, producerId: "pi-persona-mind", activityId: "only", sessionId: "native-session", phase: "apply", state: "running", target: "persona" }, 0)!.node);
	const calls: string[] = [];
	const overlay = new AgentOverlay(tree, tui, theme, () => {}, { canStop: () => true, canSteer: () => true, onStop: (id) => { calls.push(`stop:${id}`); return true; }, onSteer: (id) => { calls.push(`steer:${id}`); return true; } });
	t.after(() => overlay.dispose());
	assert.doesNotMatch(overlay.render(80).join("\n"), /x stop|s steer|X stop all/);
	overlay.handleInput("s"); overlay.handleInput("x"); overlay.handleInput("X"); overlay.handleInput("X");
	assert.deepEqual(calls, []);
	overlay.handleInput("\n");
	const detail = overlay.render(80).join("\n");
	assert.match(detail, /local work/);
	assert.doesNotMatch(detail, /● live|● armed|steer unavailable|thinking:|x stop|s steer/);
	overlay.handleInput("s"); overlay.handleInput("x");
	assert.deepEqual(calls, []);
});
