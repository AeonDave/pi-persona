import { test } from "node:test";
import assert from "node:assert/strict";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { AgentOverlay } from "../../../src/ui/agent-overlay.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";

const THEME = { fg: (_role: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const TUI_STUB = { requestRender: () => {} } as unknown as TUI;

function openOverlay(tree: AgentTree): AgentOverlay {
	return new AgentOverlay(tree, TUI_STUB, THEME, () => {}, undefined, undefined, () => true);
}

function type(overlay: AgentOverlay, text: string): void {
	for (const ch of text) overlay.handleInput(ch);
}

test("a half-typed steer does not follow the user to another agent when the drilled agent vanishes", () => {
	const tree = new AgentTree();
	tree.add({ id: "async:A", label: "A" });
	tree.add({ id: "async:B", label: "B" });
	const overlay = openOverlay(tree);
	overlay.handleInput("\n"); // drill into A
	overlay.handleInput("s");
	type(overlay, "focus on /api");
	tree.remove("async:A"); // the async run completes and its node is removed mid-compose
	overlay.handleInput("\n"); // drill into B from the list
	const text = overlay.render(80).join("\n");
	assert.ok(text.includes("B"), "the overlay shows agent B's detail view");
	assert.ok(!text.includes("steer ▸"), "no compose line re-opens on a different agent");
	overlay.dispose();
});

test("re-opening the steer compose starts from an empty buffer", () => {
	const tree = new AgentTree();
	tree.add({ id: "async:A", label: "A" });
	let steerable = true;
	const overlay = new AgentOverlay(tree, TUI_STUB, THEME, () => {}, undefined, undefined, () => steerable);
	overlay.handleInput("\n");
	overlay.handleInput("s");
	type(overlay, "stale text");
	steerable = false; // the steer handle goes away mid-compose → the compose line closes
	tree.update("async:A", { detail: "thinking" }); // a live refresh re-renders the detail view
	steerable = true;
	overlay.handleInput("s");
	const text = overlay.render(80).join("\n");
	assert.ok(text.includes("steer ▸"), "the compose line re-opens");
	assert.ok(!text.includes("stale text"), "the previous half-typed message is gone");
	overlay.dispose();
});

test("agent detail treats child terminal escape sequences as visible data, not terminal control", () => {
	const tree = new AgentTree();
	tree.add({ id: "async:A", label: "A", output: "SAFE\u001b[2J\u001b[31mRED\u001b[0m\u0000\nnext" });
	const overlay = openOverlay(tree);
	overlay.handleInput("\n");
	const text = overlay.render(80).join("\n");
	assert.doesNotMatch(text, /\u001b|\u0000/);
	assert.match(text, /SAFERED/);
	assert.match(text, /next/);
	overlay.dispose();
});

test("list selection follows the chosen agent when an earlier sibling is pruned", () => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "alpha" });
	tree.add({ id: "b", label: "bravo" });
	tree.add({ id: "c", label: "charlie" });
	const stopped: string[] = [];
	const steered: string[] = [];
	const overlay = new AgentOverlay(
		tree,
		TUI_STUB,
		THEME,
		() => {},
		(id) => {
			stopped.push(id);
			return true;
		},
		(id, text) => {
			steered.push(`${id}:${text}`);
			return true;
		},
		() => true,
	);
	overlay.handleInput("j"); // aim at bravo
	tree.remove("a"); // alpha settles and its node is pruned under the user
	assert.match(overlay.render(80).join("\n"), /▸ ⏳ bravo/, "the selection marker stays on bravo");
	overlay.handleInput("x");
	assert.deepEqual(stopped, ["b"], "x must stop the agent the user aimed at");
	overlay.handleInput("s");
	type(overlay, "kill it");
	overlay.handleInput("\n");
	assert.deepEqual(steered, ["b:kill it"], "s must steer the agent the user aimed at");
	overlay.dispose();
});

