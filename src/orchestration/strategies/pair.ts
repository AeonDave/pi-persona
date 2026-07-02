/**
 * pair — driver/navigator live pairing on the p2p comm plane. The driver executes the
 * task; the navigator does an INDEPENDENT inspection of the same ground (real work that
 * keeps it alive while milestones arrive), sends an early risk checklist, answers each
 * milestone with a short correction, and ends with a final review. All over one-way
 * `contact_peer` sends — the critic-loop's live counterpart, without sequential round
 * costs. Timing is best-effort BY DESIGN (same as debate): a peer that already finalized
 * is "gone" and the other proceeds solo.
 *
 * roster = [driver, navigator] · result = the driver's work + the navigator's review
 */

import { sumUsage } from "../reducers.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";

const DRIVER_PROTOCOL = [
	"You are the DRIVER of a live pair: a navigator is inspecting the same ground right now.",
	"Announce your plan to it first (`contact_peer` action `list`, then `send`), send a short",
	"milestone note after each significant step, and send a final \"done: <summary>\" before you",
	"finish. Weigh the navigator's \"[message from peer …]\" corrections and take the genuinely",
	"right ones — you own the work and the final call. If the navigator is gone, proceed solo.",
].join(" ");

const NAVIGATOR_PROTOCOL = [
	"You are the NAVIGATOR of a live pair: a driver is executing this task right now — you do",
	"NOT execute it yourself. First inspect the task's ground independently (the relevant code,",
	"files, constraints) and `contact_peer send` the driver a short risk checklist (pitfalls,",
	"edge cases). Keep inspecting deeper; whenever a driver \"[message from peer …]\" milestone",
	"arrives, check it and send back ONE short correction or confirmation. Before you finish,",
	"send the driver your final review, then OUTPUT that same review: a verdict plus the risks",
	"that remain.",
].join(" ");

export const pair: Strategy = {
	name: "pair",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length < 2) throw new Error("pair: a roster of [driver, navigator] is required");
		const driver = rosterSpec(team[0]!);
		const navigator = rosterSpec(team[1]!);
		sdk.log(`pair: ${driver.agent} drives, ${navigator.agent} navigates`);
		if (sdk.limits.maxConcurrency < 2) sdk.log("pair: maxConcurrency < 2 — the live exchange degrades to sequential runs");

		const results = await sdk.parallel([
			() => sdk.agent({ ...driver, task: `${input.task}\n\n--- pair protocol (driver) ---\n${DRIVER_PROTOCOL}`, peers: true }),
			() => sdk.agent({ ...navigator, task: `${input.task}\n\n--- pair protocol (navigator) ---\n${NAVIGATOR_PROTOCOL}`, peers: true }),
		]);
		const work = results[0];
		const review = results[1];
		if (!work || !review) throw new Error("pair: a member run went missing");

		// The driver's work IS the deliverable; the navigator's review is attached when it
		// produced one, and its failure only degrades the pair to a solo run.
		const lines = [work.output];
		if (review.ok && review.output.trim()) lines.push(`\n--- navigator review (${navigator.agent}) ---\n${review.output.trim()}`);
		return {
			agent: "pair",
			output: lines.join("\n"),
			structured: { driver: driver.agent, navigator: navigator.agent, driverOk: work.ok, navigatorOk: review.ok },
			usage: sumUsage([work, review].map((r) => r.usage)),
			ok: work.ok,
		};
	},
};
