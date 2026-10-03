import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
	collectModelParticipants,
	participantKey,
	pendingParticipants,
	type ParticipantInput,
} from "../../../src/persona/model-participants.ts";
import type { StrategyParam } from "../../../src/orchestration/sdk.ts";

const SECURITY = "Focus ONLY on the SECURITY lens: unsafe input flows, access control.";
const PERFORMANCE = "Focus ONLY on the PERFORMANCE lens: algorithmic cost on hot paths.";

/** `type: "agent"` is the auxiliary-actor param marker (strategy param contract). */
const agentSchema = (judge: Partial<StrategyParam> = {}): Record<string, StrategyParam> => ({
	judge: { type: "agent", doc: "the arbiter agent", ...judge },
});

test("a bare member keeps the legacy agent-name key; a role member gets a stable hashed key", () => {
	assert.equal(participantKey("melchior"), "melchior", "no role ⇒ the historical key, so old assignments still apply");
	assert.equal(participantKey("melchior", "   "), "melchior", "a blank role is no role");
	const key = participantKey("reviewer", SECURITY);
	assert.match(key, /^reviewer#[0-9a-f]{32,}$/, `key must be agent + a full-width digest, got ${key}`);
	for (const word of ["Focus", "ONLY", "SECURITY", "lens", "unsafe", "access", "control"]) {
		assert.equal(key.includes(word), false, `the persisted key must not carry role prose ("${word}")`);
	}
	assert.equal(participantKey("reviewer", SECURITY), key, "stable across calls");
	assert.equal(participantKey("reviewer", ` ${SECURITY} `), participantKey("reviewer", SECURITY), "stable across whitespace");
	assert.notEqual(participantKey("reviewer", PERFORMANCE), key, "two lenses of ONE agent are two participants");
	assert.notEqual(participantKey("scout", SECURITY), key, "the digest is bound to the agent too");
});

test("the key digest is a real sha256 (>=128 bits), so a role collision cannot change a chosen model", () => {
	// A collision here means one lens silently inherits another's model assignment — the exact
	// failure this key exists to prevent, so the digest width is pinned rather than assumed.
	const expected = createHash("sha256").update(`reviewer\0${SECURITY}`).digest("hex");
	assert.equal(participantKey("reviewer", SECURITY), `reviewer#${expected.slice(0, 32)}`);
	assert.ok(expected.slice(0, 32).length * 4 >= 128, "at least 128 bits of digest");
});

test("model precedence: inline > saved role key > saved agent key > agent frontmatter > session", () => {
	const base: ParticipantInput = {
		members: ["melchior"],
		assigned: { reviewer: "p/agent-key", [`${reviewerRoleKey()}`]: "p/role-key" },
		agentModel: (agent) => (agent === "melchior" ? "p/frontmatter" : undefined),
		sessionModel: "p/session",
	};
	// Bare participant: saved agent key beats frontmatter, frontmatter beats session.
	assert.deepEqual(pick(base, "melchior"), { model: "p/frontmatter", source: "agent" });
	assert.deepEqual(pick({ ...base, assigned: { melchior: "p/agent-key" } }, "melchior"), { model: "p/agent-key", source: "assignment" });
	// A role member of `reviewer`: the role key wins over the agent-level assignment.
	assert.deepEqual(pick({ ...base, members: [{ agent: "reviewer", role: SECURITY }] }, "reviewer"), {
		model: "p/role-key",
		source: "assignment",
	});
	// A role member with NO role assignment inherits the agent-level one (no prompt, no gap).
	assert.deepEqual(pick({ ...base, members: [{ agent: "reviewer", role: "SOME OTHER LENS" }] }, "reviewer"), {
		model: "p/agent-key",
		source: "assignment",
	});
	// An inline member model beats every saved assignment and the agent's own default.
	assert.deepEqual(pick({ ...base, members: [{ agent: "melchior", model: "p/inline" }] }, "melchior"), {
		model: "p/inline",
		source: "inline",
	});
	// Nothing assigned anywhere ⇒ the session model, and the session default is NOT an assignment.
	assert.deepEqual(pick({ members: ["melchior"], sessionModel: "p/session" }, "melchior"), { model: "p/session", source: "session" });
	assert.deepEqual(pick({ members: ["melchior"] }, "melchior"), { model: undefined, source: "none" });
});

test("an agent frontmatter model is resolved once per participant", () => {
	let calls = 0;
	const participants = collectModelParticipants({
		members: ["melchior"],
		agentModel: () => {
			calls += 1;
			return "p/frontmatter";
		},
	});
	assert.equal(calls, 1);
	assert.equal(participants[0]?.model, "p/frontmatter");
});

test("participants carry a display label that is separate from the persisted key", () => {
	const list = collectModelParticipants({ members: ["melchior", { agent: "reviewer", role: SECURITY }] });
	assert.equal(list.length, 2);
	assert.equal(list[0]?.label, "melchior");
	assert.equal(list[0]?.origin, "roster");
	assert.match(list[1]?.label ?? "", /^reviewer · /, "the human label names the lens; the key does not");
	assert.equal(list[1]?.key, participantKey("reviewer", SECURITY));
	assert.equal(list[1]?.assigned, false, "nothing assigned ⇒ the picker may ask");
	assert.equal(list[1]?.model, undefined);
});

test("an explicit inline member model is never a picker candidate", () => {
	const list = collectModelParticipants({
		members: [{ agent: "reviewer", role: SECURITY, model: "p/pinned" }, { agent: "reviewer", role: PERFORMANCE }],
	});
	const pending = pendingParticipants(list, { prompted: new Set() });
	assert.deepEqual(pending.map((p) => p.key), [participantKey("reviewer", PERFORMANCE)]);
	assert.equal(list[0]?.assigned, true, "an explicit model counts as assigned");
});

test("auxiliary actors come from agent-typed strategy params (provided value or declared default)", () => {
	const list = collectModelParticipants({
		members: ["melchior"],
		strategy: "judge",
		params: { judge: "balthasar", rounds: 2 },
		schema: { ...agentSchema(), rounds: { type: "number", doc: "rounds" } },
	});
	const arbiter = list.find((p) => p.origin === "param");
	assert.equal(arbiter?.agent, "balthasar");
	assert.equal(arbiter?.param, "judge");
	assert.equal(arbiter?.key, "balthasar", "a bare auxiliary actor reuses the legacy agent key");
	assert.deepEqual(list.filter((p) => p.origin === "roster").map((p) => p.agent), ["melchior"]);

	// A declared default is a participant too (the run really does spawn it).
	const defaulted = collectModelParticipants({ strategy: "judge", schema: agentSchema({ default: "reviewer" }) });
	assert.equal(defaulted.find((p) => p.origin === "param")?.agent, "reviewer");

	// An inline specialisation of an auxiliary actor (role/model) is a participant like any member.
	const inlined = collectModelParticipants({ strategy: "judge", params: { judge: { agent: "reviewer", role: "ARBITER" } }, schema: agentSchema() });
	const arb = inlined.find((p) => p.origin === "param");
	assert.equal(arb?.key, participantKey("reviewer", "ARBITER"));

	// Junk in an agent param is not a participant, and non-agent params are never scanned.
	const junk = collectModelParticipants({
		strategy: "judge",
		params: { judge: "", other: "scout" },
		schema: { ...agentSchema(), other: { type: "string", doc: "a plain string" } },
	});
	assert.equal(junk.filter((p) => p.origin === "param").length, 0);
});

test("an auxiliary actor that DEFAULTS to a roster member is that member, not a phantom agent", () => {
	// critic-loop declares `generator: rosterIndex 0 / default "operator"` and
	// `critic: rosterIndex 1 / default "verifier"`. With a roster the run really seats members 0 and
	// 1 — offering a model for `operator`/`verifier` here would put a phantom actor in the UI for
	// legs that never run, and would re-ask for a model the roster member already has.
	const withRoster = collectModelParticipants({
		members: ["scout", { agent: "reviewer", role: SECURITY }],
		strategy: "critic-loop",
	});
	assert.deepEqual(withRoster.map((p) => p.key), ["scout", participantKey("reviewer", SECURITY)], "no extra auxiliary participants");

	// Provided values win over the roster slot they would otherwise take.
	const provided = collectModelParticipants({
		members: ["scout", "reviewer"],
		strategy: "critic-loop",
		params: { critic: "casper" },
	});
	assert.deepEqual(provided.filter((p) => p.origin === "param").map((p) => p.agent), ["casper"]);

	// No roster ⇒ the REAL default agent is the actor, and it must be offered a model.
	const noRoster = collectModelParticipants({ strategy: "critic-loop" });
	assert.deepEqual(noRoster.map((p) => p.agent).sort(), ["operator", "verifier"]);
});

test("an aux param that inherits the roster resolves the matching MEMBER, not a bare duplicate", () => {
	// `map.verify` documents a legacy "a member named `verifier`" lookup: naming the member must
	// resolve THAT member (with its role/inline model), so the aux actor and the roster entry are
	// one participant, not two. The `inheritRoster` marker is the strategy's own metadata — passed
	// in here through the schema seam so this pins the COLLECTOR's rule, not one strategy's flag.
	const inherited = (params: Record<string, unknown>, inheritRoster: boolean) =>
		collectModelParticipants({
			members: ["scout", { agent: "reviewer", role: SECURITY }],
			params,
			schema: { verify: { type: "agent", doc: "", ...(inheritRoster ? { inheritRoster } : {}) } },
		});

	const resolved = inherited({ verify: "reviewer" }, true);
	assert.deepEqual(resolved.map((p) => p.key), ["scout", participantKey("reviewer", SECURITY)], "the role member IS the verifier");
	assert.equal(resolved.filter((p) => p.origin === "param").length, 0, "deduped into the roster entry");

	// Without the marker the very same value stays a bare actor — the historic arbiter/critic rule.
	const bare = inherited({ verify: "reviewer" }, false);
	assert.equal(bare.find((p) => p.origin === "param")?.key, "reviewer");
	assert.equal(bare.find((p) => p.origin === "param")?.role, undefined);

	// A name that is NOT on the roster has nothing to inherit and is its own bare actor.
	const outsider = inherited({ verify: "casper" }, true);
	assert.deepEqual(outsider.map((p) => p.key), ["scout", participantKey("reviewer", SECURITY), "casper"]);
});

test("an arbiter/critic keeps its BARE semantics — it never inherits a roster member's role", () => {
	// Historic semantics: an explicitly named critic/generator is that agent, full stop. Only the
	// params that declare `inheritRoster` resolve into the panel.
	const list = collectModelParticipants({
		members: ["scout", { agent: "reviewer", role: SECURITY }],
		strategy: "critic-loop",
		params: { critic: "reviewer" },
	});
	const critic = list.find((p) => p.origin === "param");
	assert.equal(critic?.agent, "reviewer");
	assert.equal(critic?.key, "reviewer", "a bare agent name, not the lens role's key");
	assert.equal(critic?.role, undefined);
});

test("a doc PHRASE as a param default never becomes a phantom participant", () => {
	// `synthesize` used to declare its default as the sentence "the first roster agent" — a phrase,
	// not an agent. Taking a default literally would spawn UI for a leg that cannot exist.
	const withRoster = collectModelParticipants({ members: ["scout", "operator"], strategy: "synthesize" });
	assert.deepEqual(withRoster.map((p) => p.agent), ["scout", "operator"], "the merge is roster member 0 — nothing extra");
	const phrase = collectModelParticipants({
		strategy: "no-such",
		schema: { synthesizer: { type: "agent", default: "the first roster agent", rosterIndex: 0, doc: "" } },
	});
	assert.deepEqual(phrase.map((p) => p.agent), [], "a phrase default yields no participant");
});

test("without a schema (strategy not registered yet) the roster is still complete", () => {
	const list = collectModelParticipants({ members: ["melchior"], strategy: "no-such-strategy", params: { judge: "balthasar" } });
	assert.deepEqual(list.map((p) => p.agent), ["melchior"]);
});

test("a participant is asked at most once per session, and a saved choice is never re-asked", () => {
	const list = collectModelParticipants({ members: ["melchior", "balthasar", { agent: "reviewer", role: SECURITY }] });
	// First run: everything unassigned is askable.
	assert.equal(pendingParticipants(list, { prompted: new Set() }).length, 3);
	// After a dismissal the key is recorded ⇒ never asked again, while a NEW roster member still is.
	const roleKey = participantKey("reviewer", SECURITY);
	const after = pendingParticipants(list, { prompted: new Set([roleKey]) });
	assert.deepEqual(after.map((p) => p.key), ["melchior", "balthasar"]);
	// A SAVED assignment suppresses the prompt even when that model is not authenticated right now —
	// re-asking every session for an unreachable ref is the spam this gate exists to stop.
	const saved = collectModelParticipants({ members: ["melchior"], assigned: { melchior: "gone/gone" } });
	assert.equal(pendingParticipants(saved, { prompted: new Set() }).length, 0);
	assert.equal(saved[0]?.model, "gone/gone", "the saved ref stays the effective model (the runtime reroutes it)");
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────

function reviewerRoleKey(): string {
	return participantKey("reviewer", SECURITY);
}

function pick(input: ParticipantInput, agent: string): { model: string | undefined; source: string } {
	const found = collectModelParticipants(input).find((p) => p.agent === agent && p.origin === "roster");
	assert.ok(found, `no roster participant for ${agent}`);
	return { model: found.model, source: found.source };
}
