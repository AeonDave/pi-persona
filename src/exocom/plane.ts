/**
 * exocom peer-to-peer plane — binds this instance's own socket/pipe, serves inbound frames
 * (message/ping/bye), sends point-to-point with large-message artifact spill (R3) and a
 * single reconnect on a peer-restarting error (R4), and cleans up on stop.
 *
 * Reuses the broker's length-prefixed framing (`bus/broker/framing.ts`) verbatim, and its
 * stale-socket reclaim probe (`bus/broker/host.ts`'s `isConnectable`/`attemptListen`) —
 * those two are not exported there, so the small probe + bind-attempt helpers are lifted
 * here rather than re-implemented differently.
 */

import { createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import nodeNet from "node:net";
import type net from "node:net";
import { dirname, join } from "node:path";

import { createFrameReader, encodeFrame } from "../bus/broker/framing.ts";
import { frameSigningPayload, isExocomFrame, nextHops, truncateForInject, type AgentCard, type ExocomAck, type ExocomBye, type ExocomFrame, type ExocomMessage, type ExocomNack } from "./envelope.ts";
import { EXOCOM } from "./limits.ts";
import { exocomRoot } from "./paths.ts";
import { normalizePeerName, prune, readAll, removeEntry, writeEntry, type RegistryEntry } from "./registry.ts";

export interface ExocomIdentity {
	session_id: string; name: string; persona: string; purpose: string; color: string;
	model: string; endpoint: string; cwd: string;
}

export type ExocomInboundResult =
	| { accepted: true; duplicate?: boolean }
	| { accepted: false; reason: string };

export interface ExocomPlaneDeps {
	agentDir: string;
	hash: string;
	identity: ExocomIdentity;
	getCard: () => AgentCard;
	onInbound: (m: ExocomMessage, fromEntry: RegistryEntry | undefined) => ExocomInboundResult;
	/** Fired when the live pool changes without our own action — a peer's `bye` (clean shutdown)
	 *  removes it from the registry, so the widget should refresh at once rather than wait for the
	 *  next heartbeat tick. Optional; unset ⇒ no-op. */
	onPoolChange?: () => void;
	now?: () => number;
	/** Injected transport (tests use real sockets/pipes over a temp dir); defaults to `node:net`. */
	net?: typeof import("node:net");
	/** Bounds `send`'s ack-wait (defaults to `EXOCOM.ACK_TIMEOUT_MS`); shrinkable in tests. */
	ackTimeoutMs?: number;
}

const STALE_PROBE_TIMEOUT_MS = 1000;
const RECONNECT_DELAY_MS = 150;
const MAX_TRACKED_HOPS = 1024;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		t.unref?.();
	});
}

function isRestartingError(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	return code === "ECONNREFUSED" || code === "ENOENT";
}

/** A peer accepted the connection but never acked within budget — distinct from a connect
 *  error (R4): the peer is registered and possibly just frozen, not necessarily gone, so
 *  `send` propagates this without pruning the registry (the heartbeat/stale prune is the
 *  right place to evict a genuinely dead entry, not a single slow ack). */
class AckTimeoutError extends Error {}
class PeerNackError extends Error {}
class PeerProtocolError extends Error {}
class PeerAuthenticationError extends Error {}

function verifyFrameOrigin(frame: ExocomFrame, entry: RegistryEntry): boolean {
	if (!frame.signature || !entry.public_key) return false;
	try {
		const key = createPublicKey({ key: Buffer.from(entry.public_key, "base64"), format: "der", type: "spki" });
		return cryptoVerify(null, Buffer.from(frameSigningPayload(frame), "utf8"), key, Buffer.from(frame.signature, "base64"));
	} catch {
		return false;
	}
}

