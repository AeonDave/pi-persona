/**
 * Headless driver ("log mode") for self-testing pi-persona end-to-end.
 *
 * Runs `pi --mode json -p <prompt>` with a chosen persona/engine, parses the JSON
 * event stream, and prints a readable transcript — assistant text, tool calls
 * (delegate/council) with their args + results, and the final usage/cost — so a
 * developer or an automated harness can launch a prompt and SEE the outcome without
 * the interactive TUI. Uses the real model/auth (costs tokens); prefer a cheap
 * `--model` and short prompts for smoke tests.
 *
 * Usage:
 *   node --import tsx scripts/drive.ts [--persona magi] [--engine inproc] [--model claude-haiku-4-5] "your prompt"
 */
import { spawn } from "node:child_process";

type Json = Record<string, unknown>;

function parseArgs(argv: string[]): { persona?: string; engine?: string; model?: string; prompt: string } {
	const out: { persona?: string; engine?: string; model?: string; prompt: string } = { prompt: "" };
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--persona") out.persona = argv[++i];
		else if (a === "--engine") out.engine = argv[++i];
		else if (a === "--model") out.model = argv[++i];
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
	console.error('usage: drive.ts [--persona x] [--engine inproc] [--model m] "prompt"');
	process.exit(2);
}

const env = { ...process.env };
env.PI_PERSONA_DEBUG = "1"; // surfaces "[pi-persona] engine=…" so we can confirm the backend
if (opts.persona) env.PI_PERSONA_DEFAULT = opts.persona;
if (opts.engine) env.PI_PERSONA_ENGINE = opts.engine;

const args = ["--mode", "json", "-p"];
if (opts.model) args.push("--model", opts.model);
args.push(opts.prompt);

console.log(`▶ pi -p   persona=${opts.persona ?? "—"}  engine=${opts.engine ?? "inproc (default)"}  model=${opts.model ?? "default"}`);
console.log(`  prompt: ${short(opts.prompt, 120)}\n`);

// Spawn via the shell so Windows resolves `pi` → `pi.cmd`; quote each token so the
// prompt (spaces/quotes) survives re-parsing.
const win = process.platform === "win32";
const q = (s: string): string => `"${s.replace(/"/g, win ? '""' : '\\"')}"`;
const cmdline = ["pi", ...args].map(q).join(" ");
const proc = spawn(cmdline, { env, stdio: ["ignore", "pipe", "pipe"], shell: true });
let buf = "";
let finalUsage: Json | undefined;
let assistantTurns = 0;
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
	if (finalUsage) {
		const cost = (finalUsage.cost as Json | undefined)?.total ?? 0;
		console.log(
			`— turns=${assistantTurns} in=${finalUsage.input} out=${finalUsage.output} cacheW=${finalUsage.cacheWrite} ctx=${finalUsage.totalTokens} cost=$${Number(cost).toFixed(4)}  (${secs}s)`,
		);
	}
	if (code !== 0 && stderr.trim()) console.error(`[stderr] ${stderr.trim().slice(0, 600)}`);
	console.log(`▷ exit ${code}`);
	process.exit(code ?? 0);
});
