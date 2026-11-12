import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { fenceUntrusted, attributePeer } from "../../../src/core/fence.ts";

initTheme("dark", false);
import { Markdown, visibleWidth, type Component } from "@earendil-works/pi-tui";
// Generator imports are READ-ONLY drift guards: the parsers in src/ui/session-cards.ts must
// keep matching exactly what src/engine/async.ts emits (see the drift-guard tests below).
import { buildCheckIn, buildCompletionReport, buildPeekDigest, type AsyncRun } from "../../../src/engine/async.ts";
import { registerSessionCards } from "../../../src/ui/session-cards.ts";
import { sanitizeTerminalText } from "../../../src/ui/presentation.ts";
import type { MonitorLogRecord } from "../../../src/monitor/archive.ts";
import { renderMonitorLog } from "../../../src/tools/monitor.ts";

type RenderOptions = { expanded: boolean; keyText: (id: string) => string; keyHint: (id: string, description: string) => string } & ({ outputPad: number } | { outputPad?: never });
type Renderer = (value: unknown, options: RenderOptions, theme: Theme) => Component | undefined;
function harness() {
	const renderers = new Map<string, Renderer>();
	const register = (name: string, renderer: Renderer) => { renderers.set(name, renderer); };
	let outputPad: 0 | 1 = 0;
	const cardOptions = {
		detailHint: () => "expand to see full detail",
		monitorLog: (record: MonitorLogRecord) => renderMonitorLog(record, true),
		getOutputPad: () => outputPad,
	};
	registerSessionCards({ registerMessageRenderer: register, registerEntryRenderer: register } as unknown as ExtensionAPI, cardOptions);
	let generation = 1;
	const backgrounds: string[] = [];
	const theme = {
		fg: (_token: string, text: string) => text,
		bold: (text: string) => text,
		bg: (token: string, text: string) => { backgrounds.push(`${generation}:${token}`); return text; },
	} as unknown as Theme;
	function card(name: string, data: unknown, expanded = false, pad = 0, keyHint = (_id: string, description: string) => `ctrl+o ${description}`) {
		const renderer = renderers.get(name);
		assert.ok(renderer, name);
		const isMessage = name === "pi-persona" || name === "exocom_received";
		const options: RenderOptions = isMessage
			? { expanded, outputPad: pad, keyText: () => "ctrl+o", keyHint }
			: { expanded, keyText: () => "ctrl+o", keyHint };
		const component = renderer(isMessage ? { content: data } : { data }, options, theme);
		assert.ok(component, name);
		return component;
	}
	function check(name: string, data: unknown, token: string, title: RegExp, metadata?: RegExp) {
		backgrounds.length = 0;
		const text = card(name, data).render(120).join("\n");
		assert.ok(backgrounds.length > 0);
		assert.ok(backgrounds.every((value) => value === `${generation}:${token}`), `${name}: ${backgrounds}`);
		// Rows carry full-width background padding; compare trimmed content.
		const rows = text.split("\n").map((line) => line.trimEnd());
		assert.match(rows[0] ?? "", title);
		if (metadata) assert.match(rows[1] ?? "", metadata, `${name} metadata line`);
		return text;
	}
	return { renderers, card, check, backgrounds, setOutputPad: (value: 0 | 1) => { outputPad = value; }, nextTheme: () => { generation++; } };
}

test("entry cards use the live native outputPad exactly once without changing message padding", () => {
	const h = harness();
	const entries: Array<[string, unknown, number]> = [
		["pi-persona-nudge", { content: "⟢ pi-persona · delegation checkpoint\nTrigger: work\nAction: delegate\nScope: local" }, 1],
		["pi-persona-status", { content: "snapshot\nfirst run\nsecond run\nthird run" }, 1],
		["pi-persona-result", { label: "flow", content: "first\nsecond\nthird\nfourth", ok: true }, 1],
		["pi-persona-run-failure", { id: "r1", label: "worker", agent: "scout", error: "failure detail\nsecond\nthird" }, 2],
		["pi-persona-monitor-log", monitor({ text: "first output\nsecond output" }), 2],
	];
	const leadingSpaces = (line: string | undefined) => /^ */.exec(line ?? "")?.[0].length ?? 0;
	const hint = (_id: string, description: string) => `alt+e ${description}`;
	const messageData = Array.from({ length: 8 }, (_, index) => `message ${index}`).join("\n");

	for (const pad of [0, 1] as const) {
		h.setOutputPad(pad);
		const message = h.card("pi-persona", messageData, false, pad, hint).render(120).map((line) => line.trimEnd());
		assert.equal(leadingSpaces(message[0]), pad, `message title at outputPad=${pad}`);
		assert.equal(leadingSpaces(message[1]), pad + 2, `message body at outputPad=${pad}`);
		assert.equal(leadingSpaces(message.at(-1)), pad, `message hint at outputPad=${pad}`);
		assert.match(message.at(-1) ?? "", /alt\+e to expand/);

		for (const [name, data, metadataRows] of entries) {
			const rows = h.card(name, data, false, 0, hint).render(120).map((line) => line.trimEnd());
			assert.equal(leadingSpaces(rows[0]), pad, `${name} title at outputPad=${pad}`);
			if (metadataRows === 2) assert.equal(leadingSpaces(rows[1]), pad + 2, `${name} metadata at outputPad=${pad}`);
			assert.equal(leadingSpaces(rows[metadataRows]), pad + 2, `${name} body at outputPad=${pad}`);
			assert.equal(leadingSpaces(rows.at(-1)), pad, `${name} hint at outputPad=${pad}`);
			assert.match(rows.at(-1) ?? "", /alt\+e to expand/, `${name} keeps host key hint`);
			assert.ok(rows.every((line) => visibleWidth(line) <= 120), `${name} width at outputPad=${pad}`);
		}
	}

	// The entry path reads the latest setting when the host rebuilds the renderer.
	h.setOutputPad(1);
	const latest = h.card("pi-persona-nudge", entries[0]?.[1]).render(120).map((line) => line.trimEnd());
	assert.equal(leadingSpaces(latest[0]), 1);

	// Native Pi outputPad is 0|1; both entry layouts stay width-safe, while arbitrary renderer
	// padding remains width-safe on the message path whose public render context supplies it.
	for (const pad of [0, 1] as const) {
		h.setOutputPad(pad);
		for (const [name, data] of entries) {
			for (const expanded of [false, true]) {
				for (const width of [0, 1, 2, 3, 8, 16, 40]) {
					const rows = h.card(name, data, expanded).render(width);
					assert.ok(rows.every((line) => visibleWidth(line) <= width), `${name} width=${width}, outputPad=${pad}, expanded=${expanded}`);
				}
			}
		}
	}
	for (const width of [0, 1, 2, 3, 8, 40]) {
		const rows = h.card("pi-persona", messageData, false, 3).render(width);
		assert.ok(rows.every((line) => visibleWidth(line) <= width), `message width=${width}, padding=3`);
	}

	// Expanded literal and Markdown entry paths retain the full sanitized body under native padding.
	const literal = "⟢ pi-persona · delegation checkpoint\nScope: local\nTrigger: too much work\nAction: delegate\nTAIL\u001b[2J";
	const literalRows = h.card("pi-persona-nudge", { content: literal }, true).render(1000);
	assert.equal(literalRows.slice(1).map((line) => line.slice(1).trimEnd()).join("\n"), sanitizeTerminalText(literal));
	const report = "### Review\n\n**Verdict:** accept\n\n- evidence\n\nTAIL";
	const reportRows = h.card("pi-persona-result", { label: "review", content: report, ok: true }, true).render(1000);
	const reportBody = reportRows.slice(1).map((line) => line.slice(1).trimEnd()).join("\n");
	for (const expected of ["Review", "Verdict: accept", "evidence", "TAIL"]) assert.ok(reportBody.includes(expected), expected);
});

