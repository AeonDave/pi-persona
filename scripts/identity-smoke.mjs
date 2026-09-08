/**
 * Live identity bootstrap smoke test.
 *
 * It spends real model tokens and deliberately leaves naming out of both task texts. The
 * standalone turn must discover `agent_name` from pi-persona's context hook. The Exocom turn
 * receives its first stimulus over the real local ExocomPlane and must discover `exocom_name`
 * before sending the requested reply.
 *
 * Run from PowerShell:
 *   $env:LIVE_MODEL='openai-codex/gpt-5.6-luna'
 *   node --import tsx scripts/identity-smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { workspaceHash } from "../src/exocom/paths.ts";
import { endpoint } from "../src/exocom/paths.ts";
import { ExocomPlane } from "../src/exocom/plane.ts";
import { readAll, removeEntryIfMatches } from "../src/exocom/registry.ts";
import { killProcessTree } from "../src/engine/child.ts";

const model = process.env.LIVE_MODEL?.trim();
if (!model || !/^[^/\s]+\/\S+$/.test(model)) {
	console.error("identity-smoke: refusing to spend tokens; set LIVE_MODEL=provider/id explicitly.");
	process.exit(2);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repoRoot, "src", "extension.ts");
const piIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = join(dirname(piIndex), "cli.js");
const modeDeadlineMs = 120_000;
const replyMarker = "IDENTITY_SMOKE_RECEIVED";
const standaloneMarker = "IDENTITY_SMOKE_STANDALONE";

// Keep the same global Pi directory that supplies the user's existing provider auth. The
// workspace is temporary, so the Exocom scope and its registry slot remain isolated per mode.
const configuredAgentDir = process.env.PI_AGENT_DIR?.trim();
const agentDir = configuredAgentDir ? resolve(configuredAgentDir) : getAgentDir();

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function removeOwnedWorkspace(workspace, prefix) {
	const tempBase = resolve(tmpdir());
	const target = resolve(workspace);
	const rel = relative(tempBase, target);
	if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !basename(target).startsWith(prefix)) {
		throw new Error(`refusing recursive cleanup outside generated tmp workspace: ${target}`);
	}
	rmSync(target, { recursive: true, force: true });
}

function removeDeadReceiverEntry(workspace, receiverSessionId, receiverPid) {
	if (!receiverSessionId || !Number.isInteger(receiverPid) || receiverPid <= 0) return;
	const hash = workspaceHash(workspace);
	const entry = readAll(agentDir, hash).find((candidate) => candidate.session_id === receiverSessionId);
	if (!entry) return;
	if (entry.pid !== receiverPid || resolve(entry.cwd) !== resolve(workspace)) {
		throw new Error("refusing registry cleanup: receiver PID/session/cwd do not match");
	}
	removeEntryIfMatches(agentDir, hash, {
		session_id: entry.session_id,
		endpoint: entry.endpoint,
		...(entry.public_key ? { public_key: entry.public_key } : {}),
	});
	if (readAll(agentDir, hash).some((candidate) => candidate.session_id === receiverSessionId)) {
		throw new Error("receiver registry entry remained after exact ownership cleanup");
	}
}

function appendBounded(current, chunk, max) {
	const next = current + chunk;
	return next.length <= max ? next : next.slice(-max);
}

function contentText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? part.text : "")
		.join("");
}

function resultDetails(result) {
	return result && typeof result === "object" && result.details && typeof result.details === "object" ? result.details : undefined;
}

function makeEnv(exocom) {
	return {
		...process.env,
		// Resolve this explicitly because the RPC child has a temporary cwd while the sender runs
		// from the repository cwd. It preserves the same auth directory and registry root.
		PI_AGENT_DIR: agentDir,
		PI_PERSONA_DISABLE: "",
		PI_PERSONA_DEFAULT: "dev",
		PI_PERSONA_SEED: "off",
		PI_PERSONA_PERSIST: "off",
		PI_PERSONA_ENGINE: "inproc",
		PI_PERSONA_EXOCOM: exocom ? "1" : "off",
		PI_PERSONA_BROKER: "off",
		PI_PERSONA_DELEGATE_DEFAULT: "off",
		PI_PERSONA_NUDGE: "off",
	};
}

function makeArgs(exocom) {
	const args = [
		"--mode", "rpc",
		"--no-session",
		"--extension", extensionPath,
		"--persona", "dev",
		"--model", model,
		"--thinking", "xhigh",
	];
	if (exocom) args.push("--exocom");
	return args;
}

function createRpc(exocom, cwd) {
	const state = {
		child: undefined,
		lineBuffer: "",
		events: [],
		toolStarts: [],
		toolEnds: [],
		agentEnds: 0,
		promptCommands: 0,
		firstAssistantTextAt: undefined,
		name: undefined,
		nameEndAt: undefined,
		assistantText: "",
		replyText: undefined,
		replyAt: undefined,
		failure: undefined,
		stopping: false,
		waiters: new Set(),
	};

	const notify = () => {
		for (const waiter of [...state.waiters]) {
			let ready = false;
			try { ready = waiter.predicate(state); } catch (error) {
				state.waiters.delete(waiter);
				clearTimeout(waiter.timer);
				waiter.reject(error instanceof Error ? error : new Error(String(error)));
				continue;
			}
			if (!ready) continue;
			state.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(state);
		}
	};

	const fail = (error) => {
		if (state.failure) return;
		state.failure = error instanceof Error ? error : new Error(String(error));
		for (const waiter of [...state.waiters]) {
			state.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.reject(state.failure);
		}
	};

	const handleEvent = (event) => {
		if (!event || typeof event !== "object") return;
		state.events.push({ type: event.type, tool: event.toolName, at: Date.now() });
		if (state.events.length > 120) state.events.shift();
		if (event.type === "response" && event.success === false) {
			// Do not echo provider/RPC error payloads: they can contain request or account data.
			fail(new Error("Pi RPC reported a failed command"));
			return;
		}
		if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
			state.toolStarts.push({ name: event.toolName, at: Date.now() });
		}
		if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
			const at = Date.now();
			const details = resultDetails(event.result);
			state.toolEnds.push({ name: event.toolName, ok: event.isError !== true, at });
			if ((event.toolName === "agent_name" || event.toolName === "exocom_name")
				&& event.isError !== true && typeof details?.name === "string" && details.name.trim()) {
				state.name = details.name.trim();
				state.nameEndAt = at;
			}
		}
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update && typeof update === "object" && update.type === "text_delta" && typeof update.delta === "string" && update.delta.trim()) {
				state.firstAssistantTextAt ??= Date.now();
				state.assistantText += update.delta;
			}
		}
		if (event.type === "message_end" && event.message && typeof event.message === "object" && event.message.role === "assistant") {
			const text = contentText(event.message.content);
			if (text.trim()) {
				state.firstAssistantTextAt ??= Date.now();
				state.assistantText += text;
			}
		}
		if (event.type === "agent_end") state.agentEnds++;
		notify();
	};

	const feedStdout = (chunk) => {
		state.lineBuffer = appendBounded(state.lineBuffer, chunk, 1_000_000);
		let newline;
		while ((newline = state.lineBuffer.indexOf("\n")) >= 0) {
			const line = state.lineBuffer.slice(0, newline).replace(/\r$/, "");
			state.lineBuffer = state.lineBuffer.slice(newline + 1);
			if (!line.trim()) continue;
			try { handleEvent(JSON.parse(line)); }
			catch { fail(new Error("Pi RPC emitted malformed JSON")); }
		}
	};

	state.child = spawn(process.execPath, [piCli, ...makeArgs(exocom)], {
		cwd,
		env: makeEnv(exocom),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	state.child.stdin.setDefaultEncoding("utf8");
	state.child.on("error", (error) => fail(error));
	state.child.on("close", (code, signal) => {
		if (!state.stopping && !state.failure) fail(new Error(`Pi RPC exited before verification (code=${code ?? "null"}, signal=${signal ?? "none"})`));
		notify();
	});
	state.child.stdout.setEncoding("utf8");
	state.child.stdout.on("data", (chunk) => feedStdout(String(chunk)));
	// Drain stderr so a verbose provider/CLI failure cannot back up the RPC process, but never
	// retain or print it because auth diagnostics may contain sensitive request details.
	state.child.stderr.on("data", () => {});

	return {
		state,
		sendPrompt(message) {
			if (!state.child?.stdin?.writable) throw new Error("Pi RPC stdin is not writable");
			state.promptCommands++;
			state.child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
		},
		waitFor(predicate, deadline, label) {
			if (state.failure) return Promise.reject(state.failure);
			if (predicate(state)) return Promise.resolve(state);
			const remaining = deadline - Date.now();
			if (remaining <= 0) return Promise.reject(new Error(`${label} exceeded ${modeDeadlineMs}ms`));
			return new Promise((resolveWait, rejectWait) => {
				const waiter = {
					predicate,
					resolve: resolveWait,
					reject: rejectWait,
					timer: setTimeout(() => {
						state.waiters.delete(waiter);
						rejectWait(new Error(`${label} exceeded ${modeDeadlineMs}ms`));
					}, remaining),
				};
				state.waiters.add(waiter);
			});
		},
	};
}

function makeSender(workspace, mode, onInbound) {
	const hash = workspaceHash(workspace);
	const sessionId = `identity-smoke-sender-${mode}-${process.pid}`;
	const name = `identity-smoke-sender-${mode}`;
	return new ExocomPlane({
		agentDir,
		hash,
		identity: {
			session_id: sessionId,
			name,
			persona: "dev",
			purpose: "identity smoke sender",
			color: "#36F9F6",
			model: "smoke/model",
			endpoint: endpoint(agentDir, hash, sessionId, process.platform),
			cwd: workspace,
		},
		getCard: () => ({ name, persona: "dev", model: "smoke/model", context_pct: 0, inbox: 0 }),
		onInbound,
	});
}

async function waitForPeer(sender, childPid, deadline) {
	while (Date.now() < deadline) {
		const peer = sender.listPeers().find((entry) => entry.pid === childPid && entry.persona === "dev");
		if (peer) return peer;
		await delay(Math.min(250, Math.max(1, deadline - Date.now())));
	}
	throw new Error("Exocom receiver did not publish a live registry entry before the deadline");
}

async function waitForNamedPeer(sender, childPid, expectedName, deadline) {
	while (Date.now() < deadline) {
		const peer = sender.listPeers().find((entry) => entry.pid === childPid && entry.persona === "dev");
		if (peer && peer.name === expectedName) return peer;
		await delay(Math.min(250, Math.max(1, deadline - Date.now())));
	}
	throw new Error("Exocom receiver did not publish a nonempty name distinct from persona dev");
}

async function stopRpc(rpc) {
	const child = rpc?.state.child;
	if (!child || child.exitCode !== null || child.pid === undefined) return;
	rpc.state.stopping = true;
	try { killProcessTree(child.pid); } catch { /* best effort */ }
	await new Promise((resolveStopped) => {
		const timer = setTimeout(resolveStopped, 2_000);
		child.once("close", () => {
			clearTimeout(timer);
			resolveStopped();
		});
	});
}

