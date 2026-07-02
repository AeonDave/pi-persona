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
 * `reply` answers a pending ask via `bus.reply`; `list` answers a `peers` frame scoped to
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
import nodeNet from "node:net";
import type net from "node:net";

import { createFrameReader, encodeFrame } from "./framing.ts";
import { type Frame, isFrame } from "./messages.ts";
import type { InProcessBus } from "../inproc.ts";

export interface BrokerHost {
	endpoint: string;
	close(): Promise<void>;
	connectedHandles(): string[];
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

		const write = (frame: Frame): void => {
			try {
				socket.write(encodeFrame(frame));
			} catch {
				/* peer went away mid-write */
			}
		};

		const cleanup = (): void => {
			for (const ac of pendingAsks.values()) ac.abort();
			pendingAsks.clear();
			if (handle) unregisterConnection(handle);
		};

		const dispatch = (frame: Frame): void => {
			switch (frame.t) {
				case "register": {
					if (frame.handle === deps.supervisorHandle) {
						write({ t: "error", reason: "reserved handle" });
						return;
					}
					handle = frame.handle;
					group = frame.group;
					bus.register(handle);
					connections.set(handle, { write });
					if (frame.peers) peerRegistry.set(handle, { handle, label: frame.label ?? handle, group: frame.group ?? "" });
					write({ t: "registered", handle });
					drain(handle);
					return;
				}
				case "send": {
					if (!handle) {
						write({ t: "error", reason: "send before register" });
						return;
					}
					const from = handle;
					if (frame.expectsReply) {
						const ac = new AbortController();
						pendingAsks.set(frame.msgId, ac);
						bus.ask(from, frame.to, frame.text, { kind: frame.kind, signal: ac.signal }).then(
							(text) => {
								pendingAsks.delete(frame.msgId);
								write({ t: "replied", askId: frame.msgId, text });
							},
							(err: unknown) => {
								pendingAsks.delete(frame.msgId);
								write({ t: "error", reason: err instanceof Error ? err.message : String(err) });
							},
						);
					} else if (!bus.send(from, frame.to, frame.text, frame.kind)) {
						write({ t: "error", reason: `unknown peer: ${frame.to}` });
					}
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
				return;
			}
			try {
				dispatch(raw);
			} catch (e) {
				write({ t: "error", reason: e instanceof Error ? e.message : String(e) });
			}
		};

		socket.on("data", createFrameReader(handleFrame, (e) => {
			write({ t: "error", reason: e.message });
			socket.destroy();
		}));
		socket.on("error", () => socket.destroy());
		socket.once("close", () => {
			sockets.delete(socket);
			cleanup();
		});
	}

	const server = await bindServer(netImpl, deps.endpoint, handleConnection);

	let closed = false;
	return {
		endpoint: deps.endpoint,
		connectedHandles: () => [...connections.keys()],
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			unsubBus();
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
		},
	};
}