function preparePosixEndpoint(endpoint: string): void {
	if (process.platform === "win32") return;
	const dir = dirname(endpoint);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`exocom: unsafe socket directory ${dir}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`exocom: socket directory is not owned by this user: ${dir}`);
	chmodSync(dir, 0o700);
}

function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => {
		try { server.close(() => resolve()); } catch { resolve(); }
	});
}

/** Probe: is something actually listening at `endpoint`? (lifted from `broker/host.ts`,
 *  which does not export it — same probe, not a different one.) */
function isConnectable(netImpl: typeof import("node:net"), endpoint: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = netImpl.connect(endpoint);
		const finish = (ok: boolean): void => {
			clearTimeout(timer);
			socket.removeListener("connect", onConnect);
			socket.removeListener("error", onError);
			socket.destroy();
			resolve(ok);
		};
		const onConnect = (): void => finish(true);
		const onError = (): void => finish(false);
		socket.once("connect", onConnect);
		socket.once("error", onError);
		const timer = setTimeout(() => finish(false), STALE_PROBE_TIMEOUT_MS);
		timer.unref?.();
	});
}

type ListenAttempt = { server: net.Server } | { code: string };

/** One bind attempt on a fresh server; connection handler wired before `listen()` so no
 *  connection can race it. On success: permanent error sink + `unref()`. */
function attemptListen(netImpl: typeof import("node:net"), endpoint: string, onConnection: (socket: net.Socket) => void): Promise<ListenAttempt> {
	return new Promise((resolve) => {
		const server = netImpl.createServer();
		server.on("connection", onConnection);
		const onError = (err: NodeJS.ErrnoException): void => {
			server.removeListener("listening", onListening);
			try { server.close(); } catch { /* ignore */ }
			resolve({ code: err.code ?? "EUNKNOWN" });
		};
		const onListening = (): void => {
			server.removeListener("error", onError);
			server.on("error", () => { /* permanent sink: a late error must never crash the plane */ });
			server.unref();
			resolve({ server });
		};
		server.once("error", onError);
		server.once("listening", onListening);
		try {
			server.listen(endpoint);
		} catch (err) {
			resolve({ code: (err as NodeJS.ErrnoException).code ?? "EUNKNOWN" });
		}
	});
}

/** Bind `endpoint`, reclaiming a stale POSIX socket file once (mirrors `broker/host.ts`'s
 *  bind pattern, minus its host-election concerns — exocom peers are all equal). Windows
 *  named pipes leave no stale-file state behind, so the reclaim step is POSIX-only. */
async function bindServer(netImpl: typeof import("node:net"), endpoint: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
	let attempt = await attemptListen(netImpl, endpoint, onConnection);
	if (
		!("server" in attempt) &&
		attempt.code === "EADDRINUSE" &&
		process.platform !== "win32" &&
		existsSync(endpoint) &&
		!(await isConnectable(netImpl, endpoint))
	) {
		try { unlinkSync(endpoint); } catch { /* another instance may have reaped it first */ }
		attempt = await attemptListen(netImpl, endpoint, onConnection);
	}
	if (!("server" in attempt)) throw new Error(`exocom plane: failed to listen on ${endpoint} (${attempt.code})`);
	return attempt.server;
}

/** Connect, write one frame, and resolve with the peer's first reply frame (ack/pong).
 *  Bounded by an unref'd `ackTimeoutMs` (R4): a peer that accepts the connection and then
 *  never replies (frozen, wedged) must not hang the caller's turn forever. */
function sendFrame(netImpl: typeof import("node:net"), endpoint: string, frame: ExocomMessage, ackTimeoutMs: number, expected: RegistryEntry): Promise<ExocomAck> {
	return new Promise((resolve, reject) => {
		const socket = netImpl.connect(endpoint);
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		socket.once("connect", () => socket.write(encodeFrame(frame)));
		socket.on("data", createFrameReader(
			(raw) => finish(() => {
				socket.destroy();
				if (!isExocomFrame(raw)) { reject(new PeerProtocolError("exocom: malformed reply frame")); return; }
				if (raw.kind === "nack" && raw.msg_id === frame.msg_id) {
					if (raw.from_session !== expected.session_id || !verifyFrameOrigin(raw, expected)) reject(new PeerAuthenticationError("exocom: unauthenticated nack"));
					else reject(new PeerNackError(raw.error));
					return;
				}
				if (raw.kind !== "ack" || raw.msg_id !== frame.msg_id) { reject(new PeerProtocolError("exocom: unexpected reply frame")); return; }
				if (raw.from_session !== expected.session_id || !verifyFrameOrigin(raw, expected)) { reject(new PeerAuthenticationError("exocom: unauthenticated ack")); return; }
				resolve(raw);
			}),
			(e) => finish(() => { socket.destroy(); reject(e); }),
		));
		socket.once("error", (err) => finish(() => { socket.destroy(); reject(err); }));
		socket.once("close", () => finish(() => reject(new Error("exocom: connection closed before reply"))));
		const timer = setTimeout(() => finish(() => {
			socket.destroy();
			reject(new AckTimeoutError(`exocom: ack timeout from ${endpoint}`));
		}), ackTimeoutMs);
		timer.unref?.();
	});
}

/** Best-effort, fire-and-forget send (used for `bye` — the receiver sends nothing back, so
 *  waiting for a reply frame would hang). Bounded by a short timeout either way. */
function sendNoReply(netImpl: typeof import("node:net"), endpoint: string, frame: ExocomFrame): Promise<void> {
	return new Promise((resolve) => {
		const socket = netImpl.connect(endpoint);
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve();
		};
		socket.once("connect", () => socket.write(encodeFrame(frame), () => socket.end()));
		socket.once("close", finish);
		socket.once("error", finish);
		const timer = setTimeout(finish, STALE_PROBE_TIMEOUT_MS);
		timer.unref?.();
	});
}

export type DisplayPeer = RegistryEntry & { displayName: string };

/** Display-time-only name disambiguation. The registry FILE is keyed by session_id (registry.ts),
 *  so a name collision can never corrupt storage — but two peers named "elite" still need
 *  distinct labels for a human/tool to address. Ties are broken by `session_id` (stable: the
 *  numbering never flaps as peers come and go, unlike ordering by arrival/heartbeat). Never
 *  mutates the stored `.name`; recomputed fresh from the CURRENT live set on every call.
 *  `listPeers()` and `send()`'s target resolution both go through this ONE helper, so the
 *  numbering shown by `exocom_list` can never diverge from what `exocom_send` actually resolves. */
function dedupeDisplayNames(peers: RegistryEntry[]): DisplayPeer[] {
	const byName = new Map<string, RegistryEntry[]>();
	for (const p of peers) {
		const group = byName.get(p.name);
		if (group) group.push(p); else byName.set(p.name, [p]);
	}
	const out: DisplayPeer[] = [];
	for (const group of byName.values()) {
		if (group.length === 1) {
			out.push({ ...group[0]!, displayName: group[0]!.name });
			continue;
		}
		const ordered = [...group].sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0));
		ordered.forEach((p, i) => out.push({ ...p, displayName: i === 0 ? p.name : `${p.name}#${i + 1}` }));
	}
	return out;
}

