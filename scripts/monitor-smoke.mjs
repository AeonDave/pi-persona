/**
 * Persistent REAL-model monitor smoke test.
 *
 * This deliberately uses Pi's RPC mode so one supervisor can finish a turn, remain alive, and
 * receive the monitor event as a later automatic turn. It is a live verification harness and may
 * spend provider tokens: require LIVE_MODEL explicitly before doing any work.
 *
 * Run from PowerShell:
 *   $env:LIVE_MODEL='openai-codex/gpt-5.6-luna'; node --import tsx scripts/monitor-smoke.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { killProcessTree } from "../src/engine/child.ts";

const model = process.env.LIVE_MODEL?.trim();
if (!model) {
	console.error("monitor-smoke: refusing to spend tokens; set LIVE_MODEL=provider/id explicitly.");
	process.exit(2);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repoRoot, "src", "extension.ts");
const piIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = join(dirname(piIndex), "cli.js");
const marker = "MONITOR_SMOKE_EVENT_7f4a";
const deadlineMs = 120_000;
const maxStderrChars = 24_000;
const maxEventLog = 120;

const tempRoot = mkdtempSync(join(tmpdir(), "pi-persona-monitor-smoke-"));
const gatePath = join(tempRoot, "release-gate.txt");
const adapterPath = join(tempRoot, "monitor-adapter.mjs");

// The adapter has no shell, no network, and no model knowledge. It only emits the marker after
// the harness writes the gate following the first agent_end. A local timer poll avoids any
// dependence on the monitor process's own startup timing.
writeFileSync(
	adapterPath,
	["import { existsSync } from \"node:fs\";", "", "const gate = process.argv[2];", "const event = process.argv[3];", "const deadline = Date.now() + 90_000;", "function poll() {", "  if (existsSync(gate)) {", "    process.stdout.write(`${event}\\n`);", "    return;", "  }", "  if (Date.now() >= deadline) {", "    process.stderr.write(\"adapter gate deadline elapsed\\n\");", "    process.exitCode = 2;", "    return;", "  }", "  setTimeout(poll, 25);", "}", "poll();", ""].join("\n"),
	"utf8",
);

const prompt = [
	"This is a persistent monitor reliability smoke test. Follow the exact order below.",
	"1. Call timer with action=now first. This is a required fresh-clock check.",
	"2. Immediately call monitor with action=arm, mode=output, maxEvents=1, timeoutSeconds=45, and this exact local adapter:",
	`   command=${JSON.stringify(process.execPath)}`,
	`   args=${JSON.stringify([adapterPath, gatePath, marker])}`,
	"   label=RPC monitor smoke adapter",
	"3. After the monitor arm succeeds, end this turn. Do not call monitor list/cancel, do not poll, and do not use another tool.",
	`4. When the automatic monitor follow-up arrives, reply with a short acknowledgement containing the exact marker ${marker}.`,
	"The harness writes the adapter gate only after it observes the first agent_end, so the event must be generated after that completed turn. Keep this task isolated; do not delegate.",
].join("\n");

const env = {
	...process.env,
	PI_PERSONA_DEFAULT: "dev",
	PI_PERSONA_SEED: "off",
	PI_PERSONA_PERSIST: "off",
	PI_PERSONA_ENGINE: "inproc",
	PI_PERSONA_EXOCOM: "off",
	PI_PERSONA_BROKER: "off",
	PI_PERSONA_DELEGATE_DEFAULT: "off",
	PI_PERSONA_NUDGE: "off",
};

const args = [
	"--mode", "rpc",
	"--no-session",
	"--extension", extensionPath,
	"--model", model,
	"--thinking", "xhigh",
	"--tools", "read,bash,timer,monitor",
];

let child;
let lineBuffer = "";
let stderrTail = "";
let settled = false;
let firstAgentEndAt;
let gateWrittenAt;
let sourceMarkerAt;
let firstAgentEndCount = 0;
let agentStartCount = 0;
let timerNowSeen = false;
let monitorArmSeen = false;
let forbiddenMonitorAction;
let secondAssistantText = "";
let completeOutcome;
const eventLog = [];

function appendBounded(current, chunk, max) {
	const next = current + chunk;
	return next.length <= max ? next : next.slice(-max);
}

function short(value, max = 320) {
	let text;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	} catch {
		text = String(value);
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function contentText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? part.text : "")
		.join("");
}

function resultDetails(result) {
	return result && typeof result === "object" && result.details && typeof result.details === "object" ? result.details : undefined;
}

function isMonitorFollowUp(event) {
	if (event.type !== "message_start" && event.type !== "message_end") return false;
	const message = event.message;
	return message && typeof message === "object"
		&& message.role === "custom"
		&& message.customType === "pi-persona"
		&& typeof message.content === "string"
		&& message.content.includes(marker);
}

function record(event) {
	if (eventLog.length >= maxEventLog) eventLog.shift();
	eventLog.push({ type: event.type, tool: event.toolName, at: Date.now() });
}

function fail(reason) {
	if (settled) return;
	settled = true;
	throw new Error(reason);
}

function handleEvent(event) {
	if (!event || typeof event !== "object") return;
	record(event);
	if (event.type === "response" && event.success === false) fail(`RPC command failed: ${short(event.error ?? event)}`);
	if (event.type === "agent_start") {
		agentStartCount++;
		return;
	}
	if (event.type === "tool_execution_start" && event.toolName === "monitor") {
		const action = event.args && typeof event.args === "object" ? event.args.action : undefined;
		if (action === "list" || action === "cancel") forbiddenMonitorAction = action;
	}
	if (event.type === "tool_execution_end") {
		const details = resultDetails(event.result);
		if (event.toolName === "timer" && details?.action === "now" && details.ok === true && event.isError !== true) timerNowSeen = true;
		if (event.toolName === "monitor") {
			if (details?.ok === true && typeof details.id === "string" && !timerNowSeen) fail("monitor was armed before the required timer now check");
			if (details?.ok === true && typeof details.id === "string") monitorArmSeen = true;
			const action = event.args && typeof event.args === "object" ? event.args.action : undefined;
			if (action === "list" || action === "cancel") forbiddenMonitorAction = action;
		}
		return;
	}
	if (event.type === "message_update" && firstAgentEndAt !== undefined) {
		const update = event.assistantMessageEvent;
		if (update && typeof update === "object" && update.type === "text_delta" && typeof update.delta === "string") secondAssistantText += update.delta;
	}
	if (event.type === "message_end" && event.message && typeof event.message === "object" && event.message.role === "assistant" && firstAgentEndAt !== undefined) {
		secondAssistantText += contentText(event.message.content);
	}
	if (firstAgentEndAt !== undefined && sourceMarkerAt === undefined && isMonitorFollowUp(event)) {
		sourceMarkerAt = Date.now();
		if (sourceMarkerAt < (gateWrittenAt ?? Number.POSITIVE_INFINITY)) fail("monitor source event arrived before the harness wrote the post-agent_end gate");
	}
	if (event.type === "agent_end") {
		firstAgentEndCount++;
		if (firstAgentEndAt === undefined) {
			if (!timerNowSeen) fail("first agent_end arrived without a successful timer now call");
			if (!monitorArmSeen) fail("first agent_end arrived without a successful monitor arm");
			if (forbiddenMonitorAction) fail(`model polled monitor with forbidden action=${forbiddenMonitorAction}`);
			firstAgentEndAt = Date.now();
			writeFileSync(gatePath, "release after first agent_end\n", "utf8");
			gateWrittenAt = Date.now();
			console.log(`PASS — initial agent_end observed; gate written at ${gatePath}`);
			return;
		}
		if (sourceMarkerAt === undefined) fail("second agent_end arrived without an automatic monitor event marker");
		if (!secondAssistantText.includes(marker)) fail(`second model turn did not acknowledge exact marker ${marker}`);
		settled = true;
		try { child?.stdin?.end(); } catch { /* close below still owns the result */ }
		completeOutcome?.();
		return;
	}
}

