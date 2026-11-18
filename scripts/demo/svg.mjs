/**
 * Rasterises an SVG illustration to PNG with the same headless browser `render.mjs` uses, so text
 * is laid out once, here, rather than by each viewer's fonts. See `record.mjs` for DEMO_TOOLS.
 *
 *   DEMO_TOOLS=<tools> node scripts/demo/svg.mjs assets/workflow.svg assets/workflow.png
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [svgPath, pngPath] = process.argv.slice(2);
if (!svgPath || !pngPath || !process.env.DEMO_TOOLS) {
	console.error("usage: DEMO_TOOLS=<dir> node scripts/demo/svg.mjs <in.svg> <out.png>");
	process.exit(2);
}
const { chromium } = createRequire(join(resolve(process.env.DEMO_TOOLS), "package.json"))("playwright-core");
const svg = readFileSync(svgPath, "utf8");
const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg) ?? [];
if (!width) throw new Error(`${svgPath} needs a viewBox starting at 0 0`);
const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
await page.evaluate(() => document.fonts.ready);
await page.locator("svg").screenshot({ path: pngPath });
await browser.close();
console.log(`rendered ${width}x${height} -> ${pngPath}`);
