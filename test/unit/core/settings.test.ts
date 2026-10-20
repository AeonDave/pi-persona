import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../../../src/core/config.ts";
import {
	PERSONA_SETTINGS,
	parseSettingInput,
	resolvePersonaConfig,
	resolveSettingsValues,
	settingHasEnvironmentOverride,
	validatePreferences,
} from "../../../src/core/settings.ts";

test("the settings registry covers every public config value except process and state-file controls", () => {
	const expected = [
		"extraDirs", "defaultPersona", "keybinding", "persist", "delegateDefaultAllow", "seed",
		"childThinking", "engine", "peekEveryMs", "checkInEveryMs", "agentHardTimeoutMs",
		"agentStartupTimeoutMs", "nudge", "broker", "exocom", "asyncRetain", "ledgerV2",
		"spine", "spineLegs", "changeReport", "mindCapture", "mindNudge", "flowEnabled",
		"flowPort", "flowIdleMs",
	].sort();
	assert.deepEqual(PERSONA_SETTINGS.map((setting) => setting.id).sort(), expected);
	assert.ok(PERSONA_SETTINGS.every((setting) => setting.group && setting.label && setting.description));
	assert.ok(PERSONA_SETTINGS.filter((setting) => setting.id !== "flowEnabled").every((setting) => setting.env?.startsWith("PI_PERSONA_")));
	assert.ok(PERSONA_SETTINGS.every((setting) => setting.applyWhen.length > 0));
	assert.equal(PERSONA_SETTINGS.length, 25);
	assert.deepEqual(PERSONA_SETTINGS.filter((setting) => setting.owner === "mind").map(({ id }) => id).sort(), ["mindCapture", "mindNudge"]);
	assert.deepEqual(PERSONA_SETTINGS.filter((setting) => setting.owner === "flow").map(({ id }) => id).sort(), ["flowEnabled", "flowIdleMs", "flowPort"]);
	assert.match(PERSONA_SETTINGS.find(({ id }) => id === "flowPort")?.applyWhen ?? "", /next shared-service start.*existing service is unchanged/i);
	const ids: readonly string[] = PERSONA_SETTINGS.map((setting) => setting.id);
	assert.ok(!ids.includes("disabled") && !ids.includes("stateFile"));
});

test("companion preferences validate strictly with their current ranges", () => {
	assert.deepEqual(validatePreferences({
		mindCapture: "prompt",
		mindNudge: false,
		flowEnabled: true,
		flowPort: 0,
		flowIdleMs: 60_000,
	}), {
		mindCapture: "prompt",
		mindNudge: false,
		flowEnabled: true,
		flowPort: 0,
		flowIdleMs: 60_000,
	});
	for (const invalid of [
		{ mindCapture: "PROMPT" }, { mindNudge: "off" }, { flowEnabled: 0 },
		{ flowPort: -1 }, { flowPort: 65_536 }, { flowIdleMs: 49 }, { flowIdleMs: 60_001 },
	]) assert.throws(() => validatePreferences(invalid), /invalid preference/i);
});

test("preference validation accepts public values and preserves path spelling", () => {
	assert.deepEqual(validatePreferences({
		extraDirs: ["C:\\Tools\\Pi", "D:\\CaseSensitive"],
		spine: "D:\\Prompts\\Spine.MD",
		spineLegs: "on",
		peekEveryMs: 0,
		asyncRetain: 2,
		engine: "child",
		childThinking: "xhigh",
	}), {
		extraDirs: ["C:\\Tools\\Pi", "D:\\CaseSensitive"],
		spine: "D:\\Prompts\\Spine.MD",
		spineLegs: "on",
		peekEveryMs: 0,
		asyncRetain: 2,
		engine: "child",
		childThinking: "xhigh",
	});
});

test("preference validation rejects unknown keys and invalid values instead of silently dropping them", () => {
	assert.throws(() => validatePreferences({ retiredOption: true }), /unknown/i);
	assert.throws(() => validatePreferences({ broker: "yes" }), /broker/i);
	assert.throws(() => validatePreferences({ peekEveryMs: -1 }), /peekEveryMs/i);
	assert.throws(() => validatePreferences({ asyncRetain: 0 }), /asyncRetain/i);
	assert.throws(() => validatePreferences({ extraDirs: ["ok", 7] }), /extraDirs/i);
	assert.throws(() => validatePreferences({ engine: "shell" }), /engine/i);
	assert.throws(() => validatePreferences({ childThinking: "adaptive" }), /childThinking/i);
	assert.throws(() => validatePreferences({ peekEveryMs: 2_147_483_648 }), /peekEveryMs/i);
	assert.throws(() => validatePreferences({ keybinding: "   " }), /keybinding/i);
	assert.throws(() => validatePreferences({ defaultPersona: "   " }), /defaultPersona/i);
});