function feedStdout(chunk) {
	lineBuffer = appendBounded(lineBuffer, chunk, 1_000_000);
	let newline;
	while ((newline = lineBuffer.indexOf("\n")) >= 0) {
		const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
		lineBuffer = lineBuffer.slice(newline + 1);
		if (!line.trim()) continue;
		handleEvent(JSON.parse(line));
	}
}

function send(command) {
	if (!child?.stdin?.writable) throw new Error("RPC stdin is not writable");
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

async function waitForOutcome() {
	return await new Promise((resolve, reject) => {
		completeOutcome = resolve;
		let finished = false;
		let timeout;
		const finish = (error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			if (error) reject(error);
			else resolve();
		};
		timeout = setTimeout(() => finish(new Error(`monitor smoke exceeded ${deadlineMs}ms`)), deadlineMs);
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

async function main() {
	console.log(`▶ monitor-smoke model=${model} thinking=xhigh`);
	console.log(`  temp cwd=${tempRoot}`);
	child = spawn(process.execPath, [piCli, ...args], {
		cwd: tempRoot,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stdin.setDefaultEncoding("utf8");
	const outcome = waitForOutcome();
	if (child.exitCode !== null) throw new Error(`Pi exited during startup (code=${child.exitCode})`);
	send({ type: "prompt", message: prompt });
	await outcome;
	if (agentStartCount < 2 || firstAgentEndCount < 2 || sourceMarkerAt === undefined || gateWrittenAt === undefined || sourceMarkerAt < gateWrittenAt) {
		throw new Error("monitor smoke ended without proving the post-agent_end automatic event ordering");
	}
	console.log(`PASS — timer now → monitor arm → initial agent_end → ${marker} → second agent_end`);
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

try {
	await main();
	process.exitCode = 0;
} catch (error) {
	console.error(`FAIL — ${error instanceof Error ? error.message : String(error)}`);
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
