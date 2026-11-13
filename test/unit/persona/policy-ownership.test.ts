import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { parsePersona } from "../../../src/persona/persona.ts";

function persona(name: string) {
	const path = new URL(`../../../personas/${name}.md`, import.meta.url);
	return parsePersona(readFileSync(path, "utf8"), path.pathname)!;
}

function body(name: string): string {
	return persona(name).body.replace(/\s+/g, " ");
}

// Discover the complete bundled set so future personas cannot silently miss this contract.
const names = readdirSync(new URL("../../../personas/", import.meta.url))
	.filter((file) => file.endsWith(".md"))
	.map((file) => file.slice(0, -3))
	.sort();

for (const name of names) {
	test(`${name} has no persona-specific tool veto or invented authorization/scope policy`, () => {
		const parsed = persona(name);
		assert.equal(parsed.tools?.allow, undefined, "tool grants belong to the supplied operating context, not a persona");
		assert.equal(parsed.tools?.deny, undefined, "specialization is a default, not a tool veto");
		assert.doesNotMatch(body(name), /confirm irreversible|irreversible steps[^.]*go-ahead|production data is read-only unless|re-pin scope\/ROE|never change existing code by any route|never edit existing code or config|no edit, fix or relaxed check unless/i);
	});
}

// The user deliberately superseded the former persona-authored route/retention/approval
// contracts. These are prompt regressions, not assertions about runtime enforcement.
test("Elite inherits operating constraints and propagates them without defining its own policy classes", () => {
	const elite = body("elite");
	assert.match(elite, /scope, authorization, network, data and action constraints come from (?:the )?user\/project\/platform/i);
	assert.match(elite, /propagate supplied requirements[^.]*workers/i);
	assert.match(elite, /no extra questionnaires or approval gates/i);
	assert.match(elite, /sensitive data[^.]*loaded skills[^.]*inherited requirements/i);
	assert.doesNotMatch(elite, /LOCAL-VERIFIED|REMOTE\/HOSTED|ZERO-RETENTION|HOSTED\/LOGGING|## (?:Target egress|Evidence) is a hard boundary/i);
	assert.doesNotMatch(elite, /confirm irreversible|avoid lockout without confirmation|confirm production changes|free models stay off|controlled noise|low-observable|low-noise/i);
});

test("Elite retains route and access honesty and objective-driven incident/credential decisions", () => {
	const elite = body("elite");
	assert.match(elite, /local CLI\/process\/stdio[^.]*not proof of local target egress/i);
	assert.match(elite, /when (?:the )?(?:chosen )?route matters[^.]*verify/i);
	assert.match(elite, /(?:never assume|do not assume)[^.]*workers inherit[^.]*session[^.]*access/i);
	assert.match(elite, /credential reuse:[^.]*objective-relevant[^.]*rate-limit-aware/i);
	assert.match(elite, /live attacker activity[^.]*objective and evidence/i);
	assert.match(elite, /(?:not|never)[^.]*automatic authorization to contain/i);
	assert.doesNotMatch(elite, /discovering live attacker activity switches to response|stop offensive legs|re-pin scope\/ROE/i);
});

test("Elite retains blue custody, live oracles, and the technical purple loop without an approval gate", () => {
	const elite = body("elite");
	assert.match(elite, /known-good event end to end[^.]*source → forwarder → parser → index/i);
	assert.match(elite, /acquisition manifest: path, size, sha256, custody; analyze copies, preserve originals/i);
	assert.match(elite, /hardening:[^.]*live technique re-test, not config-only validation/i);
	assert.match(elite, /response automation[^.]*side effects[^.]*supplied operating rules/i);
	assert.match(elite, /isolate[^.]*side effects/i);
	assert.doesNotMatch(elite, /confirm or suppress automation first/i);
	assert.match(elite, /replay the original plus one variant[^.]*lookalike benign control/i);
	assert.match(elite, /verify cleanup/i);
});

test("Data inherits access/data requirements without defaulting production to read-only", () => {
	const data = body("data");
	assert.match(data, /access\/data rules come from (?:the )?user\/project\/platform/i);
	assert.match(data, /(?:carry|pass)[^.]*supplied[^.]*rules[^.]*every leg/i);
	assert.doesNotMatch(data, /production data is read-only unless|writes are authorized/i);
	assert.match(data, /lineage/);
	assert.match(data, /reproducibility gap/i);
	assert.match(data, /never weaken checks or discard inconvenient rows/i);
	assert.match(data, /preserve others' edits and task scope/i);
});

test("MAGI inherits execution constraints but keeps its vote, dissent and new-fork method", () => {
	const magi = body("magi");
	assert.match(magi, /execution constraints come from (?:the )?user\/project\/platform/i);
	assert.match(magi, /(?:carry|pass)[^.]*supplied requirements[^.]*council[^.]*execution legs/i);
	assert.doesNotMatch(magi, /irreversible steps[^.]*go-ahead/i);
	assert.match(magi, /a NEW fork gets a new council/i);
	assert.match(magi, /do not repeat an unchanged question just to get a preferred vote/i);
	assert.match(magi, /minority report/i);
	assert.match(magi, /a vote is a judgment, not proof/i);
	assert.match(magi, /(?:reconsider|revise)[^.]*evidence/i);
	assert.doesNotMatch(magi, /never override or soften a ruling/i);
});

test("Swarm leaves limits to runtime and revisits items only when fresh evidence warrants it", () => {
	const swarm = body("swarm");
	assert.match(swarm, /runtime owns run limits/i);
	assert.match(swarm, /supplied execution constraints/i);
	assert.doesNotMatch(swarm, /do not raise run limits|never rerun completed items|retry only failed items/i);
	assert.match(swarm, /(?:changed|new) (?:inputs|evidence)[^.]*recheck|recheck[^.]*changed (?:inputs|evidence)/i);
	assert.match(swarm, /not-run with why/i);
	assert.match(swarm, /carry not-run items forward by name/i);
	assert.match(swarm, /agree which items are whose before launching/i);
	assert.match(swarm, /writeSet/);
});

test("Verify has no persona-defined attempt cap and preserves its fresh real-check method", () => {
	const verify = body("verify");
	assert.match(verify, /supplied execution constraints/i);
	assert.match(verify, /pass supplied requirements[^.]*both legs/i);
	assert.doesNotMatch(verify, /same cause surviving a second loop is a blocker/i);
	assert.match(verify, /reassess[^.]*changed evidence/i);
	assert.match(verify, /concrete blocker[^.]*remaining unproved work/i);
	assert.match(verify, /check run on the final tree[^.]*command and exit status/i);
	assert.match(verify, /fresh `verifier`/i);
	assert.match(verify, /never delete, weaken, mock away or disable/i);
	assert.deepEqual(persona("verify").council?.params, { rounds: 4 });
});