test("saved preferences apply over defaults while explicit environment variables keep precedence", () => {
	const preferences = {
		persist: false,
		nudge: false,
		defaultPersona: "saved-persona",
		engine: "child" as const,
		spine: "D:\\Prompts\\Main.MD",
	};
	const config = resolvePersonaConfig(preferences, {
		PI_PERSONA_PERSIST: "on",
		PI_PERSONA_DEFAULT: "environment-persona",
		PI_PERSONA_ENGINE: "inproc",
	});
	assert.equal(config.persist, true, "an explicit env value wins even when it is the default value");
	assert.equal(config.nudge, false, "an unset env value allows the stored preference");
	assert.equal(config.defaultPersona, "environment-persona");
	assert.equal(config.engine, "inproc");
	assert.equal(config.spine, "D:\\Prompts\\Main.MD");
	assert.equal(config.spineLegs, "D:\\Prompts\\Main.MD", "saved spine selection keeps the established legs-follow rule");
});

test("companion values resolve saved preferences and current extension environment grammar", () => {
	const defaults = resolveSettingsValues({}, {});
	assert.equal(defaults.mindCapture, "auto");
	assert.equal(defaults.mindNudge, true);
	assert.equal(defaults.flowEnabled, true);
	assert.equal(defaults.flowPort, 7874);
	assert.equal(defaults.flowIdleMs, 60_000);

	const saved = resolveSettingsValues({
		mindCapture: "prompt",
		mindNudge: false,
		flowEnabled: false,
		flowPort: 8088,
		flowIdleMs: 12_000,
	}, {});
	assert.equal(saved.mindCapture, "prompt");
	assert.equal(saved.mindNudge, false);
	assert.equal(saved.flowEnabled, false);
	assert.equal(saved.flowPort, 8088);
	assert.equal(saved.flowIdleMs, 12_000);

	const env = resolveSettingsValues({
		mindCapture: "prompt",
		mindNudge: false,
		flowEnabled: false,
		flowPort: 8088,
		flowIdleMs: 12_000,
	}, {
		PI_PERSONA_MIND_CAPTURE: " OFF ",
		PI_PERSONA_MIND_NUDGE: "OFF",
		PI_PERSONA_FLOW_PORT: "0",
		PI_PERSONA_FLOW_IDLE_MS: "49",
	});
	assert.equal(env.mindCapture, "off", "Mind capture trims and lowercases the environment selector");
	assert.equal(env.mindNudge, true, "Mind's existing nudge rule disables only for the exact lowercase off value");
	assert.equal(env.flowEnabled, false, "flowEnabled has no environment override and keeps its saved value");
	assert.equal(env.flowPort, 0, "Flow accepts port zero");
	assert.equal(env.flowIdleMs, 60_000, "invalid Flow idle values preview the default rather than hiding settings UI");
	assert.equal(resolveSettingsValues({}, { PI_PERSONA_FLOW_PORT: "000000" }).flowPort, 0,
		"Flow accepts any digits-only representation its extension currently accepts");
});

test("companion environment pins include invalid extension values but never leak into PiPersonaConfig", () => {
	const env = {
		PI_PERSONA_MIND_CAPTURE: "unknown",
		PI_PERSONA_FLOW_PORT: "65536",
		PI_PERSONA_FLOW_IDLE_MS: "not-an-integer",
	};
	const settings = resolveSettingsValues({ mindCapture: "prompt", flowPort: 4000, flowIdleMs: 10_000 }, env);
	assert.equal(settings.mindCapture, "auto");
	assert.equal(settings.flowPort, 7874);
	assert.equal(settings.flowIdleMs, 60_000);
	assert.equal(settingHasEnvironmentOverride("mindCapture", env), true);
	assert.equal(settingHasEnvironmentOverride("flowPort", env), true);
	assert.equal(settingHasEnvironmentOverride("flowIdleMs", env), true);
	assert.equal(settingHasEnvironmentOverride("flowEnabled", env), false);
	assert.deepEqual(resolvePersonaConfig({ flowEnabled: false, flowPort: 1234 }, env), resolveConfig(env));
});

test("present but invalid environment values still pin the existing resolver behavior", () => {
	const config = resolvePersonaConfig({ peekEveryMs: 17, childThinking: "high", engine: "child" }, {
		PI_PERSONA_PEEK_MS: "not-a-number",
		PI_PERSONA_CHILD_THINKING: "adaptive",
		PI_PERSONA_ENGINE: "unknown-engine",
	});
	assert.equal(config.peekEveryMs, 30_000, "invalid numeric env input retains the resolver default, not the saved value");
	assert.equal(config.childThinking, undefined, "invalid optional choice remains unset instead of reviving a saved value");
	assert.equal(config.engine, "inproc", "the existing engine resolver normalizes unknown values");
});