export class ExocomPlane {
	private readonly deps: ExocomPlaneDeps;
	private readonly netImpl: typeof import("node:net");
	private readonly now: () => number;
	private readonly sockets = new Set<net.Socket>();
	private readonly inboundHops = new Map<string, number>(); // msg_id -> hops (for reply increment)
	private readonly ackTimeoutMs: number;
	private readonly privateKey: KeyObject;
	private readonly publicKey: string;
	private readonly artifacts = new Map<string, string>();
	private server: net.Server | undefined;
	// Viewer-centric per-peer counters, keyed by the PEER's session_id — NOT a global self-report
	// (that read "inverted" on another instance's pool: a peer who sent TO us would show ITS OWN
	// out-count, not what WE received from it). Local to this instance, never published in the
	// registry (registry.ts no longer carries sent/received).
	private readonly sentTo = new Map<string, number>();
	private readonly receivedFrom = new Map<string, number>();

	constructor(deps: ExocomPlaneDeps) {
		this.deps = deps;
		this.netImpl = deps.net ?? nodeNet;
		this.now = deps.now ?? Date.now;
		this.ackTimeoutMs = deps.ackTimeoutMs ?? EXOCOM.ACK_TIMEOUT_MS;
		const pair = generateKeyPairSync("ed25519");
		this.privateKey = pair.privateKey;
		this.publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
	}

	private signFrame<T extends ExocomFrame>(frame: T): T {
		return { ...frame, signature: cryptoSign(null, Buffer.from(frameSigningPayload(frame), "utf8"), this.privateKey).toString("base64") };
	}

	private ack(msgId: string): ExocomAck {
		return this.signFrame({ kind: "ack", msg_id: msgId, from_session: this.deps.identity.session_id });
	}

