import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installExocom, type ExocomHost } from "../../src/exocom/install.ts";
import { commitLedgerEvent, loadLedger } from "../../src/exocom/ledger.ts";
import { collaborationStatus } from "../../src/exocom/collaboration.ts";
import { ledgerPath, registryPath, workspaceHash } from "../../src/exocom/paths.ts";
import { readAll, sessionKey, writeEntry } from "../../src/exocom/registry.ts";
import { EXOCOM_RELOAD_ENTRY } from "../../src/exocom/reload.ts";
import { ExocomPlane } from "../../src/exocom/plane.ts";
import { endpoint } from "../../src/exocom/paths.ts";

interface InstalledTool { name: string; execute(id: string, args: Record<string, unknown>): Promise<unknown> }

function session(dir: string, id: string, name: string, registerTool: (tool: InstalledTool) => void = () => {}, cwd = dir, exocomEnabled = true) {
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const notices: Array<{ message: string; level: string }> = [];
	const ctx = {
		cwd, hasUI: true, sessionManager: { getSessionId: () => id, getEntries: () => entries, getBranch: () => entries },
		isIdle: () => false, getContextUsage: () => undefined,
		ui: { notify(message: string, level: string) { notices.push({ message, level }); }, setWidget() {}, setStatus() {} },
	} as unknown as ExtensionContext;
	const pi = {
		getFlag: () => false, registerTool, getAllTools: () => [], getActiveTools: () => [],
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	const host = {
		pi, identity: { chosen: true, name }, config: { exocom: exocomEnabled }, controller: {}, lastCtx: ctx,
		canDeliverNotifications: () => false, exocomArgs: {}, userAgentDir: () => dir,
	} as unknown as ExocomHost;
	const exocom = installExocom(pi, host);
	return { exocom, entries, notices, ctx, controller: host.controller, start: (reload = false) => exocom.reconcile(ctx, reload) };
}

test("the same session in two agent directories binds independently while a directory alias remains a duplicate", async () => {
	const root = await mkdtemp(join(tmpdir(), "exo-profiles-"));
	const firstDir = join(root, "one");
	const secondDir = join(root, "two");
	const aliasDir = join(root, "alias");
	const first = session(firstDir, "same-session", "First", undefined, root);
	const second = session(secondDir, "same-session", "Second", undefined, root);
	const alias = session(aliasDir, "same-session", "Alias", undefined, root);
	const peer = session(aliasDir, "peer", "Peer", undefined, root);
	try {
		await mkdir(firstDir);
		await symlink(firstDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
		await first.start(); await second.start(); await alias.start();
		assert.ok(first.exocom.plane, first.exocom.startupError);
		assert.ok(second.exocom.plane, second.exocom.startupError);
		assert.equal(alias.exocom.plane, undefined);
		assert.match(alias.exocom.startupError ?? "", /endpoint is busy/);
		assert.deepEqual(readAll(firstDir, workspaceHash(root)).map((entry) => entry.name), ["First"]);
		assert.deepEqual(readAll(secondDir, workspaceHash(root)).map((entry) => entry.name), ["Second"]);
		await peer.start();
		const spilled = await peer.exocom.plane!.send("First", "large payload".repeat(2_000));
		assert.equal(first.exocom.notifier?.peekPending()[0]?.receipt?.id, spilled.msg_id);
	} finally {
		await peer.exocom.stop();
		await alias.exocom.stop(); await second.exocom.stop(); await first.exocom.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("a window with Exocom disabled leaves the owner's pending reload handoff untouched", async () => {
	const dir = await mkdtemp(join(tmpdir(), "exo-disabled-duplicate-"));
	const owner = session(dir, "shared", "Owner");
	const disabled = session(dir, "shared", "Disabled", undefined, dir, false);
	const peer = session(dir, "sender", "Peer");
	try {
		await owner.start(); await peer.start();
		const queued = await peer.exocom.plane!.send("Owner", "held");
		await owner.exocom.stop(owner.ctx);
		disabled.entries.push(...owner.entries);
		await disabled.start();
		assert.equal(disabled.entries.length, 1, "the disabled window must not write a consumed marker into the native session");
		await owner.start(true);
		assert.equal(owner.exocom.notifier?.peekPending()[0]?.receipt?.id, queued.msg_id);
	} finally {
		await owner.exocom.stop(); await disabled.exocom.stop(); await peer.exocom.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("tool calls after shutdown starts cannot acquire work after the owner's releases", async () => {
	const dir = await mkdtemp(join(tmpdir(), "exo-stop-admission-"));
	const tools = new Map<string, InstalledTool>();
	const owner = session(dir, "stopping", "Owner", (tool) => tools.set(tool.name, tool));
	const peer = session(dir, "watching", "Peer");
	try {
		await owner.start(); await peer.start();
		const claim = tools.get("exocom_claim")!;
		const file = owner.exocom.ledgerFile;
		const stopped = owner.exocom.stop();
		try {
			await assert.rejects(claim.execute("late", { work_key: "late", write_set: ["b"], slice: "late" }), /not active/);
		} finally { await stopped; }
		assert.deepEqual(loadLedger(file).claims, []);
	} finally {
		await owner.exocom.stop(); await peer.exocom.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a tool waiting to commit retains a new peer's intervening claim", async () => {
	const dir = await mkdtemp(join(tmpdir(), "exo-ledger-admission-"));
	const tools = new Map<string, InstalledTool>();
	const owner = session(dir, "caller", "Caller", (tool) => tools.set(tool.name, tool));
	try {
		await owner.start();
		const file = owner.exocom.ledgerFile;
		const hash = workspaceHash(dir);
		const entry = readAll(dir, hash)[0]!;
		// Another process registers and commits between the caller's capability preflight and locked commit.
		let joined = false;
		Object.defineProperty(owner.controller, "capabilities", { configurable: true, get() {
			if (!joined) {
				joined = true;
				writeEntry(dir, hash, { ...entry, session_id: "new-peer", name: "New" });
				assert.ok(commitLedgerEvent(file, { kind: "claim", work_key: "first", from_session: "new-peer", from_name: "New",
					msg_id: "first", ts: new Date().toISOString(), write_set: ["file.ts"], slice: "first" }).ok);
			}
			return undefined;
		} });
		await assert.rejects(tools.get("exocom_claim")!.execute("overlap", { work_key: "overlap", write_set: ["file.ts"], slice: "late" }), /overlap/);
		assert.equal(joined, true);
		assert.deepEqual(loadLedger(file).claims.map((item) => item.from_session), ["new-peer"]);
	} finally {
		await owner.exocom.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a registry cleanup checking the current entry cannot temporarily forfeit its live owner's claim", async () => {
	const dir = await mkdtemp(join(tmpdir(), "exo-quarantine-"));
	const hash = workspaceHash(dir);
	const tools = new Map<string, InstalledTool>();
	const owner = session(dir, "caller", "Caller", (tool) => tools.set(tool.name, tool));
	const peer = session(dir, "peer", "Peer");
	const slot = registryPath(dir, hash, sessionKey("peer"));
	const claimed = `${slot}.claim-${process.pid}-${randomUUID()}`;
	try {
		await owner.start(); await peer.start();
		const file = owner.exocom.ledgerFile;
		assert.ok(commitLedgerEvent(file, { kind: "claim", work_key: "first", from_session: "peer", from_name: "Peer", msg_id: "first",
			ts: new Date().toISOString(), write_set: ["file.ts"], slice: "first" }).ok);
		await rename(slot, claimed); // A stale remover has claimed the live replacement for comparison.
		try {
			await assert.rejects(tools.get("exocom_claim")!.execute("overlap", { work_key: "overlap", write_set: ["file.ts"], slice: "late" }), /overlap/);
			assert.deepEqual(loadLedger(file).claims.map((item) => item.from_session), ["peer"]);
		} finally { await rename(claimed, slot); }
	} finally {
		await owner.exocom.stop(); await peer.exocom.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a duplicate Pi session leaves the live owner's ledger, registry and deliveries intact", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "exo-duplicate-"));
	const owner = session(dir, "resumed", "Owner");
	const duplicate = session(dir, "resumed", "Duplicate");
	const peer = session(dir, "peer", "Peer");
	try {
		await owner.start();
		await peer.start();
		assert.ok(owner.exocom.plane, owner.exocom.startupError);
		assert.ok(peer.exocom.plane, peer.exocom.startupError);
		const queued = await peer.exocom.plane.send(peer.exocom.plane.resolvePeer("Owner").target, "queued before reload");
		await owner.exocom.stop(owner.ctx);
		assert.equal(owner.entries[0]?.customType, EXOCOM_RELOAD_ENTRY);
		duplicate.entries.push(...owner.entries); // Both hosts loaded the session file before either rejoined.
		await owner.start(true);
		assert.equal(owner.exocom.notifier?.peekPending()[0]?.receipt?.id, queued.msg_id);
		const entry = peer.exocom.plane.resolvePeer("Owner");
		const file = owner.exocom.ledgerFile;
		const base = { from_session: "resumed", from_name: "Owner", ts: new Date().toISOString() };
		assert.equal(commitLedgerEvent(file, { ...base, kind: "claim", work_key: "edit", msg_id: "claim", write_set: ["src/a.ts"], slice: "edit" }).ok, true);
		assert.equal(commitLedgerEvent(file, { ...base, kind: "ask", work_key: "question", msg_id: "ask", ask_id: "ask", to_session: "peer", question: "Ready?" }).ok, true);
		assert.equal(commitLedgerEvent(file, { ...base, kind: "task_create", work_key: "follow-up", msg_id: "task", description: "Review", write_set: [] }).ok, true);
		const original = await readFile(file, "utf8");

		await duplicate.start(true);
		assert.equal(duplicate.exocom.plane, undefined);
		assert.match(duplicate.exocom.startupError ?? "", /^You can keep working without Exocom.*endpoint is busy.*\/fork.*\/reload/);
		assert.deepEqual(duplicate.notices.filter(({ level }) => level === "warning").map(({ message }) => message), [duplicate.exocom.startupError]);
		const stderr = t.mock.method(process.stderr, "write", () => true);
		try {
			await duplicate.exocom.reconcile({ ...duplicate.ctx, hasUI: false }, false);
			assert.equal(stderr.mock.calls[0]?.arguments[0], `[pi-persona] ${duplicate.exocom.startupError}\n`);
		} finally { stderr.mock.restore(); }
		await duplicate.exocom.stop();
		assert.equal(duplicate.entries.length, 1, "a rejected registration cannot consume a pending reload handoff");
		assert.equal(await readFile(file, "utf8"), original, "a rejected registration cannot append releases");
		assert.equal(peer.exocom.plane.resolvePeer("Owner").public_key, entry.public_key);
		const sent = await peer.exocom.plane.send(entry.target, "still reachable");
		assert.ok(owner.exocom.notifier?.peekPending().some((item) => item.receipt?.id === sent.msg_id));

		await owner.exocom.stop();
		const state = loadLedger(file);
		assert.equal(state.claims.length, 0);
		assert.equal(state.asks.length, 0);
		assert.equal(collaborationStatus(state.collaboration!.tasks[0]!), "stale");
		assert.ok(!peer.exocom.plane.listPeers().some((p) => p.session_id === "resumed"));

		await duplicate.start(true);
		assert.ok(peer.exocom.plane.resolvePeer("Duplicate"));
		assert.equal(duplicate.exocom.notifier?.peekPending().length, 0, "a takeover cannot replay the previous owner's handoff from stale Pi history");
		assert.ok(!duplicate.notices.some(({ message }) => message.includes("could not be restored")));

		// A genuine handoff has a different failure mode: its owner must learn that it lost its inbox.
		await peer.exocom.plane.send(peer.exocom.plane.resolvePeer("Duplicate").target, "awaiting reload");
		await duplicate.exocom.stop(duplicate.ctx);
		await owner.start();
		await duplicate.start(true);
		assert.equal(duplicate.exocom.plane, undefined);
		assert.ok(duplicate.notices.some(({ message, level }) => level === "warning" && message.includes("could not be restored")));
	} finally {
		await duplicate.exocom.stop();
		await owner.exocom.stop();
		await peer.exocom.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("failed tool registration closes the newly bound plane without releasing prior ledger work", async () => {
	const dir = await mkdtemp(join(tmpdir(), "exo-activation-"));
	const failed = session(dir, "resumed", "Owner", () => { throw new Error("tool registration failed"); });
	const hash = workspaceHash(dir);
	const file = ledgerPath(dir, hash);
	try {
		assert.equal(commitLedgerEvent(file, { kind: "claim", work_key: "edit", msg_id: "prior", from_session: "resumed", from_name: "Owner",
			ts: new Date().toISOString(), write_set: ["src/a.ts"], slice: "edit" }).ok, true);
		const original = await readFile(file, "utf8");
		await failed.start();
		assert.equal(failed.exocom.startupError, "tool registration failed");
		assert.ok(failed.notices.some(({ message, level }) => level === "error" && message.includes("tool registration failed")));
		assert.equal(failed.exocom.plane, undefined);
		assert.deepEqual(readAll(dir, hash), []);
		assert.equal(await readFile(file, "utf8"), original);
	} finally {
		await failed.exocom.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a takeover immediately after a crash retires the old owner's work before advertising the new lease", async () => {
	const dir = await mkdtemp(join(tmpdir(), "exo-crashed-owner-"));
	const next = session(dir, "resumed", "Next");
	try {
		const old = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
			import { ExocomPlane } from "./src/exocom/plane.ts";
			import { commitLedgerEvent } from "./src/exocom/ledger.ts";
			import { ledgerPath, workspaceHash, endpoint } from "./src/exocom/paths.ts";
			const dir = process.argv[1], hash = workspaceHash(dir), session_id = "resumed";
			const plane = new ExocomPlane({ agentDir: dir, hash, identity: { session_id, name: "Old", persona: "", purpose: "",
				color: "", model: "m", endpoint: endpoint(dir, hash, session_id, process.platform), cwd: dir },
				getCard: () => ({ context_pct: 0, inbox: 0 }), onInbound: () => ({ accepted: true }) });
			await plane.start();
			const file = ledgerPath(dir, hash), base = { from_session: session_id, from_name: "Old", ts: new Date().toISOString() };
			for (const event of [
				{ ...base, kind: "claim", msg_id: "claim", work_key: "edit", write_set: ["a"], slice: "edit" },
				{ ...base, kind: "task_create", msg_id: "task", work_key: "review", write_set: [], description: "Review" },
			]) if (!commitLedgerEvent(file, event).ok) process.exit(1);
			process.exit(0);
		`, dir], { encoding: "utf8", timeout: 10_000 });
		assert.equal(old.status, 0, old.stderr);
		await next.start();
		assert.ok(next.exocom.plane, next.exocom.startupError);
		const state = loadLedger(next.exocom.ledgerFile);
		assert.deepEqual(state.claims, []);
		assert.equal(collaborationStatus(state.collaboration!.tasks[0]!), "stale");
	} finally {
		await next.exocom.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a live registrant advertising a different endpoint keeps its signing key, ledger and route", async () => {
	const dir = await mkdtemp(join(tmpdir(), "exo-other-endpoint-"));
	const hash = workspaceHash(dir);
	const owner = new ExocomPlane({ agentDir: dir, hash, identity: { session_id: "shared", name: "Old", persona: "", purpose: "", color: "", model: "m",
		endpoint: endpoint(dir, hash, "different-format", process.platform), cwd: dir },
		getCard: () => ({ name: "Old", persona: "", model: "m", context_pct: 0, inbox: 0 }), onInbound: () => ({ accepted: true }) });
	const next = session(dir, "shared", "Duplicate");
	const peer = session(dir, "peer", "Peer");
	const file = ledgerPath(dir, hash);
	try {
		await owner.start(); await peer.start();
		const entry = peer.exocom.plane!.resolvePeer("Old");
		assert.ok(commitLedgerEvent(file, { kind: "claim", work_key: "edit", msg_id: "old", from_session: "shared", from_name: "Old",
			ts: new Date().toISOString(), write_set: ["a"], slice: "edit" }).ok);
		const original = await readFile(file, "utf8");
		await next.start();
		assert.equal(next.exocom.plane, undefined);
		assert.match(next.exocom.startupError ?? "", /endpoint is busy/);
		assert.equal(await readFile(file, "utf8"), original);
		assert.equal(peer.exocom.plane!.resolvePeer("Old").public_key, entry.public_key);
		await peer.exocom.plane!.send(entry.target, "owner still reachable");
	} finally {
		await next.exocom.stop(); await owner.stop(); await peer.exocom.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("an armed waiter wakes when a successor has already retired the old pending ask", async () => {
	const dir = await mkdtemp(join(tmpdir(), "exo-wait-takeover-"));
	const tools = new Map<string, InstalledTool>();
	const sender = session(dir, "sender", "Sender", (tool) => tools.set(tool.name, tool));
	const first = session(dir, "resumed", "First");
	const next = session(dir, "resumed", "Next");
	try {
		await sender.start(); await first.start();
		const work_key = "review", ask_id = "pending-review";
		await tools.get("exocom_ask")!.execute("ask", { work_key, target: "First", question: "Ready?", ask_id });
		await tools.get("exocom_wait")!.execute("wait", { work_key, ask_id });
		await first.exocom.stop(); await next.start();
		assert.deepEqual(loadLedger(sender.exocom.ledgerFile).asks, []);
		sender.exocom.ledgerState(); // same reconciliation the heartbeat drives
		const notices = sender.exocom.waitNotifier!.peekPending();
		assert.equal(notices.length, 1);
		assert.match(notices[0]!.text, /wait ended.*ask_id=pending-review/);
	} finally {
		await first.exocom.stop(); await next.exocom.stop(); await sender.exocom.stop();
		await rm(dir, { recursive: true, force: true });
	}
});
