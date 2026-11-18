/**
 * Renders a cast written by `record.mjs` to an animated GIF, or to an MP4 when the output name
 * ends in `.mp4`: replays the terminal bytes through xterm.js in a headless browser, screenshots
 * each changed frame, and assembles them with ffmpeg.
 * See `record.mjs` for DEMO_TOOLS. Requires `ffmpeg` on PATH and an installed Edge or Chrome.
 *
 *   DEMO_TOOLS=<tools> node scripts/demo/render.mjs <in.cast.json> <out.gif|out.mp4> [--still <ms> <out.png>]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const [castPath, outPath, ...rest] = process.argv.slice(2);
if (!castPath || !outPath || !process.env.DEMO_TOOLS) {
	console.error("usage: DEMO_TOOLS=<dir> node scripts/demo/render.mjs <in.cast.json> <out.gif|out.mp4> [--still <ms> <out.png>]");
	process.exit(2);
}
const stills = [];
for (let i = 0; i < rest.length; i++) if (rest[i] === "--still") stills.push({ at: Number(rest[++i]), path: rest[++i] });

const toolsDir = resolve(process.env.DEMO_TOOLS);
const tools = createRequire(join(toolsDir, "package.json"));
const { chromium } = tools("playwright-core");
const cast = JSON.parse(readFileSync(castPath, "utf8"));
const FPS = Number(process.env.DEMO_FPS ?? 12);
const FONT_SIZE = Number(process.env.DEMO_FONT_SIZE ?? 14);

// Everything before the last `cut` is startup noise: replay it instantly, record nothing.
const cutAt = cast.events.findLast((event) => event.cut)?.t ?? 0;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: #070a12; }
#stage { display: inline-flex; flex-direction: column; gap: 14px; padding: 22px 22px 18px; background: #070a12; }
#panes { display: flex; gap: 16px; }
.window { border-radius: 11px; overflow: hidden; background: #0d1117; border: 1px solid #263043; box-shadow: 0 0 0 1px #00000080; }
.bar { height: 32px; display: flex; align-items: center; padding: 0 13px; background: #161b26; border-bottom: 1px solid #263043; font: 500 12.5px "Segoe UI", system-ui, sans-serif; color: #8b96aa; }
.dot { width: 11px; height: 11px; border-radius: 50%; margin-right: 7px; }
.title { flex: 1; text-align: center; margin-right: 54px; letter-spacing: .02em; }
.screen { padding: 10px 12px 12px; }
#caption { height: 34px; display: flex; align-items: center; justify-content: center; gap: 12px; font: 600 15px "Segoe UI", system-ui, sans-serif; color: #c9d4e8; }
#caption kbd { font: 700 13px "Cascadia Mono", Consolas, monospace; color: #0b1020; background: #7dd3fc; border-radius: 6px; padding: 3px 9px; }
#caption .dim { color: #7c88a0; font-weight: 500; }
/* Text-presentation symbols the terminal font lacks: a monochrome face, not the wide emoji one. */
@font-face { font-family: "Demo Symbols"; src: local("Segoe UI Symbol"); unicode-range: U+2139, U+2299, U+2699, U+2714, U+2716, U+25C6; }
.xterm-viewport { overflow: hidden !important; }
</style></head><body><div id="stage"><div id="panes"></div><div id="caption"></div></div></body></html>`;

const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER ?? "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 2400, height: 1500 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.addStyleTag({ path: tools.resolve("@xterm/xterm/css/xterm.css") });
await page.addScriptTag({ path: tools.resolve("@xterm/xterm/lib/xterm.js") });
await page.addScriptTag({ path: tools.resolve("@xterm/addon-unicode11/lib/addon-unicode11.js") });
await page.evaluate(async ({ cast, fontSize }) => {
	await document.fonts.ready;
	window.terms = [];
	document.getElementById("panes").style.flexDirection = cast.layout;
	for (let index = 0; index < cast.panes; index++) {
		const title = cast.paneTitles?.[index] ?? cast.title;
		const frame = document.createElement("div");
		frame.className = "window";
		frame.innerHTML = `<div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title"></span></div><div class="screen"></div>`;
		frame.querySelector(".title").textContent = title;
		document.getElementById("panes").append(frame);
		const term = new Terminal({
			cols: cast.cols, rows: cast.rows, fontSize, lineHeight: 1.0, letterSpacing: 0,
			fontFamily: '"Demo Symbols", "Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Emoji", monospace',
			allowProposedApi: true, cursorBlink: false, cursorInactiveStyle: "none", scrollback: 0,
			theme: {
				background: "#0d1117", foreground: "#d5dbe6", cursor: "#0d1117", cursorAccent: "#0d1117",
				black: "#1b2230", red: "#ff7b72", green: "#56d364", yellow: "#e3b341", blue: "#6cb6ff", magenta: "#bc8cff", cyan: "#5ad7e6", white: "#c9d1d9",
				brightBlack: "#6e7a8f", brightRed: "#ffa198", brightGreen: "#7ee787", brightYellow: "#f2cc60", brightBlue: "#8ccbff", brightMagenta: "#d2a8ff", brightCyan: "#8be9f5", brightWhite: "#f0f6fc",
			},
		});
		term.loadAddon(new Unicode11Addon.Unicode11Addon());
		term.unicode.activeVersion = "11";
		term.open(frame.querySelector(".screen"));
		window.terms.push(term);
	}
	window.feed = (pane, data) => new Promise((done) => window.terms[pane].write(data, done));
	window.setCaption = (value) => {
		const node = document.getElementById("caption");
		node.textContent = "";
		// `[F9]` renders as a key cap; the text after ` -- ` is dimmed.
		const [main, dim] = value.split(" -- ");
		for (const part of main.split(/(\[[^\]]+\])/)) {
			if (!part) continue;
			const key = /^\[(.+)\]$/.exec(part);
			const element = document.createElement(key ? "kbd" : "span");
			element.textContent = key ? key[1] : part;
			node.append(element);
		}
		if (dim) { const element = document.createElement("span"); element.className = "dim"; element.textContent = dim; node.append(element); }
	};
}, { cast, fontSize: FONT_SIZE });