	private nack(msgId: string, error: string): ExocomNack {
		return this.signFrame({ kind: "nack", msg_id: msgId, error, from_session: this.deps.identity.session_id });
	}

	/** The identity name — display-only (see `RegistryEntry.name`'s doc comment). Nothing left to
	 *  suffix: the registry file is keyed by session_id, so this never diverges from
	 *  `deps.identity.name`, before or after `start()`. */
	get name(): string {
		return normalizePeerName(this.deps.identity.name);
	}

	/** Messages this instance has successfully `send()`'d TO the given peer (ack settled), keyed by
	 *  the peer's session_id — 0 for a peer never sent to. The plane is the SINGLE source of these
	 *  counters — the widget reads them, it never keeps its own. */
	sentToPeer(sessionId: string): number {
		return this.sentTo.get(sessionId) ?? 0;
	}

	/** Inbound `message` frames received FROM the given peer (ping/pong/bye/ack don't count — see
	 *  `handleConnection`'s `onFrame`), keyed by the peer's session_id — 0 for a peer never heard
	 *  from. */
	receivedFromPeer(sessionId: string): number {
		return this.receivedFrom.get(sessionId) ?? 0;
	}

	/** Sum across all peers — the status line's aggregate view. */
	get totalSent(): number {
		return [...this.sentTo.values()].reduce((a, b) => a + b, 0);
	}

	/** Sum across all peers — the status line's aggregate view. */
	get totalReceived(): number {
		return [...this.receivedFrom.values()].reduce((a, b) => a + b, 0);
	}

	async start(): Promise<void> {
		const { agentDir, hash, identity } = this.deps;
		let bound = false;
		try {
			preparePosixEndpoint(identity.endpoint);
			this.server = await bindServer(this.netImpl, identity.endpoint, (s) => this.handleConnection(s));
			bound = true;
			if (process.platform !== "win32") chmodSync(identity.endpoint, 0o600);
			prune(agentDir, hash, { now: this.now(), staleMs: EXOCOM.STALE_AFTER_MS });
			writeEntry(agentDir, hash, this.buildEntry());
			this.cleanupArtifacts();
		} catch (err) {
			const server = this.server;
			this.server = undefined;
			for (const socket of this.sockets) {
				try { socket.destroy(); } catch { /* best-effort rollback */ }
			}
			this.sockets.clear();
			if (server) await closeServer(server);
			if (bound && process.platform !== "win32") {
				try { unlinkSync(identity.endpoint); } catch { /* best-effort */ }
			}
			if (bound) removeEntry(agentDir, hash, identity.session_id);
			throw err;
		}
	}

	/** This instance's registry entry, keyed (by writeEntry) on `identity.session_id` — never on
	 *  `name`, so there is nothing to claim/suffix. The heartbeat re-write (extension.ts) targets
	 *  the SAME file on every call via `writeEntry`. */
	private buildEntry(): RegistryEntry {
		const { identity } = this.deps;
		const card = this.deps.getCard();
		return {
			session_id: identity.session_id, name: this.name, persona: identity.persona, purpose: identity.purpose,
			color: identity.color, model: identity.model, pid: process.pid, endpoint: identity.endpoint,
			cwd: identity.cwd, context_pct: card.context_pct, inbox: card.inbox,
			heartbeat_at: new Date(this.now()).toISOString(),
			public_key: this.publicKey,
		};
	}

	/** Pruned live peers, excluding self, with a display-deduped `displayName` ("elite"/"elite#2")
	 *  computed over the FULL live set (self included) before self is filtered out — so every
	 *  instance computes the SAME numbering for a given peer, regardless of who's asking. */
	listPeers(): DisplayPeer[] {
		const { agentDir, hash, identity } = this.deps;
		const live = prune(agentDir, hash, { now: this.now(), staleMs: EXOCOM.STALE_AFTER_MS });
		return dedupeDisplayNames(live).filter((e) => e.session_id !== identity.session_id);
	}

