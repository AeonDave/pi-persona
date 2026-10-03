import assert from "node:assert/strict";
import { test } from "node:test";
import { collectModelParticipants } from "../../../src/persona/model-participants.ts";

test("map verification actor participates in model selection even outside the roster", () => {
	const participants = collectModelParticipants({
		strategy: "map",
		members: ["splitter", "worker"],
		params: { verify: "checker" },
	});
	assert.deepEqual(participants.map((p) => p.agent), ["splitter", "worker", "checker"]);
	assert.equal(participants[2]?.origin, "param");
	assert.equal(participants[2]?.param, "verify");
});

test("map's named verifier inherits its roster role/model without a phantom bare-agent picker", () => {
	const participants = collectModelParticipants({
		strategy: "map",
		members: ["splitter", "worker", { agent: "checker", role: "TESTS review", model: "fixture/chosen" }],
		params: { verify: "checker" },
	});
	assert.equal(participants.length, 3);
	assert.equal(participants[2]?.model, "fixture/chosen");
	assert.equal(participants[2]?.assigned, true);
});

test("map's disabled verification default does not introduce a phantom picker participant", () => {
	const participants = collectModelParticipants({ strategy: "map", members: ["splitter", "worker"] });
	assert.deepEqual(participants.map((p) => p.agent), ["splitter", "worker"]);
});
