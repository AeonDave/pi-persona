// Fake `pi --mode json -p` for engine plumbing tests — no LLM, deterministic.
// The task arrives over STDIN (like the real engine sends it — argv carries only
// flags); behaviour is keyed off its content:
//   contains "[sleep]" -> hang forever (so the test can abort it)
//   contains "[fail]"  -> emit an error stop reason
//   otherwise          -> emit a normal assistant message_end echoing the task
const args = process.argv.slice(2);
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let stdinData = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
	stdinData += d;
});
process.stdin.on("end", () => run(stdinData || (args[args.length - 1] ?? "")));

function run(task) {
	if (task.includes("[sleep]")) {
		setInterval(() => {}, 1000); // keep the process alive until killed
	} else if (task.includes("[ignore-term]")) {
		process.on("SIGTERM", () => {}); // refuse graceful termination → forces the SIGKILL escalation
		setInterval(() => {}, 1000);
	} else if (task.includes("[drip]")) {
		// Emit an event IMMEDIATELY (so node's boot latency can't eat the caller's idle
		// window under parallel-suite load), then every 150ms a few times (total > a short
		// idle window, each gap < it), then finish — exercises the idle-timeout reset (an
		// active child must NOT be killed).
		emit({ type: "turn_start" });
		let n = 0;
		const iv = setInterval(() => {
			n += 1;
			emit({ type: "turn_start" });
			if (n >= 4) {
				clearInterval(iv);
				emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						model: "stub/model",
						stopReason: "end",
						usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 },
					},
				});
				process.exit(0);
			}
		}, 150);
	} else if (task.includes("[spew-stderr]")) {
		process.stderr.write("E".repeat(500000)); // flood stderr to exercise the retention cap
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				model: "stub/model",
				stopReason: "end",
				usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 },
			},
		});
		process.exit(0);
	} else if (task.includes("[fail]")) {
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "stub failure",
				usage: { input: 1, output: 0, cost: { total: 0 }, totalTokens: 1 },
			},
		});
		process.exit(0);
	} else if (task.includes("[env]")) {
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `PI_PERSONA_DISABLE=${process.env.PI_PERSONA_DISABLE ?? "unset"} PI_PERSONA_CHILD=${process.env.PI_PERSONA_CHILD ?? "unset"} PI_PERSONA_LEG=${process.env.PI_PERSONA_LEG ?? "unset"} PI_PERSONA_BUS=${process.env.PI_PERSONA_BUS ?? "unset"} PI_PERSONA_HANDLE=${process.env.PI_PERSONA_HANDLE ?? "unset"} PI_PERSONA_PEERS=${process.env.PI_PERSONA_PEERS ?? "unset"} PI_PERSONA_ALLOW_BLOCKING=${process.env.PI_PERSONA_ALLOW_BLOCKING ?? "unset"}` }],
				model: "stub/model",
				stopReason: "end",
				usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 },
			},
		});
		process.exit(0);
	} else if (task.includes("[args]")) {
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `args: ${args.join(" ")}` }],
				model: "stub/model",
				stopReason: "end",
				usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 },
			},
		});
		process.exit(0);
	} else if (task.includes("[len]")) {
		// Echo the received task's LENGTH — proves a huge task survives the stdin path intact.
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `len: ${task.length}` }],
				model: "stub/model",
				stopReason: "end",
				usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 },
			},
		});
		process.exit(0);
	} else if (task.includes("[json]")) {
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: JSON.stringify({ result: "done", confidence: 0.9, stance: "approve" }) }],
				model: "stub/model",
				stopReason: "end",
				usage: { input: 5, output: 3, cost: { total: 0.001 }, totalTokens: 20 },
			},
		});
		process.exit(0);
	} else {
		emit({ type: "turn_start" });
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `echo: ${task}` }],
				model: "stub/model",
				stopReason: "end",
				usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 }, totalTokens: 42 },
			},
		});
		process.exit(0);
	}
}
