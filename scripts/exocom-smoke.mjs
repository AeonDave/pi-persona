/**
 * exocom-smoke.mjs — drives the REAL exocom plane end-to-end (no mocks): two `ExocomPlane`
 * instances over a temp agentDir + a fixed workspace hash, talking over a real socket/pipe
 * (`bindServer`/`sendFrame` in src/exocom/plane.ts), with the receiving side's `onInbound` wired
 * through `buildInboundDelivery` + a real `SenderBudget`/`SeenMessages` exactly as
 * src/extension.ts wires it — so the R2 budget guardrail is actually exercised, not bypassed.
 * Run: `node --import tsx scripts/exocom-smoke.mjs`. Prints PASS/FAIL per check; exits non-zero
 * on any failure.
 *
 * ── Manual live two-instance trial (Windows/PowerShell) ──────────────────────────────────────
 * Real `pi` runs are left to the user — not driven by this script. Two terminals, SAME workspace
 * folder:
 *
 *   # terminal 1 (elite)
 *   $env:PI_PERSONA_EXOCOM=1; npm run drive -- --persona elite --model <provider/id> "list your exocom peers, then send dev a task to audit README and wait for its reply"
 *
 *   # terminal 2 (dev, same folder)
 *   $env:PI_PERSONA_EXOCOM=1; npm run drive -- --persona dev --model <provider/id> "stand by for exocom messages; when one arrives, do it and reply with in_reply_to"
 *
 * Verify by eye:
 *   - elite's `exocom_list` shows dev (cross-process discovery)
 *   - elite's `exocom_send` reaches dev (dev's turn wakes with the task)
 *   - dev acts on the task and replies with `in_reply_to` set to the original msg_id
 *   - the reply lands back on elite as a FENCED follow-up (attributed, <subagent-output>-wrapped)
 * Capture the transcript from both terminals.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attributeInbound } from "../src/core/fence.ts";
import { SeenMessages, SenderBudget } from "../src/exocom/guards.ts";
import { buildInboundDelivery } from "../src/exocom/inbound.ts";
import { EXOCOM } from "../src/exocom/limits.ts";
import { endpoint } from "../src/exocom/paths.ts";
import { ExocomPlane } from "../src/exocom/plane.ts";
import { readAll } from "../src/exocom/registry.ts";

// A fixed literal, not workspaceHash(cwd) — this smoke's two planes only ever need to agree
// with EACH OTHER, not collide with a real session's registry path.
const HASH = "smoke-fixed-hash";
const agentDir = mkdtempSync(join(tmpdir(), "exocom-smoke-"));

let failures = 0;
function check(label, ok) {
	console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
	if (!ok) failures++;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function planeFor(name, onInbound) {
	const session_id = `sid-${name}-${process.pid}`;
	return new ExocomPlane({
		agentDir, hash: HASH,
		identity: {
			session_id, name, persona: name, purpose: `${name} smoke persona`, color: "#36F9F6",
			model: "smoke/model", endpoint: endpoint(agentDir, HASH, session_id, process.platform), cwd: process.cwd(),
		},
		getCard: () => ({ name, persona: name, model: "smoke/model", context_pct: 0, inbox: 0 }),
		onInbound,
	});
}

async function main() {
	const aInbound = [];
	const a = planeFor("smoke-a", (msg) => aInbound.push(msg));

	// B's onInbound mirrors extension.ts's wiring verbatim: resolve the label from the REGISTRY
	// entry (fromEntry), never from msg.from_name (the envelope's own self-report), then run the
	// real guardrail chain with a real SenderBudget/SeenMessages — not the raw plane hook.
	const budget = new SenderBudget({ windowMs: EXOCOM.SENDER_WINDOW_MS, maxMsgs: EXOCOM.SENDER_MAX_MSGS, maxBytes: EXOCOM.SENDER_MAX_BYTES });
	const seen = new SeenMessages({ ttlMs: EXOCOM.SEEN_TTL_MS });
	const bDecisions = []; // { msg, fromEntry, decision }
	const b = planeFor("smoke-b", (msg, fromEntry) => {
		const label = fromEntry ? `${fromEntry.name}${fromEntry.persona ? ` (${fromEntry.persona})` : ""}` : msg.from_session;
		const decision = buildInboundDelivery(msg, label, {
			budget, seen, injectMaxBytes: EXOCOM.INJECT_MAX_BYTES,
			fence: (t) => t,
			attribute: attributeInbound,
		});
		bDecisions.push({ msg, fromEntry, decision });
	});

	try {
		await a.start();
		await b.start();

		// ── 1. discovery ──────────────────────────────────────────────────────
		check("discovery: A sees B in listPeers()", a.listPeers().some((p) => p.name === "smoke-b"));
		check("discovery: B sees A in listPeers()", b.listPeers().some((p) => p.name === "smoke-a"));

		// ── 2. send + inbound ─────────────────────────────────────────────────
		const { msg_id: firstMsgId } = await a.send("smoke-b", "audit README");
		await delay(150);
		const first = bDecisions[0];
		check("send+inbound: B's onInbound fired exactly once", bDecisions.length === 1);
		check("send+inbound: raw text arrived intact", first?.msg.text === "audit README");
		// Not a spoof-resistance test (that's inbound.test.ts's job at the pure level) — this just
		// proves the real wiring actually populates fromEntry via a registry lookup end-to-end.
		check("send+inbound: attribution resolves from B's registry view (fromEntry), not the envelope",
			first?.fromEntry?.name === "smoke-a" && first?.fromEntry?.session_id !== undefined);
		check("send+inbound: delivered follow-up is attributed + fenced",
			first?.decision && "deliver" in first.decision
				&& first.decision.deliver.includes("smoke-a")
				&& first.decision.deliver.includes("<subagent-output>"));

		// ── 3. correlated reply ──────────────────────────────────────────────────
		await b.send("smoke-a", "done", firstMsgId);
		await delay(150);
		check("correlated reply: A's onInbound fired", aInbound.length === 1);
		check("correlated reply: in_reply_to matches the original msg_id", aInbound[0]?.in_reply_to === firstMsgId);

		// ── 4. budget cap (R2) ────────────────────────────────────────────────
		// One message already spent from A's bucket in step 2 — fire enough more to cross
		// EXOCOM.SENDER_MAX_MSGS and force at least one { drop: "budget" } out of the real guard.
		const extra = EXOCOM.SENDER_MAX_MSGS + 5;
		for (let i = 0; i < extra; i++) await a.send("smoke-b", `budget filler ${i}`);
		await delay(150);
		check(`budget cap: at least one of ${extra + 1} sends from A was dropped as { drop: "budget" }`,
			bDecisions.some((d) => "drop" in d.decision && d.decision.drop === "budget"));

		// ── 5. clean stop ─────────────────────────────────────────────────────
		await a.stop();
		const stillRegistered = readAll(agentDir, HASH).some((e) => e.name === "smoke-a");
		check("clean stop: A's registry entry is removed", !stillRegistered);
		check("clean stop: B no longer lists A", !b.listPeers().some((p) => p.name === "smoke-a"));

		await b.stop();
	} finally {
		try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
}

main()
	.then(() => {
		console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		console.error("exocom-smoke: uncaught error —", err);
		process.exit(1);
	});
