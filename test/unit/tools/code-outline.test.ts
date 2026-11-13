import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCodeOutlineTool } from "../../../src/tools/code-outline.ts";

const context = { cwd: "", hasUI: false };

test("code_outline rejects a real FIFO without a writer without hanging", async () => {
	if (platform() === "win32") {
		const dir = await mkdtemp(join(tmpdir(), "pi-outline-fifo-"));
		try {
			const tool = makeCodeOutlineTool();
			const call = tool.execute as unknown as (id: string, params: { path: string }, signal: undefined, update: undefined, ctx: typeof context) => Promise<unknown>;
			await assert.rejects(call("test", { path: dir }, undefined, undefined, { ...context, cwd: dir }), /regular files only|directory|access|EPERM|EISDIR/i);
		} finally { await rm(dir, { recursive: true, force: true }); }
		return;
	}
	const { createBashTool } = await import("@earendil-works/pi-coding-agent");
	const dir = await mkdtemp(join(tmpdir(), "pi-outline-fifo-"));
	try {
		const bash = createBashTool(dir);
		const fixture = await (bash.execute as unknown as (id: string, params: { command: string }, signal: AbortSignal, update: undefined, ctx: typeof context) => Promise<{ content?: Array<{ text?: string }>; details?: { exitCode?: number } }>)("test", { command: "mkfifo fixture.ts" }, new AbortController().signal, undefined, { ...context, cwd: dir });
		assert.equal(fixture.details?.exitCode, 0, JSON.stringify(fixture));
		const tool = makeCodeOutlineTool();
		const call = tool.execute as unknown as (id: string, params: { path: string }, signal: undefined, update: undefined, ctx: typeof context) => Promise<unknown>;
		await Promise.race([
			assert.rejects(call("test", { path: join(dir, "fixture.ts") }, undefined, undefined, { ...context, cwd: dir }), /regular files only/i),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("FIFO open did not reject promptly")), 3000)),
		]);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("code_outline rejects non-regular filesystem entries after open", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-outline-nonregular-"));
	try {
		const nested = join(dir, "directory.ts");
		await mkdir(nested);
		const tool = makeCodeOutlineTool();
		const call = tool.execute as unknown as (id: string, params: { path: string }, signal: undefined, update: undefined, ctx: typeof context) => Promise<unknown>;
		await assert.rejects(call("test", { path: nested }, undefined, undefined, context), /regular files only|directory|access|EPERM|EISDIR/i);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("code_outline factory returns an executable native definition and rechecks authorization per call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outline-tool-"));
  try {
    const path = join(dir, "source.ts");
    await writeFile(path, "export function safe() {}\nexport function safeAgain() {}");
    let allowed = true;
    let checks = 0;
    const tool = makeCodeOutlineTool({ authorize: () => { checks += 1; return allowed; } });
    const call = tool.execute as unknown as (id: string, params: { path: string; query?: string; limit?: number }, signal: undefined, update: undefined, ctx: typeof context) => Promise<{ content: Array<{ text?: string }>; details: { symbols: Array<{ name: string }>; language: string; grammar: string; returned: number } }>;
    const result = await call("test", { path }, undefined, undefined, { ...context, cwd: dir });
    assert.match(result.content[0]?.text ?? "", /safe/);
    assert.deepEqual(result.details.symbols.map((symbol) => symbol.name), ["safe", "safeAgain"]);
    assert.equal(result.details.language, "TypeScript");
    assert.equal(result.details.grammar, "typescript");
    assert.equal(result.details.returned, 2);
    const filtered = await call("query", { path, query: "Again", limit: 1 }, undefined, undefined, { ...context, cwd: dir });
    assert.deepEqual(filtered.details.symbols.map((symbol) => symbol.name), ["safeAgain"]);
    assert.match(filtered.content[0]?.text ?? "", /1 matching symbols; returned 1; hasMore=false/);
    assert.equal((result.content[0]?.text?.match(/Sub-agent output \(untrusted data\):/g) ?? []).length, 1);
    assert.match(result.content[0]?.text ?? "", /^Sub-agent output/);
    allowed = false;
    await assert.rejects(call("test", { path }, undefined, undefined, { ...context, cwd: dir }), /not authorized/i);
    assert.equal(checks, 3);
    allowed = true;
    await writeFile(path, Array.from({ length: 200 }, (_, index) => `export function symbol${index}() {}`).join("\n"));
    const large = await call("test", { path, limit: 200 }, undefined, undefined, { ...context, cwd: dir });
    assert.ok(Buffer.byteLength(large.content[0]?.text ?? "", "utf8") <= 16 * 1024);
    assert.ok(large.details.symbols.length <= 200);
    await writeFile(path, "namespace N {".repeat(8000) + "function f() {}" + "}".repeat(8000));
    await assert.rejects(call("deep", { path, query: "nonmatch", limit: 1 }, undefined, undefined, { ...context, cwd: dir }), /resource limit.*depth.*smaller.*query and limit/i);
    await writeFile(path, "export function recovered() {}");
    const recovered = await call("recovery", { path }, undefined, undefined, { ...context, cwd: dir });
    assert.deepEqual(recovered.details.symbols.map((symbol) => symbol.name), ["recovered"]);
    assert.match(recovered.content[0]?.text ?? "", /^Sub-agent output/);
    assert.ok(Buffer.byteLength(recovered.content[0]?.text ?? "", "utf8") <= 16 * 1024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
