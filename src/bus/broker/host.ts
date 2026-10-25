/**
 * Broker host — the supervisor-side relay (spec B2): listens on the session-scoped
 * endpoint (`paths.ts`) and RELAYS every connected client's frames into (and out of) the
 * local `InProcessBus`, so a remote (child-process) participant is indistinguishable from
 * an in-process one to the rest of pi-persona (intercom, idle notifier, f9, peek, …) —
 * the "same surface" promise `bus/inproc.ts`'s header makes, kept literally.
 *
 * Inbound (client → bus): `register` proxies `bus.register(handle)` (a client claiming
 * the reserved `supervisorHandle` is rejected — the in-process supervisor never dials in,
 * so a remote impersonating it would hijack the supervisor's own inbox); `send` becomes
 * `bus.send`, or — when `expectsReply` — `bus.ask` run ON BEHALF of the remote sender (the
 * bus mints its own ask id; the host correlates it back to the client's `msgId` via the
 * settled promise, so an eventual `bus.reply`/local answer produces a `replied` frame);
 * `cancel` aborts only the ask owned by that same socket; `reply` answers a pending ask via
 * `bus.reply`; `list` answers a `peers` frame scoped to
 * the caller's own registered group (B7); `bye`/socket close proxies `bus.unregister`.
 *
 * Outbound (bus → client): one `bus.onMessage` subscription drains (`bus.takeWhere`,
 * mirroring the in-process delivery bridge in `engine/inproc.ts`) any envelope addressed
 * to a connected remote handle — both kinds, since the host is that handle's ONLY
 * consumer — and forwards it as a `deliver` frame (a blocking ask included: the remote
 * side answers with a `reply` frame, resolved via the same `bus.reply` path above).
 *
 * Cross-process safety mirrors comtac's `broker/embedded.ts` MINUS its 12-attempt host
 * election (the supervisor is always the sole host, spec B1): POSIX stale-socket reclaim
 * before `listen` (unlink only a socket that is provably not connectable), a permanent
 * `error` sink on every server/socket, `server.unref()` so the host never keeps Pi alive,
 * idempotent teardown.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import nodeNet from "node:net";
import type net from "node:net";

import { createFrameReader, encodeFrame } from "./framing.ts";
import { type Frame, isFrame } from "./messages.ts";
import type { InProcessBus } from "../inproc.ts";
import { isReadReplyFor, readFailure, RESULT_READ_MAX_FRAME_BYTES, RESULT_READ_MAX_PENDING,
	RESULT_READ_MAX_REQUESTS, RESULT_READ_TIMEOUT_MS, type PreparedResultReader, type ReadReply,
	type ScopedReader } from "../result-reader.ts";

export interface BrokerHost {
	endpoint: string;
	close(): Promise<void>;
	connectedHandles(): string[];
	/** Parent-only preflight. Reserve before bus/adapter registration or spawning. */
	prepareResultReader(handle: string, reader: ScopedReader, signal?: AbortSignal): Promise<PreparedResultReader>;
	/** Pushes a `steer` frame directly to a connected handle (spec B4) — the supervisor's own
	 *  live voice, NOT a bus envelope (it bypasses `bus.send`/the outbound drain entirely, so
	 *  it can't be mistaken for a peer/child message on the wire). Returns false (a harmless
	 *  no-op, mirrors `InProcessBus.reply`'s unknown-id return) when the handle is not
	 *  currently connected AND was never `expect()`ed — e.g. a typo, or already forgotten.
	 *  A handle `expect()`ed during spawn-before-connect buffers the steer and still returns
	 *  true; the buffer flushes when the child registers. */
	steer(handle: string, text: string): boolean;
	/** Mark `handle` as a child that is about to connect (adapter pre-register). A steer
	 *  to an expected-but-not-yet-connected handle is buffered rather than reported as lost. */
	expect(handle: string): void;
	/** Drop expectation + any buffered steers (adapter unregister / spawn failure). */
	forget(handle: string): void;
}