test("a pruned selection re-anchors on the first agent rather than on whatever slid into its slot", () => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "alpha" });
	tree.add({ id: "b", label: "bravo" });
	tree.add({ id: "c", label: "charlie" });
	const stopped: string[] = [];
	const overlay = new AgentOverlay(tree, TUI_STUB, THEME, () => {}, (id) => {
		stopped.push(id);
		return true;
	}, undefined, () => true);
	overlay.handleInput("j"); // aim at bravo
	tree.remove("b"); // the aimed-at agent is the one that vanishes
	assert.match(overlay.render(80).join("\n"), /▸ ⏳ alpha/, "the marker visibly falls back to the top");
	overlay.handleInput("x");
	assert.deepEqual(stopped, ["a"]);
	overlay.dispose();
});

test("a drilled-in agent that streams a long report does not cost the render loop the whole buffer per tick", () => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "alpha" });
	const overlay = openOverlay(tree);
	overlay.handleInput("\n"); // drill in — the detail view sanitizes and wraps the output
	const chunk = `${"lorem ipsum dolor sit amet ".repeat(38)}\n`;
	let buffer = "";
	const started = performance.now();
	for (let tick = 0; tick < 400; tick++) {
		buffer += chunk;
		tree.update("a", { output: buffer }); // a progress snapshot carries the whole buffer
	}
	const elapsed = performance.now() - started;
	const rendered = overlay.render(80).join("\n");
	assert.ok(rendered.includes("lorem ipsum"), "the streamed report is still displayed");
	assert.ok(elapsed < 1000, `400 progress ticks over a ${buffer.length}-char report took ${Math.round(elapsed)}ms`);
	overlay.dispose();
});