async function runStandalone() {
	const workspace = mkdtempSync(join(tmpdir(), "pi-persona-identity-standalone-"));
	const deadline = Date.now() + modeDeadlineMs;
	let rpc;
	try {
		rpc = createRpc(false, workspace);
		// Neutral task: the naming requirement must come from pi-persona's runtime context.
		rpc.sendPrompt("Reply with exactly the marker IDENTITY_SMOKE_STANDALONE.");
		await rpc.waitFor((state) => state.agentEnds >= 1 && state.toolStarts[0]?.name === "agent_name"
			&& typeof state.name === "string" && state.name.length > 0
			&& state.firstAssistantTextAt !== undefined && state.nameEndAt !== undefined
			&& state.nameEndAt < state.firstAssistantTextAt, deadline, "standalone identity smoke");
		if (rpc.state.promptCommands !== 1) throw new Error("standalone smoke did not issue exactly one user prompt");
		if (!rpc.state.name || rpc.state.name.toLowerCase() === "dev") throw new Error("standalone name is empty or equals active persona dev");
		if (!rpc.state.assistantText.includes(standaloneMarker)) throw new Error("standalone answer did not contain the requested marker");
		console.log(`PASS — standalone: agent_name first, chose a distinct nonempty handle (${rpc.state.name}) before answer`);
	} finally {
		await stopRpc(rpc);
		removeOwnedWorkspace(workspace, "pi-persona-identity-standalone-");
	}
}

