import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExocomUnavailable, parseExocomCommand } from "../../../src/exocom/availability.ts";
import { resolveCapabilities } from "../../../src/core/capabilities.ts";

const caps = (deny: string[]) => resolveCapabilities({ allToolNames: [], knownAgents: [], permissions: { tools: { deny } } });

test("availability identifies activation, capability and startup failures", () => {
	assert.match(resolveExocomUnavailable({ requested: false }), /--exocom/);
	assert.match(resolveExocomUnavailable({ requested: true, activationError: "invalid join code" }), /invalid join code/);
	assert.match(resolveExocomUnavailable({ requested: true, capabilities: caps(["intercom"]) }), /bus/i);
	assert.match(resolveExocomUnavailable({ requested: true, capabilities: caps(["exocom_answer", "exocom_decline"]) }), /answer.*decline/i);
	assert.match(resolveExocomUnavailable({ requested: true, startupError: "socket unavailable" }), /socket unavailable/);
	assert.match(resolveExocomUnavailable({ requested: true }), /starting/i);
});

test("command recognizes only status and help", () => {
	assert.equal(parseExocomCommand(""), "status");
	assert.equal(parseExocomCommand(" status "), "status");
	assert.equal(parseExocomCommand("help"), "help");
	assert.equal(parseExocomCommand("send peer hello"), "invalid");
	assert.equal(parseExocomCommand("status extra"), "invalid");
});