	private handleConnection(socket: net.Socket): void {
		socket.unref?.(); // M5: an accepted connection must never keep the process alive on its own (mirrors the server's own unref())
		this.sockets.add(socket);
		const write = (frame: ExocomFrame): void => {
			try { socket.write(encodeFrame(frame)); } catch { /* peer went away mid-write */ }
		};
		const onFrame = (raw: unknown): void => {
			if (!isExocomFrame(raw)) return; // fail-closed preflight (R5) — silently drop junk
			switch (raw.kind) {
			case "message": {
					const entry = readAll(this.deps.agentDir, this.deps.hash).find((e) => e.session_id === raw.from_session);
					if (!entry || raw.from_endpoint !== entry.endpoint || !verifyFrameOrigin(raw, entry)) {
						write(this.nack(raw.msg_id, "authentication failed"));
						return;
					}
					let disposition: ExocomInboundResult | undefined;
					try {
						disposition = this.deps.onInbound(raw, entry);
					} catch {
						write(this.nack(raw.msg_id, "receiver rejected message"));
						return;
					}
					if (disposition?.accepted === false) {
						write(this.nack(raw.msg_id, disposition.reason.slice(0, 256) || "receiver rejected message"));
						return;
					}
					if (disposition?.accepted === true && disposition.duplicate === true) {
						write(this.ack(raw.msg_id));
						return;
					}
					this.receivedFrom.set(raw.from_session, (this.receivedFrom.get(raw.from_session) ?? 0) + 1);
					this.inboundHops.set(raw.msg_id, raw.hops);
					if (this.inboundHops.size > MAX_TRACKED_HOPS) {
						const oldest = this.inboundHops.keys().next().value;
						if (oldest !== undefined) this.inboundHops.delete(oldest);
					}
					try { this.deps.onPoolChange?.(); } catch { /* UI refresh must never block the transport ACK */ }
					write(this.ack(raw.msg_id));
					return;
				}
				case "ping":
					write({ kind: "pong", msg_id: raw.msg_id, card: this.deps.getCard() });
					return;
				case "bye": {
					const entry = readAll(this.deps.agentDir, this.deps.hash).find((e) => e.session_id === raw.from_session);
					if (entry && raw.from_endpoint === entry.endpoint && verifyFrameOrigin(raw, entry)) {
						removeEntry(this.deps.agentDir, this.deps.hash, entry.session_id);
						this.deps.onPoolChange?.(); // a peer left cleanly — refresh the pool now, don't wait 30s
					}
					return;
				}
				default:
					return; // ack/pong/nack land on a SENDER's own connection, never here
			}
		};
		socket.on("data", createFrameReader(onFrame, () => socket.destroy()));
		socket.on("error", () => socket.destroy());
		socket.once("close", () => this.sockets.delete(socket));
	}

	private cleanupArtifacts(): void {
		const dir = join(exocomRoot(this.deps.agentDir, this.deps.hash), "artifacts");
		if (!existsSync(dir)) return;
		try {
			const now = Date.now();
			const live: Array<{ path: string; mtime: number }> = [];
			for (const file of readdirSync(dir)) {
				if (!/^[0-9a-f-]{36}\.txt$/i.test(file)) continue;
				const path = join(dir, file);
				const stat = statSync(path);
				if (!stat.isFile()) continue;
				if (now - stat.mtimeMs > EXOCOM.ARTIFACT_TTL_MS) { try { unlinkSync(path); } catch { /* best-effort */ } }
				else live.push({ path, mtime: stat.mtimeMs });
			}
			live.sort((a, b) => a.mtime - b.mtime);
			const excess = Math.max(0, live.length - (EXOCOM.ARTIFACT_MAX_FILES - 1));
			for (let i = 0; i < excess; i++) { try { unlinkSync(live[i]!.path); } catch { /* best-effort */ } }
		} catch { /* cleanup must not break messaging */ }
	}

	private removeArtifact(msgId: string): void {
		const path = this.artifacts.get(msgId);
		if (!path) return;
		try { unlinkSync(path); } catch { /* best-effort */ }
		this.artifacts.delete(msgId);
	}