test("custom message and entry cards use host-injected keybinding hints", () => {
	const h = harness();
	const configured = (_id: string, description: string) => `alt+e ${description}`;
	const message = h.card("pi-persona", Array.from({ length: 12 }, (_, i) => `update ${i}`).join("\n"), false, 0, configured).render(120).join("\n");
	assert.match(message, /alt\+e to expand/);
	assert.doesNotMatch(message, /ctrl\+o/);
	const log = h.card("pi-persona-monitor-log", monitor({ text: Array.from({ length: 8 }, (_, i) => `output ${i}`).join("\n") }), false, 0, configured).render(120).join("\n");
	assert.match(log, /alt\+e to expand/);
	assert.doesNotMatch(log, /ctrl\+o/);
});

function monitor(overrides: Partial<MonitorLogRecord> = {}): MonitorLogRecord {
	return {
		version: 1,
		entry: { id: "m1", label: "build", command: "node", args: [], cwd: "/tmp", mode: "exit", startedAtEpochMs: 0, expiresAtEpochMs: 1000, maxEvents: 1 },
		outcome: "exit", text: "process exited with exit code 0", stdout: "ERROR from log", stderr: "", truncated: false,
		...overrides,
	};
}

/** Minimal tracked-run fixture shaped like the tracker's own entries, for generator drift guards. */
function asynRun(overrides: Partial<AsyncRun> & { id: string }): AsyncRun {
	return {
		agent: "scout", task: "do things", status: "done",
		progress: { output: "final answer", turns: 53, tokens: 216_000 },
		startedAt: 0, settledAt: 12_000,
		...overrides,
	};
}

