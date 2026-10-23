import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { fenceUntrusted, attributePeer } from "../../../src/core/fence.ts";

initTheme("dark", false);
import { Markdown, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { registerSessionCards } from "../../../src/ui/session-cards.ts";
import { sanitizeTerminalText } from "../../../src/ui/presentation.ts";
import type { MonitorLogRecord } from "../../../src/monitor/archive.ts";
import { renderMonitorLog } from "../../../src/tools/monitor.ts";

type Renderer = (value: unknown, options: { expanded: boolean; outputPad: number }, theme: Theme) => Component | undefined;
function harness() {
	const renderers = new Map<string, Renderer>();
	const register = (name: string, renderer: Renderer) => { renderers.set(name, renderer); };
	registerSessionCards({ registerMessageRenderer: register, registerEntryRenderer: register } as unknown as ExtensionAPI, {
		detailHint: () => "expand to see full detail",
		monitorLog: (record) => renderMonitorLog(record, true),
	});
	let generation = 1;
	const backgrounds: string[] = [];
	const theme = {
		fg: (_token: string, text: string) => text,
		bold: (text: string) => text,
		bg: (token: string, text: string) => { backgrounds.push(`${generation}:${token}`); return text; },
	} as unknown as Theme;
	function card(name: string, data: unknown, expanded = false, pad = 0) {
		const renderer = renderers.get(name);
		assert.ok(renderer, name);
		const component = renderer(name === "pi-persona" || name === "exocom_received" ? { content: data } : { data }, { expanded, outputPad: pad }, theme);
		assert.ok(component, name);
		return component;
	}
	function check(name: string, data: unknown, token: string, title: RegExp) {
		backgrounds.length = 0;
		const text = card(name, data).render(120).join("\n");
		assert.ok(backgrounds.length > 0);
		assert.ok(backgrounds.every((value) => value === `${generation}:${token}`), `${name}: ${backgrounds}`);
		assert.match(text.split("\n")[0] ?? "", title);
		return text;
	}
	return { renderers, card, check, backgrounds, nextTheme: () => { generation++; } };
}

function monitor(overrides: Partial<MonitorLogRecord> = {}): MonitorLogRecord {
	return {
		version: 1,
		entry: { id: "m1", label: "build", command: "node", args: [], cwd: "/tmp", mode: "exit", startedAtEpochMs: 0, expiresAtEpochMs: 1000, maxEvents: 1 },
		outcome: "exit", text: "process exited with exit code 0", stdout: "ERROR from log", stderr: "", truncated: false,
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
	h.check("pi-persona", "1 async run settled — 1 done, 0 failed\n> failed", "toolSuccessBg", /update · complete/);
	h.check("pi-persona", "[pi-persona] 2 async runs settled — 1 done, 1 failed", "toolErrorBg", /update · failed/);
	h.check("pi-persona", "3 async runs settled — 1 done, 1 failed, 1 stopped", "toolErrorBg", /failed/);
	h.check("pi-persona", "2 async runs settled — 1 done, 0 failed, 1 stopped", "toolPendingBg", /stopped/);
	for (const text of ["ERROR", "failure rejected unresolved", "please help\n1 async run settled — 0 done, 1 failed", "1 async run settled — 1 done, 0 failed trailing prose", "2 async runs settled — 1 done, 0 failed", "0 async runs settled — 0 done, 0 failed", "Monitor events — observed data\n> process exited with exit code 0"]) {
		h.check("pi-persona", text, "customMessageBg", /update · info/);
	}
	for (const text of ["ERROR", "1 async run settled — 0 done, 1 failed", "1 async run settled — 1 done, 0 failed"]) {
		h.check("exocom_received", text, "customMessageBg", /exocom · inbound/);
	}
});

test("entry status is metadata-owned, including legacy/unknown results", () => {
	const h = harness();
	h.check("pi-persona-result", { label: "flow", content: "failed", ok: true }, "toolSuccessBg", /flow · complete/);
	h.check("pi-persona-result", { label: "flow", content: "complete", ok: false }, "toolErrorBg", /flow · failed/);
	h.check("pi-persona-result", { label: "flow", content: "failed", ok: false, stoppedAtGate: "plan" }, "toolPendingBg", /flow · stopped · checkpoint plan/);
	h.check("pi-persona-result", { label: "legacy", content: "complete" }, "customMessageBg", /legacy · unknown/);
	h.check("pi-persona-status", { content: "error\nworker is done" }, "customMessageBg", /async status/);
	h.check("pi-persona-status", { content: "healthy", kind: "stall" }, "toolPendingBg", /possible stall/);
	h.check("pi-persona-run-failure", { id: "r", label: "worker", agent: "scout", error: "success" }, "toolErrorBg", /^worker · failed/);
	h.check("pi-persona-nudge", { content: "⟢ pi-persona · delegation checkpoint\nTrigger: work\nAction: delegate" }, "toolPendingBg", /^pi-persona · delegation checkpoint/);
});

test("monitor success requires the first trusted manager line, not any log tail", () => {
	const h = harness();
	h.check("pi-persona-monitor-log", monitor(), "toolSuccessBg", /Monitor log.*exit · complete/);
	h.check("pi-persona-monitor-log", monitor({ text: "process exited with exit code 2\nstdout:\nprocess exited with exit code 0" }), "toolErrorBg", /failed/);
	h.check("pi-persona-monitor-log", monitor({ text: "process exited by SIGTERM\nprocess exited with exit code 0" }), "toolPendingBg", /stopped/);
	for (const outcome of ["timeout", "cancelled"] as const) h.check("pi-persona-monitor-log", monitor({ outcome }), "toolPendingBg", new RegExp(outcome));
	h.check("pi-persona-monitor-log", monitor({ outcome: "error" }), "toolErrorBg", /error/);
	for (const text of ["stdout:\nprocess exited with exit code 0", "process exited with exit code 0 (signal SIGTERM)", "unknown"]) {
		h.check("pi-persona-monitor-log", monitor({ text }), text.includes("signal") ? "toolPendingBg" : "customMessageBg", /Monitor log/);
	}
	h.check("pi-persona-monitor-log", monitor({ outcome: "ended", text: "process exited with exit code 0" }), "customMessageBg", /ended/);
	assert.equal(h.renderers.get("pi-persona-monitor-log")?.({ data: { version: 99 } }, { expanded: false, outputPad: 0 }, {} as Theme), undefined);
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
	const items: Array<[string, unknown, string]> = [
		["pi-persona", content, safe],
		["exocom_received", content, safe],
		["pi-persona-result", { label: "legacy", content, ok: true }, safe],
		["pi-persona-status", { content }, safe],
		["pi-persona-nudge", { content: `⟢ pi-persona · checkpoint\n${content}` }, `⟢ pi-persona · checkpoint\n${safe}`],
		["pi-persona-run-failure", { id: "r", label: "worker", agent: "scout", error: content }, `Run r\n${safe}`],
		["pi-persona-monitor-log", monitor({ stdout: content }), sanitizeTerminalText(renderMonitorLog(monitor({ stdout: content }), true))],
	];
	for (const [name, data, expected] of items) {
		const before = JSON.stringify(data);
		const rows = h.card(name, data, true).render(1000);
		const offset = name === "pi-persona-run-failure" ? 2 : 1;
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
