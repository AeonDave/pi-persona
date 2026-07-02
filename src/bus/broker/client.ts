/**
 * Broker client — the child-side half of the relay (spec B3/B6): connects to the
 * session-scoped endpoint (`paths.ts`), performs the `register`/`registered` handshake,
 * and exposes the same shape a local `contact_supervisor`/`contact_peer` binding needs —
 * `send` (fire-and-forget), `ask` (a blocking `send{expectsReply}` correlated to a
 * `replied{askId}`, 10-minute cap, mirrors `bus.ask`), `reply` (answers a host-issued
 * blocking `deliver`), `list` (the engine-scoped peer roster, B7), and `onDeliver`/`onSteer`
 * for inbound frames. A future bridge (`src/bridge.ts`) wires these onto Pi tools; this
 * module has no Pi imports.
 *
 * Ported from comtac `broker/client.ts`, slimmed to the B6 frame set and to what a
 * per-session child — which lives strictly less than the run — actually needs: capped
 * exponential backoff (250ms–5s) on the INITIAL connect only (comtac's presence tracking,
 * `list` request timeout/roster, and endless reconnect-after-disconnect "storm" are
 * dropped — YAGNI here, see spec B6/Task 4 brief). An unexpected disconnect (host died
 * mid-run) is NOT auto-reconnected: sends silently go nowhere and in-flight asks simply
 * ride out their own timeout, exactly as the design's error-handling section specifies —
 * the child keeps executing, mute, never crashing.
 *
 * Pure over an injected socket factory (`net`), mirroring `host.ts`'s `net` param — same
 * transport-injection seam, opposite side of the same fake in tests.
 */

import { randomUUID } from "node:crypto";
import nodeNet from "node:net";
import type net from "node:net";

import { createFrameReader, encodeFrame } from "./framing.ts";
import { type Frame, isFrame } from "./messages.ts";
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
	/** Connect (capped backoff) and complete the register handshake. */
	register(): Promise<void>;
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
	/** Sends `bye` (best-effort) and disposes the socket; idempotent. */
	close(): void;
}

export interface MakeBrokerClientDeps {
	endpoint: string;
	handle: string;
	label?: string;
	group?: string;
	peers?: boolean;
	/** Injected transport (tests use a paired in-memory fake); defaults to real `node:net`. */
	net?: typeof import("node:net");
}

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5000;
const CONNECT_MAX_ATTEMPTS = 6;
const ASK_TIMEOUT_MS = 600_000;

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
	let registerSettle: { resolve: () => void; reject: (err: Error) => void } | undefined;

	const deliverListeners = new Set<(evt: DeliverEvent) => void>();
	const steerListeners = new Set<(text: string) => void>();
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

	function handleFrame(frame: Frame): void {
		switch (frame.t) {
			case "registered":
				registerSettle?.resolve();
				registerSettle = undefined;
				return;
			case "error":
				// Only the register handshake can be unambiguously correlated to a bare
				// `error` frame (host.ts does not echo msgId/askId on ask failures); any
				// other error is unresolvable here and is left to its own ask timeout.
				registerSettle?.reject(new Error(frame.reason));
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
				for (const cb of deliverListeners) cb(evt);
				return;
			}
			case "steer":
				for (const cb of steerListeners) cb(frame.text);
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

	function connectOnce(): Promise<net.Socket> {
		return new Promise((resolve, reject) => {
			const s = netImpl.connect(deps.endpoint);
			let settled = false;
			const onConnect = (): void => {
				if (settled) return;
				settled = true;
				s.removeListener("error", onError);
				resolve(s);
			};
			const onError = (err: Error): void => {
				if (settled) return;
				settled = true;
				s.removeListener("connect", onConnect);
				s.destroy();
				reject(err);
			};
			s.once("connect", onConnect);
			s.once("error", onError);
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
		for (const p of pendingAsks.values()) p.reject(new Error(reason));
		pendingAsks.clear();
		for (const p of pendingLists.values()) p.reject(new Error(reason));
		pendingLists.clear();
	}

	async function register(): Promise<void> {
		const s = await connectWithBackoff();
		socket = s;
		s.on(
			"data",
			createFrameReader(
				(raw) => {
					if (isFrame(raw)) handleFrame(raw);
				},
				() => s.destroy(),
			),
		);
		s.on("error", () => {
			/* permanent sink post-connect: ask()/list() surface a dead link via their own
			 * timeout/hang, per the design's mid-run host-death handling (header). */
		});
		s.once("close", () => {
			socket = undefined;
		});

		return new Promise<void>((resolve, reject) => {
			registerSettle = { resolve, reject };
			write({
				t: "register",
				handle: deps.handle,
				...(deps.label !== undefined ? { label: deps.label } : {}),
				...(deps.group !== undefined ? { group: deps.group } : {}),
				...(deps.peers !== undefined ? { peers: deps.peers } : {}),
			});
		});
	}

	function send(to: string, kind: MsgKind, text: string): void {
		write({ t: "send", to, kind, text, msgId: randomUUID(), expectsReply: false });
	}

	function ask(to: string, kind: MsgKind, text: string, signal?: AbortSignal): Promise<string> {
		const msgId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const onAbort = (): void => {
				finish();
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
				finish();
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
		const reqId = randomUUID();
		return new Promise((resolve, reject) => {
			pendingLists.set(reqId, { resolve, reject });
			write({ t: "list", reqId });
		});
	}

	function onDeliver(cb: (evt: DeliverEvent) => void): void {
		deliverListeners.add(cb);
	}

	function onSteer(cb: (text: string) => void): void {
		steerListeners.add(cb);
	}

	function close(): void {
		if (closed) return;
		closed = true;
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

	return { register, send, ask, reply, list, onDeliver, onSteer, close };
}
