import { test } from "node:test";
import assert from "node:assert/strict";

import { OFF_WORDS, resolveConfig } from "../../../src/core/config.ts";

test("defaults apply when no env vars are set", () => {
	const c = resolveConfig({});
	assert.equal(c.disabled, false);
	assert.equal(c.keybinding, "f8");
	assert.equal(c.persist, true);
	assert.equal(c.delegateDefaultAllow, true);
	assert.equal(c.seed, false); // auto-install is opt-in (PI_PERSONA_SEED=on); default off
	assert.deepEqual(c.extraDirs, []);
	assert.equal(c.defaultPersona, undefined);
});

test("PI_PERSONA_ENGINE selects the sub-agent backend; in-process is the default", () => {
	assert.equal(resolveConfig({}).engine, "inproc", "in-process by default");
	assert.equal(resolveConfig({ PI_PERSONA_ENGINE: "inproc" }).engine, "inproc");
	assert.equal(resolveConfig({ PI_PERSONA_ENGINE: " CHILD " }).engine, "child", "opt out with child");
	assert.equal(resolveConfig({ PI_PERSONA_ENGINE: "bogus" }).engine, "inproc", "unknown value falls back to the default");
});

test("PI_PERSONA_PEEK_MS sets the periodic peek interval (default ON; explicit 0 disables)", () => {
	assert.equal(resolveConfig({}).peekEveryMs, 30_000, "the timed supervisor wakeup is on by default");
	assert.equal(resolveConfig({ PI_PERSONA_PEEK_MS: "15000" }).peekEveryMs, 15000);
	assert.equal(resolveConfig({ PI_PERSONA_PEEK_MS: "0" }).peekEveryMs, 0, "explicit 0 opts out");
	assert.equal(resolveConfig({ PI_PERSONA_PEEK_MS: "abc" }).peekEveryMs, 30_000, "non-numeric ⇒ default");
	assert.equal(resolveConfig({ PI_PERSONA_PEEK_MS: "-5" }).peekEveryMs, 30_000, "negative ⇒ default");
});

test("PI_PERSONA_CHECKIN_MS sets the routine check-in interval (default 5 min; explicit 0 disables)", () => {
	assert.equal(resolveConfig({}).checkInEveryMs, 300_000, "the routine direction check-in is on by default");
	assert.equal(resolveConfig({ PI_PERSONA_CHECKIN_MS: "120000" }).checkInEveryMs, 120_000);
	assert.equal(resolveConfig({ PI_PERSONA_CHECKIN_MS: "0" }).checkInEveryMs, 0, "explicit 0 opts out");
	assert.equal(resolveConfig({ PI_PERSONA_CHECKIN_MS: "abc" }).checkInEveryMs, 300_000, "non-numeric ⇒ default");
	assert.equal(resolveConfig({ PI_PERSONA_CHECKIN_MS: "-5" }).checkInEveryMs, 300_000, "negative ⇒ default");
});

test("PI_PERSONA_AGENT_MAX_MS sets the per-agent hard wall-clock cap (default 0 = unlimited; >0 arms it)", () => {
	assert.equal(resolveConfig({}).agentHardTimeoutMs, 0, "unlimited by default — a healthy child runs to completion");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_MAX_MS: "120000" }).agentHardTimeoutMs, 120000);
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_MAX_MS: "0" }).agentHardTimeoutMs, 0, "explicit 0 disables the cap");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_MAX_MS: "abc" }).agentHardTimeoutMs, 0, "non-numeric ⇒ default (unlimited)");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_MAX_MS: "-5" }).agentHardTimeoutMs, 0, "negative ⇒ default (unlimited)");
});

test("PI_PERSONA_AGENT_STARTUP_MS sets the per-agent startup deadline (default 300000; explicit 0 disables)", () => {
	assert.equal(resolveConfig({}).agentStartupTimeoutMs, 300_000, "generous enough to cover a cold provider start — this deadline kills, the idle watchdog does not");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_STARTUP_MS: "30000" }).agentStartupTimeoutMs, 30000);
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_STARTUP_MS: "0" }).agentStartupTimeoutMs, 0, "explicit 0 disables the deadline");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_STARTUP_MS: "abc" }).agentStartupTimeoutMs, 300_000, "non-numeric ⇒ default");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_STARTUP_MS: "-5" }).agentStartupTimeoutMs, 300_000, "negative ⇒ default");
});

