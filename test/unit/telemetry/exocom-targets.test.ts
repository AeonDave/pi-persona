import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalExocomTelemetryTargets } from "../../../src/extension.ts";

const peers = [
	{ session_id: "peer-session-a", name: "twin", displayName: "twin", target: "twin@0123456789abcdef01234567" },
	{ session_id: "peer-session-b", name: "twin", displayName: "twin#2", target: "twin@89abcdef0123456789abcdef" },
];

test("exocom telemetry resolves routing tokens to canonical peer session ids", () => {
	assert.deepEqual(canonicalExocomTelemetryTargets(peers, peers[1]!.target), ["peer-session-b"]);
	assert.deepEqual(canonicalExocomTelemetryTargets(peers, "twin#2"), ["peer-session-b"]);
	assert.deepEqual(canonicalExocomTelemetryTargets(peers, "*"), ["peer-session-a", "peer-session-b"]);
	assert.deepEqual(canonicalExocomTelemetryTargets(peers, "missing"), []);
});

test("a routing token never degrades into a display-name match", () => {
	// Call-signs are unreserved: `normalizePeerName` keeps `@`, so a peer may register another
	// peer's published routing token as its own display name. `ExocomPlane.send` refuses that
	// fallback for exactly that reason, and the telemetry edge must refuse it too — otherwise the
	// impostor collects the lapsed peer's message.sent edge, byte size included.
	const lapsedToken = "orion@0123456789abcdef01234567";
	const impostor = [
		{ session_id: "peer-session-b", name: "twin", displayName: lapsedToken, target: "twin@89abcdef0123456789abcdef" },
	];
	assert.deepEqual(canonicalExocomTelemetryTargets(impostor, lapsedToken), [], "a token nobody answers to resolves to nothing");
	assert.deepEqual(canonicalExocomTelemetryTargets(impostor, impostor[0]!.target), ["peer-session-b"], "…while its own token still resolves");
});
