/**
 * exocom peer-to-peer plane — binds this instance's own socket/pipe, serves inbound frames
 * (message/bye), sends point-to-point with large-message artifact spill (R3) and a
 * single reconnect on a peer-restarting error (R4), and cleans up on stop.
 *
 * Reuses the broker's length-prefixed framing (`bus/broker/framing.ts`) verbatim, and its
 * stale-socket reclaim probe (`bus/broker/host.ts`'s `isConnectable`/`attemptListen`) —
 * those two are not exported there, so the small probe + bind-attempt helpers are lifted
 * here rather than re-implemented differently.
 */

import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import nodeNet from "node:net";
import type net from "node:net";
import { dirname, join } from "node:path";

import { createFrameReader, encodeFrame } from "../bus/broker/framing.ts";
import { frameSigningPayload, isExocomFrame, nextHops, parseExocomArtifactDescriptor, truncateForInject, type AgentCard, type ExocomAck, type ExocomArtifactDescriptor, type ExocomBye, type ExocomFrame, type ExocomMessage, type ExocomNack } from "./envelope.ts";
import { EXOCOM } from "./limits.ts";
import { exocomRoot } from "./paths.ts";
import { isAlive, normalizePeerName, prune, readAll, removeEntryIfMatches, writeEntry, type RegistryEntry, type RegistryOwnership } from "./registry.ts";

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
	/** Read-only registry pool read (defaults to `readAll`). Injected so a test can drive the
	 *  registry-unreadable path — the one failure the delivery path has to survive without
	 *  turning a good message into a NACK, and one plain `fs` can't be made to produce. */
	readPool?: (agentDir: string, hash: string) => RegistryEntry[];
	/** Bounds `send`'s ack-wait (defaults to `EXOCOM.ACK_TIMEOUT_MS`); shrinkable in tests. */
	ackTimeoutMs?: number;
	/** Endpoint cleanup seam; production unlinks only POSIX socket paths. */
	unlinkEndpoint?: () => void;
}

const STALE_PROBE_TIMEOUT_MS = 1000;
const RECONNECT_DELAY_MS = 150;
const MAX_TRACKED_HOPS = 1024;

/** Hop history belongs to a message as observed from one sender.  msg_id is only
 * sender-scoped by protocol, so using it alone lets two peers overwrite each
 * other's chain depth. JSON's array encoding is unambiguous for the token fields
 * and keeps the map key independent of any delimiter escaping. */
function inboundHopKey(fromSession: string, msgId: string): string {
	return JSON.stringify([fromSession, msgId]);
}

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

/** Connect, write one frame, and resolve with the peer's ack (or reject on a signed nack).
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

/** `displayName` is the human label (may be renumbered as peers come and go); `target` is the
 *  session-pinned token every caller should ROUTE with. Both are derived, never stored. */
export type DisplayPeer = RegistryEntry & { displayName: string; target: string };

/** A display name is intentionally human-sized, may be shared, and is renumbered from the live
 * set on every read. This qualified token uses a 96-bit session hash, stays within the tool's
 * 80-character budget even for maximum-length names, and is kept separate from human roster
 * labels so a send always addresses the authenticated session it was aimed at. */
function qualifiedTarget(entry: RegistryEntry): string {
	const sessionSuffix = createHash("sha256").update(entry.session_id).digest("hex").slice(0, 24);
	return `${entry.name}@${sessionSuffix}`;
}

function isQualifiedTarget(target: string): boolean {
	return /@[a-f0-9]{24}$/i.test(target);
}

interface InboundContext {
	msg_id: string;
	hops: number;
	entry: RegistryEntry;
	replyTarget: string;
}

/** Display-time-only name disambiguation. The registry FILE is keyed by session_id (registry.ts),
 *  so a name collision can never corrupt storage — but two peers named "orion" still need
 *  distinct labels for a human to read. Ties are broken by `session_id`, so every instance
 *  computes the SAME numbering for one live set; the numbering is NOT stable across time, since
 *  it is recomputed from the CURRENT live set and a group that loses a member gives up its
 *  suffixes. That is precisely why `target` (session-pinned) rides along with every label and is
 *  what routing uses. Never mutates the stored `.name`. */
