import assert from "node:assert/strict";
import { test } from "node:test";
import { collectModelParticipants, participantKey } from "../../../src/persona/model-participants.ts";
import { orchestrationLaunchLines, snapshotOrchestrationParticipants } from "../../../src/ui/orchestration-launch.ts";

test("launch snapshot reuses model precedence and resolves inline, agent and inherited requested effort", () => {
	const participants = collectModelParticipants({ strategy: "judge", members: [
		{ agent: "reviewer", role: "INLINE", model: "inline/model", thinking: "xhigh" },
		{ agent: "reviewer", role: "SAVED" }, "configured", "inherited",
	], params: { judge: "arbiter" }, assigned: { [participantKey("reviewer", "SAVED")]: "saved/model", reviewer: "bare/model" },
		agentModel: (agent) => agent === "configured" ? "agent/model" : undefined, sessionModel: "session/model" });
	const snapshot = snapshotOrchestrationParticipants(participants, { childThinking: "medium", pendingKeys: new Set(["inherited"]),
		agentThinking: (agent) => agent === "reviewer" ? "low" : agent === "configured" ? "off" : undefined });
	assert.deepEqual(snapshot.participants.map((p) => [p.model, p.modelSource, p.thinkingRequested, p.setupPending]), [
		["inline/model", "inline", "xhigh", false], ["saved/model", "assignment", "low", false],
		["agent/model", "agent", "off", false], ["session/model", "session", "medium", true], ["session/model", "session", "medium", false],
	]);
	assert.equal(snapshot.participants[4]!.param, "judge");
});

test("launch formatting keeps each member's metadata, bounded collapsed rows, and literal expanded history", () => {
	const participants = collectModelParticipants({ members: ["one", "two", "three", "four"], sessionModel: "provider/model" });
	const snapshot = snapshotOrchestrationParticipants(participants, { childThinking: "max", pendingKeys: new Set(), agentThinking: () => undefined });
	snapshot.participants[0]!.label = "bad\u001b[31m\nname";
	snapshot.participants[0]!.phase = "review";
	const collapsed = orchestrationLaunchLines(snapshot, false);
	assert.equal(collapsed.length, 4);
	for (const line of collapsed.slice(0, 3)) assert.match(line, /provider\/model.*requested effort max/);
	assert.match(collapsed[3]!, /\+1 more/);
	assert.doesNotMatch(collapsed.join("\n"), /\u001b|\nname/);
	assert.match(orchestrationLaunchLines(snapshot, true).join("\n"), /four.*provider\/model.*requested effort max/);
	assert.deepEqual(orchestrationLaunchLines({ participants: [], unavailable: true }, false), ["Launch metadata unavailable"]);
});
