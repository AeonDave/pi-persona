import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { fenceUntrusted } from "../../../src/core/fence.ts";
import { createReportBody } from "../../../src/ui/report-body.ts";
import { sanitizeTerminalText } from "../../../src/ui/presentation.ts";

initTheme("dark", false);
const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
} as unknown as Theme;
const source = fenceUntrusted("### Review\n\n**Verdict:** accept `src/ui`\n\n- 漢字 👩‍💻 e\u0301\n- second\n\n```text\nraw_code()\n```\n\n> quoted evidence\n\nTAIL");

test("report body delegates unchanged sanitized source to native Markdown, retaining quote attribution", () => {
	const hostile = source + "\u001b[2J\u0007";
	const body = createReportBody(hostile, theme);
	assert.deepEqual(body.render(120), new Markdown(sanitizeTerminalText(hostile), 0, 0, getMarkdownTheme()).render(120));
	const text = sanitizeTerminalText(body.render(120).join("\n"));
	assert.match(text, /Sub-agent output \(untrusted data\):/);
	assert.match(text, /│.*Review/);
	assert.match(text, /│.*│.*quoted evidence/);
	assert.doesNotMatch(text, /\*\*Verdict|`src\/ui`|\u0007/);
	// Native Pi intentionally retains ### heading prefixes and styled code-fence borders.
	assert.match(body.render(120).join("\n"), /\u001b\[[^m]+m### /, "heading prefix has native styling");
	assert.match(text, /raw_code\(\)/);
});

test("one native component caches repeated content and reflows on resize without splitting Unicode", () => {
	const body = createReportBody(source, theme);
	const originalRender = Markdown.prototype.render;
	const seen = new Set<Markdown>();
	Markdown.prototype.render = function (width) { seen.add(this); return originalRender.call(this, width); };
	try {
		for (const width of [120, 120, 0, 1, 2, 3, 8, 16, 40, 120]) {
			const lines = body.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.every((line) => Array.from(line).every((point) => !/^[\uD800-\uDFFF]$/u.test(point))));
		}
		const reused = createReportBody(source, theme, {}, body);
		assert.equal(reused, body, "host lastComponent is reused for the same sanitized source");
		body.invalidate();
		assert.match(sanitizeTerminalText(body.render(120).join("\n")), /TAIL/);
		assert.equal(seen.size, 1, "resize, invalidation and repeated callbacks retain the native parser cache");
		assert.notEqual(createReportBody("new source", theme, {}, body), body);
	} finally { Markdown.prototype.render = originalRender; }
});

test("theme invalidation refreshes native Markdown colors and custom semantic background/padding", () => {
	const backgrounds: string[] = [];
	const custom = { ...theme, bg: (token: string, text: string) => { backgrounds.push(token); return text; } } as Theme;
	const body = createReportBody(source, custom, { background: "toolSuccessBg", padding: 3, header: () => "Trusted heading" });
	const dark = body.render(100);
	assert.match(sanitizeTerminalText(dark[0] ?? ""), /^   Trusted heading/);
	assert.ok(backgrounds.every((token) => token === "toolSuccessBg"));
	initTheme("light", false);
	try {
		body.invalidate();
		const light = body.render(100);
		assert.notDeepEqual(light, dark, "rendered native colors are not frozen in the component");
		assert.equal(sanitizeTerminalText(light.join("\n")), sanitizeTerminalText(dark.join("\n")));
	} finally { initTheme("dark", false); }
});
