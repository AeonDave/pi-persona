/**
 * Records a scripted Pi session for a README demo: the real Pi TUI and this checkout's extension in
 * a pseudo-terminal, driven by scenario keystrokes, with every model response supplied by
 * `provider.mjs`. Writes a timed cast (JSON) that `render.mjs` turns into a GIF. Spends no tokens.
 *
 * The recorder's own dependencies are NOT repository dependencies. Install them in any scratch
 * directory and name it in DEMO_TOOLS (an optional `<DEMO_TOOLS>/bin` supplies `rg`/`fd`):
 *
 *   mkdir <tools> && cd <tools> && npm init -y
 *   npm i node-pty @xterm/xterm @xterm/addon-unicode11 playwright-core
 *   DEMO_TOOLS=<tools> DEMO_SANDBOX=<neutral dir> node scripts/demo/record.mjs <scenario> <out.cast.json>
 *   DEMO_TOOLS=<tools> node scripts/demo/render.mjs <out.cast.json> <out.gif>
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [scenarioName, outPath] = process.argv.slice(2);
if (!scenarioName || !outPath || !process.env.DEMO_TOOLS) {
	console.error("usage: DEMO_TOOLS=<dir> node scripts/demo/record.mjs <scenario> <out.cast.json>");
	process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const toolsDir = resolve(process.env.DEMO_TOOLS);
const pty = createRequire(join(toolsDir, "package.json"))("node-pty");
const scenarioFile = join(here, "scenarios", `${scenarioName}.mjs`);
const scenario = await import(pathToFileURL(scenarioFile).href);
const piCli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");

// A throwaway home: `~/<project>` in the footer, and no path to the real profile. Some tool output
// prints absolute paths, so DEMO_SANDBOX should name a neutral location (not under a user profile).
const sandbox = join(resolve(process.env.DEMO_SANDBOX ?? join(toolsDir, "sandbox")), scenarioName);
rmSync(sandbox, { recursive: true, force: true });
const home = join(sandbox, "home");
const agentDir = join(home, ".pi", "agent");
const project = join(home, scenario.project ?? "acme-api");
mkdirSync(agentDir, { recursive: true });
cpSync(join(here, "fixture"), project, { recursive: true });
const git = (...args) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", ...args], { cwd: project, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "initial");
// Install the bundled personas and agents up front: the first-run notice would print the sandbox path.
const { seedDefaults } = await import(pathToFileURL(join(repoRoot, "src", "core", "seed.ts")).href);
seedDefaults(repoRoot, join(agentDir, "persona"), false);
if (existsSync(join(toolsDir, "bin"))) cpSync(join(toolsDir, "bin"), join(agentDir, "bin"), { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
	extensions: [join(here, "provider.mjs"), join(repoRoot, "src", "extension.ts")],
	defaultProvider: "demo",
	defaultModel: scenario.model ?? "opus-5",
	defaultThinkingLevel: "medium",
	defaultProjectTrust: "always",
	quietStartup: true,
	retry: { enabled: false },
	compaction: { enabled: false },
	...scenario.settings,
}, null, "\t"));

const cols = scenario.cols ?? 110;
const rows = scenario.rows ?? 34;
const env = {
	...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PI_/i.test(key))),
	HOME: home, USERPROFILE: home,
	PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir,
	PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
	DEMO_SCENARIO: pathToFileURL(scenarioFile).href,
	TERM: "xterm-256color", COLORTERM: "truecolor", FORCE_COLOR: "3",
	...scenario.env,
};

const started = Date.now();
const now = () => Date.now() - started;
const events = [];
const panes = (scenario.panes ?? [{ args: scenario.args ?? [] }]).map((pane, index) => {
	const term = pty.spawn(process.execPath, [piCli, ...(pane.args ?? [])], { name: "xterm-256color", cols, rows, cwd: project, env: { ...env, ...pane.env } });
	const state = { term, buffer: "", exited: false };
	term.onData((data) => {
		state.buffer = (state.buffer + data).slice(-200_000);
		events.push({ t: now(), pane: index, data });
	});
	term.onExit(() => { state.exited = true; });
	return state;
});

const plain = (value) => value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_]/g, "");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let current = 0;
const api = {
	sleep,
	project,
	/** Select the pane that later keystrokes go to. */
	pane(index) { current = index; },
	key(sequence) { panes[current].term.write(sequence); },
	async type(value, { cps = 30 } = {}) {
		for (const char of value) {
			panes[current].term.write(char);
			await sleep(1000 / cps * (0.6 + Math.random() * 0.8));
		}
	},
	/** Wait until output on a pane matches; by default only output produced from now on. */
	async waitFor(pattern, { timeout = 60_000, pane = current, fresh = true } = {}) {
		const state = panes[pane];
		if (fresh) state.buffer = "";
		const deadline = Date.now() + timeout;
		while (!pattern.test(plain(state.buffer))) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern} on pane ${pane}: ${plain(state.buffer).slice(-1500)}`);
			await sleep(50);
		}
	},
	/** Caption shown under the terminal until replaced: `[F9]` is a key cap, text after ` -- ` is dimmed. */
	caption(value) { events.push({ t: now(), caption: value }); },
	/** Discard everything recorded so far (startup). */
	cut() { events.push({ t: now(), cut: true }); },
};

let failure;
try {
	for (const state of panes) await api.waitFor(scenario.ready ?? /opus-5/, { timeout: 45_000, pane: panes.indexOf(state), fresh: false });
	await scenario.run(api);
} catch (error) {
	failure = error;
}
const duration = now();
mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(outPath, JSON.stringify({ cols, rows, panes: panes.length, title: scenario.title ?? "pi", paneTitles: scenario.paneTitles, layout: scenario.layout ?? "row", duration, events }));
console.log(`${failure ? "FAILED" : "recorded"} ${scenarioName}: ${(duration / 1000).toFixed(1)}s, ${events.length} events -> ${outPath}`);
if (failure) console.error(failure.message);
// Leave by exiting: node-pty's Windows kill path spawns a helper that outlives a clean shutdown.
process.exit(failure ? 1 : 0);
