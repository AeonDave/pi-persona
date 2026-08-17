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

test("aggregate UI keeps a failed member's cause and failure kind", () => {
	const aggregate: AgentResult = {
		agent: "fanout",
		output: "raw aggregate",
		structured: {
			count: 1,
			results: [
				{
					agent: "melchior",
					ok: false,
					output: "",
					error: "provider unavailable",
					failureKind: "provider",
					structured: null,
				},
			],
		},
		usage,
		ok: false,
	};
	const text = humanizeAggregateResult(aggregate) ?? "";
	assert.match(text, /✗ melchior/);
	assert.match(text, /provider/);
	assert.match(text, /provider unavailable/);
});

test("dissent lines stay bounded while preserving member and vote", () => {
	const member: AgentResult = {
		agent: "casper",
		output: "x".repeat(500),
		structured: { vote: "stage" },
		usage,
		ok: true,
	};
	const text = dissentLine(member);
	assert.match(text, /^\[casper · stage\] /);
	assert.ok(text.length < 260, `dissent line was not bounded: ${text.length}`);
	assert.match(text, /…$/);
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

test("the collapsed council card sanitizes and bounds the child-authored headline and tally", () => {
	// The winner's `result`/`vote` reach these fields verbatim; only `body` is stripped
	// upstream, and collapsed is the view the user sees before expanding.
	const tally: Record<string, number> = { ["x".repeat(5_000)]: 1, ["y".repeat(5_000)]: 1 };
	const collapsed = formatCouncilResult(
		{
			headline: "\u001b[2J\u001b[H\u001b]0;pwned\u0007OWNED",
			status: "win\u001b[?1049hner",
			tally,
			usedFallback: false,
			body: "full ruling",
		},
		false,
	);
	assert.doesNotMatch(collapsed, /\u001b|\u0007/, "council chrome must not carry terminal escapes");
	assert.match(collapsed, /^OWNED · winner · tally /);
	assert.ok(collapsed.length <= 400, `collapsed council card was ${collapsed.length} chars`);
});