function dedupeDisplayNames(peers: RegistryEntry[]): DisplayPeer[] {
	const byName = new Map<string, RegistryEntry[]>();
	for (const p of peers) {
		const group = byName.get(p.name);
		if (group) group.push(p); else byName.set(p.name, [p]);
	}
	const out: DisplayPeer[] = [];
	for (const group of byName.values()) {
		if (group.length === 1) {
			out.push({ ...group[0]!, displayName: group[0]!.name, target: qualifiedTarget(group[0]!) });
			continue;
		}
		const ordered = [...group].sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0));
		ordered.forEach((p, i) => out.push({ ...p, displayName: i === 0 ? p.name : `${p.name}#${i + 1}`, target: qualifiedTarget(p) }));
	}
	return out;
}

export class ExocomPlane {
	private readonly deps: ExocomPlaneDeps;
	private readonly netImpl: typeof import("node:net");
	private readonly now: () => number;
	private readonly sockets = new Set<net.Socket>();
	private readonly inboundContext = new Map<string, InboundContext>(); // [from_session,msg_id] -> auth + hops + reply target
	private readonly ackTimeoutMs: number;
	private readonly privateKey: KeyObject;
	private readonly publicKey: string;
	private readonly artifacts = new Map<string, string>();
	private server: net.Server | undefined;
	private readonly unlinkEndpoint: () => void;
	private endpointOwned = false;
	/** Ownership of the registry entry successfully written by this plane.  A plane
	 * may share a session_id with a replacement, so session_id alone is not enough
	 * to clean up safely. */
	private registeredOwnership: RegistryOwnership | undefined;
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
		this.unlinkEndpoint = deps.unlinkEndpoint ?? (() => {
			if (process.platform !== "win32") {
				try { unlinkSync(deps.identity.endpoint); } catch { /* best-effort */ }
			}
		});
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

