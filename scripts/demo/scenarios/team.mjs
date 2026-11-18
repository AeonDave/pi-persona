/** Hero demo: one prompt, three parallel workers, a look inside one of them, then a verified fix. */
export const title = "pi — ~/acme-api";
export const cols = 112;
export const rows = 36;
export const args = ["--persona", "dev"];

const brief = (objective) => ({
	objective,
	scopeRoe: "Read this repository only",
	position: "Current checkout",
	constraints: ["Do not modify files"],
	requiredArtifacts: ["path:line evidence"],
	stopConditions: ["Stop once the question is answered"],
});

/** Each worker: [tool, arguments, think-time before the call in ms]. */
const WORKERS = {
	"CANCEL-PATH": {
		steps: [
			["grep", { pattern: "cancel", path: "src" }, 1800],
			["code_outline", { path: "src/queue.js" }, 2400],
			["read", { path: "src/queue.js", offset: 25, limit: 10 }, 2600],
			["read", { path: "src/queue.js", offset: 36, limit: 14 }, 2800],
		],
		report: "**Answer:** `cancel()` only searches `#pending`. A running job's `AbortController` sits in `#running` and is never aborted, so the handler finishes and `#settle` overwrites the status.\n\n**Evidence:** `src/queue.js:25-33` has no branch for `#running`; `src/queue.js:39` stores a controller nothing ever calls.",
	},
	"TEST-GAPS": {
		steps: [
			["ls", { path: "test" }, 1500],
			["read", { path: "test/queue.test.js" }, 2600],
			["grep", { pattern: "cancel", path: "test" }, 2400],
			["read", { path: "package.json" }, 2200],
		],
		report: "**Answer:** The regression is already pinned: `cancels a running job` fails today because `cancel` returns `false`. Pending-job cancellation is covered and green.\n\n**Evidence:** `test/queue.test.js:21-28`. Run with `npm test`.",
	},
	"API-CONTRACT": {
		steps: [
			["read", { path: "src/api.js" }, 2000],
			["grep", { pattern: "cancel\\(", path: "src" }, 2600],
			["read", { path: "README.md" }, 2200],
			["code_outline", { path: "src/api.js" }, 2400],
			["read", { path: "src/queue.js", offset: 1, limit: 24 }, 2600],
		],
		report: "**Answer:** The public contract already promises it: `cancel` resolves `true` for pending **and** running jobs, so fixing `JobQueue.cancel` needs no signature change.\n\n**Evidence:** `src/api.js:4-5` (documented contract), `src/api.js:13` (thin pass-through).",
	},
};

const OLD = `			return true;
		}
		return false;
	}`;
const NEW = `			return true;
		}
		const controller = this.#running.get(id);
		if (!controller) return false;
		controller.abort();
		this.#settle(id, { status: "cancelled" });
		return true;
	}`;

export async function respond(view, { act, call, say, sleep, text, think }) {
	const worker = Object.keys(WORKERS).find((key) => view.task.includes(key));
	if (worker) {
		const plan = WORKERS[worker];
		const step = plan.steps[view.turn];
		if (!step) { await sleep(1200); return say(plan.report); }
		await sleep(step[2]);
		return act(call(step[0], step[1]));
	}
	const { tool } = view;
	if (!view.called("agent_name")) { await sleep(500); return act(call("agent_name", { name: "Atlas" })); }
	if (!view.called("delegate")) {
		await sleep(500);
		return act(
			think("Three independent questions: the cancel path, the test coverage, the public contract. None depends on another."),
			text("Three independent questions. I'll hand them off in parallel and keep the fix for myself."),
			call("delegate", {
				tasks: [
					{ agent: "scout", name: "Cancel-Path", model: "demo/haiku-5", task: "CANCEL-PATH: trace what JobQueue.cancel does for a job that is already running.", brief: brief("Explain why a running job survives cancel()") },
					{ agent: "scout", name: "Test-Gaps", model: "demo/haiku-5", task: "TEST-GAPS: find which cancellation behaviours the suite covers and which fail.", brief: brief("Map cancellation test coverage") },
					{ agent: "reviewer", name: "API-Contract", model: "demo/sonnet-5", task: "API-CONTRACT: state the public cancel contract and whether a fix may change it.", brief: brief("Pin the public cancel contract") },
				],
			}),
		);
	}
	if (tool === "delegate") { await sleep(300); return say("All three are running. Their reports come back to me on their own."); }
	if (view.last?.role === "user" && !view.called("edit")) {
		await sleep(900);
		return act(
			text("All three agree. `cancel()` never reaches a running job, the failing test already pins it, and the public contract stays as it is. One small change:"),
			call("edit", { path: "src/queue.js", edits: [{ oldText: OLD, newText: NEW }] }),
		);
	}
	if (tool === "edit") { await sleep(500); return act(call("bash", { command: "npm test 2>&1 | grep -E \"^(ok|not ok|# pass|# fail)\"" })); }
	if (tool === "bash") {
		await sleep(600);
		return say("Fixed and verified.\n\n- **Cause:** `cancel()` ignored jobs in `#running` (`src/queue.js:25`)\n- **Fix:** abort the job's controller and settle it as `cancelled`\n- **Proof:** `npm test` is green, 3 of 3, including `cancels a running job`");
	}
	return say("Done.");
}

export async function run({ caption, cut, key, sleep, type, waitFor }) {
	const F9 = "\x1b[20~";
	await sleep(1200);
	cut();
	caption("Describe the outcome -- the supervisor splits the work");
	await sleep(700);
	await type("Cancelling a running job doesn't stop it. Investigate in parallel, then fix it.");
	await sleep(350);
	key("\r");
	await waitFor(/running\./);
	await sleep(1500);
	caption("[F9] -- inspect live workers");
	key(F9);
	await sleep(2600);
	key("\x1b[B");
	await sleep(700);
	key("\x1b[B");
	await sleep(900);
	caption("[Enter] -- read a worker's chat as it works");
	key("\r");
	await sleep(4200);
	key(F9);
	caption("Results come back on their own -- no polling");
	await waitFor(/verified\./, { timeout: 90_000 });
	caption("Investigated in parallel, fixed, verified");
	await sleep(6000);
}
