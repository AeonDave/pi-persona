/** Exocom: two independent Pi sessions in one workspace find each other and hand work across. */
export const cols = 108;
export const rows = 17;
export const layout = "column";
export const paneTitles = ["pi — terminal 1 — ~/acme-api", "pi — terminal 2 — ~/acme-api"];
export const panes = [{ args: ["--exocom", "--persona", "dev"] }, { args: ["--exocom", "--persona", "dev"] }];

/** The target `exocom_list` printed for the peer with this display name. */
function peerTarget(view, name) {
	for (const message of view.messages.toReversed()) {
		if (message.role !== "toolResult" || message.toolName !== "exocom_list") continue;
		const body = (message.content ?? []).map((block) => block.text ?? "").join("\n");
		const line = body.split("\n").find((candidate) => candidate.startsWith("- ") && candidate.includes(name));
		if (line) return line.slice(2).split(" · ")[0].trim();
	}
	return name;
}

export async function respond(view, { act, call, say, sleep, text }) {
	const self = view.task.startsWith("Name yourself Ember") ? "Ember" : "Flint";
	if (!view.called("exocom_name")) { await sleep(500); return act(call("exocom_name", { name: self })); }
	if (self === "Ember") {
		if (view.seen(/ready for review/)) {
			if (view.tool === "exocom_send") { await sleep(300); return say("Told Flint. Starting the review."); }
			if (view.tool === "exocom_list") {
				await sleep(500);
				return act(call("exocom_send", { target: peerTarget(view, "Flint"), message: "On it. Reviewing src/queue.js now; findings will come with file and line." }));
			}
			await sleep(900);
			return act(text("Flint finished the cancel fix. Taking the review."), call("exocom_list", {}));
		}
		if (!view.called("exocom_list")) { await sleep(400); return act(call("exocom_list", {})); }
		await sleep(300);
		return say("I'm **Ember**. One other session shares this workspace; it has no name yet.");
	}
	if (!view.called("exocom_list")) { await sleep(400); return act(call("exocom_list", {})); }
	if (!view.called("exocom_send")) {
		await sleep(500);
		return act(call("exocom_send", { target: peerTarget(view, "Ember"), message: "The cancel fix in src/queue.js is ready for review: abort the running job's controller, then settle it as cancelled. npm test is green." }));
	}
	if (view.tool === "exocom_send") { await sleep(300); return say("I'm **Flint**. Ember has the review request."); }
	await sleep(300);
	return say("Ember picked up the review.");
}

export async function run({ caption, cut, key, pane, sleep, type, waitFor }) {
	await sleep(1500);
	cut();
	caption("Two independent Pi sessions -- one workspace, each started with pi --exocom");
	await sleep(1500);
	pane(0);
	await type("Name yourself Ember and list your Exocom peers.");
	await sleep(300);
	key("\r");
	await waitFor(/shares/, { pane: 0 });
	await sleep(2000);
	pane(1);
	caption("Sessions find each other -- no server, no setup");
	await type("Name yourself Flint and tell Ember the cancel fix is ready for review.");
	await sleep(300);
	key("\r");
	await waitFor(/request\./, { pane: 1 });
	caption("The message arrives on its own -- and Ember answers");
	await waitFor(/Starting/, { pane: 0, timeout: 40_000, fresh: false });
	await sleep(6000);
}