test("a report that carries ANSI colour is still rendered incrementally", () => {
	// Agents colour their output, and an untrusted child can emit one ESC on purpose. If a
	// single escape anywhere in the settled text disables the row cache, the whole-buffer
	// re-wrap — and the render-loop stall it causes — is back for the normal case.
	const tree = new AgentTree();
	tree.add({ id: "a", label: "alpha" });
	const overlay = openOverlay(tree);
	overlay.handleInput("\n");
	const chunk = `[32m${"lorem ipsum dolor sit amet ".repeat(38)}[0m\n`;
	let buffer = "";
	const started = performance.now();
	for (let tick = 0; tick < 400; tick++) {
		buffer += chunk;
		tree.update("a", { output: buffer });
	}
	const elapsed = performance.now() - started;
	const rendered = overlay.render(80).join("\n");
	assert.ok(rendered.includes("lorem ipsum"), "the streamed report is still displayed");
	assert.doesNotMatch(rendered, //, "and the colour codes are still stripped");
	assert.ok(elapsed < 1000, `400 coloured progress ticks over a ${buffer.length}-char report took ${Math.round(elapsed)}ms`);
	overlay.dispose();
});

test("a coloured report streamed one chunk at a time renders what the whole report renders", () => {
	// Reuse across an ESC is only sound where the split is not inside a sequence, so the
	// incremental rows must stay byte-identical to the whole-buffer rows.
	const report = [
		"[32mgreen line[0m",
		"plain",
		"[1;31mred [4munderline[0m done",
		"]0;titleafter an osc",
		"a]0;spanning\nthe breakb",
		"[38;5;208mtruecolor-ish[0m",
		"trailing without a newline",
	].join("\n");
	const whole = new AgentTree();
	whole.add({ id: "a", label: "A", output: report });
	const wholeOverlay = openOverlay(whole);
	wholeOverlay.handleInput("\n");
	const expected = wholeOverlay.render(80).join("\n");
	wholeOverlay.dispose();

	const streamed = new AgentTree();
	streamed.add({ id: "a", label: "A" });
	const streamedOverlay = openOverlay(streamed);
	streamedOverlay.handleInput("\n");
	for (let end = 1; end <= report.length; end++) streamed.update("a", { output: report.slice(0, end) });
	assert.equal(streamedOverlay.render(80).join("\n"), expected);
	assert.doesNotMatch(expected, /|title|spanning/);
	streamedOverlay.dispose();
});

test("agent list clamps hostile label and detail metadata", () => {
	const tree = new AgentTree();
	tree.add({ id: "async:huge", label: "L".repeat(500), detail: "D".repeat(500) });
	const overlay = openOverlay(tree);
	const text = overlay.render(80).join("\n");
	assert.ok(text.length < 700, `overlay list was not bounded: ${text.length}`);
	assert.match(text, /…/);
	overlay.dispose();
});

test("a report streamed one chunk at a time renders exactly what the same report delivered whole renders", () => {
	// The detail view reuses the rows it already wrapped, so a control sequence that spans
	// a line break must still be erased as one sequence rather than half at a time.
	const report = "alpha\r\nbeta\n\n  gamma \u001b[31mred\u001b[0m\nzeta\u0000\na\u001b]0;multi\nline\u0007b\ntail without a newline";
	const whole = new AgentTree();
	whole.add({ id: "a", label: "A", output: report });
	const wholeOverlay = openOverlay(whole);
	wholeOverlay.handleInput("\n");
	const expected = wholeOverlay.render(80).join("\n");
	wholeOverlay.dispose();

	const streamed = new AgentTree();
	streamed.add({ id: "a", label: "A" });
	const streamedOverlay = openOverlay(streamed);
	streamedOverlay.handleInput("\n");
	for (let end = 1; end <= report.length; end++) streamed.update("a", { output: report.slice(0, end) });
	assert.equal(streamedOverlay.render(80).join("\n"), expected);
	assert.doesNotMatch(expected, /\u001b|\u0000|multi/);
	streamedOverlay.dispose();
});

test("the incremental detail render survives arbitrary interleavings of escapes and line breaks", () => {
	// The seam between reused and freshly-wrapped rows must never fall inside a control
	// sequence. Deterministic fuzz: build escape-heavy reports, stream each one byte by
	// byte, and require the frame to stay identical to the same report delivered whole.
	let seed = 0x2f6e2b1;
	const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const tokens = [
		"alpha", "beta gamma", " ", "\n", "\r\n", "\r", "\n\n", "x".repeat(30),
		"\u001b[32m", "\u001b[0m", "\u001b[1;31m", "\u001b[38;5;208m", "\u001b[", "\u001b[0", "\u001b[0;",
		"\u001b]0;title\u0007", "\u001b]2;t\u001b\\", "\u001b]0;open", "\u001b]", "\u001b", "\u001bA", "\u001b\\",
		"\u0007", "\u0000", "\u007f",
	];
	for (let round = 0; round < 250; round++) {
		let report = "";
		for (let i = 4 + Math.floor(rnd() * 22); i > 0; i--) report += tokens[Math.floor(rnd() * tokens.length)] ?? "";

		const whole = new AgentTree();
		whole.add({ id: "a", label: "A", output: report });
		const wholeOverlay = openOverlay(whole);
		wholeOverlay.handleInput("\n");
		const expected = wholeOverlay.render(60).join("\n");
		wholeOverlay.dispose();

		const streamed = new AgentTree();
		streamed.add({ id: "a", label: "A" });
		const streamedOverlay = openOverlay(streamed);
		streamedOverlay.handleInput("\n");
		for (let end = 1; end <= report.length; end++) streamed.update("a", { output: report.slice(0, end) });
		const got = streamedOverlay.render(60).join("\n");
		streamedOverlay.dispose();
		assert.equal(got, expected, `round ${round} diverged on ${JSON.stringify(report)}`);
	}
});

test("an unterminated control sequence cannot stall the detail render either", () => {
	// A child that opens `ESC ]` and never terminates it used to hold the seam open for
	// the rest of the run, so every progress tick paid for the whole buffer again — and
	// `x` (stop), the user's way out of a misbehaving agent, queued behind that rebuild.
	const tree = new AgentTree();
	tree.add({ id: "a", label: "alpha" });
	const overlay = openOverlay(tree);
	overlay.handleInput("\n");
	const chunk = `${"lorem ipsum dolor sit amet ".repeat(38)}\n`;
	let buffer = "\u001b]0;never-terminated\n";
	const started = performance.now();
	for (let tick = 0; tick < 400; tick++) {
		buffer += chunk;
		tree.update("a", { output: buffer });
	}
	const elapsed = performance.now() - started;
	const rendered = overlay.render(80).join("\n");
	assert.ok(rendered.includes("lorem ipsum"), "the report is still displayed");
	assert.doesNotMatch(rendered, /\u001b/, "and the dangling introducer is still stripped");
	assert.ok(elapsed < 1000, `400 ticks behind an unterminated OSC took ${Math.round(elapsed)}ms`);
	overlay.dispose();
});
