/**
 * The CHILD side of the cross-process broker (spec B3): loaded INSTEAD of the full
 * extension when `PI_PERSONA_BUS` is set (see `extension.ts`'s factory dispatch). Connects
 * a `BrokerClient` (relay to the supervisor's `InProcessBus`), registers `contact_supervisor`
 * + `contact_peer` bound to the wire, and surfaces inbound frames as `pi.sendMessage`
 * follow-ups — the same mechanism comtac's `index.ts` uses for inbound bus traffic, and the
 * same fencing rule the in-process delivery bridge (`engine/inproc.ts`) enforces: untrusted
 * sub-agent/peer text goes through `fenceUntrusted`, with attribution OUTSIDE the fence so a
 * malicious payload can never spoof its own sender.
 *
 * A `steer` frame is NOT fenced — it is the supervisor's own live voice (the same as
 * `onSteerable` in the in-process engine, which injects steer text unfenced), just attributed.
 *
 * No personas, no delegate/council, no input hooks — bridge mode is deliberately a sealed,
 * minimal surface (the fork-bomb guard `PI_PERSONA_DISABLE=1` already keeps the full
 * extension out of a spawned child; this only adds the connected comm plane on top).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type BrokerClient, type DeliverEvent, makeBrokerClient, type MakeBrokerClientDeps } from "./bus/broker/client.ts";
import { makeContactSupervisorTool } from "./bus/contact.ts";
import { InProcessBus, type MsgKind } from "./bus/inproc.ts";
import { makeContactPeerTool, type PeerInfo } from "./bus/peers.ts";
import { fenceUntrusted } from "./core/fence.ts";

type Env = Record<string, string | undefined>;

/** The bus handle pi-persona's supervisor always registers under (mirrors `extension.ts`'s
 *  `SUPERVISOR` constant — a child can never BE the supervisor, `host.ts` rejects that
 *  handle on `register`, so the literal is safe to hardcode here too). */
const SUPERVISOR_HANDLE = "supervisor";

const BRIDGE_MESSAGE_TYPE = "pi_persona_bridge";

export interface InstallBridgeDeps {
	/** Override for `process.env` (tests). */
	env?: Env;
	/** Override for `makeBrokerClient` (tests inject a fake `BrokerClient`). */
	makeClient?: (deps: MakeBrokerClientDeps) => BrokerClient;
}

/** True iff this process was spawned as a broker-connected child (spec B3/B5). Checked at the
 *  very top of the extension factory — `PI_PERSONA_BUS` unset ⇒ zero behavior change. */
export function isBridgeMode(env: Env = process.env): boolean {
	return !!env.PI_PERSONA_BUS;
}

/** Routes `InProcessBus.send`/`ask` over a `BrokerClient` instead of a local mailbox — the
 *  thin adapter the bus-bound `contact_supervisor`/`contact_peer` factories need to run
 *  unmodified against a remote target. A real `InProcessBus` subclass (not a duck-typed
 *  object) so it satisfies the factories' concrete parameter type without touching them.
 *  `connected` gates both overrides so the tools' existing "no supervisor reachable" /
 *  "dropped" wording stays honest before the handshake completes — the client's own
 *  `send`/`ask` can't report that (a write to a not-yet-open socket silently no-ops, per
 *  spec's "sends report undelivered"). */
class BrokerBus extends InProcessBus {
	private readonly client: BrokerClient;
	connected = false;

	constructor(client: BrokerClient) {
		super();
		this.client = client;
	}

	override send(_from: string, to: string, text: string, kind: MsgKind = "progress"): boolean {
		if (!this.connected) return false;
		this.client.send(to, kind, text);
		return true;
	}

