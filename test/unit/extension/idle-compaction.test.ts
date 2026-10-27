import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installIdleCompaction } from "../../../src/extension/idle-compaction.ts";

test("unqualified native host installs no hooks, timers or native compaction even when requested", () => {
	let effects = 0;
	const pi = new Proxy({}, { get() { effects++; throw new Error("blocked installation touched the host"); } }) as ExtensionAPI;
	for (const enabled of [false, true]) {
		const installation = installIdleCompaction(pi, {
			enabled, idleMs: Number.NaN, thresholdPercent: Number.NaN,
			canCompact() { effects++; return true; }, onReleased() { effects++; },
		});
		assert.equal(installation.busy, false);
		installation.dispose();
		installation.dispose();
	}
	assert.equal(effects, 0, "block must precede policy construction and every host access");
});
