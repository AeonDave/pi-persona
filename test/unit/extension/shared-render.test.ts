import assert from "node:assert/strict";
import { test } from "node:test";
import { expandDetailHint } from "../../../src/extension/shared.ts";

test("expandDetailHint uses host-injected configured keybindings", () => {
	const keybindings = {
		keyHint: (id: string, description: string) => `${id === "app.tools.expand" ? "alt+e" : "?"} ${description}`,
	};
	assert.equal(expandDetailHint(keybindings), "alt+e to expand");
	assert.equal(expandDetailHint(), "expand to see full detail", "internal callers retain the existing generic wording, never a global binding lookup");
});