async function runReceiver() {
	const workspace = mkdtempSync(join(tmpdir(), "pi-persona-identity-receiver-"));
	const deadline = Date.now() + modeDeadlineMs;
	let rpc;
	let sender;
	let receiverSessionId;
	try {
		rpc = createRpc(true, workspace);
		sender = makeSender(workspace, "receiver", (message, fromEntry) => {
			if (message.in_reply_to && message.text.includes(replyMarker)) {
				rpc.state.replyText = message.text;
				rpc.state.replyAt = Date.now();
			}
		return { accepted: true };
		});
		await sender.start();
		const peer = await waitForPeer(sender, rpc.state.child.pid, deadline);
		receiverSessionId = peer.session_id;
		// This is the receiver's first stimulus. No RPC prompt is sent in this mode.
		await sender.send(peer.target, "Reply with exactly the marker IDENTITY_SMOKE_RECEIVED.");
		await rpc.waitFor((state) => state.replyAt !== undefined, deadline, "receiver peer reply");
		await rpc.waitFor((state) => state.agentEnds >= 1 && state.toolStarts[0]?.name === "exocom_name"
			&& typeof state.name === "string" && state.name.length > 0
			&& state.replyAt !== undefined && state.nameEndAt !== undefined && state.nameEndAt < state.replyAt,
			deadline, "receiver identity smoke");
		const namedPeer = await waitForNamedPeer(sender, rpc.state.child.pid, rpc.state.name, deadline);
		if (rpc.state.promptCommands !== 0) throw new Error("receiver smoke sent a human prompt before the peer wake");
		if (!rpc.state.replyText?.includes(replyMarker)) throw new Error("receiver did not send the requested peer reply");
		if (!namedPeer.name.trim() || namedPeer.name.toLowerCase() === namedPeer.persona.toLowerCase()) {
			throw new Error("receiver registry name is empty or equals active persona dev");
		}
		console.log(`PASS — receiver: peer wake → exocom_name first, chose a distinct nonempty handle (${namedPeer.name}) → reply`);
	} finally {
		if (sender) {
			try { await sender.stop(); } catch { /* best effort */ }
		}
		await stopRpc(rpc);
		removeDeadReceiverEntry(workspace, receiverSessionId, rpc?.state.child?.pid);
		removeOwnedWorkspace(workspace, "pi-persona-identity-receiver-");
	}
}

try {
	console.log(`▶ identity-smoke model=${model} thinking=xhigh`);
	await runStandalone();
	await runReceiver();
	console.log("ALL PASS — identity bootstrap and Exocom first-peer naming verified");
	process.exitCode = 0;
} catch (error) {
	console.error(`FAIL — ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