const stage = page.locator("#stage");
const framesDir = join(toolsDir, "frames", createHash("sha1").update(resolve(outPath)).digest("hex").slice(0, 10));
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const frames = [];
let cursor = 0;
let lastHash = "";
async function advance(until) {
	let changed = false;
	while (cursor < cast.events.length && cast.events[cursor].t <= until) {
		const event = cast.events[cursor++];
		if (event.data !== undefined) await page.evaluate(([pane, data]) => window.feed(pane, data), [event.pane, event.data]);
		else if (event.caption !== undefined) await page.evaluate((value) => window.setCaption(value), event.caption);
		changed = true;
	}
	return changed;
}
await advance(cutAt);
const step = 1000 / FPS;
for (let t = cutAt; t <= cast.duration + step; t += step) {
	const changed = await advance(t);
	const still = stills.find((entry) => !entry.done && t - cutAt >= entry.at);
	if (still) { still.done = true; await stage.screenshot({ path: still.path }); }
	if (!changed && frames.length > 0) { frames.at(-1).duration += step; continue; }
	const png = await stage.screenshot();
	const hash = createHash("sha1").update(png).digest("hex");
	if (hash === lastHash) { frames.at(-1).duration += step; continue; }
	lastHash = hash;
	const file = join(framesDir, `${String(frames.length).padStart(5, "0")}.png`);
	writeFileSync(file, png);
	frames.push({ file, duration: step });
}
await browser.close();
if (frames.length === 0) throw new Error("no frames rendered");
// Hold the final frame so the loop does not snap back mid-read.
frames.at(-1).duration += Number(process.env.DEMO_TAIL_MS ?? 2500);

const list = join(framesDir, "frames.txt");
const posix = (path) => path.replaceAll("\\", "/");
writeFileSync(list, frames.map((frame) => `file '${posix(frame.file)}'\nduration ${(frame.duration / 1000).toFixed(3)}`).join("\n") + `\nfile '${posix(frames.at(-1).file)}'\n`);
mkdirSync(dirname(resolve(outPath)), { recursive: true });
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
const total = frames.reduce((sum, frame) => sum + frame.duration, 0);
if (outPath.toLowerCase().endsWith(".mp4")) {
	// A constant-rate H.264 file with even dimensions plays in every gallery and browser. The
	// concat demuxer stretches its closing frame, so the length is stated.
	ffmpeg("-f", "concat", "-safe", "0", "-i", list, "-t", (total / 1000).toFixed(3), "-vf", "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-crf", "24", "-movflags", "+faststart", outPath);
} else {
	const palette = join(framesDir, "palette.png");
	ffmpeg("-f", "concat", "-safe", "0", "-i", list, "-vf", "palettegen=max_colors=128:stats_mode=diff", palette);
	ffmpeg("-f", "concat", "-safe", "0", "-i", list, "-i", palette, "-lavfi", "paletteuse=dither=none:diff_mode=rectangle", "-fps_mode", "vfr", outPath);
}
console.log(`rendered ${frames.length} frames, ${(total / 1000).toFixed(1)}s -> ${outPath}`);