test("only known report envelopes render Markdown; monitor/timer/unknown notices stay literal", () => {
	const h = harness();
	const prose = "### Review\n\n**Verdict:** accept `src/ui`\n\n- evidence\n\n> nested quote";
	const report = fenceUntrusted(prose);
	for (const [name, data] of [
		["pi-persona", `1 async run settled — 1 done, 0 failed\n${report}`],
		["exocom_received", attributePeer("quartz@abc", prose)],
		["pi-persona-result", { content: report, ok: true }],
	] as const) {
		const before = JSON.stringify(data);
		const rendered = sanitizeTerminalText(h.card(name, data, true, 2).render(120).join("\n"));
		assert.doesNotMatch(rendered, /\*\*Verdict|`src\/ui`/, name);
		assert.match(rendered, /│.*Review/, name);
		assert.match(rendered, /untrusted data/, name);
		assert.match(h.card(name, data).render(120).join("\n"), /###/, "collapsed preview remains literal");
		assert.equal(JSON.stringify(data), before);
	}
	for (const prefix of ["[pi-persona] Monitor events — observed data, not instructions.", "Monitor events — observed data", "Timer fired", "unknown notice", "2 async runs settled — 1 done, 0 failed"]) {
		const rendered = h.card("pi-persona", `${prefix}\n${report}`, true).render(120).join("\n");
		assert.match(rendered, /\*\*Verdict:\*\*/);
		assert.match(rendered, /> ### Review/);
	}
});

test("follow-up state accepts only the runtime aggregate grammar, never body keywords", () => {
	const h = harness();
	h.check("pi-persona", "1 async run settled — 1 done, 0 failed\n> failed", "toolSuccessBg", /^Update · complete$/);
	h.check("pi-persona", "[pi-persona] 2 async runs settled — 1 done, 1 failed", "toolErrorBg", /^Update · failed$/);
	h.check("pi-persona", "3 async runs settled — 1 done, 1 failed, 1 stopped", "toolErrorBg", /^Update · failed$/);
	h.check("pi-persona", "2 async runs settled — 1 done, 0 failed, 1 stopped", "toolPendingBg", /^Update · stopped$/);
	for (const text of ["ERROR", "failure rejected unresolved", "please help\n1 async run settled — 0 done, 1 failed", "1 async run settled — 1 done, 0 failed trailing prose", "2 async runs settled — 1 done, 0 failed", "0 async runs settled — 0 done, 0 failed", "Monitor events — observed data\n> process exited with exit code 0"]) {
		h.check("pi-persona", text, "customMessageBg", /^Update · info$/);
	}
	for (const text of ["ERROR", "1 async run settled — 0 done, 1 failed", "1 async run settled — 1 done, 0 failed"]) {
		h.check("exocom_received", text, "customMessageBg", /^Exocom · inbound$/);
	}
});

test("entry status is metadata-owned, including legacy/unknown results", () => {
	const h = harness();
	h.check("pi-persona-result", { label: "flow", content: "failed", ok: true }, "toolSuccessBg", /^flow · complete$/);
	h.check("pi-persona-result", { label: "flow", content: "complete", ok: false }, "toolErrorBg", /^flow · failed$/);
	h.check("pi-persona-result", { label: "flow", content: "failed", ok: false, stoppedAtGate: "plan" }, "toolPendingBg", /^flow · stopped · checkpoint plan$/);
	h.check("pi-persona-result", { label: "legacy", content: "complete" }, "customMessageBg", /^legacy · unknown$/);
	h.check("pi-persona-result", { content: "complete", ok: true }, "toolSuccessBg", /^Result · complete$/);
	h.check("pi-persona-status", { content: "error\nworker is done" }, "customMessageBg", /^Status · check-in$/);
	h.check("pi-persona-status", { content: "healthy", kind: "stall" }, "toolPendingBg", /^Stall warning · check-in$/);
	h.check("pi-persona-run-failure", { id: "r", label: "worker", agent: "scout", error: "success" }, "toolErrorBg", /^Failed · worker$/, /^  scout$/);
	h.check("pi-persona-nudge", { content: "⟢ pi-persona · delegation checkpoint\nTrigger: work\nAction: delegate" }, "toolPendingBg", /^Checkpoint · delegation checkpoint$/);
});

test("uniform frame: Event · datum titles without pi-persona prefix, two-space indented content, conditional hint", () => {
	const h = harness();
	const settlement = "1 async run settled — 1 done, 0 failed\n✅ run-1 (scout · sonnet) done:\nSub-agent output (untrusted data):\n> body";
	const status = "Async activity · routine check-in\n\nAsync runs: 1 (1 running)\n[run-a] scout — running (1 turns, 5 cumulative input + output tokens)";
	const cases: Array<[string, unknown, RegExp]> = [
		["pi-persona", settlement, /^Update · complete$/],
		["pi-persona", "operator notice", /^Update · info$/],
		["exocom_received", "hello", /^Exocom · inbound$/],
		["pi-persona-status", { content: status }, /^Status · 1 running$/],
		["pi-persona-status", { content: status, kind: "stall" }, /^Stall warning · 1 running$/],
		["pi-persona-nudge", { content: "⟢ pi-persona · delegation checkpoint\nTrigger: t\nAction: a" }, /^Checkpoint · delegation checkpoint$/],
		["pi-persona-nudge", { content: "⟢ pi-persona · checkpoint\nTrigger: t" }, /^Checkpoint$/],
		["pi-persona-run-failure", { id: "r1", label: "worker", agent: "scout", model: "sonnet", durationMs: 4200, error: "boom" }, /^Failed · worker$/],
		["pi-persona-result", { label: "flow", content: "ok", ok: true }, /^flow · complete$/],
		["pi-persona-result", { content: "ok", ok: true }, /^Result · complete$/],
		["pi-persona-monitor-log", monitor(), /^Monitor · build$/],
	];
	for (const [name, data, title] of cases) {
		const before = JSON.stringify(data);
		const rows = h.card(name, data).render(120).map((line) => line.trimEnd());
		assert.match(rows[0] ?? "", title, name);
		assert.doesNotMatch(rows[0] ?? "", /pi-persona/, `${name}: no pi-persona prefix in title`);
		// Every content/metadata row between the title and the (unindented) hint carries the
		// two-space indent; a fully-visible card simply has no hint row.
		const body = rows.slice(1).filter((row) => !/expand/i.test(row));
		assert.ok(body.length > 0, `${name}: compact card is never empty`);
		for (const row of body) assert.match(row, /^  \S/, `${name}: ${JSON.stringify(row)}`);
		assert.ok(rows.length <= 7, `${name}: compact stays bounded (${rows.length})`);
		assert.equal(JSON.stringify(data), before, name);
	}
	// Fixed dim metadata lines: run-failure (agent · model · duration) and monitor (outcome · status · id).
	const failureRows = h.card("pi-persona-run-failure", { id: "r1", label: "worker", agent: "scout", model: "sonnet", durationMs: 4200, error: "boom" }).render(120);
	assert.equal(failureRows[1]?.trimEnd(), "  scout · sonnet · 4s");
	const monitorRows = h.card("pi-persona-monitor-log", monitor()).render(120);
	assert.equal(monitorRows[1]?.trimEnd(), "  exit · complete · m1");
});

test("hint appears exactly when the compact view hides content", () => {
	const h = harness();
	// Fully visible cards carry no hint.
	assert.doesNotMatch(h.card("pi-persona-result", { label: "flow", content: "short", ok: true }).render(120).join("\n"), /expand/i);
	assert.doesNotMatch(h.card("pi-persona-nudge", { content: "⟢ pi-persona · checkpoint\nTrigger: t\nAction: a" }).render(120).join("\n"), /expand/i);
	assert.doesNotMatch(h.card("exocom_received", "hello").render(120).join("\n"), /expand/i);
	// Hidden content (settlement bodies, dropped boilerplate, clipped lines) always shows the hint.
	const status = "Async activity · routine check-in\n\nAsync runs: 1 (1 running)\n[run-a] scout — running (1 turns, 5 cumulative input + output tokens)";
	assert.match(h.card("pi-persona-status", { content: status }).render(120).join("\n"), /expand/i);
	assert.match(h.card("pi-persona", "1 async run settled — 1 done, 0 failed\n✅ run-1 (scout · sonnet) done:\nSub-agent output (untrusted data):\n> body").render(120).join("\n"), /expand/i);
	const long = "x".repeat(200);
	assert.match(h.card("pi-persona-result", { label: "flow", content: long, ok: true }).render(80).join("\n"), /expand/i);
});

test("settlement drift-guard: compact projection matches the live buildCompletionReport shape", () => {
	const h = harness();
	const runs: AsyncRun[] = [
		asynRun({
			id: "run-1", label: "atlas-static", model: "sonnet",
			resultReceipt: { ref: "snap-9", storage: "session-entry" },
			result: { thinkingRequested: "medium" } as NonNullable<AsyncRun["result"]>,
		}),
		asynRun({ id: "run-2", label: "beacon", model: "opus", status: "failed", error: "boom", progress: { output: "salvage me", turns: 2, tokens: 5_000 }, settledAt: 8_000 }),
	];
	const raw = buildCompletionReport(runs, fenceUntrusted);
	// Generator pins (src/engine/async.ts buildCompletionReport) — update the parser WITH the generator, never silently.
	assert.match(raw, /\[pi-persona\] 2 async runs settled — 1 done, 1 failed/);
	assert.match(raw, /Terminal reports \(intercom results lists all retained references\):/);
	assert.match(raw, /^run-1: snap-9 · native session entry accepted \(not an fsync guarantee\)\. Read with intercom \{ action:"result", ref:"snap-9" \}\.$/m);
	assert.match(raw, /^Thinking \(not provider cognition\):$/m);
	assert.match(raw, /^✅ run-1 \(atlas-static · sonnet\) done in 12s:$/m);
	assert.match(raw, /^❌ 1 failed:$/m);
	assert.match(raw, /^> • run-2 \(beacon · opus\) after 8s: boom$/m);
	assert.match(raw, /^Handle each failure deliberately: /m);

	const before = JSON.stringify(raw);
	const rows = h.card("pi-persona", raw).render(120).join("\n").split("\n").map((line) => line.trimEnd());
	assert.equal(rows[0], "Update · failed");
	assert.equal(rows[1], "  1 done, 1 failed");
	assert.equal(rows[2], "  atlas-static · sonnet · done · 12s");
	assert.equal(rows[3], "  beacon · opus · failed · 8s");
	assert.match(rows.at(-1) ?? "", /expand/i, "bodies are hidden in compact → hint");
	const compact = rows.join("\n");
	assert.doesNotMatch(compact, /Terminal reports|Thinking \(|run-1:|\[run-|^ • |Sub-agent output|Handle each failure|salvage me/);
	assert.equal(JSON.stringify(raw), before);

	// The delivery path strips the [pi-persona] prefix (shared.ts sendPersonaFollowUp) — same projection.
	const stripped = raw.replace(/^\[pi-persona\] /, "");
	assert.equal(h.card("pi-persona", stripped).render(120).join("\n").split("\n")[1]?.trimEnd(), "  1 done, 1 failed");

	// Expanded keeps the omitted boilerplate verbatim (Markdown path renders the full report).
	const expanded = sanitizeTerminalText(h.card("pi-persona", raw, true).render(600).join("\n"));
	assert.match(expanded, /Terminal reports \(intercom results lists all retained references\):/);
	assert.match(expanded, /run-2 \(beacon · opus\) after 8s: boom/);
	assert.match(expanded, /✅ run-1 \(atlas-static · sonnet\) done in 12s:/);
});

test("status drift-guard: compact projection matches the live buildPeekDigest/buildCheckIn shape", () => {
	const h = harness();
	const runs: AsyncRun[] = [
		asynRun({ id: "run-a", label: "atlas-static", model: "sonnet", status: "running" }),
		asynRun({ id: "run-b", label: "beacon", model: "opus", status: "running", queued: true, progress: { output: "", turns: 0, tokens: 0 } }),
	];
	const digest = buildPeekDigest(runs, { now: 5_000, stallMs: 90_000 });
	// Generator pins (src/engine/async.ts buildPeekDigest / buildCheckIn).
	assert.match(digest, /^Async runs: 2 \(2 running\)$/m);
	assert.match(digest, /^\[run-a\] atlas-static · sonnet — running \(53 turns, 216k cumulative input \+ output tokens\) · running for 5s$/m);
	assert.match(digest, /^\[run-b\] beacon · opus — running \(0 cumulative input \+ output tokens\) · queued \(waiting for concurrency slot\)$/m);
	assert.match(digest, /^Cumulative tokens show total input \+ output so far, not current context occupancy\.$/m);
	const content = buildCheckIn(runs, { now: 5_000, stallMs: 90_000 });
	assert.match(content, /^Async activity · routine check-in$/m);

	const before = JSON.stringify(content);
	const rows = h.card("pi-persona-status", { content }).render(120).join("\n").split("\n").map((line) => line.trimEnd());
	assert.equal(rows[0], "Status · 2 running · 1 queued");
	assert.equal(rows[1], "  atlas-static · sonnet · 53 turns · 216k cumulative input + output tokens");
	assert.equal(rows[2], "  beacon · opus · queued · 0 cumulative input + output tokens");
	const compact = rows.join("\n");
	assert.doesNotMatch(compact, /Async runs:|\[run-|Cumulative tokens|running for|Async activity/);
	assert.match(rows.at(-1) ?? "", /expand/i);
	assert.match(h.card("pi-persona-status", { content }, true).render(400).join("\n"), /\[run-a\] atlas-static · sonnet — running/);
	assert.equal(JSON.stringify(content), before);

	// The actual stall envelope keeps the digest, while the compact card leads with the
	// concrete lack-of-progress reason ahead of verbose cumulative token counters.
	const stalledRun = asynRun({ id: "run-stalled", label: "atlas-static", model: "sonnet", status: "running", lastAdvanceAt: 0 });
	const stallContent = buildCheckIn([stalledRun], { now: 95_000, stallMs: 90_000, reason: "stall" });
	assert.match(stallContent, /^Async activity · possible stall$/m);
	assert.match(stallContent, /⚠ possibly stuck \(no progress for 95s\)/);
	const stallData = { content: stallContent, kind: "stall" };
	const stall = h.card("pi-persona-status", stallData).render(120).join("\n").split("\n").map((line) => line.trimEnd());
	assert.equal(stall[0], "Stall warning · 1 running");
	assert.equal(stall[1], "  atlas-static · sonnet · no observed progress for 95s · 53 turns · 216k cumulative input + output tokens");
	h.check("pi-persona-status", stallData, "toolPendingBg", /^Stall warning · 1 running$/);
	assert.match(h.card("pi-persona-status", stallData, true).render(400).join("\n"), /⚠ possibly stuck \(no progress for 95s\)/);

	// Recovery is a live progress digest with a distinct header. It must remain a running
	// projection and must never imply that a worker completed.
	const resumedRun = asynRun({
		id: "run-resumed", label: "atlas-static", model: "sonnet", status: "running",
		progress: { output: "", turns: 54, tokens: 217_000 }, lastAdvanceAt: 90_000,
	});
	const recoveryContent = buildCheckIn([resumedRun], { now: 95_000, stallMs: 90_000, reason: "recovery" });
	assert.match(recoveryContent, /^Async activity · progress resumed$/m);
	const recoveryData = { content: recoveryContent, kind: "recovery" };
	const recovery = h.card("pi-persona-status", recoveryData).render(120).join("\n").split("\n").map((line) => line.trimEnd());
	assert.equal(recovery[0], "Progress resumed · 1 running");
	assert.equal(recovery[1], "  atlas-static · sonnet · progress resumed · 54 turns · 217k cumulative input + output tokens");
	assert.doesNotMatch(recovery.join("\n"), /done|complete/i);
	h.check("pi-persona-status", recoveryData, "toolSuccessBg", /^Progress resumed · 1 running$/);
	assert.match(h.card("pi-persona-status", recoveryData, true).render(400).join("\n"), /Async activity · progress resumed/);
	for (const width of [40, 60, 80, 120]) {
		for (const data of [stallData, recoveryData]) {
			const rows = h.card("pi-persona-status", data).render(width);
			for (const row of rows) assert.ok(visibleWidth(row) <= width, `status width=${width}: spilled ${visibleWidth(row)}`);
		}
	}

	// Explicit wait states remain visible ahead of usage counters in the collapsed projection.
	for (const wait of ["waiting for operator", "waiting for supervisor"] as const) {
		const waitingRun = asynRun({
			id: `run-${wait.replaceAll(" ", "-")}`, status: "running",
			...(wait === "waiting for operator" ? { awaiting: wait } : {}),
		});
		const waitingDigest = buildPeekDigest([waitingRun], { now: 5_000, stallMs: 90_000, waitingForSupervisor: new Set([waitingRun.id]) });
		const waitingContent = `Async activity · routine check-in\n\n${waitingDigest}`;
		const waitingRows = h.card("pi-persona-status", { content: waitingContent }).render(120).join("\n");
		assert.match(waitingRows, new RegExp(`\\b${wait} · 53 turns · 216k cumulative input \\+ output tokens`));
	}

	// A settled leg inside the digest keeps its own compact shape.
	const settled = buildPeekDigest([asynRun({ id: "run-c", label: "old", model: "haiku", result: {} as NonNullable<AsyncRun["result"]> })], { now: 30_000, stallMs: 90_000 });
	assert.match(settled, /^\[run-c\] old · haiku — done in 12s: full result available via intercom result \(to: run-c\)$/m);
	const settledRows = h.card("pi-persona-status", { content: `Async activity · routine check-in\n\n${settled}` }).render(120).join("\n").split("\n").map((line) => line.trimEnd());
	assert.equal(settledRows[0], "Status · 0 running");
	assert.equal(settledRows[1], "  old · haiku · done · 12s");
});

test("status cards split clipped signals into complete run blocks and count omitted runs", () => {
	const h = harness();
	const label = "very-long-research-agent-alias";
	const model = "sonnet";
	const displayName = `${label} · ${model}`;
	const signalRows = (content: string, kind: string | undefined, width: number) => {
		const rows = h.card("pi-persona-status", { content, ...(kind ? { kind } : {}) }).render(width).map((line) => line.trimEnd());
		return rows.slice(1).filter((line) => !/expand/i.test(line));
	};

	const stalled = asynRun({ id: "run-long-stall", label, model, status: "running", lastAdvanceAt: 0 });
	const stallContent = buildCheckIn([stalled], { now: 95_000, stallMs: 90_000, reason: "stall" });
	for (const width of [40, 60]) {
		const body = signalRows(stallContent, "stall", width);
		assert.equal(body.length, 2, `width=${width}: the signal stays a complete two-row block`);
		assert.doesNotMatch(body[0] ?? "", /no observed progress/);
		assert.match(body[1] ?? "", /no observed progress for 95s/);
	}
	const wideStall = signalRows(stallContent, "stall", 80);
	assert.equal(wideStall.length, 1, "the row stays single-line when name and reason fit");
	assert.ok((wideStall[0] ?? "").includes(`${displayName} · no observed progress for 95s`));

	const resumed = asynRun({
		id: "run-long-recovery", label, model, status: "running",
		progress: { output: "", turns: 54, tokens: 217_000 }, lastAdvanceAt: 90_000,
	});
	const recoveryContent = buildCheckIn([resumed], { now: 95_000, stallMs: 90_000, reason: "recovery" });
	for (const width of [40, 60]) {
		const body = signalRows(recoveryContent, "recovery", width);
		const signalWouldClip = visibleWidth(`${displayName} · progress resumed`) >= width - 2;
		assert.equal(body.length, signalWouldClip ? 2 : 1, `width=${width}: only split when the signal would be clipped`);
		assert.match(body.at(-1) ?? "", /progress resumed/);
	}
	const wideRecovery = signalRows(recoveryContent, "recovery", 80);
	assert.equal(wideRecovery.length, 1);
	assert.ok((wideRecovery[0] ?? "").includes(`${displayName} · progress resumed · 54 turns`));

	const waiting = asynRun({ id: "run-long-wait", label, model, status: "running", awaiting: "waiting for operator" });
	const waitingContent = `Async activity · routine check-in\n\n${buildPeekDigest([waiting], { now: 95_000, stallMs: 90_000 })}`;
	const waitingBody = signalRows(waitingContent, undefined, 40);
	assert.equal(waitingBody.length, 2);
	assert.match(waitingBody[1] ?? "", /^  waiting for operator · 53 turns/);

	const queued = asynRun({ id: "run-long-queued", label, model, status: "running", queued: true, progress: { output: "", turns: 0, tokens: 0 } });
	const queuedContent = `Async activity · routine check-in\n\n${buildPeekDigest([queued], { now: 95_000, stallMs: 90_000 })}`;
	const queuedBody = signalRows(queuedContent, undefined, 40);
	assert.equal(queuedBody.length, 2);
	assert.match(queuedBody[1] ?? "", /^  queued/);

	const manyStalled = Array.from({ length: 5 }, (_, index) => asynRun({
		id: `run-crowded-${index + 1}`, label: `${label}-${index + 1}`, model,
		status: "running", lastAdvanceAt: 0,
	}));
	const crowdedContent = buildCheckIn(manyStalled, { now: 95_000, stallMs: 90_000, reason: "stall" });
	for (const [width, expectedMore] of [[40, 4], [60, 4], [80, 2]] as const) {
		const body = signalRows(crowdedContent, "stall", width);
		assert.ok(body.length <= 4, `width=${width}: bounded preview (${body.length})`);
		assert.match(body.at(-1) ?? "", new RegExp(`… \\+${expectedMore} more`));
		if (width < 80) {
			assert.equal(body.length, 3, "one complete two-row signal block plus the omitted-run count");
			assert.match(body[1] ?? "", /no observed progress for 95s/);
			assert.doesNotMatch(body.join("\n"), /very-long-research-agent-alias-2/);
		} else {
			assert.match(body.join("\n"), /very-long-research-agent-alias-2/);
		}
	}
	const expanded = h.card("pi-persona-status", { content: crowdedContent, kind: "stall" }, true).render(400).join("\n");
	assert.match(expanded, /\[run-crowded-5\]/, "expanded view retains every run in the full digest");
	assert.match(expanded, /Cumulative tokens show/, "expanded view retains the complete generated report");
});

test("unknown shapes fall back to the bounded generic preview — never a crash or an empty card", () => {
	const h = harness();
	const junk = "operator notice\narbitrary body\nsecond line\nthird\nfourth\nfifth";
	const rows = h.card("pi-persona", junk).render(120).join("\n").split("\n").map((line) => line.trimEnd());
	assert.equal(rows[0], "Update · info");
	assert.ok(rows.length <= 7, `bounded (${rows.length})`);
	assert.match(rows[1] ?? "", /^  \S/, "fallback preview is non-empty and indented");

	// A settlement head followed by unrecognized content falls back instead of mis-projecting.
	const mixed = "2 async runs settled — 1 done, 1 failed\nmystery block that matches nothing\nmore";
	const mixedRows = h.card("pi-persona", mixed).render(120).join("\n").split("\n").map((line) => line.trimEnd());
	assert.equal(mixedRows[0], "Update · failed");
	assert.ok(mixedRows.length <= 7);
	assert.match(mixedRows.join("\n"), /mystery block/);

	const statusRows = h.card("pi-persona-status", { content: "error\nworker is done" }).render(120).join("\n").split("\n").map((line) => line.trimEnd());
	assert.equal(statusRows[0], "Status · check-in");
	assert.match(statusRows.join("\n"), /worker is done/);
	assert.ok(statusRows.length <= 7);

	// A status digest with no parseable run rows also falls back (never an empty card).
	const headerOnly = h.card("pi-persona-status", { content: "Async activity · routine check-in\n\nAsync runs: 0 (0 running)" }).render(120).join("\n").split("\n");
	assert.ok(headerOnly.length >= 2);
	assert.match(headerOnly.join("\n"), /\S/);
});

test("compact lines clip at width with no mid-word spill, long names included", () => {
	const h = harness();
	const longName = "x".repeat(200);
	const digest = buildPeekDigest([asynRun({ id: "run-1", label: longName, model: longName })], { now: 1_000, stallMs: 90_000 });
	const content = `Async activity · routine check-in\n\n${digest}`;
	for (const width of [40, 60, 80, 120]) {
		const rows = h.card("pi-persona-status", { content }).render(width);
		assert.ok(rows.length > 1, `width=${width}`);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `width=${width}: spilled ${visibleWidth(row)}`);
		assert.doesNotMatch(rows[1] ?? "", /x{60}/, `width=${width}: no unclipped mid-word run`);
	}
	const report = buildCompletionReport([asynRun({ id: "run-1", label: longName, model: longName })], fenceUntrusted);
	for (const width of [40, 120]) {
		const rows = h.card("pi-persona", report).render(width);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `width=${width}: spilled ${visibleWidth(row)}`);
	}
});

test("monitor success requires the first trusted manager line, not any log tail", () => {
	const h = harness();
	h.check("pi-persona-monitor-log", monitor(), "toolSuccessBg", /^Monitor · build$/, /^  exit · complete · m1$/);
	h.check("pi-persona-monitor-log", monitor({ text: "process exited with exit code 2\nstdout:\nprocess exited with exit code 0" }), "toolErrorBg", /^Monitor · build$/, /^  exit · failed · m1$/);
	h.check("pi-persona-monitor-log", monitor({ text: "process exited by SIGTERM\nprocess exited with exit code 0" }), "toolPendingBg", /^Monitor · build$/, /^  exit · stopped · m1$/);
	for (const outcome of ["timeout", "cancelled"] as const) h.check("pi-persona-monitor-log", monitor({ outcome }), "toolPendingBg", /^Monitor · build$/, new RegExp(`^  ${outcome} · stopped · m1$`));
	h.check("pi-persona-monitor-log", monitor({ outcome: "error" }), "toolErrorBg", /^Monitor · build$/, /^  error · failed · m1$/);
	for (const text of ["stdout:\nprocess exited with exit code 0", "process exited with exit code 0 (signal SIGTERM)", "unknown"]) {
		const stopped = text.includes("signal");
		h.check("pi-persona-monitor-log", monitor({ text }), stopped ? "toolPendingBg" : "customMessageBg", /^Monitor · build$/, new RegExp(`^  exit · ${stopped ? "stopped" : "info"} · m1$`));
	}
	h.check("pi-persona-monitor-log", monitor({ outcome: "ended", text: "process exited with exit code 0" }), "customMessageBg", /^Monitor · build$/, /^  ended · info · m1$/);
	assert.equal(h.renderers.get("pi-persona-monitor-log")?.({ data: { version: 99 } }, { expanded: false, outputPad: 0, keyText: () => "ctrl+o", keyHint: (_id, description) => `ctrl+o ${description}` }, {} as Theme), undefined);
});

test("specialized previews keep trigger/action and status digest; expansion retains exact sanitized payload", () => {
	const h = harness();
	const full = "⟢ pi-persona · delegation checkpoint\n  Scope: local\n  Trigger: too much work\n  Action: delegate\n\n  Keep local: quick checks\n  TAIL\u001b[2J";
	const collapsed = h.card("pi-persona-nudge", { content: full }).render(120).join("\n");
	assert.match(collapsed, /Trigger: too much work/);
	assert.match(collapsed, /Action: delegate/);
	assert.match(collapsed, /expand/i);
	assert.doesNotMatch(collapsed, /Scope:|TAIL/);
	const expanded = h.card("pi-persona-nudge", { content: full }, true).render(120).slice(1).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, sanitizeTerminalText(full));
	// Unknown digest shape: the generic bounded fallback still shows the body lines, not the header.
	const status = "Async activity\n2 running\nquiet-scout · cumulative input + output tokens\nMore detail";
	const digest = h.card("pi-persona-status", { content: status }).render(120).join("\n");
	assert.match(digest, /quiet-scout/);
	assert.doesNotMatch(digest, /Async activity|More detail/);
	assert.match(h.card("pi-persona-status", { content: status }, true).render(120).join("\n"), /More detail/);
});

test("expanded literal cards preserve sanitized text; report cards match native Markdown without payload mutation", () => {
	const h = harness();
	const content = "  first line\u001b[31m\r\n\n    second 漢字 👩‍💻 e\u0301\u0007\nTAIL  ";
	const safe = sanitizeTerminalText(content);
	const items: Array<[string, unknown, string, number]> = [
		["pi-persona", content, safe, 1],
		["exocom_received", content, safe, 1],
		["pi-persona-result", { label: "legacy", content, ok: true }, safe, 1],
		["pi-persona-status", { content }, safe, 1],
		["pi-persona-nudge", { content: `⟢ pi-persona · checkpoint\n${content}` }, `⟢ pi-persona · checkpoint\n${safe}`, 1],
		["pi-persona-run-failure", { id: "r", label: "worker", agent: "scout", error: content }, `Run r\n${safe}`, 2],
		["pi-persona-monitor-log", monitor({ stdout: content }), sanitizeTerminalText(renderMonitorLog(monitor({ stdout: content }), true)), 2],
	];
	for (const [name, data, expected, offset] of items) {
		const before = JSON.stringify(data);
		const rows = h.card(name, data, true).render(1000);
		// Markdown deliberately interprets indented code. Compare its native visual projection,
		// while independently retaining the exact stored/model payload assertion.
		const visual = name === "exocom_received" || name === "pi-persona-result"
			? new Markdown(expected, 0, 0, getMarkdownTheme()).render(1000).join("\n") : expected;
		assert.equal(rows.slice(offset).map((row) => row.trimEnd()).join("\n"), visual.split("\n").map((row) => row.trimEnd()).join("\n"), name);
		assert.equal(JSON.stringify(data), before, "rendering does not change raw payloads");
	}
	const multipart = [{ type: "text", text: "one\u001b[2J" }, { type: "image", data: "unused", mimeType: "image/png" }, { type: "text", text: "two" }];
	assert.match(h.card("pi-persona", multipart, true).render(80).join("\n"), /one\s*\n\[image\]\s*\ntwo/);
});

test("collapsed and expanded archived monitor logs neutralize bidi and terminal controls while retaining literal text and raw records", () => {
	const h = harness();
	const hostile = "**literal** \u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069safe.exe\u001b[2J\u001b]0;spoofed title\u0007\u2028line\u2029end\r\nnext";
	const record = monitor({ text: `process exited with exit code 0\n${hostile}`, stdout: hostile, stderr: hostile });
	const before = JSON.stringify(record);
	const rendered = h.card("pi-persona-monitor-log", record, true).render(240).map((line) => line.trimEnd()).join("\n");
	assert.doesNotMatch(rendered, /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\u001b\u0007]/);
	assert.ok(rendered.includes("> **literal** safe.exe line end\n> next"), rendered);
	assert.match(rendered, /Sub-agent output \(untrusted data\):/);
	assert.doesNotMatch(rendered, /spoofed title/);
	const collapsed = h.card("pi-persona-monitor-log", record, false).render(240).join("\n");
	assert.doesNotMatch(collapsed, /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\u001b\u0007]/);
	assert.match(collapsed, /\*\*literal\*\* safe\.exe line end/);
	assert.equal(JSON.stringify(record), before);
});

