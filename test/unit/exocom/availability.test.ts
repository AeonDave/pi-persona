import assert from "node:assert/strict";
import { test } from "node:test";
import { formatExocomStartupError, resolveExocomUnavailable, parseExocomCommand } from "../../../src/exocom/availability.ts";
import { ExocomListenError } from "../../../src/exocom/plane.ts";
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

test("occupied endpoint startup failures explain how to keep using Pi and Exocom", () => {
	const error = new ExocomListenError("EADDRINUSE", "test-endpoint");
	const message = formatExocomStartupError(error);
	assert.match(message, /^You can keep working without Exocom.*endpoint is busy.*\/fork.*\/reload.*any other Pi window/);
	assert.equal(resolveExocomUnavailable({ requested: true, startupError: message, endpointBusy: true }), message);
	assert.doesNotMatch(message, /EADDRINUSE|test-endpoint/);
});

test("startup failures other than a typed bind collision retain their original diagnostics", () => {
	const denied = new ExocomListenError("EACCES", "test-endpoint");
	assert.equal(formatExocomStartupError(denied), denied.message);
	const unrelated = new Error("another component reported EADDRINUSE");
	assert.equal(formatExocomStartupError(unrelated), unrelated.message);
});

test("command recognizes only status and help", () => {
	assert.equal(parseExocomCommand(""), "status");
	assert.equal(parseExocomCommand(" status "), "status");
	assert.equal(parseExocomCommand("help"), "help");
	assert.equal(parseExocomCommand("send peer hello"), "invalid");
	assert.equal(parseExocomCommand("status extra"), "invalid");
});
