/**
 * Persistent REAL-model smoke test for the interactive wake contract:
 * launch -> end the turn -> exactly ONE automatic completion wake -> no polling in between.
 *
 * Uses Pi's RPC mode (an interactive session: `ctx.hasUI === true`, so `delegate` runs in the
 * background) so one supervisor can finish a turn, stay alive, and receive the completion as a
 * later automatic turn. It spends provider tokens: LIVE_MODEL must be set explicitly.
 *
 * Usage:
 *   LIVE_MODEL=<provider/id> node --import tsx scripts/wake-smoke.mjs [--scout-model <provider/id>]
 *
 * Run from PowerShell:
 *   $env:LIVE_MODEL='claude-pro-max-native/claude-opus-4-8'; npm run smoke:wake
 *
 * Asserts (exit 0 on PASS, 1 on FAIL, 2 on usage / refusal):
 *   1. the supervisor launches ONE `delegate` call with a 3-entry `tasks` array (haiku-pinned scouts);
 *   2. that turn ends (agent_end) before any completion arrives;
 *   3. exactly ONE completion wake arrives, and it carries all three scout results;
 *   4. no `timer`, `intercom` peek/result/wait, or sleep-like `bash` call happens before the wake;
 *   5. launch -> wake takes at most 120 s;
 *   6. no second completion wake arrives during a short grace window after the wake turn ends.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { killProcessTree } from "../src/engine/child.ts";
import { appendBounded, contentText, jsonLineReader, sendCommand, short } from "./lib/rpc-smoke.mjs";
import { coerceWakeSmokeDelegateTasks } from "./lib/wake-smoke.ts";

const USAGE = "usage: LIVE_MODEL=<provider/id> node --import tsx scripts/wake-smoke.mjs [--scout-model <provider/id>]";
const DEFAULT_SCOUT_MODEL = "claude-pro-max-native/claude-haiku-4-5";

function parseArgs(argv) {
	let scoutModel = DEFAULT_SCOUT_MODEL;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") return { help: true };
		if (arg !== "--scout-model") return { error: `unknown argument ${JSON.stringify(arg)}` };
		scoutModel = argv[++i]?.trim() ?? "";
		if (!scoutModel.includes("/")) return { error: "--scout-model must be provider-qualified (provider/id)" };
	}
	return { scoutModel };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
	console.log(USAGE);
	process.exit(0);
}
if (parsed.error) {
	console.error(`wake-smoke: ${parsed.error}\n${USAGE}`);
	process.exit(2);
}
const { scoutModel } = parsed;

const model = process.env.LIVE_MODEL?.trim();
if (!model) {
	console.error(`wake-smoke: refusing to spend tokens; set LIVE_MODEL=provider/id explicitly.\n${USAGE}`);
	process.exit(2);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repoRoot, "src", "extension.ts");
const piIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = join(dirname(piIndex), "cli.js");
const markers = ["WAKE_SMOKE_A_3c1f", "WAKE_SMOKE_B_9d42", "WAKE_SMOKE_C_e07b"];
const deadlineMs = 300_000;
const maxWakeMs = 120_000;
const graceMs = 4_000;
const maxStderrChars = 24_000;
const maxEventLog = 160;
const SLEEP_LIKE = /\b(sleep|start-sleep|timeout|ping|choice)\b|settimeout/i;

// Project-local fixtures: a fresh install has no agents or personas, so the temp project carries
// the bundled scout (pinned to the haiku model) and a minimal brief-free persona.
const tempRoot = mkdtempSync(join(tmpdir(), "pi-persona-wake-smoke-"));
const agentsDir = join(tempRoot, ".pi", "agents");
mkdirSync(agentsDir, { recursive: true });
cpSync(join(repoRoot, "agents", "scout.md"), join(agentsDir, "scout.md"));
const scoutFile = join(agentsDir, "scout.md");
writeFileSync(scoutFile, readFileSync(scoutFile, "utf8").replace(/^---\r?\n/, `---\nmodel: ${scoutModel}\n`), "utf8");
writeFileSync(
	join(agentsDir, "waker.md"),
	["---", "name: waker", "persona: true", "description: Wake-contract smoke supervisor.", "systemPromptMode: append", "---", "You are a minimal supervisor. Delegate as instructed, then end your turn.", ""].join("\n"),
	"utf8",
);

const prompt = [
	"This is an interactive wake-contract smoke test. Follow the exact order below.",
	"1. Make ONE delegate call with a tasks array of exactly 3 entries, all agent=scout, no top-level task. Entry i task (verbatim):",
	...markers.map((m, i) => `   tasks[${i}].task = "Use no tools. Reply with exactly this token and nothing else: ${m}"  (name: scout-${i + 1})`),
	"2. As soon as the delegate call returns its run ids, end this turn. Do NOT peek, do NOT call intercom, do NOT arm a timer, do NOT sleep or poll with bash, and do not use any other tool.",
	"3. When the single automatic completion follow-up arrives, reply with one short line listing the three tokens you received.",
].join("\n");

const env = {
	...process.env,
	PI_PERSONA_DEFAULT: "waker",
	PI_PERSONA_SEED: "off",
	PI_PERSONA_PERSIST: "off",
	PI_PERSONA_ENGINE: "inproc",
	PI_PERSONA_EXOCOM: "off",
	PI_PERSONA_BROKER: "off",
	PI_PERSONA_NUDGE: "off",
};

const args = [
	"--mode", "rpc",
	"--no-session",
	"--extension", extensionPath,
	"--model", model,
	"--thinking", "low",
	"--tools", "read,bash,delegate,intercom,timer",
];

const startedAt = Date.now();
let child;
let stderrTail = "";
let settled = false;
let finishOutcome;
let graceTimer;
let launchEndAt;
let firstAgentEndAt;
let wakeAt;
let wakeAgentEndAt;
let delegateCalls = 0;
let launchedLegs = 0;
let delegateArgumentError;
const wakes = [];
const forbidden = [];
const sequence = [];
const eventLog = [];

const stamp = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const note = (text) => sequence.push(`${stamp()} ${text}`);

const messageText = (content) => (typeof content === "string" ? content : contentText(content));

// The completion wake is a custom `pi-persona` message whose head reads "N async run(s) settled".
function isWake(message) {
	return message && typeof message === "object"
		&& message.role === "custom"
		&& message.customType === "pi-persona"
		&& /async runs? settled/.test(messageText(message.content));
}

function forbiddenCall(event) {
	const input = event.args && typeof event.args === "object" ? event.args : {};
	if (event.toolName === "timer") return `timer ${short(input.action ?? "", 40)}`.trim();
	if (event.toolName === "intercom" && ["peek", "result", "wait"].includes(input.action)) return `intercom ${input.action}`;
	if ((event.toolName === "bash" || event.toolName === "powershell") && typeof input.command === "string" && SLEEP_LIKE.test(input.command)) {
		return `${event.toolName} ${short(input.command, 80)}`;
	}
	return undefined;
}

function delegateArgsShape(args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return `root=${Array.isArray(args) ? "array" : typeof args}`;
	const keys = Object.keys(args).slice(0, 12);
	const typeOf = (value) => Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
	const types = keys.map((key) => `${key}:${typeOf(args[key])}`).join(",");
	const tasks = args.tasks;
	const tasksShape = typeof tasks === "string"
		? `string(${tasks.length} chars)`
		: Array.isArray(tasks)
			? `array(${tasks.length})[${tasks.slice(0, 3).map((task) => task && typeof task === "object" ? `object{${Object.keys(task).slice(0, 8).join(",")}}` : typeOf(task)).join(";")}]`
			: typeOf(tasks);
	return `keys=[${keys.join(",")}], types={${types}}, tasks=${tasksShape}`;
}

function fail(reason) {
	if (settled) return;
	settled = true;
	throw new Error(reason);
}

function done() {
	if (settled) return;
	settled = true;
	try { child?.stdin?.end(); } catch { /* close below still owns the result */ }
	finishOutcome?.();
}

