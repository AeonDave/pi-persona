/**
 * Broker client — the child-side half of the relay (spec B3/B6): connects to the
 * session-scoped endpoint (`paths.ts`), performs the `register`/`registered` handshake,
 * and exposes the same shape a local `contact_supervisor`/`contact_peer` binding needs —
 * `send` (fire-and-forget), `ask` (a blocking `send{expectsReply}` correlated to a
 * `replied{askId}`, 10-minute cap, mirrors `bus.ask`, and sends `cancel{msgId}` when
 * aborted), `reply` (answers a host-issued
 * blocking `deliver`), `list` (the engine-scoped peer roster, B7), and `onDeliver`/`onSteer`
 * for inbound frames. A future bridge (`src/bridge.ts`) wires these onto Pi tools; this
 * module has no Pi imports.
 *
 * Ported from comtac `broker/client.ts`, slimmed to the B6 frame set and to what a
 * per-session child — which lives strictly less than the run — actually needs: capped
 * exponential backoff (250ms–5s) on the INITIAL connect only (comtac's presence tracking,
 * roster cache, and endless reconnect-after-disconnect "storm" are dropped — YAGNI here,
 * see spec B6/Task 4 brief). An unexpected disconnect (host died
 * mid-run) is NOT auto-reconnected: sends silently go nowhere, while in-flight asks/lists
 * reject promptly and clean up their timers. Authenticated result readers are stricter:
 * one connect attempt, bounded handshake/reads, closed failure replies, never mute success.
 *
 * Pure over an injected socket factory (`net`), mirroring `host.ts`'s `net` param — same
 * transport-injection seam, opposite side of the same fake in tests.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import nodeNet from "node:net";
import type net from "node:net";

import { createFrameReader, encodeFrame } from "./framing.ts";
import { type Frame, isFrame, isReaderToken } from "./messages.ts";
import { isReadRequest, isReadReplyFor, readFailure, RESULT_READ_MAX_PENDING, RESULT_READ_TIMEOUT_MS,
	type ReadReply, type ResultReadRequest } from "../result-reader.ts";
import type { MsgKind } from "../inproc.ts";

export interface DeliverEvent {
	from: string;
	fromLabel?: string;
	kind: MsgKind;
	text: string;
	msgId: string;
	expectsReply: boolean;
}

export interface BrokerClient {
	/** Register once. Ordinary comms back off on initial connect; reader grants never retry. */
	register(): Promise<void>;
	/** Authenticated bounded read. Failures are fixed closed replies; never a mute success. */
	read(request: ResultReadRequest, signal?: AbortSignal): Promise<ReadReply>;
	/** Fire-and-forget; a dead connection silently drops it (spec: "sends report undelivered"). */
	send(to: string, kind: MsgKind, text: string): void;
	/** Blocking request; resolves on a matching `replied`, rejects on `signal` abort or the
	 *  10-minute cap (mirrors `bus.ask`'s default). */
	ask(to: string, kind: MsgKind, text: string, signal?: AbortSignal): Promise<string>;
	/** Answers a host-issued blocking `deliver` (the supervisor asked THIS child). */
	reply(askId: string, text: string): void;
	list(): Promise<Array<{ handle: string; label: string }>>;
	onDeliver(cb: (evt: DeliverEvent) => void): void;
	onSteer(cb: (text: string) => void): void;
	/** Fired once when a live connection drops (peer-initiated); not fired by close(). */
	onClose(cb: () => void): void;
	/** Sends `bye` (best-effort) and disposes the socket; idempotent. */
	close(): void;
}

export interface MakeBrokerClientDeps {
	endpoint: string;
	handle: string;
	label?: string;
	group?: string;
	peers?: boolean;
	/** Private, one-shot parent grant. Never log this or pass it to a model. */
	readerToken?: string;
	/** Injected transport (tests use a paired in-memory fake); defaults to real `node:net`. */
	net?: typeof import("node:net");
}

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5000;
const CONNECT_MAX_ATTEMPTS = 6;
const ASK_TIMEOUT_MS = 600_000;
// A roster lookup is one local socket/pipe round-trip, unlike a blocking supervisor ask. Do not
// let a half-open broker pin `contact_peer list/send` until the child idle watchdog fires.
const LIST_TIMEOUT_MS = 10_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		t.unref?.();
	});
}