test("all surfaces share width-safe Unicode/padding, glyph-free headers, and uncached theme rendering", () => {
	const h = harness();
	const content = "漢字 e\u0301 👩‍💻 " + "界".repeat(180) + "\nTAIL";
	const items: Array<[string, unknown]> = [
		["pi-persona", content], ["exocom_received", content],
		["pi-persona-monitor-log", monitor({ stdout: content })],
		["pi-persona-run-failure", { id: "r", label: "worker", agent: "scout", error: content }],
		["pi-persona-result", { label: "flow", content, ok: true }],
		["pi-persona-nudge", { content: `⟢ pi-persona · checkpoint\nTrigger: ${content}\nAction: act` }],
		["pi-persona-status", { content: `snapshot\n${content}` }],
	];
	for (const [name, data] of items) {
		const before = JSON.stringify(data);
		for (const expanded of [false, true]) {
			const component = h.card(name, data, expanded, 5);
			for (const width of [0, 1, 2, 3, 8, 16, 40, 120]) {
				const rows = component.render(width);
				assert.ok(rows.every((line) => visibleWidth(line) <= width), `${name} width=${width}`);
				assert.ok(rows.every((line) => Array.from(line).every((point) => !/^[\uD800-\uDFFF]$/u.test(point))), `${name}: no split surrogate`);
			}
			const rows = component.render(120);
			assert.doesNotMatch(rows[0] ?? "", /^\s*[⟢✕❌⚠✓]/u);
			if (!expanded) assert.ok(rows.length <= 7, `${name} must remain bounded: ${rows.length}`);
			else assert.match(rows.join("\n"), /TAIL/);
			component.invalidate();
			h.nextTheme();
			h.backgrounds.length = 0;
			component.render(120);
			assert.ok(h.backgrounds.length > 0, `${name} recomputes semantic backgrounds after invalidation`);
		}
		assert.equal(JSON.stringify(data), before);
	}
});

