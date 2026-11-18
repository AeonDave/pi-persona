/** Personas and councils: F8 to the MAGI persona, then a three-core vote with dissent kept. */
export const title = "pi — ~/acme-api";
export const cols = 112;
export const rows = 34;
export const args = ["--persona", "dev"];

const CORES = {
	MELCHIOR: {
		look: ["read", { path: "src/queue.js", offset: 25, limit: 14 }],
		vote: { result: "Ship it now: the bug breaks a documented promise.", vote: "patch", confidence: 0.86, output: "src/api.js documents that cancel resolves true for running jobs. Today it returns false, so every caller relying on the contract is already broken. A patch restores the promise." },
	},
	BALTHASAR: {
		look: ["grep", { pattern: "cancel", path: "test" }],
		vote: { result: "Hold: aborting running handlers is new observable behaviour.", vote: "hold", confidence: 0.71, output: "Handlers that ignore the AbortSignal keep running after cancel returns true. One regression test covers the path; callers may depend on jobs finishing. Ship behind 3.0 with a migration note." },
	},
	CASPER: {
		look: ["read", { path: "src/api.js" }],
		vote: { result: "Patch, with the abort behaviour called out in the changelog.", vote: "patch", confidence: 0.8, output: "The fix matches the published contract and the signature is unchanged, so it is a bug fix by semver. Balthasar's risk is real but narrow: name it in the release notes." },
	},
};

export async function respond(view, { act, call, say, sleep, text }) {
	const core = Object.keys(CORES).find((name) => view.system.includes(`You are **${name}**`));
	if (core) {
		if (view.turn === 0) { await sleep(1800 + 700 * Object.keys(CORES).indexOf(core)); return act(call(...CORES[core].look)); }
		await sleep(2200 + 900 * Object.keys(CORES).indexOf(core));
		return say(JSON.stringify(CORES[core].vote));
	}
	if (!view.called("agent_name")) { await sleep(400); return act(call("agent_name", { name: "Oracle" })); }
	if (!view.called("council")) {
		await sleep(500);
		return act(
			text("A genuine fork with real cost either way. The cores vote."),
			call("council", { question: "The cancel() fix makes a running job abort, as src/api.js already documents. Ship it as a patch release now, or hold it for 3.0? Answer: patch or hold." }),
		);
	}
	if (view.tool === "council") { await sleep(300); return say("The three cores are deliberating."); }
	await sleep(900);
	return say("**Ruling: patch, 2 to 1.**\n\n- **Melchior** and **Casper**: the fix restores the documented contract and changes no signature, so it is a bug fix.\n- **Minority report, Balthasar:** handlers that ignore the abort signal keep running after `cancel` returns `true`. Call that out in the release notes.\n\nA vote is a judgment, not proof: `npm test` still has to pass on the release commit.");
}

export async function run({ caption, cut, key, sleep, type, waitFor }) {
	const F8 = "\x1b[19~";
	const UP = "\x1b[A";
	const DOWN = "\x1b[B";
	const ENTER = "\r";
	await sleep(1200);
	cut();
	caption("[F8] -- switch persona: a different way of working, same session");
	await sleep(1400);
	for (let presses = 0; presses < 14; presses++) {
		key(F8);
		try { await waitFor(/MAGI/, { timeout: 1100 }); break; } catch { /* next persona */ }
	}
	await sleep(1800);
	caption("MAGI -- three cores with opposed biases vote on a real fork");
	await type("We fixed cancel(). Ship it as a patch now, or hold it for 3.0?");
	await sleep(300);
	key(ENTER);
	// First council of a session: the operator assigns a model to each core, one picker at a time.
	// Each role name first appears in its picker's title.
	await waitFor(/Driver/, { fresh: false });
	caption("[↑↓] [Enter] -- give each core its own model");
	await sleep(1800);
	key(UP);
	await sleep(700);
	key(ENTER);
	await waitFor(/Regulator/, { fresh: false });
	await sleep(1200);
	key(ENTER);
	await waitFor(/Synthesizer/, { fresh: false });
	await sleep(1200);
	key(DOWN);
	await sleep(700);
	key(ENTER);
	await sleep(600);
	caption("Independent votes -- a majority decides, dissent is kept");
	await waitFor(/judgment/, { timeout: 120_000, fresh: false });
	caption("A ruling with its minority report");
	await sleep(7000);
}