test("PI_PERSONA_NUDGE=off disables the delegation nudge (default on)", () => {
	assert.equal(resolveConfig({}).nudge, true, "the delegation nudge is on by default");
	assert.equal(resolveConfig({ PI_PERSONA_NUDGE: "off" }).nudge, false, "explicit off opts out");
	assert.equal(resolveConfig({ PI_PERSONA_NUDGE: "OFF" }).nudge, false, "case-insensitive");
	assert.equal(resolveConfig({ PI_PERSONA_NUDGE: "on" }).nudge, true);
});

test("PI_PERSONA_DISABLE (any non-empty value) disables the extension", () => {
	assert.equal(resolveConfig({ PI_PERSONA_DISABLE: "1" }).disabled, true);
	assert.equal(resolveConfig({ PI_PERSONA_DISABLE: "" }).disabled, false);
});

test("PI_PERSONA_BROKER is on by default so MCP/worktree/child-engine legs are steerable; off-words opt out", () => {
	assert.equal(resolveConfig({}).broker, true, "on by default — a live async MCP leg must expose steer");
	assert.equal(resolveConfig({ PI_PERSONA_BROKER: "1" }).broker, true);
	assert.equal(resolveConfig({ PI_PERSONA_BROKER: "off" }).broker, false);
	assert.equal(resolveConfig({ PI_PERSONA_BROKER: "0" }).broker, false);
	assert.equal(resolveConfig({ PI_PERSONA_BROKER: "" }).broker, false);
});

test("PI_PERSONA_DIRS splits on ';' and ',' and trims", () => {
	assert.deepEqual(resolveConfig({ PI_PERSONA_DIRS: "/a;/b, /c " }).extraDirs, ["/a", "/b", "/c"]);
});

test("PI_PERSONA_DELEGATE_DEFAULT: off-words lock the roster down like 'deny' (additive)", () => {
	for (const word of ["deny", "off", "false", "0", "no"]) {
		const c = resolveConfig({ PI_PERSONA_DELEGATE_DEFAULT: word });
		assert.equal(c.delegateDefaultAllow, false, `"${word}" must not silently mean default-allow`);
	}
	assert.equal(resolveConfig({}).delegateDefaultAllow, true, "unset stays default-allow");
});

test("env flips keybinding, persist, delegate-default, seed, and default persona", () => {
	const c = resolveConfig({
		PI_PERSONA_KEY: "alt+p",
		PI_PERSONA_PERSIST: "off",
		PI_PERSONA_DELEGATE_DEFAULT: "deny",
		PI_PERSONA_SEED: "on",
		PI_PERSONA_DEFAULT: "magi",
		PI_PERSONA_STATE_FILE: "/custom/state.json",
	});
	assert.equal(c.keybinding, "alt+p");
	assert.equal(c.persist, false);
	assert.equal(c.delegateDefaultAllow, false);
	assert.equal(c.seed, true); // PI_PERSONA_SEED=on enables opt-in auto-install
	assert.equal(c.defaultPersona, "magi");
	assert.equal(c.stateFile, "/custom/state.json");
});

test("stateFile is undefined by default (resolved to a global default by the extension)", () => {
	assert.equal(resolveConfig({}).stateFile, undefined);
});

test("PI_PERSONA_EXOCOM enables the external plane (default OFF; truthy on)", () => {
	assert.equal(resolveConfig({}).exocom, false, "off by default");
	assert.equal(resolveConfig({ PI_PERSONA_EXOCOM: "1" }).exocom, true);
	assert.equal(resolveConfig({ PI_PERSONA_EXOCOM: "true" }).exocom, true);
	assert.equal(resolveConfig({ PI_PERSONA_EXOCOM: "" }).exocom, false, "empty ⇒ off");
	assert.equal(resolveConfig({ PI_PERSONA_EXOCOM: "off" }).exocom, false, "explicit off");
	assert.equal(resolveConfig({ PI_PERSONA_EXOCOM: "0" }).exocom, false, "0 ⇒ off");
});