test("stall, progress-resumed, and Update-complete cards preserve native outputPad parity", () => {
	const h = harness();
	const stalled = asynRun({ id: "stall-pad", status: "running", lastAdvanceAt: 0 });
	const resumed = asynRun({ id: "resume-pad", status: "running", lastAdvanceAt: 90_000, progress: { output: "", turns: 54, tokens: 217_000 } });
	const stall = { content: buildCheckIn([stalled], { now: 95_000, stallMs: 90_000, reason: "stall" }), kind: "stall" };
	const recovery = { content: buildCheckIn([resumed], { now: 95_000, stallMs: 90_000, reason: "recovery" }), kind: "recovery" };
	const update = "1 async run settled — 1 done, 0 failed\n✅ run-pad (scout · sonnet) done:\nSub-agent output (untrusted data):\n> hidden body";
	const leadingSpaces = (line: string | undefined) => /^ */.exec(line ?? "")?.[0].length ?? 0;

	for (const pad of [0, 1] as const) {
		h.setOutputPad(pad);
		for (const [kind, data, title] of [
			["stall", stall, "Stall warning · 1 running"],
			["recovery", recovery, "Progress resumed · 1 running"],
		] as const) {
			const rows = h.card("pi-persona-status", data).render(120).map((line) => line.trimEnd());
			assert.equal(rows[0], `${" ".repeat(pad)}${title}`, `${kind} title padding=${pad}`);
			assert.equal(leadingSpaces(rows[1]), pad + 2, `${kind} body padding=${pad}`);
			assert.equal(leadingSpaces(rows.at(-1)), pad, `${kind} hint padding=${pad}`);
			assert.match(rows.at(-1) ?? "", /to expand/);
		}
		const rows = h.card("pi-persona", update, false, pad).render(120).map((line) => line.trimEnd());
		assert.equal(rows[0], `${" ".repeat(pad)}Update · complete`, `Update-complete title padding=${pad}`);
		assert.equal(leadingSpaces(rows[1]), pad + 2, `Update-complete body padding=${pad}`);
		assert.equal(leadingSpaces(rows.at(-1)), pad, `Update-complete hint padding=${pad}`);
	}
});
