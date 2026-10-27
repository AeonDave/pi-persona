import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installExocom, type ExocomHost } from "../../../src/exocom/install.ts";

function makeInstall() {
	const host = {
		pi: { getFlag: () => false },
		identity: { chosen: false, name: "operator" },
		config: {},
		controller: { activePersona: undefined },
		lastCtx: undefined,
		disposed: false,
		canDeliverNotifications: () => false,
		telemetry: undefined,
		delegationNudge: { reset() {} },
		exocomArgs: {},
		userAgentDir: () => process.cwd(),
	} as unknown as ExocomHost;
	return installExocom({} as ExtensionAPI, host);
}

function makeContext(options: {
	sessionId: string;
	idle: boolean;
	percent: number | undefined;
	model?: { provider: string; id: string };
}): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => options.sessionId },
		isIdle: () => options.idle,
		getContextUsage: () => options.percent === undefined ? undefined : { percent: options.percent },
		model: options.model,
	} as unknown as ExtensionContext;
}

test("Exocom telemetry uses Pi's session identity and accepts a current context with no model or usage", () => {
	const exocom = makeInstall();
	const ctx = makeContext({ sessionId: "session-current-1", idle: true, percent: undefined });

	assert.equal(exocom.telemetrySessionId(ctx), "session-current-1");
	assert.notEqual(exocom.telemetrySessionId(ctx), `legacy-${process.pid}`);
	const { color, ...instance } = exocom.currentTelemetryInstance(ctx);
	assert.deepEqual(instance, {
		displayName: "operator",
		persona: "",
		model: "",
		status: "idle",
		pid: process.pid,
		contextPercent: 0,
		exocomEnabled: false,
	});
	assert.equal(typeof color, "string");
});

test("Exocom current telemetry reads required Pi status/context methods and keeps optional model support", () => {
	const exocom = makeInstall();
	const ctx = makeContext({
		sessionId: "session-current-2",
		idle: false,
		percent: 104,
		model: { provider: "provider", id: "model" },
	});
	const instance = exocom.currentTelemetryInstance(ctx);
	assert.equal(instance.model ?? "", "provider/model");
	assert.equal(instance.status, "active");
	assert.equal(instance.contextPercent, 100);
});