test("environment override detection follows the special blank delegated-spine rule", () => {
	assert.equal(settingHasEnvironmentOverride("nudge", {}), false);
	assert.equal(settingHasEnvironmentOverride("nudge", { PI_PERSONA_NUDGE: "off" }), true);
	assert.equal(settingHasEnvironmentOverride("spineLegs", { PI_PERSONA_SPINE_LEGS: "" }), false);
	assert.equal(settingHasEnvironmentOverride("spineLegs", { PI_PERSONA_SPINE_LEGS: "off" }), true);
});

test("saved keybindings and persona defaults are trimmed before startup resolution", () => {
	const config = resolvePersonaConfig({ keybinding: "  ctrl+f8  ", defaultPersona: "  magi  " }, {});
	assert.equal(config.keybinding, "ctrl+f8");
	assert.equal(config.defaultPersona, "magi");
});

test("explicit spine selectors preserve environment grammar and legs-only selection", () => {
	const fromEnvironment = resolvePersonaConfig({}, {
		PI_PERSONA_SPINE: "D:\\Prompts\\Upper.MD",
	});
	assert.equal(fromEnvironment.spine, "D:\\Prompts\\Upper.MD");
	assert.equal(fromEnvironment.spineLegs, "D:\\Prompts\\Upper.MD", "empty PI_PERSONA_SPINE_LEGS means follow");
	const savedLegsOnly = resolvePersonaConfig({ spineLegs: "off" }, { PI_PERSONA_SPINE: "on" });
	assert.equal(savedLegsOnly.spine, "on");
	assert.equal(savedLegsOnly.spineLegs, "", "a saved legs selector uses the same off normalization as env values");

	const legsOnly = resolvePersonaConfig({ spine: "", spineLegs: "on" }, {});
	assert.equal(legsOnly.spine, "");
	assert.equal(legsOnly.spineLegs, "on");
	const explicitOff = resolvePersonaConfig({ spine: "on" }, { PI_PERSONA_SPINE: "on", PI_PERSONA_SPINE_LEGS: "off" });
	assert.equal(explicitOff.spine, "on");
	assert.equal(explicitOff.spineLegs, "");
	assert.equal(resolvePersonaConfig({ spine: "off" }, {}).spine, "", "saved selector words use the same grammar as env values");
	assert.equal(resolvePersonaConfig({ spine: "TRUE" }, {}).spine, "on");
	assert.equal(resolvePersonaConfig({ spineLegs: "false" }, {}).spineLegs, "");
	assert.equal(resolvePersonaConfig({ spine: "D:\\Spine.MD" }, {}).spine, "D:\\Spine.MD", "saved paths retain their case and spelling");
	assert.deepEqual(resolvePersonaConfig({}, {}), resolveConfig({}));
});

test("setting input parsing follows each registry entry kind and bounds", () => {
	const setting = (id: string) => {
		const result = PERSONA_SETTINGS.find((item) => item.id === id);
		assert.ok(result, `missing registry entry ${id}`);
		return result;
	};
	assert.equal(parseSettingInput(setting("broker"), "off"), false);
	assert.equal(parseSettingInput(setting("peekEveryMs"), "1250"), 1250);
	assert.equal(parseSettingInput(setting("mindCapture"), "prompt"), "prompt");
	assert.equal(parseSettingInput(setting("mindNudge"), "off"), false);
	assert.equal(parseSettingInput(setting("flowPort"), "0"), 0);
	assert.equal(parseSettingInput(setting("flowIdleMs"), "60000"), 60_000);
	assert.throws(() => parseSettingInput(setting("flowPort"), "65536"), /flowPort/i);
	assert.throws(() => parseSettingInput(setting("flowIdleMs"), "49"), /flowIdleMs/i);
	assert.deepEqual(parseSettingInput(setting("extraDirs"), JSON.stringify(["C:\\One;tools", "D:\\Two,more"])), ["C:\\One;tools", "D:\\Two,more"]);
	assert.deepEqual(parseSettingInput(setting("extraDirs"), "C:\\One\nD:\\Two"), ["C:\\One", "D:\\Two"]);
	assert.equal(parseSettingInput(setting("engine"), "child"), "child");
	assert.throws(() => parseSettingInput(setting("engine"), "unknown"), /choice|engine/i);
	assert.throws(() => parseSettingInput(setting("peekEveryMs"), "-1"), /peekEveryMs/i);
	assert.throws(() => parseSettingInput(setting("peekEveryMs"), ""), /peekEveryMs/i);
	assert.throws(() => parseSettingInput(setting("agentStartupTimeoutMs"), "2147483648"), /agentStartupTimeoutMs/i);
});
