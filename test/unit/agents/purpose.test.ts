import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_PURPOSE_CHARS, parseAgent } from "../../../src/agents/agent.ts";

const ESC = String.fromCharCode(27);

function purposeOf(raw: string): string | undefined {
	return parseAgent(["---", "name: x", `purpose: ${raw}`, "---", "body"].join("\n"), "/a/x.md")?.purpose;
}

test("a verticalization is bounded and folded at the parse edge, not at each render site", () => {
	// It is interpolated straight into a tree row and a model-picker title, and an agent file is
	// project data — so a sentence, a newline, or a terminal escape must not reach those surfaces.
	const long = purposeOf("Conservatore ".repeat(20));
	assert.ok(long !== undefined && long.length <= MAX_PURPOSE_CHARS, `must be clipped to ${MAX_PURPOSE_CHARS}, got ${long?.length}`);

	const folded = purposeOf('"Critico\\n\\nSCIENZIATO"');
	assert.ok(folded !== undefined && !/[\r\n]/.test(folded), `must fold to one line, got ${JSON.stringify(folded)}`);

	const escaped = purposeOf(`"${ESC}[31mCritico"`);
	assert.ok(escaped !== undefined && !escaped.includes(ESC), "a terminal control sequence never reaches a label");
});

test("an ordinary verticalization passes through untouched", () => {
	// Bounding must not mangle the normal case — these three are the shipped MAGI cores.
	for (const value of ["Propulsore", "Conservatore", "Catalizzatore"]) {
		assert.equal(purposeOf(value), value);
	}
});

test("a purpose made only of control characters is dropped, never turned into a label", () => {
	// sanitizeStatusLabel substitutes its own "agent" literal for a value that reduces to nothing;
	// for a verticalization that would invent a lens out of an escape sequence.
	assert.equal(purposeOf(`"${ESC}[31m"`), undefined);
	assert.equal(purposeOf(`"${ESC}"`), undefined);
});