	/** Inbound `message` frames received FROM the given peer (bye/ack don't count — see
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
		let registeredOnThisStart = false;
		try {
			preparePosixEndpoint(identity.endpoint);
			this.server = await bindServer(this.netImpl, identity.endpoint, (s) => this.handleConnection(s));
			bound = true;
			this.endpointOwned = true;
			if (process.platform !== "win32") chmodSync(identity.endpoint, 0o600);
			prune(agentDir, hash, { now: this.now(), staleMs: EXOCOM.STALE_AFTER_MS });
			const entry = this.buildEntry();
			writeEntry(agentDir, hash, entry);
			this.registeredOwnership = {
				session_id: entry.session_id,
				endpoint: entry.endpoint,
				...(entry.public_key ? { public_key: entry.public_key } : {}),
			};
			registeredOnThisStart = true;
			this.cleanupArtifacts();
		} catch (err) {
			const server = this.server;
			this.server = undefined;
			for (const socket of this.sockets) {
				try { socket.destroy(); } catch { /* best-effort rollback */ }
			}
			this.sockets.clear();
			if (server) await closeServer(server);
			if (bound) {
				try { this.unlinkEndpoint(); } catch { /* best-effort */ }
				this.endpointOwned = false;
			}
			if (registeredOnThisStart && this.registeredOwnership) {
				removeEntryIfMatches(agentDir, hash, this.registeredOwnership);
				this.registeredOwnership = undefined;
			}
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

	/** Re-register this instance with FRESH metadata (a `/persona` switch, a model change) — the
	 *  ONLY supported way to rewrite our own entry. Routing it through the plane is what keeps the
	 *  ed25519 key attached: the entry file can vanish while we are alive (a peer's transient send
	 *  error evicts it, or a >STALE_AFTER_MS stall lets every peer prune it), and a re-creation
	 *  without `public_key` would make every frame we sign unverifiable — permanently, since the
	 *  key exists only in this process. `session_id` is ours by construction, never the caller's. */
	heartbeat(entry: Omit<RegistryEntry, "public_key">): void {
		const { agentDir, hash, identity } = this.deps;
		const owned = { ...entry, session_id: identity.session_id, public_key: this.publicKey };
		writeEntry(agentDir, hash, owned);
		this.registeredOwnership = { session_id: owned.session_id, endpoint: owned.endpoint, public_key: owned.public_key };
	}

	/** Pruned live peers, excluding self, with a display-deduped `displayName` ("orion"/"orion#2")
	 *  computed over the FULL live set (self included) before self is filtered out — so every
	 *  instance computes the SAME numbering for a given peer, regardless of who's asking. */
	listPeers(): DisplayPeer[] {
		const { agentDir, hash, identity } = this.deps;
		const live = prune(agentDir, hash, { now: this.now(), staleMs: EXOCOM.STALE_AFTER_MS });
		return dedupeDisplayNames(live).filter((e) => e.session_id !== identity.session_id);
	}

	/** Read-only live pool used for human labels. Unlike listPeers(), this never prunes: an
	 * authenticated inbound sender may be just past its heartbeat window while its socket is
	 * still serving the message. The same liveness predicate keeps numbering aligned with the
	 * normal roster whenever the registry is healthy. */
	private livePoolForDisplay(): RegistryEntry[] {
		const now = this.now();
		return this.pool().filter((entry) => {
			const heartbeat = Date.parse(entry.heartbeat_at);
			return isAlive(entry.pid) && Number.isFinite(heartbeat) && now - heartbeat <= EXOCOM.STALE_AFTER_MS;
		});
	}

	/** The whole registry pool, read-only (the `readPool` seam's single choke point). */
	private pool(): RegistryEntry[] {
		const { agentDir, hash } = this.deps;
		return this.deps.readPool ? this.deps.readPool(agentDir, hash) : readAll(agentDir, hash);
	}

	/** Resolve a session-qualified token. A REPLY may still reach a sender whose registry entry
	 * has already been pruned (the whole pool is searched before `listPeers()` would evict it) —
	 * direct stale targeting stays limited to replies, so an ordinary send resolves only against
	 * the live roster `exocom_list` publishes. */
	private qualifiedPeer(target: string, inReplyTo: string | undefined): RegistryEntry | undefined {
		if (!isQualifiedTarget(target)) return undefined;
		try {
			if (inReplyTo === undefined) return this.listPeers().find((entry) => qualifiedTarget(entry) === target);
			const own = this.deps.identity.session_id;
			return this.pool().find((entry) => entry.session_id !== own && qualifiedTarget(entry) === target);
		} catch {
			return undefined;
		}
	}

	/** An authenticated inbound frame pins its endpoint/key even if its registry
	 * file is pruned before the supervisor gets a chance to answer. Match the exact
	 * target token emitted for that frame, not merely a shared raw name. */
	private cachedReplyPeer(target: string, msgId: string): RegistryEntry | undefined {
		for (const context of this.inboundContext.values()) {
			if (context.msg_id === msgId && context.replyTarget === target) return context.entry;
		}
		return undefined;
	}

	private hasCachedReply(msgId: string): boolean {
		for (const context of this.inboundContext.values()) if (context.msg_id === msgId) return true;
		return false;
	}

	/** Stable, routable token for an authenticated inbound sender. Human display
	 * names remain the concern of `listPeers()`/`exocom_list`; reply hints always
	 * use this token so a later prune or same-name peer cannot retarget them. */
	replyTargetFor(entry: RegistryEntry): string {
		return qualifiedTarget(entry);
	}

	/** Compatibility alias for callers that used the old reply-hint method name. */
	displayNameFor(entry: RegistryEntry): string {
		return this.replyTargetFor(entry);
	}

	/** Human-facing, stable label for an authenticated registry entry. This is deliberately
	 * separate from replyTargetFor(): display labels may be `name#2`, while routing always uses
	 * the qualified session token. A registry read failure degrades to the entry's own sanitized
	 * name so naming cannot reject an otherwise valid inbound message. */
	humanDisplayLabelFor(entry: RegistryEntry): string {
		try {
			const live = this.livePoolForDisplay();
			const display = dedupeDisplayNames(live).find((peer) => peer.session_id === entry.session_id);
			if (display) return display.displayName;
			const siblings = live.filter((peer) => peer.name === entry.name);
			if (siblings.length > 0) return `${entry.name}@${createHash("sha256").update(entry.session_id).digest("hex").slice(0, 8)}`;
		} catch {
			/* Human naming must never block authenticated delivery. */
		}
		return entry.name;
	}

	/** Registry lookup for an inbound frame's claimed sender. Fails CLOSED: an unreadable pool
	 *  yields no entry (⇒ "authentication failed"), rather than escaping the frame reader — which
	 *  poisons the connection, so the sender reads it as unreachable and evicts US. */
	private lookupPeer(sessionId: string): RegistryEntry | undefined {
		try {
			return this.pool().find((e) => e.session_id === sessionId);
		} catch {
			return undefined;
		}
	}

	/** A spill descriptor is a CLAIM about a file, and the receiver turns it into `Full payload:
	 *  <path>` for its own model plus a byte charge against the sender's window (exocom/inbound.ts).
	 *  The peer authors both fields, so verify them against local ground truth here — the only
	 *  layer that has it — before the claim can become an instruction to read something. All peers
	 *  in one registry share `agentDir`+`hash` by construction (that pair IS the registry both
	 *  sides read), so `payloadFor`'s path is byte-exact on this side too. Returns a nack reason,
	 *  or undefined when the message carries no descriptor / a verified one. */
	private artifactClaimError(msg: ExocomMessage): string | undefined {
		const descriptor = parseExocomArtifactDescriptor(msg.text);
		if (!descriptor) return undefined;
		const expected = join(exocomRoot(this.deps.agentDir, this.deps.hash), "artifacts", `${msg.msg_id}.txt`);
		if (descriptor.path !== expected) return "artifact path is not this workspace's spill for that message";
		let actual: number;
		try {
			const stat = statSync(expected);
			if (!stat.isFile()) return "artifact payload is not a file";
			actual = stat.size;
		} catch {
			return "artifact payload is missing";
		}
		if (actual !== descriptor.size) return "artifact size does not match the payload on disk";
		// Only a payload the sender could not inline may travel as an artifact (see `payloadFor`);
		// anything smaller belongs in the message text, where the inject budget governs it.
		if (actual <= EXOCOM.INLINE_MAX_BYTES) return "artifact payload fits the inline budget";
		return undefined;
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
					const entry = this.lookupPeer(raw.from_session);
					if (!entry || raw.from_endpoint !== entry.endpoint || !verifyFrameOrigin(raw, entry)) {
						write(this.nack(raw.msg_id, "authentication failed"));
						return;
					}
					const artifactError = this.artifactClaimError(raw);
					if (artifactError) {
						write(this.nack(raw.msg_id, artifactError));
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
					this.inboundContext.set(inboundHopKey(raw.from_session, raw.msg_id), {
						msg_id: raw.msg_id, hops: raw.hops, entry, replyTarget: this.replyTargetFor(entry),
					});
					if (this.inboundContext.size > MAX_TRACKED_HOPS) {
						const oldest = this.inboundContext.keys().next().value;
						if (oldest !== undefined) this.inboundContext.delete(oldest);
					}
					try { this.deps.onPoolChange?.(); } catch { /* UI refresh must never block the transport ACK */ }
					write(this.ack(raw.msg_id));
					return;
				}
				case "bye": {
					const entry = this.lookupPeer(raw.from_session);
					if (entry && raw.from_endpoint === entry.endpoint && verifyFrameOrigin(raw, entry)) {
						removeEntryIfMatches(this.deps.agentDir, this.deps.hash, entry);
						this.deps.onPoolChange?.(); // a peer left cleanly — refresh the pool now, don't wait 30s
					}
					return;
				}
				default:
					return; // ack/nack land on a SENDER's own connection, never here
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
		const descriptor: ExocomArtifactDescriptor = {
			kind: "exocom_artifact",
			preview: truncateForInject(text, EXOCOM.PREVIEW_BYTES).text,
			path,
			size: Buffer.byteLength(text, "utf8"),
		};
		return JSON.stringify(descriptor);
	}

	async send(target: string, text: string, inReplyTo?: string): Promise<{ msg_id: string }> {
		const { agentDir, hash, identity } = this.deps;
		// Routing order: the authenticated inbound context (replies), then the session-qualified
		// token, then the human display name. A qualified token names ONE session, so it NEVER
		// falls back to a display name — peer names are self-chosen and unreserved, and
		// `normalizePeerName` keeps `@`, so a peer can register another's token as its own label.
		const cachedReply = inReplyTo !== undefined ? this.cachedReplyPeer(target, inReplyTo) : undefined;
		if (inReplyTo !== undefined && this.hasCachedReply(inReplyTo) && !cachedReply) {
			throw new Error(`exocom: reply target "${target}" does not match the authenticated sender for "${inReplyTo}"`);
		}
		const qualified = this.qualifiedPeer(target, inReplyTo);
		if (isQualifiedTarget(target) && !cachedReply && !qualified) {
			throw new Error(inReplyTo === undefined
				? `exocom: unknown qualified target "${target}"`
				: `exocom: unknown qualified reply target "${target}"`);
		}
		const entry = cachedReply
			?? qualified
			?? this.listPeers().find((e) => e.displayName === target);
		if (!entry) throw new Error(`exocom: unknown peer "${target}"`);

		const msg_id = randomUUID();
		const hops = inReplyTo !== undefined ? nextHops(this.inboundContext.get(inboundHopKey(entry.session_id, inReplyTo))?.hops ?? 0) : 0;
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
				removeEntryIfMatches(agentDir, hash, entry);
				throw new Error(`${err.message} from "${target}"`);
			}
			if (!isRestartingError(err)) {
				this.removeArtifact(msg_id);
				removeEntryIfMatches(agentDir, hash, entry);
				throw new Error(`exocom: peer "${target}" unreachable`);
			}
			await delay(RECONNECT_DELAY_MS);
			try {
				await sendFrame(this.netImpl, entry.endpoint, message, this.ackTimeoutMs, entry);
			} catch (err2) {
				this.removeArtifact(msg_id);
				if (err2 instanceof PeerNackError) throw new Error(`exocom: peer "${target}" rejected message: ${err2.message}`);
				if (err2 instanceof AckTimeoutError) throw new Error(`exocom: ack timeout from "${target}"`);
				removeEntryIfMatches(agentDir, hash, entry);
				if (err2 instanceof PeerAuthenticationError || err2 instanceof PeerProtocolError) throw new Error(`${err2.message} from "${target}"`);
				throw new Error(`exocom: peer "${target}" unreachable`);
			}
		}
		// Delivered: the spill file now belongs to the RECEIVER's later turn (EXOCOM.ARTIFACT_TTL_MS),
		// so drop our claim on it — `stop()` must never reap a handed-off artifact, and the TTL /
		// max-files sweep in `cleanupArtifacts` is what reclaims it.
		this.artifacts.delete(msg_id);
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
		if (this.endpointOwned) {
			try { this.unlinkEndpoint(); } catch { /* ignore */ }
			this.endpointOwned = false;
		}
		const ownership = this.registeredOwnership;
		if (ownership) {
			removeEntryIfMatches(agentDir, hash, ownership);
			this.registeredOwnership = undefined;
		}
		for (const msgId of [...this.artifacts.keys()]) this.removeArtifact(msgId); // only spills whose send never landed are still tracked here
		// A DELIVERED spill is deliberately left for its receiver's later turn, so its reclamation
		// falls to the TTL/max-files sweep — which otherwise runs only on a plane start or the next
		// spill. In a workspace where exocom is never enabled again, that is never: sweeping on the
		// way out bounds the retention without touching anything still inside its TTL.
		this.cleanupArtifacts();
	}
}