type PeerEntry = { handle: string; label: string };

export interface StartBrokerHostDeps {
	bus: InProcessBus;
	/** Reserved — `register{handle: supervisorHandle}` from a client is rejected. */
	supervisorHandle: string;
	endpoint: string;
	/** Injected transport (tests use a paired in-memory fake); defaults to real `node:net`. */
	net?: typeof import("node:net");
	/** Answers a `list` frame; default reads the host's own `peers:true` registrations. */
	listPeersFor?: (group: string, self: string) => PeerEntry[];
}

const STALE_PROBE_TIMEOUT_MS = 1000;

/** Probe a POSIX socket path: is something actually listening there? */
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
	});
}

type ListenAttempt = { server: net.Server } | { code: string };

/** One bind attempt on a FRESH server (a server that failed to listen is not reused —
 *  mirrors comtac's `listenOnce`). Wires the connection handler before `listen()` so no
 *  connection can race the handler being attached. On success: permanent error sink + unref. */
function attemptListen(netImpl: typeof import("node:net"), endpoint: string, onConnection: (socket: net.Socket) => void): Promise<ListenAttempt> {
	return new Promise((resolve) => {
		const server = netImpl.createServer();
		server.on("connection", onConnection);
		const onError = (err: NodeJS.ErrnoException): void => {
			server.removeListener("listening", onListening);
			try {
				server.close();
			} catch {
				/* ignore */
			}
			resolve({ code: err.code ?? "EUNKNOWN" });
		};
		const onListening = (): void => {
			server.removeListener("error", onError);
			server.on("error", () => {
				/* permanent sink: a late server error must never crash the host */
			});
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

/** Bind `endpoint`, reclaiming a stale POSIX socket file once (comtac `embedded.ts:103-114`,
 *  minus the host-election loop — the supervisor is the sole host). */
async function bindServer(netImpl: typeof import("node:net"), endpoint: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
	let attempt = await attemptListen(netImpl, endpoint, onConnection);
	if (
		!("server" in attempt) &&
		attempt.code === "EADDRINUSE" &&
		process.platform !== "win32" &&
		existsSync(endpoint) &&
		!(await isConnectable(netImpl, endpoint))
	) {
		try {
			unlinkSync(endpoint);
		} catch {
			/* another session may have reaped it first */
		}
		attempt = await attemptListen(netImpl, endpoint, onConnection);
	}
	if (!("server" in attempt)) {
		throw new Error(`broker host: failed to listen on ${endpoint} (${attempt.code})`);
	}
	return attempt.server;
}

export async function startBrokerHost(deps: StartBrokerHostDeps): Promise<BrokerHost> {
	const netImpl = deps.net ?? nodeNet;
	const bus = deps.bus;

	const connections = new Map<string, { write: (frame: Frame) => void }>();
	const peerRegistry = new Map<string, { handle: string; label: string; group: string }>();
	const sockets = new Set<net.Socket>();
	const expected = new Set<string>();
	const pendingSteer = new Map<string, string[]>();
	type Grant = { token: Buffer; reader: ScopedReader; active: boolean; bound: boolean; stop?: () => void; revoke: () => void };
	const grants = new Map<string, Grant>();
	let closed = false;

	function revokeReader(reader: ScopedReader): void {
		try { reader.revoke(); } catch { /* cleanup cannot leak callback errors or strand siblings */ }
	}

	async function prepareResultReader(handle: string, reader: ScopedReader, signal?: AbortSignal): Promise<PreparedResultReader> {
		if (closed || signal?.aborted || !handle || handle.length > 256 || handle === deps.supervisorHandle
			|| connections.has(handle) || grants.has(handle) || expected.has(handle) || bus.participants().includes(handle)) {
			revokeReader(reader);
			throw new Error("Result reader preparation refused.");
		}
		const token = randomBytes(32);
		const grant: Grant = { token, reader, active: true, bound: false, revoke: () => {
			if (!grant.active) return;
			grant.active = false;
			signal?.removeEventListener("abort", grant.revoke);
			if (grants.get(handle) === grant) {
				grants.delete(handle);
				expected.delete(handle);
				pendingSteer.delete(handle);
			}
			token.fill(0);
			grant.stop?.();
			revokeReader(reader);
		} };
		grants.set(handle, grant);
		expected.add(handle);
		signal?.addEventListener("abort", grant.revoke, { once: true });
		return { token: token.toString("hex"), revoke: grant.revoke, wasBound: () => grant.bound };
	}

	function flushPendingSteer(handle: string): void {
		const conn = connections.get(handle);
		const queued = pendingSteer.get(handle);
		if (!conn || !queued) return;
		pendingSteer.delete(handle);
		for (const text of queued) conn.write({ t: "steer", text });
	}

	function unregisterConnection(handle: string): void {
		if (!connections.delete(handle)) return;
		peerRegistry.delete(handle);
		bus.unregister(handle);
	}

	function defaultPeersFor(group: string, self: string): PeerEntry[] {
		return [...peerRegistry.values()]
			.filter((p) => p.group === group && p.handle !== self)
			.map((p) => ({ handle: p.handle, label: p.label }));
	}

	/** Forward every queued envelope addressed to `handle` as a `deliver` frame — both
	 *  kinds, blocking ask included (the host is this handle's only consumer). */
	function drain(handle: string): void {
		const conn = connections.get(handle);
		if (!conn) return;
		for (const env of bus.takeWhere(handle, () => true)) {
			const fromLabel = peerRegistry.get(env.from)?.label;
			conn.write({
				t: "deliver",
				from: env.from,
				kind: env.kind,
				text: env.text,
				msgId: env.id,
				expectsReply: env.expectsReply,
				...(fromLabel ? { fromLabel } : {}),
			});
		}
	}

	const unsubBus = bus.onMessage((env) => {
		if (connections.has(env.to)) drain(env.to);
	});

	function handleConnection(socket: net.Socket): void {
		sockets.add(socket);
		let handle: string | undefined;
		let group: string | undefined;
		const pendingAsks = new Map<string, AbortController>();
		let ended = false;
		let boundGrant: Grant | undefined;
		const seenReads = new Set<string>();
		const pendingReads = new Map<string, { ac: AbortController; finish: (result?: ReadReply) => void }>();

		const write = (frame: Frame): void => {
			try {
				const encoded = encodeFrame(frame);
				if (frame.t === "result_read_reply" && encoded.length > RESULT_READ_MAX_FRAME_BYTES) {
					socket.write(encodeFrame({ t: "result_read_reply", reqId: frame.reqId, result: readFailure("protocol") }));
					return;
				}
				socket.write(encoded);
			} catch {
				/* peer went away mid-write */
			}
		};
		/** This connection's identity in `connections` — compared on cleanup so a socket only
		 *  ever tears down a registration it still OWNS. */
		const conn = { write };

		const cleanup = (): void => {
			if (ended) return;
			ended = true;
			for (const pending of pendingReads.values()) { pending.finish(); pending.ac.abort(); }
			seenReads.clear();
			boundGrant?.revoke();
			for (const ac of pendingAsks.values()) ac.abort();
			pendingAsks.clear();
			// `bye` releases the handle while `handle` stays set (the socket's own `close`
			// runs cleanup again, asynchronously); by then another connection may legitimately
			// have claimed the freed handle, and unregistering blind would kill ITS live entry.
			if (handle && connections.get(handle) === conn) unregisterConnection(handle);
		};
		const forgetAsk = (msgId: string, ac: AbortController): void => {
			if (pendingAsks.get(msgId) === ac) pendingAsks.delete(msgId);
		};
		const errorReason = (error: unknown): string => error instanceof Error ? error.message : String(error);

		const dispatch = (frame: Frame): void => {
			if (ended) return;
			switch (frame.t) {
				case "result_read": {
					const grant = boundGrant;
					const respond = (result: ReadReply): void => write({ t: "result_read_reply", reqId: frame.reqId, result });
					if (!handle || connections.get(handle) !== conn || !grant?.active) { respond(readFailure("denied")); return; }
					if (seenReads.has(frame.reqId)) {
						const pending = pendingReads.get(frame.reqId);
						pending?.finish();
						pending?.ac.abort();
						respond(readFailure("protocol"));
						return;
					}
					if (seenReads.size >= RESULT_READ_MAX_REQUESTS) { grant.revoke(); return; }
					seenReads.add(frame.reqId);
					if (pendingReads.size >= RESULT_READ_MAX_PENDING) { respond(readFailure("busy")); return; }
					const { t: _t, reqId, ...request } = frame;
					const ac = new AbortController();
					const finish = (result?: ReadReply): void => {
						if (pendingReads.get(reqId)?.ac !== ac) return;
						pendingReads.delete(reqId);
						clearTimeout(timer);
						if (result && !ended && grant.active && handle && connections.get(handle) === conn) respond(result);
					};
					const timer = setTimeout(() => { finish(readFailure("timeout")); ac.abort(); }, RESULT_READ_TIMEOUT_MS);
					timer.unref?.();
					pendingReads.set(reqId, { ac, finish });
					void Promise.resolve().then(() => {
						if (ac.signal.aborted || !grant.active) return readFailure("revoked");
						return grant.reader.read(request, ac.signal);
					}).then((result) => {
						try { finish(isReadReplyFor(result, request) ? result : readFailure("protocol")); }
						catch { finish(readFailure("protocol")); }
					}, () => finish(readFailure("unavailable")));
					return;
				}
				case "result_read_cancel": {
					const pending = pendingReads.get(frame.reqId);
					pending?.finish(readFailure("cancelled"));
					pending?.ac.abort();
					return;
				}
				case "register": {
					const reject = (reason: string): void => {
						write({ t: "error", reason });
						if (frame.readerToken !== undefined || grants.has(frame.handle)) socket.destroy();
					};
					if (frame.handle === deps.supervisorHandle) {
						reject("reserved handle");
						return;
					}
					// Registration is one-shot per socket and exclusive per handle: a
					// second claim would overwrite the live entry, and this socket's close
					// would then unregister a handle it no longer owns (or leak the one it
					// silently abandoned).
					if (handle) {
						reject("already registered");
						return;
					}
					if (connections.has(frame.handle)) {
						reject("handle already connected");
						return;
					}
					const grant = grants.get(frame.handle);
					// A supplied unknown/expired token never falls through to ordinary registration.
					if (grant || frame.readerToken !== undefined) {
						if (!grant?.active || grant.bound || !frame.readerToken
							|| !timingSafeEqual(grant.token, Buffer.from(frame.readerToken, "hex"))) {
							reject("result reader authentication failed");
							return;
						}
						grant.bound = true;
						boundGrant = grant;
						grant.stop = () => { if (!ended) { cleanup(); socket.destroy(); } };
					}
					handle = frame.handle;
					group = frame.group;
					bus.register(handle);
					connections.set(handle, conn);
					if (frame.peers) peerRegistry.set(handle, { handle, label: frame.label ?? handle, group: frame.group ?? "" });
					write({ t: "registered", handle, ...(frame.readerToken ? { readerToken: frame.readerToken } : {}) });
					drain(handle);
					flushPendingSteer(handle);
					return;
				}
				case "send": {
					if (!handle) {
						write({ t: "error", reason: "send before register", msgId: frame.msgId });
						return;
					}
					const from = handle;
					if (frame.expectsReply) {
						const ac = new AbortController();
						pendingAsks.set(frame.msgId, ac);
						try {
							bus.ask(from, frame.to, frame.text, { kind: frame.kind, signal: ac.signal }).then(
								(text) => {
									forgetAsk(frame.msgId, ac);
									write({ t: "replied", askId: frame.msgId, text });
								},
								(err: unknown) => {
									forgetAsk(frame.msgId, ac);
									write({ t: "error", reason: errorReason(err), msgId: frame.msgId });
								},
							);
						} catch (error) {
							forgetAsk(frame.msgId, ac);
							write({ t: "error", reason: errorReason(error), msgId: frame.msgId });
						}
					} else {
						// Admission is not an answer. Unknown/full inboxes both return false;
						// never label a full inbox "unknown peer" or a socket write "delivered".
						let delivered = false;
						try { delivered = bus.send(from, frame.to, frame.text, frame.kind); } catch { /* no confirmation */ }
						write({ t: "sent", msgId: frame.msgId, delivered });
					}
					return;
				}
				case "cancel": {
					if (!handle) {
						write({ t: "error", reason: "cancel before register", msgId: frame.msgId });
						return;
					}
					// The map is per socket/registered participant. A child can only cancel an
					// ask that this same connection originated; an id from another peer is ignored.
					pendingAsks.get(frame.msgId)?.abort();
					return;
				}
				case "reply": {
					bus.reply(frame.askId, frame.text);
					return;
				}
				case "list": {
					const self = handle ?? "";
					const g = group ?? "";
					const peers = deps.listPeersFor ? deps.listPeersFor(g, self) : defaultPeersFor(g, self);
					write({ t: "peers", reqId: frame.reqId, peers });
					return;
				}
				case "bye": {
					cleanup();
					socket.end();
					return;
				}
				default:
					return; // host→client-only frame types received from a client are ignored
			}
		};

		const handleFrame = (raw: unknown): void => {
			if (!isFrame(raw)) {
				write({ t: "error", reason: "invalid frame" });
				if (boundGrant || (typeof raw === "object" && raw !== null
					&& ("readerToken" in raw || ("t" in raw && String(raw.t).startsWith("result_read"))))) socket.destroy();
				return;
			}
			try {
				dispatch(raw);
			} catch (e) {
				write({
					t: "error",
					reason: e instanceof Error ? e.message : String(e),
					...(raw.t === "send" && raw.expectsReply ? { msgId: raw.msgId } : {}),
				});
			}
		};

		socket.on("data", createFrameReader(handleFrame, () => {
			// JSON parser diagnostics can contain the private registration token.
			write({ t: "error", reason: "invalid frame" });
			socket.destroy();
		}));
		socket.on("error", () => socket.destroy());
		socket.once("close", () => {
			sockets.delete(socket);
			cleanup();
		});
	}

	const server = await bindServer(netImpl, deps.endpoint, handleConnection);

	return {
		endpoint: deps.endpoint,
		prepareResultReader,
		connectedHandles: () => [...connections.keys()],
		steer(handle: string, text: string): boolean {
			const conn = connections.get(handle);
			if (conn) {
				conn.write({ t: "steer", text });
				return true;
			}
			if (!expected.has(handle) || !text.trim()) return false;
			const queued = pendingSteer.get(handle) ?? [];
			queued.push(text);
			pendingSteer.set(handle, queued);
			return true;
		},
		expect(handle: string): void {
			expected.add(handle);
		},
		forget(handle: string): void {
			grants.get(handle)?.revoke();
			expected.delete(handle);
			pendingSteer.delete(handle);
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			for (const grant of grants.values()) grant.revoke();
			unsubBus();
			expected.clear();
			pendingSteer.clear();
			for (const h of [...connections.keys()]) unregisterConnection(h);
			for (const s of [...sockets]) {
				try {
					s.destroy();
				} catch {
					/* ignore */
				}
			}
			sockets.clear();
			await new Promise<void>((resolve) => {
				try {
					server.close(() => resolve());
				} catch {
					resolve();
				}
			});
			if (process.platform !== "win32") {
				try {
					unlinkSync(deps.endpoint);
				} catch {
					/* already gone, or this was a fake/in-memory endpoint */
				}
			}
		},
	};
}