	/** Spill to a workspace-scoped artifact once the payload exceeds the inline budget (R3);
	 *  the receiver reads `path` on its own turn instead of the full text landing inline. */
	private payloadFor(msgId: string, text: string): string {
		if (Buffer.byteLength(text, "utf8") <= EXOCOM.INLINE_MAX_BYTES) return text;
		const dir = join(exocomRoot(this.deps.agentDir, this.deps.hash), "artifacts");
		mkdirSync(dir, { recursive: true });
		this.cleanupArtifacts();
		const path = join(dir, `${msgId}.txt`);
		writeFileSync(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
		this.artifacts.set(msgId, path);
		const preview = truncateForInject(text, EXOCOM.PREVIEW_BYTES).text;
		return JSON.stringify({ preview, path });
	}

	async send(target: string, text: string, inReplyTo?: string): Promise<{ msg_id: string }> {
		const { agentDir, hash, identity } = this.deps;
		// Resolved against listPeers()'s displayName — the SAME helper (dedupeDisplayNames) that
		// exocom_list shows, so a target like "elite#2" resolves to exactly the peer the list
		// numbered that way, never a different same-named one.
		const entry = this.listPeers().find((e) => e.displayName === target);
		if (!entry) throw new Error(`exocom: unknown peer "${target}"`);

		const msg_id = randomUUID();
		const hops = inReplyTo !== undefined ? nextHops(this.inboundHops.get(inReplyTo) ?? 0) : 0;
		const unsigned: ExocomMessage = {
			kind: "message", msg_id, from_session: identity.session_id, from_endpoint: identity.endpoint,
			from_name: this.name, text: this.payloadFor(msg_id, text), hops, ts: new Date(this.now()).toISOString(),
			...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
		};
		const message = this.signFrame(unsigned);

		try {
			await sendFrame(this.netImpl, entry.endpoint, message, this.ackTimeoutMs, entry);
		} catch (err) {
			// A frozen-but-registered peer (accepted the connection, never acked) is left for
			// the normal heartbeat/stale prune to evict — a single slow ack doesn't warrant
			// mutating the registry here.
			if (err instanceof PeerNackError) { this.removeArtifact(msg_id); throw new Error(`exocom: peer "${target}" rejected message: ${err.message}`); }
			if (err instanceof AckTimeoutError) { this.removeArtifact(msg_id); throw new Error(`exocom: ack timeout from "${target}"`); }
			if (err instanceof PeerAuthenticationError || err instanceof PeerProtocolError) {
				this.removeArtifact(msg_id);
				removeEntry(agentDir, hash, entry.session_id);
				throw new Error(`${err.message} from "${target}"`);
			}
			if (!isRestartingError(err)) {
				this.removeArtifact(msg_id);
				removeEntry(agentDir, hash, entry.session_id);
				throw new Error(`exocom: peer "${target}" unreachable`);
			}
			await delay(RECONNECT_DELAY_MS);
			try {
				await sendFrame(this.netImpl, entry.endpoint, message, this.ackTimeoutMs, entry);
			} catch (err2) {
				this.removeArtifact(msg_id);
				if (err2 instanceof PeerNackError) throw new Error(`exocom: peer "${target}" rejected message: ${err2.message}`);
				if (err2 instanceof AckTimeoutError) throw new Error(`exocom: ack timeout from "${target}"`);
				removeEntry(agentDir, hash, entry.session_id);
				if (err2 instanceof PeerAuthenticationError || err2 instanceof PeerProtocolError) throw new Error(`${err2.message} from "${target}"`);
				throw new Error(`exocom: peer "${target}" unreachable`);
			}
		}
		this.sentTo.set(entry.session_id, (this.sentTo.get(entry.session_id) ?? 0) + 1);
		return { msg_id };
	}

	async stop(): Promise<void> {
		const { agentDir, hash, identity } = this.deps;
		const bye: ExocomBye = this.signFrame({ kind: "bye", from_session: identity.session_id, from_endpoint: identity.endpoint });
		try {
			await Promise.all(this.listPeers().map((p) => sendNoReply(this.netImpl, p.endpoint, bye)));
		} catch { /* shutdown remains best-effort */ }
		for (const s of this.sockets) {
			try { s.destroy(); } catch { /* ignore */ }
		}
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await closeServer(server);
		}
		if (process.platform !== "win32") {
			try { unlinkSync(identity.endpoint); } catch { /* ignore */ }
		}
		removeEntry(agentDir, hash, identity.session_id);
		for (const msgId of [...this.artifacts.keys()]) this.removeArtifact(msgId);
	}
}