function handleEvent(event) {
	if (!event || typeof event !== "object") return;
	if (eventLog.length >= maxEventLog) eventLog.shift();
	eventLog.push({ type: event.type, tool: event.toolName, at: stamp() });
	if (event.type === "response" && event.success === false) fail(`RPC command failed: ${short(event.error ?? event)}`);

	if (event.type === "tool_execution_start") {
		if (event.toolName === "delegate") {
			delegateCalls++;
			const normalized = coerceWakeSmokeDelegateTasks(event.args);
			if (!normalized.ok) {
				launchedLegs = 0;
				note(`delegate args could not be normalized: ${short(normalized.error, 180)}`);
			} else {
				launchedLegs = normalized.tasks.length;
				const scouts = normalized.tasks.filter((task) => task.agent === "scout").length;
				const taskMarkers = markers.filter((marker, index) => normalized.tasks[index]?.task?.includes(marker)).length;
				note(`delegate args shape: ${delegateArgsShape(event.args)}; normalized tasks=${launchedLegs}, scouts=${scouts}, markers=${taskMarkers}`);
				if (scouts !== launchedLegs) delegateArgumentError = `expected scout tasks, found ${launchedLegs - scouts} non-scout task(s)`;
				if (taskMarkers !== markers.length) delegateArgumentError ??= `expected all ${markers.length} markers in task briefs, found ${taskMarkers}`;
			}
			note(`delegate tasks[${launchedLegs}]`);
		}
		const bad = wakeAt === undefined ? forbiddenCall(event) : undefined;
		if (bad) {
			forbidden.push(bad);
			note(`FORBIDDEN before wake: ${bad}`);
		}
		return;
	}
	if (event.type === "tool_execution_end" && event.toolName === "delegate" && launchEndAt === undefined) {
		if (event.isError === true) fail(`delegate launch failed: ${short(event.result)}`);
		launchEndAt = Date.now();
		note("delegate returned (background launch)");
		return;
	}
	if ((event.type === "message_start" || event.type === "message_end") && isWake(event.message)) {
		// One wake per message: a start/end pair is one; an unpaired end is one too.
		let current = wakes.at(-1);
		if (event.type === "message_start" || !current?.open) {
			current = { at: Date.now(), text: "", open: true };
			wakes.push(current);
			wakeAt ??= current.at;
			note(`completion wake #${wakes.length}`);
		}
		if (event.type === "message_end") {
			current.text = messageText(event.message.content);
			current.open = false;
		}
		return;
	}
	if (event.type === "agent_end") {
		if (firstAgentEndAt === undefined) {
			firstAgentEndAt = Date.now();
			note("agent_end (launch turn)");
			if (wakeAt !== undefined) fail("a completion wake arrived before the launch turn ended");
			return;
		}
		if (wakeAt !== undefined && wakeAgentEndAt === undefined) {
			wakeAgentEndAt = Date.now();
			note(`agent_end (wake turn); watching ${graceMs}ms for a stray second wake`);
			graceTimer = setTimeout(done, graceMs);
		}
	}
}

