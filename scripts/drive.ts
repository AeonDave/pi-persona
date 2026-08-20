/**
 * Headless driver ("log mode") for self-testing pi-persona end-to-end.
 *
 * Runs `pi --mode json -p <prompt>` with a chosen persona/engine, parses the JSON
 * event stream, and prints a readable transcript — assistant text, tool calls
 * (delegate/council) with their args + results, and the final usage/cost — so a
 * developer or an automated harness can launch a prompt and SEE the outcome without
 * the interactive TUI. Uses the real model/auth (costs tokens); prefer a cheap
 * `--model` and short prompts for smoke tests.
 * NOTE: delegation-reflex behavior is capability-sensitive — smoke-test plumbing with a cheap
 * model, but EVALUATE persona/delegation behavior with a mid-tier or better SUPERVISOR model
 * (workers can stay cheap via roster/member `model` pins in teams.yaml).
 *
 * Usage:
 *   node --import tsx scripts/drive.ts [--persona magi] [--engine inproc] [--model claude-pro-max-native/claude-haiku-4-5] [--thinking xhigh] [--tools read,grep,find,ls,delegate] "your prompt"
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { effectiveDriveExitCode, terminalAssistantError } from "./drive-status.ts";

type Json = Record<string, unknown>;

interface DriveOptions {
	persona?: string;
	engine?: string;
	model?: string;
	thinking?: string;
	tools?: string;
	prompt: string;
}

function parseArgs(argv: string[]): DriveOptions {
	const out: DriveOptions = { prompt: "" };
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--persona") out.persona = argv[++i];
		else if (a === "--engine") out.engine = argv[++i];
		else if (a === "--model") out.model = argv[++i];
		else if (a === "--thinking") out.thinking = argv[++i];
		else if (a === "--tools") out.tools = argv[++i];
		else rest.push(a);
	}
	out.prompt = rest.join(" ");
	return out;
}

function short(v: unknown, n = 90): string {
	const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** Text from an assistant message's content array (first text part). */
function firstText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const p of content) {
		if (p && typeof p === "object" && (p as Json).type === "text" && typeof (p as Json).text === "string") return (p as Json).text as string;
	}
	return "";
}

/** Readable text from a tool result (its content text, else a compact JSON). */
function resultText(result: unknown): string {
	if (result && typeof result === "object") {
		const content = (result as Json).content;
		if (Array.isArray(content)) {
			const t = content.map((c) => (c && typeof c === "object" && (c as Json).type === "text" ? String((c as Json).text ?? "") : "")).join("").trim();
			if (t) return t;
		}
	}
	return short(result, 160);
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.prompt) {
	console.error('usage: drive.ts [--persona x] [--engine inproc] [--model provider/id] [--thinking level] [--tools names] "prompt"');
	process.exit(2);
}

const env = { ...process.env };
env.PI_PERSONA_DEBUG = "1"; // surfaces "[pi-persona] engine=…" so we can confirm the backend
if (opts.persona) env.PI_PERSONA_DEFAULT = opts.persona;
if (opts.engine) env.PI_PERSONA_ENGINE = opts.engine;

// The prompt is delivered over STDIN, never argv: `pi -p` reads piped stdin as the
// prompt, which sidesteps shell re-quoting entirely. Passing it as an argv token and
// rebuilding a `shell: true` cmdline truncated multi-line prompts on Windows (cmd.exe
// treats an embedded newline as a command separator) — a harness-only bug that faked
// "your message was cut off" from the model. stdin has no such limit or length cap.
const args = ["--mode", "json", "-p", "--no-session"];
if (opts.model) args.push("--model", opts.model);
if (opts.thinking) args.push("--thinking", opts.thinking);
if (opts.tools) args.push("--tools", opts.tools);

console.log(`▶ pi -p   persona=${opts.persona ?? "—"}  engine=${opts.engine ?? "inproc (default)"}  model=${opts.model ?? "default"}  thinking=${opts.thinking ?? "default"}`);
console.log(`  prompt: ${short(opts.prompt, 120)}\n`);

// Invoke Pi's installed JS entry directly through this Node runtime. This avoids both the Windows
// `.cmd`/shell quoting path and PATH drift to a different global Pi. The prompt remains on stdin.
const piIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = join(dirname(piIndex), "cli.js");
const proc = spawn(process.execPath, [piCli, ...args], {
	env,
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
});
let spawnError: string | undefined;
// `spawn()` reports launch failures asynchronously. Without this listener Windows turns a
// missing/inaccessible runtime into an uncaught exception instead of a clean smoke-test failure.
proc.on("error", (error) => {
	spawnError = error instanceof Error ? error.message : String(error);
});
proc.stdin.on("error", () => {
	// A provider/process may terminate before consuming stdin; `close` below owns the diagnosis.
});
proc.stdin.setDefaultEncoding("utf8");
proc.stdin.write(opts.prompt);
proc.stdin.end();
let buf = "";
let finalUsage: Json | undefined;
let assistantTurns = 0;
let assistantError: string | undefined;
const t0 = Date.now();

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (d: string) => {
	buf += d;
	const lines = buf.split("\n");
	buf = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let ev: Json;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		switch (ev.type) {
			case "tool_execution_start":
				console.log(`  → ${ev.toolName} ${short(ev.args)}`);
				break;
			case "tool_execution_end":
				console.log(`  ← ${ev.toolName}${ev.isError ? " [error]" : ""}: ${short(resultText(ev.result), 200)}`);
				break;
			case "message_end": {
				const m = ev.message as Json | undefined;
				if (m && m.role === "assistant") {
					assistantError = terminalAssistantError(m) ?? assistantError;
					const t = firstText(m.content);
					if (t.trim()) {
						assistantTurns++;
						console.log(`\n  💬 ${t.trim()}\n`);
					}
					if (m.usage) finalUsage = m.usage as Json;
				}
				break;
			}
		}
	}
});

let stderr = "";
let errBuf = "";
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d: string) => {
	stderr += d;
	// Surface pi-persona debug lines (e.g. the engine choice) as they arrive.
	errBuf += d;
	const lines = errBuf.split("\n");
	errBuf = lines.pop() ?? "";
	for (const l of lines) if (l.includes("[pi-persona]")) console.log(`  ${l.trim()}`);
});

proc.on("close", (code: number | null) => {
	const secs = ((Date.now() - t0) / 1000).toFixed(1);
	const exitCode = effectiveDriveExitCode(code, assistantError ?? spawnError);
	if (finalUsage) {
		const cost = (finalUsage.cost as Json | undefined)?.total ?? 0;
		console.log(
			`— turns=${assistantTurns} in=${finalUsage.input} out=${finalUsage.output} cacheW=${finalUsage.cacheWrite} ctx=${finalUsage.totalTokens} cost=$${Number(cost).toFixed(4)}  (${secs}s)`,
		);
	}
	if (assistantError) console.error(`[assistant error] ${short(assistantError, 600)}`);
	if (spawnError) console.error(`[spawn error] ${short(spawnError, 600)}`);
	if (code !== 0 && stderr.trim()) console.error(`[stderr] ${stderr.trim().slice(0, 600)}`);
	console.log(`▷ exit ${exitCode}`);
	process.exit(exitCode);
});
