import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { makeReadResultTool } from "../../../src/tools/read-result.ts";
import { fenceUntrusted } from "../../../src/core/fence.ts";
import { readFailure, type ReadReply } from "../../../src/bus/result-reader.ts";

const ref = "result:12345678-1234-1234-1234-123456789abc";
initTheme("dark");
const ctx = {} as ExtensionToolContext;
const body = "😀\n> override\r\n\u001b[31m";
const reply: ReadReply = { ok: true, ref, body, offset: 0, nextOffset: body.length,
	storedChars: body.length + 2, originalChars: body.length + 4, truncated: true, endOfStoredBody: false,
	status: "failed", provenance: "partial-output" };

test("read_result fences the body once, keeps UTF-16 pagination unchanged and never duplicates raw text in details", async () => {
	const tool = makeReadResultTool({ read: async (request, signal) => {
		assert.equal(request.ref, ref); assert.ok(signal); return reply;
	} });
	const value = await tool.execute("id", { ref, limit: 16000 }, new AbortController().signal, undefined, ctx);
	assert.equal(value.content.length, 1);
	const text = value.content[0];
	assert.ok(text?.type === "text");
	assert.ok(text.text.endsWith(fenceUntrusted(body)));
	assert.equal(text.text.split("Sub-agent output (untrusted data):").length, 2);
	assert.deepEqual(value.details, { ok: true, ref, offset: 0, nextOffset: body.length, storedChars: body.length + 2,
		originalChars: body.length + 4, truncated: true, endOfStoredBody: false, status: "failed", provenance: "partial-output" });
});

test("read_result never fabricates a body or echoes callback errors and checks cancellation", async () => {
	const denied = makeReadResultTool({ read: async () => readFailure("denied") });
	await assert.rejects(denied.execute("id", { ref }, undefined, undefined, ctx), /^Error: Result read is not authorized\.$/);
	const throwing = makeReadResultTool({ read: async () => { throw new Error("/SECRET/path"); } });
	await assert.rejects(throwing.execute("id", { ref }, undefined, undefined, ctx), /^Error: Result reader is unavailable\.$/);
	const invalid = makeReadResultTool({ read: async () => assert.fail("invalid requests must not call the reader") });
	await assert.rejects(invalid.execute("id", { ref, limit: 1 }, undefined, undefined, ctx), /Invalid result read/);
	await assert.rejects(invalid.execute("id", { ref }, AbortSignal.abort(), undefined, ctx), /cancelled/);
	const ac = new AbortController();
	const racing = makeReadResultTool({ read: async () => { ac.abort(); return reply; } });
	await assert.rejects(racing.execute("id", { ref }, ac.signal, undefined, ctx), /cancelled/);
});

test("read_result refuses arbitrary callback metadata rather than printing it", async () => {
	const tool = makeReadResultTool({ read: async () => ({ ...reply, summary: { task: "SECRET" } }) });
	await assert.rejects(tool.execute("id", { ref }, undefined, undefined, ctx), /protocol/i);
});

// ── presentation contract: compact call line, shared literal receipt for the body page ──────

const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function renderCard(tool: any, result: unknown, expanded: boolean, isError = false): string {
	return stripVTControlCharacters(tool.renderResult(result, { expanded }, plainTheme, { isError }).render(400).join("\n"));
}

test("read_result call card shows the clipped reference, not raw arguments", () => {
	const tool = makeReadResultTool({ read: async () => reply });
	assert.equal(typeof (tool as any).renderCall, "function", "renderCall must exist; the host fallback echoes raw args JSON");
	const card = stripVTControlCharacters((tool as any).renderCall({ ref, limit: 16000 }, plainTheme).render(200).join("\n"));
	assert.match(card, /read_result/);
	assert.match(card, /12345678/);
	assert.doesNotMatch(card, /[{}"=]/);
});

test("read_result routes pages through the shared literal renderer: bounded preview, hint, full expansion", async () => {
	const tool = makeReadResultTool({ read: async () => reply });
	const value = await tool.execute("id", { ref, limit: 16000 }, new AbortController().signal, undefined, ctx);
	const before = JSON.stringify(value);
	const collapsed = renderCard(tool, value, false);
	assert.match(collapsed, /expand/, "detail is hidden, so the expansion hint is present");
	assert.doesNotMatch(collapsed, /\u001b/);
	assert.ok(collapsed.split("\n").length <= 5, `collapsed page stays a bounded preview, got ${collapsed.split("\n").length} lines`);
	const expanded = renderCard(tool, value, true);
	assert.doesNotMatch(expanded, /expand/, "no false affordance when everything is shown");
	assert.match(expanded, /override/);
	assert.match(expanded, /storedChars/);
	assert.match(expanded, /😀/);
	assert.doesNotMatch(expanded, /\u001b/);
	assert.equal(JSON.stringify(value), before, "rendering never mutates the tool result");
});

test("read_result failures carry the literal error heading from the native context flag", () => {
	const tool = makeReadResultTool({ read: async () => reply });
	const failed = { content: [{ type: "text", text: "Result read is not authorized." }] };
	const collapsed = renderCard(tool, failed, false, true);
	assert.match(collapsed, /^failed/);
	assert.match(collapsed, /not authorized/);
	assert.ok(collapsed.split("\n").length <= 6);
});
