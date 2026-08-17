import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { knownParams, strategyNames } from "../../../src/orchestration/strategy.ts";

// The docs make load-bearing factual claims about the code (env names, the strategy schema, how
// many tests skip). Prose has no compiler, so these pin the claims that have actually drifted.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), "utf8");

const DOCS = ["README.md", "AGENTS.md", join("docs", "ARCHITECTURE.md"), join("docs", "STRATEGIES.md"), join("docs", "SPINE.md"), join("docs", "README.md")];

/** English number words up to the counts these docs plausibly state. */
const WORD_COUNTS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5 };

function sourceText(): string {
	const chunks: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts")) chunks.push(readFileSync(full, "utf8"));
		}
	};
	walk(join(REPO, "src"));
	return chunks.join("\n");
}

/** The WHOLE `PI_*` names the source actually reads. A substring test would accept a documented
 *  name that is merely a prefix of a real one (`PI_PERSONA_AGENT_MAX` inside `…_MAX_MS`), which is
 *  precisely the drift this file exists to catch, so match complete identifiers on both sides. */
function sourceEnvNames(): Set<string> {
	return new Set(sourceText().match(/\bPI_[A-Z0-9]+(?:_[A-Z0-9]+)+\b/g) ?? []);
}

/** Every markdown table row whose first cell is `<name>` in backticks — a name can head a row in
 *  more than one table (the persona catalog and the strategy catalog both list `judge`). */
function tableRows(markdown: string, strategy: string): string[] {
	return markdown.split("\n").filter((line) => line.startsWith(`| \`${strategy}\` |`));
}

test("AGENTS.md states the real number of intentional test skips", () => {
	const suite = read("test", "integration", "child-engine.test.ts");
	const actual = suite.split("{ skip:").length - 1;
	assert.ok(actual > 0, "expected the child-engine suite to still carry platform-gated skips");

	const agents = read("AGENTS.md");
	const stated = [...agents.matchAll(/\*\*(\w+)\*\* intentional|^- (\w+) skipped/gm)].map((m) => (m[1] ?? m[2] ?? "").toLowerCase());
	assert.ok(stated.length >= 2, `expected AGENTS.md to state the skip count in Testing and Accepted diagnostics, found ${stated.length}`);
	for (const word of stated) {
		assert.equal(WORD_COUNTS[word] ?? Number(word), actual, `AGENTS.md says "${word}" intentional skip(s); the suite has ${actual}`);
	}
});

test("every PI_* variable the docs name exists in the source", () => {
	const names = sourceEnvNames();
	for (const doc of DOCS) {
		for (const match of read(doc).matchAll(/\bPI_[A-Z0-9]+(?:_[A-Z0-9]+)+\b/g)) {
			assert.ok(names.has(match[0]), `${doc} documents ${match[0]}, which no source file reads`);
		}
	}
});

test("the README and STRATEGIES strategy tables cover every registered strategy and param", () => {
	const readme = read("README.md");
	const strategies = read("docs", "STRATEGIES.md");
	for (const name of strategyNames()) {
		const params = Object.keys(knownParams(name) ?? {});
		for (const [label, markdown] of [["README.md", readme], ["docs/STRATEGIES.md", strategies]] as const) {
			const rows = tableRows(markdown, name);
			assert.ok(rows.length > 0, `${label} has no table row for the "${name}" strategy`);
			for (const param of params) {
				const documented = rows.some((row) => row.includes(`\`${param}\``));
				assert.ok(documented, `${label}'s "${name}" row never mentions its \`${param}\` param`);
			}
		}
	}
});