test("the off convention is ONE convention: unset/\"\"/off/0/false/no, on every opt-in switch", () => {
	// `false` and `no` are what a user actually types to turn something off. Without them
	// PI_PERSONA_EXOCOM=false reads as truthy and PI_PERSONA_SPINE=false becomes a relative PATH.
	for (const off of ["off", "0", "false", "no", "FALSE", " No "]) {
		assert.equal(resolveConfig({ PI_PERSONA_EXOCOM: off }).exocom, false, `exocom: ${off}`);
		assert.equal(resolveConfig({ PI_PERSONA_LEDGER_V2: off }).ledgerV2, false, `ledgerV2: ${off}`);
		assert.equal(resolveConfig({ PI_PERSONA_SPINE: off }).spine, "", `spine: ${off} — an off word is never a filename`);
		assert.equal(resolveConfig({ PI_PERSONA_SPINE: "on", PI_PERSONA_SPINE_LEGS: off }).spineLegs, "", `spineLegs: ${off}`);
	}
});

test("OFF_WORDS is exported, so the one convention is readable from outside the module it lives in", () => {
	// Two doc comments point a reader at {@link OFF_WORDS}; a link to a module-private const does
	// not resolve in the emitted types, which is exactly where a reader of the config surface looks.
	// Asserting the SET (not a sample of it) is what keeps the link honest: a word added here that
	// no switch honours, or a switch that grows its own spelling, fails right here.
	assert.deepEqual([...OFF_WORDS].sort(), ["", "0", "false", "no", "off"]);
	for (const off of OFF_WORDS) {
		assert.equal(resolveConfig({ PI_PERSONA_EXOCOM: off }).exocom, false, `exocom honours "${off}"`);
		assert.equal(resolveConfig({ PI_PERSONA_LEDGER_V2: off }).ledgerV2, false, `ledgerV2 honours "${off}"`);
		assert.equal(resolveConfig({ PI_PERSONA_SPINE: off }).spine, "", `spine honours "${off}"`);
	}
});

test("PI_PERSONA_ASYNC_RETAIN sets the async tracker's retention bound (default 25; junk/<1 falls back)", () => {
	assert.equal(resolveConfig({}).asyncRetain, 25, "today's hardcoded retention by default");
	assert.equal(resolveConfig({ PI_PERSONA_ASYNC_RETAIN: "50" }).asyncRetain, 50);
	assert.equal(resolveConfig({ PI_PERSONA_ASYNC_RETAIN: "1" }).asyncRetain, 1, "smallest meaningful bound");
	assert.equal(resolveConfig({ PI_PERSONA_ASYNC_RETAIN: "abc" }).asyncRetain, 25, "non-numeric ⇒ default");
	assert.equal(resolveConfig({ PI_PERSONA_ASYNC_RETAIN: "-5" }).asyncRetain, 25, "negative ⇒ default");
	assert.equal(resolveConfig({ PI_PERSONA_ASYNC_RETAIN: "0" }).asyncRetain, 25, "0 isn't a meaningful retention bound ⇒ default");
});

test("PI_PERSONA_SPINE selects the shared behavioral layer (default OFF; `on` or a path)", () => {
	assert.equal(resolveConfig({}).spine, "", "off by default (opt-in, like exocom)");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "" }).spine, "", "empty ⇒ off");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "off" }).spine, "", "explicit off");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "OFF" }).spine, "", "case-insensitive");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "0" }).spine, "", "0 ⇒ off");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "on" }).spine, "on");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: " ON " }).spine, "on", "trimmed + case-insensitive");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: " /etc/Spine.md " }).spine, "/etc/Spine.md", "a path is kept verbatim (case included) — filesystems are case-sensitive");
});

