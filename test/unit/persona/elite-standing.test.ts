import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parsePersona } from "../../../src/persona/persona.ts";

const path = fileURLToPath(new URL("../../../personas/elite.md", import.meta.url));
const elite = parsePersona(readFileSync(path, "utf8"), path)!;
const body = elite.body.replace(/\s+/g, " ");

test("Elite keeps coaching and on-demand evidence assurance, not mandatory orchestration", () => {
	assert.equal(elite.coaching, true);
	assert.equal(elite.thinking, "high");
	assert.equal(elite.systemPromptMode, "append");
	assert.equal(elite.orchestration, undefined);
	assert.deepEqual(elite.delegation, { requireBrief: true, outputContract: "finding" });
	assert.deepEqual(elite.council, {
		strategy: "critic-loop",
		roster: "evidence-assurance",
		params: { rounds: 3 },
	});
});

test("Elite stays within 12 KB while keeping its decisive technical player-coach stance", () => {
	const bytes = Buffer.byteLength(elite.body, "utf8");
	assert.ok(bytes <= 12000, `Elite body is ${bytes} bytes; expected at most 12000`);
	assert.match(body, /direct, technical, decisive security lead/i);
	assert.match(body, /player-coach[^.]*early independent handoffs/i);
	assert.match(body, /you own objective, priorities and decisions/i);
	assert.match(body, /TEST, DON'T THEORIZE/i);
	assert.match(body, /workers execute packets and return evidence; you choose the operation/i);
});

test("Elite requires actual skill loading before substantive execution and carries it into handoffs", () => {
	assert.match(body, /before substantive execution[^.]*search[^.]*installed (?:skill )?catalog/i);
	assert.match(body, /read and load[^.]*operating[^.]*evidence[^.]*domain workflow[^.]*tool[^.]*references/i);
	assert.match(body, /metadata[^.]*not[^.]*loading/i);
	assert.match(body, /(?:missing|absent)[^.]*loading gap/i);
	assert.match(body, /(?:pass|give)[^.]*discovered skills[^.]*exact[^.]*references[^.]*workers/i);
	assert.match(body, /workers; require loading before execution/i);
	assert.match(body, /(?:rediscover|re-search)[^.]*phase[^.]*artifact[^.]*tool/i);
});

test("Elite distinguishes static support from runtime observation in its description and evidence bar", () => {
	assert.match(elite.description ?? "", /static[^.]*observed/i);
	assert.doesNotMatch(elite.description ?? "", /every claim by replay/i);
	assert.match(body, /static artifacts can establish facts about their contents/i);
	assert.match(body, /observed behavior[^.]*replayable evidence/i);
});
