/** Background work: a script, an event monitor and a timer, each reporting back on its own. */
export const title = "pi — ~/acme-api";
export const cols = 112;
export const rows = 34;
export const args = ["--persona", "dev"];

export async function respond(view, { act, call, say, sleep, text }) {
	if (!view.called("agent_name")) { await sleep(400); return act(call("agent_name", { name: "Atlas" })); }
	if (!view.called("script")) {
		await sleep(500);
		return act(
			text("Three things to keep an eye on, none of them worth blocking for."),
			call("script", { action: "run", command: "node", args: ["scripts/build.mjs"], label: "build", timeoutSeconds: 120 }),
			call("monitor", { action: "arm", command: "node", args: ["scripts/watch-deploy.mjs"], label: "deploy status", mode: "output", maxEvents: 1, timeoutSeconds: 120 }),
			call("timer", { action: "arm", delaySeconds: 22, label: "error dashboard", message: "Remind the user to check the error dashboard." }),
		);
	}
	if (view.tool) { await sleep(300); return say("All three run in the background. Each one reports here when it has something to say."); }
	// Each wake is its own follow-up; answer the newest one.
	const wake = (view.last?.content ?? []).map((block) => block.text ?? "").join("\n");
	await sleep(600);
	if (/dashboard/i.test(wake)) return say("**Reminder:** time to check the error dashboard.");
	if (/deploy/i.test(wake)) return say("**Deploy is live:** v2.4.1 reached production.");
	return say("**Build finished cleanly:** 3 steps, 0 warnings.");
}

export async function run({ caption, cut, key, sleep, type, waitFor }) {
	const F9 = "\x1b[20~";
	await sleep(1200);
	cut();
	caption("Ask in plain language -- nothing blocks the conversation");
	await sleep(600);
	await type("Run the build in the background, tell me when the deploy goes live, and remind me in 20s to check the error dashboard.", { cps: 42 });
	await sleep(300);
	key("\r");
	await waitFor(/Each/);
	await sleep(1800);
	caption("[F9] -- scripts, monitors and timers share the team view");
	key(F9);
	await sleep(4200);
	key(F9);
	caption("Each one wakes the supervisor when it has news");
	await waitFor(/Reminder/, { timeout: 60_000, fresh: false });
	await sleep(6000);
}
