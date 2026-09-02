import { test } from "node:test";
import assert from "node:assert/strict";

import {
	CALL_SIGN_PROMPT,
	exocomSelfStatusLabel,
	exocomSelfWidgetLabel,
	inventedExocomNameHint,
	inventedLegNameHint,
} from "../../../src/core/naming.ts";

test("CALL_SIGN_PROMPT invites a free invention and never seeds catalog handles", () => {
	assert.match(CALL_SIGN_PROMPT, /mood/i);
	assert.match(CALL_SIGN_PROMPT, /joke/i);
	assert.match(CALL_SIGN_PROMPT, /anything that fits/i);
	assert.doesNotMatch(CALL_SIGN_PROMPT, /orion|hermes|vega|atlas|unnamed/i);
});

test("intercom and exocom reuse the same invitation", () => {
	assert.ok(inventedLegNameHint().includes(CALL_SIGN_PROMPT));
	assert.ok(inventedExocomNameHint().includes(CALL_SIGN_PROMPT));
	assert.match(inventedLegNameHint(), /purpose/);
	assert.match(inventedExocomNameHint(), /exocom_name/);
});

test("local UI never presents the placeholder as a chosen identity", () => {
	assert.equal(exocomSelfStatusLabel(false, "unnamed"), "unnamed");
	assert.equal(exocomSelfStatusLabel(false, "unnamed", "elite"), "elite");
	assert.equal(exocomSelfStatusLabel(false, ""), "unnamed");
	assert.equal(exocomSelfWidgetLabel(false, "unnamed"), "unnamed (you)");
	assert.equal(exocomSelfWidgetLabel(false, "unnamed", "elite"), "elite (you)");
	assert.equal(exocomSelfWidgetLabel(true, "kiln"), "kiln (you)");
	assert.equal(exocomSelfStatusLabel(true, "kiln", "elite"), "kiln");
});