	override ask(
		_from: string,
		to: string,
		text: string,
		opts: { kind?: MsgKind; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<string> {
		if (!this.connected) throw new Error("bridge: not connected to the supervisor");
		return this.client.ask(to, opts.kind ?? "decision", text, opts.signal);
	}
}

/** Wrap fenced, attributed follow-up text as a `pi.sendMessage` custom message (comtac's
 *  inbound-surfacing mechanism — see `index.ts`'s `surface()`). */
function sendFollowUp(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({ customType: BRIDGE_MESSAGE_TYPE, content, display: true }, { deliverAs: "followUp", triggerTurn: true });
}

/** Install child-mode bridge wiring on `pi` — called once, from `session_start`, when
 *  `isBridgeMode()` is true. Connects the broker client (capped retries; a failed connect
 *  degrades to a mute executor, never a crash — spec §4), registers the two wire-bound
 *  comm-plane tools, surfaces inbound `deliver`/`steer` frames as follow-ups, and closes the
 *  client on `session_shutdown`. */
export function installBridge(pi: ExtensionAPI, ctx: ExtensionContext, deps: InstallBridgeDeps = {}): void {
	const env = deps.env ?? process.env;
	const endpoint = env.PI_PERSONA_BUS;
	const handle = env.PI_PERSONA_HANDLE;
	if (!endpoint || !handle) return; // isBridgeMode() gates the real caller; malformed env degrades to a no-op

	const wantsPeers = env.PI_PERSONA_PEERS === "1";
	const clientDeps: MakeBrokerClientDeps = { endpoint, handle, ...(wantsPeers ? { peers: true } : {}) };
	const client = (deps.makeClient ?? makeBrokerClient)(clientDeps);

	// Blocking asks are honoured only when the spawning run is async (`PI_PERSONA_ALLOW_BLOCKING`,
	// set by adapter.ts from the strategy's `allowBlocking`) — a sync delegate/council/orchestrate
	// turn holds the supervisor's turn, so a blocking `decision`/`interview` here would deadlock it
	// (the same safety default the in-process engine applies; see contact.ts / spec §4.9).
	const allowBlocking = env.PI_PERSONA_ALLOW_BLOCKING === "1";
	const bus = new BrokerBus(client);
	pi.registerTool(makeContactSupervisorTool(bus, handle, SUPERVISOR_HANDLE, { allowBlocking }));

	// The engine-scoped peer roster (B7): fetched from the host's `list` frame and cached —
	// `contact_peer`'s `listPeers` is synchronous, a wire round-trip is not, so each call
	// returns the last-known roster and kicks off a refresh for the next one.
	let peerCache: PeerInfo[] = [];
	const refreshPeers = (): void => {
		if (!bus.connected) return;
		client.list().then(
			(peers) => {
				peerCache = peers;
			},
			() => {
				/* best-effort — keep the stale cache rather than clearing a known roster */
			},
		);
	};
	pi.registerTool(
		makeContactPeerTool(bus, handle, {
			listPeers: () => {
				refreshPeers();
				return peerCache;
			},
		}),
	);

	// Inbound `deliver` — a supervisor `intercom send` or a sibling's `contact_peer` send.
	// Fenced (untrusted text crossing a process boundary), attribution OUTSIDE the fence —
	// exactly the in-process delivery bridge's rule (`engine/inproc.ts`).
	client.onDeliver((evt: DeliverEvent) => {
		const from = evt.from === SUPERVISOR_HANDLE ? "your supervisor" : `peer ${evt.fromLabel ?? evt.from}`;
		sendFollowUp(pi, `[message from ${from}]\n${fenceUntrusted(evt.text)}`);
	});

	// Inbound `steer` — the supervisor's own live redirect (`intercom steer` / f9 `s`), queued
	// as a follow-up turn (cross-process steer is follow-up semantics, not mid-turn injection —
	// spec B4). NOT fenced: this is the supervisor speaking, the same as the in-process
	// engine's `onSteerable`, which injects steer text unfenced.
	client.onSteer((text) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		sendFollowUp(pi, `[steer from your supervisor]\n${trimmed}`);
	});

	client.register().then(
		() => {
			bus.connected = true;
			refreshPeers();
			try {
				ctx.ui.setStatus("persona-bridge", `⇄ ${handle}`);
			} catch {
				/* cosmetic */
			}
		},
		() => {
			// Capped retries exhausted (host gone, or a race on a just-spawned child) — degrade to
			// a mute executor and keep running; never crash, never hang (spec §4).
			if (env.PI_PERSONA_DEBUG) process.stderr.write(`[pi-persona] bridge: could not connect to ${endpoint}\n`);
			try {
				ctx.ui.setStatus("persona-bridge", "⇄ offline");
			} catch {
				/* cosmetic */
			}
		},
	);

	pi.on("session_shutdown", () => {
		client.close();
	});
}
