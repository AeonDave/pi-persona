import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

/** Files under `dir` matching `suffix`, as repo-relative posix paths. */
function filesUnder(dir: string, suffix: string): string[] {
	const found: string[] = [];
	const walk = (at: string): void => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const full = join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(suffix)) found.push(relative(REPO, full).split(sep).join("/"));
		}
	};
	walk(join(REPO, dir));
	return found;
}

function sourceText(): string {
	return filesUnder("src", ".ts").map((file) => read(file)).join("\n");
}

/** The WHOLE `PI_*` names the source actually reads. A substring test would accept a documented
 *  name that is merely a prefix of a real one (`PI_PERSONA_AGENT_MAX` inside `…_MAX_MS`), which is
 *  precisely the drift this file exists to catch, so match complete identifiers on both sides. */
function sourceEnvNames(): Set<string> {
	return new Set(sourceText().match(/\bPI_[A-Z0-9]+(?:_[A-Z0-9]+)+\b/g) ?? []);
}

/** Every skip the runner will honour, anywhere in the suite, with the expression that gates it.
 *  AGENTS.md's claim is about the runner's own number, so counting one hardcoded file cannot see
 *  the skip someone adds in another — the drift that number really suffers. Node prints one
 *  `skipped` per skipped test, so a marker count is the runner's count; the `.skip` shorthand is
 *  collected too, and carries no gate by construction. */
function skipMarkers(): { file: string; gate: string }[] {
	const markers: { file: string; gate: string }[] = [];
	for (const file of filesUnder("test", ".test.ts")) {
		const src = read(file);
		for (const m of src.matchAll(/\bskip\s*:\s*([^\n]*)/g)) markers.push({ file, gate: (m[1] ?? "").trim() });
		for (const _ of src.matchAll(/\b(?:test|it|describe|suite)\.skip\b/g)) markers.push({ file, gate: "unconditional shorthand" });
	}
	return markers;
}

/** The rows of the ONE table that documents strategies: the run of `|` lines under the header
 *  whose first cell is `Strategy` and which names a params column. A row headed by a strategy's
 *  name elsewhere in the file (the persona catalog also lists `judge`) documents a persona, not
 *  a strategy, so matching a row header anywhere in the markdown proves nothing. */
function strategyTableRows(markdown: string): string[] {
	const lines = markdown.split("\n");
	const header = lines.findIndex((line) => /^\|\s*Strategy\s*\|/.test(line) && /\bParams\b/.test(line));
	if (header < 0) return [];
	const rows: string[] = [];
	for (let i = header + 2; i < lines.length && lines[i]?.startsWith("|"); i++) rows.push(lines[i] as string);
	return rows;
}

test("AGENTS.md states the real number of intentional test skips, and they are all Windows-only", () => {
	const markers = skipMarkers();
	const where = markers.map((m) => `${m.file} (${m.gate})`).join(", ");
	assert.ok(markers.length > 0, "expected the suite to still carry platform-gated skips");

	const agents = read("AGENTS.md");
	const stated = [...agents.matchAll(/\*\*(\w+)\*\* intentional|^- (\w+) skipped/gm)].map((m) => (m[1] ?? m[2] ?? "").toLowerCase());
	assert.ok(stated.length >= 2, `expected AGENTS.md to state the skip count in Testing and Accepted diagnostics, found ${stated.length}`);
	for (const word of stated) {
		assert.equal(WORD_COUNTS[word] ?? Number(word), markers.length, `AGENTS.md says "${word}" intentional skip(s); the suite carries ${markers.length}: ${where}`);
	}

	// The claim is about the runner's own tally, so pin both halves of it.
	const windows = agents.match(/`skipped (\d+)` on Windows/);
	const elsewhere = agents.match(/`skipped (\d+)` elsewhere/);
	assert.ok(windows && elsewhere, "AGENTS.md no longer states what the runner reports on each platform");
	assert.equal(Number(windows[1]), markers.length, `AGENTS.md promises "skipped ${windows[1]}" on Windows; the suite carries ${markers.length}: ${where}`);
	assert.equal(Number(elsewhere[1]), 0, "AGENTS.md promises no skips off Windows");
	for (const marker of markers) {
		assert.match(marker.gate, /process\.platform === "win32"/, `${marker.file} skips on \`${marker.gate}\`, so the runner does not report "skipped 0" off Windows`);
	}
	// Accepted diagnostics names where they live, so a skip added elsewhere is a silent surprise.
	for (const file of new Set(markers.map((m) => m.file))) {
		assert.ok(agents.includes(file), `AGENTS.md documents no intentional skip in ${file}`);
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
			const rows = strategyTableRows(markdown).filter((row) => row.startsWith(`| \`${name}\` |`));
			assert.equal(rows.length, 1, `${label}'s strategy table has ${rows.length} rows for the "${name}" strategy`);
			// Skip the row's own header cell: `judge`'s required `judge` param would otherwise be
			// satisfied by the name heading the row, whatever the row goes on to say.
			const described = (rows[0] as string).split("|").slice(2).join("|");
			for (const param of params) {
				assert.ok(described.includes(`\`${param}\``), `${label}'s "${name}" row never mentions its \`${param}\` param`);
			}
		}
	}
});