export function makeBrokerClient(deps: MakeBrokerClientDeps): BrokerClient {
	const netImpl = deps.net ?? nodeNet;

	let socket: net.Socket | undefined;
	let closed = false;
	let disconnected = false;
	let registerStarted = false;
	let registered = false;
	let cancelConnect: (() => void) | undefined;
	const pendingReads = new Map<string, { request: ResultReadRequest; resolve: (result: ReadReply) => void }>();
	let registerSettle: { resolve: () => void; reject: (err: Error) => void } | undefined;

	const deliverListeners = new Set<(evt: DeliverEvent) => void>();
	const steerListeners = new Set<(text: string) => void>();
	const closeListeners = new Set<() => void>();
	const pendingAsks = new Map<string, { resolve: (text: string) => void; reject: (err: Error) => void }>();
	const pendingLists = new Map<string, { resolve: (peers: Array<{ handle: string; label: string }>) => void; reject: (err: Error) => void }>();

	/** Best-effort write: a frame sent while disconnected is silently dropped — matches
	 *  the design's "sends report undelivered" (no throw the caller could even act on,
	 *  `send`/`reply` are `void`). */
	function write(frame: Frame): void {
		if (!socket) return;
		try {
			socket.write(encodeFrame(frame));
		} catch {
			/* peer went away mid-write */
		}
	}

	/** An application listener's throw must never reach the frame reader: the reader would
	 *  poison itself and destroy the socket, muting the child for the rest of the run (the
	 *  host hardens its own dispatch the same way). */
	function safely(fn: () => void): void {
		try {
			fn();
		} catch {
			/* a faulty listener is the listener's problem, not the connection's */
		}
	}

	function handleFrame(frame: Frame): void {
		switch (frame.t) {
			case "registered":
				if (!registerSettle) return;
				if (frame.handle !== deps.handle || (deps.readerToken !== undefined && (!frame.readerToken
					|| !timingSafeEqual(Buffer.from(deps.readerToken, "hex"), Buffer.from(frame.readerToken, "hex"))))) {
					failReaderProtocol();
					return;
				}
				registered = true;
				registerSettle.resolve();
				registerSettle = undefined;
				return;
			case "result_read_reply": {
				const pending = pendingReads.get(frame.reqId);
				if (pending) pending.resolve(isReadReplyFor(frame.result, pending.request) ? frame.result : readFailure("protocol"));
				return;
			}
			case "error":
				// A correlated error belongs to one request on this connection. Do not let an
				// unknown/stale correlation id affect the register handshake or another ask.
				if (frame.msgId !== undefined) {
					pendingAsks.get(frame.msgId)?.reject(new Error(frame.reason));
					return;
				}
				// A bare error belongs to the register handshake, not an outstanding read.
				registerSettle?.reject(new Error(deps.readerToken !== undefined ? "Result reader authentication failed." : frame.reason));
				registerSettle = undefined;
				return;
			case "deliver": {
				const evt: DeliverEvent = {
					from: frame.from,
					kind: frame.kind,
					text: frame.text,
					msgId: frame.msgId,
					expectsReply: frame.expectsReply,
					...(frame.fromLabel !== undefined ? { fromLabel: frame.fromLabel } : {}),
				};
				for (const cb of deliverListeners) safely(() => cb(evt));
				return;
			}
			case "steer":
				for (const cb of steerListeners) safely(() => cb(frame.text));
				return;
			case "replied": {
				const pending = pendingAsks.get(frame.askId);
				if (pending) pending.resolve(frame.text);
				return;
			}
			case "peers": {
				const pending = pendingLists.get(frame.reqId);
				if (pending) pending.resolve(frame.peers);
				return;
			}
			default:
				return; // register/send/reply/list/bye are client→host-only; ignore if echoed
		}
	}

	function failReaderProtocol(): void {
		registerSettle?.reject(new Error("Result reader protocol failure."));
		registerSettle = undefined;
		for (const pending of pendingReads.values()) pending.resolve(readFailure("protocol"));
		socket?.destroy();
	}

	function connectOnce(): Promise<net.Socket> {
		return new Promise((resolve, reject) => {
			const s = netImpl.connect(deps.endpoint);
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => { clearTimeout(timer); cancelConnect = undefined; };
			const onConnect = (): void => {
				if (settled) return;
				settled = true;
				finish();
				s.removeListener("error", onError);
				resolve(s);
			};
			const onError = (err: Error): void => {
				if (settled) return;
				settled = true;
				finish();
				s.removeListener("connect", onConnect);
				s.destroy();
				reject(err);
			};
			s.once("connect", onConnect);
			s.once("error", onError);
			// Permanent sink also covers cancellation before the eventual connect event.
			s.on("error", () => {});
			cancelConnect = () => onError(new Error("broker client closed"));
			if (deps.readerToken !== undefined) {
				timer = setTimeout(() => onError(new Error("Result reader connection deadline exceeded.")), RESULT_READ_TIMEOUT_MS);
				timer.unref?.();
			}
		});
	}

	/** Capped exponential backoff (250ms → 5s) on the INITIAL connect only — comtac's
	 *  endless reconnect-after-disconnect loop is deliberately not ported (see header). */
	async function connectWithBackoff(): Promise<net.Socket> {
		let lastErr: unknown;
		for (let attempt = 0; attempt < CONNECT_MAX_ATTEMPTS; attempt += 1) {
			if (closed) throw new Error("broker client closed");
			try {
				return await connectOnce();
			} catch (err) {
				lastErr = err;
				if (attempt < CONNECT_MAX_ATTEMPTS - 1) {
					await delay(Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS));
				}
			}
		}
		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
	}

	function rejectAllPending(reason: string): void {
		for (const p of pendingReads.values()) p.resolve(readFailure("unavailable"));
		for (const p of pendingAsks.values()) p.reject(new Error(reason));
		pendingAsks.clear();
		for (const p of pendingLists.values()) p.reject(new Error(reason));
		pendingLists.clear();
	}

	async function register(): Promise<void> {
		if (registerStarted || closed) throw new Error("broker register is one-shot or closed");
		registerStarted = true;
		if (deps.readerToken !== undefined && !isReaderToken(deps.readerToken)) throw new Error("Result reader protocol failure.");
		// Ordinary comms retain initial-connect backoff. A result grant never reconnects/replays.
		const s = await (deps.readerToken !== undefined ? connectOnce() : connectWithBackoff());
		if (closed) {
			s.destroy();
			throw new Error("broker client closed");
		}
		socket = s;
		s.on(
			"data",
			createFrameReader(
				(raw) => {
					if (isFrame(raw)) handleFrame(raw);
					else if (deps.readerToken !== undefined) failReaderProtocol();
				},
				() => { if (deps.readerToken !== undefined) failReaderProtocol(); else s.destroy(); },
			),
		);
		s.on("error", () => {
			if (deps.readerToken !== undefined) s.destroy();
			/* The close event rejects in-flight requests; this listener only prevents an
			 * unhandled socket error from taking down the child. */
		});
		s.once("close", () => {
			if (socket === s) socket = undefined;
			registered = false;
			// A peer-initiated drop (host teardown/crash) between connect and the handshake
			// reply would otherwise leave register() pending for the child's whole life.
			registerSettle?.reject(new Error("connection closed during register"));
			registerSettle = undefined;
			if (!closed) {
				rejectAllPending("broker connection closed");
				disconnected = true;
				for (const cb of closeListeners) safely(cb);
			}
		});

		return new Promise<void>((resolve, reject) => {
			const timer = deps.readerToken !== undefined ? setTimeout(() => {
				registerSettle?.reject(new Error("Result reader handshake deadline exceeded."));
				registerSettle = undefined;
				s.destroy();
			}, RESULT_READ_TIMEOUT_MS) : undefined;
			timer?.unref?.();
			registerSettle = {
				resolve: () => { clearTimeout(timer); resolve(); },
				reject: (error) => { clearTimeout(timer); reject(error); },
			};
			write({
				t: "register",
				handle: deps.handle,
				...(deps.readerToken !== undefined ? { readerToken: deps.readerToken } : {}),
				...(deps.label !== undefined ? { label: deps.label } : {}),
				...(deps.group !== undefined ? { group: deps.group } : {}),
				...(deps.peers !== undefined ? { peers: deps.peers } : {}),
			});
		});
	}

	function read(request: ResultReadRequest, signal?: AbortSignal): Promise<ReadReply> {
		if (signal?.aborted) return Promise.resolve(readFailure("cancelled"));
		if (!isReadRequest(request)) return Promise.resolve(readFailure("invalid"));
		if (deps.readerToken === undefined) return Promise.resolve(readFailure("denied"));
		if (closed || disconnected || !registered || !socket) return Promise.resolve(readFailure("unavailable"));
		if (pendingReads.size >= RESULT_READ_MAX_PENDING) return Promise.resolve(readFailure("busy"));
		const reqId = randomUUID();
		// Snapshot caller data so mutation after dispatch cannot alter correlation checks.
		const snapshot = { ...request };
		return new Promise((resolve) => {
			const finish = (result: ReadReply): void => {
				if (!pendingReads.delete(reqId)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const cancel = (result: ReadReply): void => {
				finish(result);
				write({ t: "result_read_cancel", reqId });
			};
			const onAbort = (): void => cancel(readFailure("cancelled"));
			const timer = setTimeout(() => cancel(readFailure("timeout")), RESULT_READ_TIMEOUT_MS);
			timer.unref?.();
			pendingReads.set(reqId, { request: snapshot, resolve: finish });
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				socket!.write(encodeFrame({ t: "result_read", reqId, ...snapshot }));
			} catch { finish(readFailure("unavailable")); socket?.destroy(); }
		});
	}

	function send(to: string, kind: MsgKind, text: string): void {
		write({ t: "send", to, kind, text, msgId: randomUUID(), expectsReply: false });
	}

	/** Why `ask`/`list` refuse to send right now — distinguishes a disposed client from one that
	 *  merely lost its connection (an unexpected disconnect is never auto-reconnected; see header). */
	function unavailableReason(): string {
		return closed ? "broker client closed" : "broker connection closed";
	}

	function ask(to: string, kind: MsgKind, text: string, signal?: AbortSignal): Promise<string> {
		if (closed || disconnected) return Promise.reject(new Error(unavailableReason()));
		const msgId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const onAbort = (): void => {
				const wasPending = pendingAsks.has(msgId);
				finish();
				if (wasPending) write({ t: "cancel", msgId });
				reject(new Error("ask aborted"));
			};
			// Always drop the pending entry + timer + abort listener, so a settled ask never
			// leaks a 10-minute timer or a stale resolver (mirrors `bus.ask`'s `finish`).
			const finish = (): void => {
				clearTimeout(timer);
				pendingAsks.delete(msgId);
				signal?.removeEventListener("abort", onAbort);
			};
			timer = setTimeout(() => {
				const wasPending = pendingAsks.has(msgId);
				finish();
				if (wasPending) write({ t: "cancel", msgId });
				reject(new Error(`ask timeout after ${ASK_TIMEOUT_MS}ms`));
			}, ASK_TIMEOUT_MS);
			timer.unref?.();
			if (signal) {
				if (signal.aborted) {
					finish();
					reject(new Error("ask aborted"));
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			pendingAsks.set(msgId, {
				resolve: (text: string) => {
					finish();
					resolve(text);
				},
				reject: (err: Error) => {
					finish();
					reject(err);
				},
			});
			write({ t: "send", to, kind, text, msgId, expectsReply: true });
		});
	}

	function reply(askId: string, text: string): void {
		write({ t: "reply", askId, text });
	}

	function list(): Promise<Array<{ handle: string; label: string }>> {
		if (closed || disconnected) return Promise.reject(new Error(unavailableReason()));
		const reqId = randomUUID();
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const finish = (): void => {
				clearTimeout(timer);
				pendingLists.delete(reqId);
			};
			pendingLists.set(reqId, {
				resolve: (peers) => { finish(); resolve(peers); },
				reject: (err) => { finish(); reject(err); },
			});
			timer = setTimeout(() => {
				finish();
				reject(new Error(`list timeout after ${LIST_TIMEOUT_MS}ms`));
			}, LIST_TIMEOUT_MS);
			timer.unref?.();
			write({ t: "list", reqId });
		});
	}

	function onDeliver(cb: (evt: DeliverEvent) => void): void {
		deliverListeners.add(cb);
	}

	function onSteer(cb: (text: string) => void): void {
		steerListeners.add(cb);
	}

	function onClose(cb: () => void): void {
		closeListeners.add(cb);
	}

	function close(): void {
		if (closed) return;
		closed = true;
		registered = false;
		cancelConnect?.();
		const s = socket;
		if (s) {
			write({ t: "bye" });
			// Capture + clear before end()/destroy(): a `close` event can fire
			// SYNCHRONOUSLY (real sockets are async, but a fake — or a socket that is
			// already half-closed — is not), which would otherwise null `socket` via the
			// `once("close", …)` listener mid-call.
			socket = undefined;
			s.end();
			s.destroy();
		}
		// A `register()` still mid-flight (connecting, or connected but awaiting
		// `registered`/`error`) would otherwise hang forever — settle it too.
		registerSettle?.reject(new Error("broker client closed"));
		registerSettle = undefined;
		rejectAllPending("broker client closed");
	}

	return { register, read, send, ask, reply, list, onDeliver, onSteer, onClose, close };
}
