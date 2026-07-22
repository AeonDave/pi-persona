import { test } from "node:test";
import assert from "node:assert/strict";

import { compactMemberResult, dissentLine, formatCouncilResult, humanizeAggregateResult, readableRuling } from "../../../src/orchestration/render.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };

test("structured member UI is compact and never exposes its raw JSON envelope", () => {
	const member: AgentResult = {
		agent: "melchior",
		output: '```json\n{"result":"Ship it","vote":"ship","confidence":0.9}\n```',
		structured: { result: "Ship it", vote: "ship", confidence: 0.9 },
		usage,
		ok: true,
	};
	const text = compactMemberResult(member);
	assert.match(text, /vote ship · confidence 90%/);
	assert.match(text, /Ship it/);
	assert.doesNotMatch(text, /```|"result"|"vote"/);
});

test("vote/confidence-only metadata annotates rather than replaces prose", () => {
	const member: AgentResult = {
		agent: "casper",
		output: "Prefer a staged rollout because rollback remains cheap.",
		structured: { vote: "stage", confidence: 0.8 },
		usage,
		ok: true,
	};
	assert.equal(readableRuling(member), member.output);
	assert.match(compactMemberResult(member), /^vote stage · confidence 80%\nPrefer a staged rollout/);
	assert.equal(dissentLine(member), `[casper · stage] ${member.output}`);
});

test("aggregate UI humanizes structured members and preserves a prose fallback", () => {
	const aggregate: AgentResult = {
		agent: "fanout",
		output: "raw aggregate",
		structured: {
			count: 2,
			results: [
				{ agent: "melchior", ok: true, output: '{"result":"Ship it"}', structured: { result: "Ship it", vote: "ship", confidence: 0.8 } },
				{ agent: "casper", ok: true, output: "Prefer the safer staged rollout.", structured: null },
			],
		},
		usage,
		ok: true,
	};
	const text = humanizeAggregateResult(aggregate) ?? "";
	assert.match(text, /✓ melchior/);
	assert.match(text, /vote ship · confidence 80%/);
	assert.match(text, /Prefer the safer staged rollout/);
	assert.doesNotMatch(text, /"result"/);
});

test("council result is answer-first and leaves the single title to renderCall", () => {
	const collapsed = formatCouncilResult(
		{ headline: "Ship the staged rollout", status: "winner", tally: { ship: 2, wait: 1 }, usedFallback: false, body: "full ruling" },
		false,
	);
	assert.match(collapsed, /^Ship the staged rollout/);
	assert.match(collapsed, /winner · tally ship=2, wait=1/);
	assert.doesNotMatch(collapsed, /council/i);
	assert.equal(
		formatCouncilResult({ headline: undefined, status: undefined, tally: undefined, usedFallback: undefined, body: "full ruling" }, true),
		"full ruling",
	);
});