const feedStdout = jsonLineReader((event) => handleEvent(event));
const send = (command) => sendCommand(child, command);

async function waitForOutcome() {
	return await new Promise((resolveOutcome, reject) => {
		finishOutcome = resolveOutcome;
		let finished = false;
		const finish = (error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			clearTimeout(graceTimer);
			if (error) reject(error);
			else resolveOutcome();
		};
		const timeout = setTimeout(() => finish(new Error(`wake smoke exceeded ${deadlineMs}ms without finishing (wakes=${wakes.length})`)), deadlineMs);
		child.on("error", (error) => finish(error));
		child.on("close", (code, signal) => {
			if (settled) finish(undefined);
			else finish(new Error(`Pi RPC exited before verification (code=${code ?? "null"}, signal=${signal ?? "none"})`));
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			try { feedStdout(String(chunk)); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderrTail = appendBounded(stderrTail, String(chunk), maxStderrChars); });
	});
}

function verify() {
	if (delegateCalls !== 1) throw new Error(`expected exactly 1 delegate call, saw ${delegateCalls}`);
	if (delegateArgumentError) throw new Error(delegateArgumentError);
	if (launchedLegs !== 3) throw new Error(`expected a 3-leg tasks fan-out, saw ${launchedLegs} legs`);
	if (wakes.length !== 1) throw new Error(`expected exactly ONE completion wake, saw ${wakes.length}`);
	const missing = markers.filter((m) => !wakes[0].text.includes(m));
	if (missing.length > 0) throw new Error(`the wake is missing scout result(s): ${missing.join(", ")}`);
	if (forbidden.length > 0) throw new Error(`polling before the wake: ${forbidden.join("; ")}`);
	const elapsed = (wakes[0].at - (launchEndAt ?? startedAt));
	if (elapsed > maxWakeMs) throw new Error(`launch -> wake took ${elapsed}ms (limit ${maxWakeMs}ms)`);
	return elapsed;
}

async function stopChild() {
	if (!child || child.exitCode !== null || child.pid === undefined) return;
	try { killProcessTree(child.pid); } catch { /* best effort */ }
	await new Promise((resolveStopped) => {
		const timer = setTimeout(resolveStopped, 2_000);
		child.once("close", () => {
			clearTimeout(timer);
			resolveStopped();
		});
	});
}

async function main() {
	console.log(`▶ wake-smoke supervisor=${model} scouts=${scoutModel} maxWakeMs=${maxWakeMs}`);
	console.log(`  temp cwd=${tempRoot}`);
	child = spawn(process.execPath, [piCli, ...args], { cwd: tempRoot, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	child.stdin.setDefaultEncoding("utf8");
	const outcome = waitForOutcome();
	send({ type: "prompt", message: prompt });
	await outcome;
	const elapsed = verify();
	console.log(`PASS — one wake with all 3 results, ${elapsed}ms after launch, no peek/result/timer/sleep before it`);
	console.log(`sequence:\n  ${sequence.join("\n  ")}`);
}

try {
	await main();
	process.exitCode = 0;
} catch (error) {
	console.error(`FAIL — ${error instanceof Error ? error.message : String(error)}`);
	console.error(`sequence:\n  ${sequence.join("\n  ") || "(no events)"}`);
	if (stderrTail.trim()) console.error(`stderr (bounded): ${stderrTail.trim()}`);
	console.error(`events (bounded): ${short(eventLog, 4_000)}`);
	process.exitCode = 1;
} finally {
	await stopChild();
	try {
		rmSync(tempRoot, { recursive: true, force: true });
	} catch (error) {
		console.error(`cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
	}
}
