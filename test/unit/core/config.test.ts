import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../../../src/core/config.ts";

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

test("PI_PERSONA_AGENT_MAX_MS sets the per-agent hard wall-clock cap (default 600000; explicit 0 disables)", () => {
	assert.equal(resolveConfig({}).agentHardTimeoutMs, 600_000, "a generous lifetime ceiling by default");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_MAX_MS: "120000" }).agentHardTimeoutMs, 120000);
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_MAX_MS: "0" }).agentHardTimeoutMs, 0, "explicit 0 disables the cap");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_MAX_MS: "abc" }).agentHardTimeoutMs, 600_000, "non-numeric ⇒ default");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_MAX_MS: "-5" }).agentHardTimeoutMs, 600_000, "negative ⇒ default");
});

test("PI_PERSONA_AGENT_STARTUP_MS sets the per-agent startup deadline (default 90000; explicit 0 disables)", () => {
	assert.equal(resolveConfig({}).agentStartupTimeoutMs, 90_000, "a fast-fail startup window by default");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_STARTUP_MS: "30000" }).agentStartupTimeoutMs, 30000);
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_STARTUP_MS: "0" }).agentStartupTimeoutMs, 0, "explicit 0 disables the deadline");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_STARTUP_MS: "abc" }).agentStartupTimeoutMs, 90_000, "non-numeric ⇒ default");
	assert.equal(resolveConfig({ PI_PERSONA_AGENT_STARTUP_MS: "-5" }).agentStartupTimeoutMs, 90_000, "negative ⇒ default");
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

test("PI_PERSONA_BROKER (any non-empty value) opts into the cross-process broker; unset ⇒ off", () => {
	assert.equal(resolveConfig({}).broker, false, "off by default (default-OFF pin)");
	assert.equal(resolveConfig({ PI_PERSONA_BROKER: "1" }).broker, true);
	assert.equal(resolveConfig({ PI_PERSONA_BROKER: "" }).broker, false);
});

test("PI_PERSONA_DIRS splits on ';' and ',' and trims", () => {
	assert.deepEqual(resolveConfig({ PI_PERSONA_DIRS: "/a;/b, /c " }).extraDirs, ["/a", "/b", "/c"]);
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