test("the on words are as forgiving as the off words — a selector whose value can be a path cannot guess", () => {
	// `not off` does not imply `on` here: anything unrecognised is taken as a filename, so a user
	// typing the truthy word the broker's docs teach (PI_PERSONA_BROKER=1) would silently get a
	// relative path named "1" instead of the bundled layer.
	for (const word of ["1", "true", "yes", "TRUE", " 1 "]) {
		assert.equal(resolveConfig({ PI_PERSONA_SPINE: word }).spine, "on", `${word} ⇒ on`);
		assert.equal(resolveConfig({ PI_PERSONA_SPINE_LEGS: word }).spineLegs, "on", `${word} ⇒ on for the legs too`);
	}
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "onwards.md" }).spine, "onwards.md", "an on-word PREFIX is still a path");
});

test("PI_PERSONA_SPINE_LEGS follows PI_PERSONA_SPINE unless it is set, and takes the same value grammar", () => {
	assert.equal(resolveConfig({}).spineLegs, "", "off by default, like the supervisor selector");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "on" }).spineLegs, "on", "one switch still spines BOTH roles");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "/etc/Spine.md" }).spineLegs, "/etc/Spine.md", "a supervisor path is followed verbatim too");
	// Same grammar, applied to its own value.
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "on", PI_PERSONA_SPINE_LEGS: "off" }).spineLegs, "", "explicit off wins over the followed `on`");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE_LEGS: " ON " }).spineLegs, "on", "trimmed + case-insensitive");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE_LEGS: " /etc/Worker.md " }).spineLegs, "/etc/Worker.md", "a path is kept verbatim here as well");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "on", PI_PERSONA_SPINE_LEGS: "on" }).spine, "on", "and the legs' selector never writes back to the supervisor's");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE_LEGS: "on" }).spine, "", "legs-only leaves the supervisor unspined");
	// Present-but-empty is how a shell clears a variable, and an inherited empty must not silently
	// split the legs off from the supervisor — that is "unset", not the off word it is elsewhere.
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "on", PI_PERSONA_SPINE_LEGS: "" }).spineLegs, "on", "empty ⇒ unset ⇒ follow");
	assert.equal(resolveConfig({ PI_PERSONA_SPINE: "on", PI_PERSONA_SPINE_LEGS: "   " }).spineLegs, "on", "whitespace-only ⇒ unset ⇒ follow");
});

test("the four measurement arms of docs/SPINE.md are each expressible", () => {
	// A single selector cannot express the middle two, and without them a null result on a fanout
	// task is uninterpretable: a gain in the supervisor text can hide a loss in the worker text.
	const arm = (env: Record<string, string>) => {
		const c = resolveConfig(env);
		return [c.spine, c.spineLegs];
	};
	assert.deepEqual(arm({}), ["", ""], "off — neither set");
	assert.deepEqual(arm({ PI_PERSONA_SPINE: "on", PI_PERSONA_SPINE_LEGS: "off" }), ["on", ""], "supervisor-only");
	assert.deepEqual(arm({ PI_PERSONA_SPINE: "off", PI_PERSONA_SPINE_LEGS: "on" }), ["", "on"], "legs-only");
	assert.deepEqual(arm({ PI_PERSONA_SPINE: "on" }), ["on", "on"], "both — the one switch still covers it");
});

test("PI_PERSONA_LEDGER_V2 opts into the wider delegation-ledger key (default OFF; truthy on)", () => {
	assert.equal(resolveConfig({}).ledgerV2, false, "off by default (today's agent+model+task key)");
	assert.equal(resolveConfig({ PI_PERSONA_LEDGER_V2: "1" }).ledgerV2, true);
	assert.equal(resolveConfig({ PI_PERSONA_LEDGER_V2: "true" }).ledgerV2, true);
	assert.equal(resolveConfig({ PI_PERSONA_LEDGER_V2: "" }).ledgerV2, false, "empty ⇒ off");
	assert.equal(resolveConfig({ PI_PERSONA_LEDGER_V2: "off" }).ledgerV2, false, "explicit off");
	assert.equal(resolveConfig({ PI_PERSONA_LEDGER_V2: "0" }).ledgerV2, false, "0 ⇒ off");
});
