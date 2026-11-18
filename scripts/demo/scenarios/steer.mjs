/** Live supervision: open F9, read a worker's chat, redirect it mid-run, stop another. */
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

/** Each step: [tool, arguments, think-time before the call in ms]. */
const TRACE = [
	["grep", { pattern: "cancel", path: "src" }, 1600],
	["code_outline", { path: "src/queue.js" }, 2200],
	["read", { path: "src/queue.js", offset: 25, limit: 10 }, 2400],
	["read", { path: "src/api.js" }, 2600],
	["grep", { pattern: "status", path: "src" }, 2600],
	["read", { path: "test/queue.test.js", offset: 14, limit: 15 }, 2600],
	["read", { path: "README.md" }, 2600],
	["grep", { pattern: "submit", path: "src" }, 2600],
];
const AUDIT = [
	["read", { path: "test/queue.test.js" }, 2200],
	["grep", { pattern: "test\\(", path: "test" }, 3400],
	["read", { path: "package.json" }, 3400],
	["read", { path: "README.md" }, 3400],
	["grep", { pattern: "delay", path: "test" }, 3400],
	["read", { path: "src/queue.js" }, 3400],
	["read", { path: "src/api.js" }, 3400],
	["code_outline", { path: "src/queue.js" }, 3400],
	["grep", { pattern: "status", path: "src" }, 3400],
	["read", { path: "test/queue.test.js", offset: 1, limit: 12 }, 3400],
];

export async function respond(view, { act, call, say, sleep, text }) {
	if (view.task.includes("TRACE-CANCEL")) {
		// The operator's steer arrives as a new message in the worker's own conversation.
		if (view.seen(/free its slot/) && !view.seen(/Switching to #drain/)) {
			await sleep(900);
			return act(text("Understood. Switching to #drain: does a cancelled job free its slot?"), call("read", { path: "src/queue.js", offset: 36, limit: 22 }));
		}
		if (view.seen(/Switching to #drain/)) {
			await sleep(2600);
			return say("**Answer:** No. `cancel()` leaves `#running` untouched, so a cancelled running job keeps its concurrency slot until the handler returns.\n\n**Evidence:** `src/queue.js:36-37` gates on `#running.size`; only `#settle` (`src/queue.js:51`) frees a slot.");
		}
		const step = TRACE[view.turn];
		if (!step) { await sleep(1500); return say("**Answer:** `cancel()` never reaches `#running`."); }
		await sleep(step[2]);
		return act(call(step[0], step[1]));
	}
	if (view.task.includes("AUDIT-TESTS")) {
		const step = AUDIT[view.turn];
		if (!step) { await sleep(1500); return say("**Answer:** coverage mapped."); }
		await sleep(step[2]);
		return act(call(step[0], step[1]));
	}
	if (!view.called("agent_name")) { await sleep(400); return act(call("agent_name", { name: "Atlas" })); }
	if (!view.called("delegate")) {
		await sleep(400);
		return act(
			text("Two read-only investigations, in parallel."),
			call("delegate", {
				tasks: [
					{ agent: "scout", name: "Trace-Cancel", model: "demo/haiku-5", task: "TRACE-CANCEL: trace what JobQueue.cancel does for a job that is already running.", brief: brief("Explain why a running job survives cancel()") },
					{ agent: "reviewer", name: "Audit-Tests", model: "demo/sonnet-5", task: "AUDIT-TESTS: audit the whole test suite for missing cancellation cases.", brief: brief("Map cancellation test coverage") },
				],
			}),
		);
	}
	if (view.tool === "delegate") { await sleep(300); return say("Both are running."); }
	await sleep(900);
	return say("**Trace-Cancel** answered the question you redirected it to: a cancelled running job keeps its concurrency slot, because only `#settle` frees one (`src/queue.js:51`).\n\n**Audit-Tests** was stopped on your instruction, so there is no coverage report from it.");
}

export async function run({ caption, cut, key, sleep, type, waitFor }) {
	const F9 = "\x1b[20~";
	const DOWN = "\x1b[B";
	await sleep(1200);
	cut();
	await sleep(500);
	await type("Why does a running job survive cancel()? Check the code and the tests.");
	await sleep(300);
	key("\r");
	await waitFor(/running\./);
	await sleep(3500);
	caption("[F9] -- every worker, live");
	key(F9);
	await sleep(2600);
	caption("[Enter] -- open a worker's conversation");
	key("\r");
	await sleep(3800);
	caption("[s] -- steer it while it works");
	key("s");
	await sleep(900);
	await type("Focus on #drain instead: does a cancelled job free its slot?");
	await sleep(500);
	key("\r");
	caption("It reads the instruction and changes course");
	await sleep(7500);
	key("\x1b");
	await sleep(900);
	key(DOWN);
	await sleep(900);
	caption("[x] -- stop the one you no longer need");
	key("x");
	await sleep(2500);
	key(F9);
	caption("You stay in charge of the whole run");
	await waitFor(/redirected/, { timeout: 90_000, fresh: false });
	await sleep(6500);
}
