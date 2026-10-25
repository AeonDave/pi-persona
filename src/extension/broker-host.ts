/**
 * Supervisor-side broker lifecycle (spec B1-B7): the ONE cross-process host every child-engine
 * leg connects to. Started lazily on the first child-engine build; a failed bind is reported to
 * the user ONCE, children built while it is failed spawn without a bus endpoint (so they never
 * burn the connect backoff against a dead socket), and the next build retries. Result readers
 * use the separate strict awaited preflight on this SAME host, never bus-less degradation.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { EngineAdapterBroker } from "../engine/adapter.ts";
import { type BrokerHost, startBrokerHost } from "../bus/broker/host.ts";
import type { InProcessBus } from "../bus/inproc.ts";
import { RESULT_READ_TIMEOUT_MS, type PreparedResultReader, type ScopedReader } from "../bus/result-reader.ts";

export interface SupervisorBrokerDeps {
	bus: InProcessBus;
	supervisorHandle: string;
	/** Injected in tests. */
	startHost?: typeof startBrokerHost;
	/** User-facing warning (ctx.ui.notify "warning" when a TUI is present, stderr otherwise). */
	warn: (message: string) => void;
}

/** Cross-process `contact_peer` roster (spec B7): scopes `brokerPeers` — the process-wide,
 *  pre-spawn registry keyed by handle (populated in `SupervisorBroker.adapterDeps`'s `register`,
 *  below) — to the SAME per-engine group as the caller `self`, mirroring `engine/inproc.ts`'s
 *  per-engine-instance `peerLabels` map. `self`'s OWN recorded group is the source of truth
 *  here, NOT the wire's `group` argument the host would otherwise pass: the child's env
 *  carries no group (spec B6, the wire `register` frame stays minimal), so every wire group
 *  is "" and scoping by it would either always come back empty (this scope) or leak every
 *  concurrent run's peers into one flat list (the host's own default `group=""` scoping).
 *  `self` not found (not registered with `peers: true`) ⇒ empty roster, never a leak.
 *  Exported for direct unit/integration testing — `extension.ts`'s activation closure itself
 *  isn't a testable unit. */
export function listPeersForGroup(brokerPeers: ReadonlyMap<string, { label: string; group: string }>, self: string): Array<{ handle: string; label: string }> {
	const g = brokerPeers.get(self)?.group;
	if (g === undefined) return [];
	return [...brokerPeers.entries()]
		.filter(([handle, p]) => p.group === g && handle !== self)
		.map(([handle, p]) => ({ handle, label: p.label }));
}

export class SupervisorBroker {
	readonly peers = new Map<string, { label: string; group: string }>();
	private hostRef: BrokerHost | undefined;
	private promise: Promise<BrokerHost> | undefined;
	private lastError: string | undefined;
	private warned = false;
	private readonly expected = new Set<string>();
	private readonly preHostSteers = new Map<string, string[]>();
	private readonly deps: SupervisorBrokerDeps;
	private generation = 0;
	private readonly preparingReaders = new Set<() => void>();

	constructor(deps: SupervisorBrokerDeps) {
		this.deps = deps;
	}

	get host(): BrokerHost | undefined {
		return this.hostRef;
	}

	get error(): string | undefined {
		return this.lastError;
	}

	/** The lifecycle state `adapterDeps`, `steerFrame`, and `doctorLine` each branch on, named
	 *  once so they can never read it as three different ad hoc conditions. */
	private state(): "idle" | "starting" | "up" | "failed" {
		if (this.hostRef) return "up";
		if (this.lastError !== undefined) return "failed";
		if (this.promise) return "starting";
		return "idle";
	}

	/** Start the host once per endpoint attempt; retried on the next call after a failure. */
	ensure(endpoint: string): void {
		if (this.promise) return;
		if (process.platform !== "win32") {
			try {
				mkdirSync(dirname(endpoint), { recursive: true }); // POSIX sockets are filesystem paths
			} catch {
				/* a failed mkdir surfaces as a listen error below */
			}
		}
		const start = this.deps.startHost ?? startBrokerHost;
		const generation = this.generation;
		this.promise = start({
			bus: this.deps.bus,
			supervisorHandle: this.deps.supervisorHandle,
			endpoint,
			listPeersFor: (_group, self) => listPeersForGroup(this.peers, self),
		});
		this.promise.then(
			(h) => {
				if (generation !== this.generation) return; // close() owns the late host's teardown
				this.hostRef = h;
				this.lastError = undefined;
				this.warned = false;
				for (const handle of this.expected) h.expect(handle);
				for (const [handle, texts] of this.preHostSteers) for (const text of texts) h.steer(handle, text);
				this.preHostSteers.clear();
			},
			(err) => {
				if (generation !== this.generation) return;
				this.promise = undefined; // a later build retries
				this.lastError = err instanceof Error ? err.message : String(err);
				const dropped = [...this.preHostSteers.values()].reduce((n, texts) => n + texts.length, 0);
				this.preHostSteers.clear();
				if (!this.warned) {
					this.warned = true;
					this.deps.warn(
						`pi-persona: child-agent bus unavailable — ${this.lastError}; child legs run without live steer/contact until it starts${dropped > 0 ? `; ${dropped} queued steer${dropped === 1 ? "" : "s"} ${dropped === 1 ? "was" : "were"} dropped` : ""}`,
					);
				}
			},
		);
	}

	/** Strict reader preflight, unlike ordinary bus-less degradation. Call ensure(endpoint)
	 * first, then await this BEFORE adapter registration/spawn. The owner must revoke on
	 * settlement/spawn failure and close this broker when the owning session changes. */
	async prepareResultReader(handle: string, reader: ScopedReader, signal?: AbortSignal): Promise<PreparedResultReader> {
		const generation = this.generation;
		let revoked = false;
		const revoke = (): void => {
			if (revoked) return;
			revoked = true;
			try { reader.revoke(); } catch { /* fixed diagnostic, even if cleanup throws */ }
		};
		const fail = (): Error => new Error("Result reader preparation failed.");
		const hostPromise = this.promise;
		if (!hostPromise || signal?.aborted) { revoke(); throw fail(); }
		return new Promise<PreparedResultReader>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => {
				settled = true;
				clearTimeout(timer);
				this.preparingReaders.delete(cancel);
				signal?.removeEventListener("abort", cancel);
			};
			const cancel = (): void => {
				if (settled) return;
				revoke(); cleanup(); reject(fail());
			};
			const timer = setTimeout(cancel, RESULT_READ_TIMEOUT_MS);
			timer.unref?.();
			this.preparingReaders.add(cancel);
			signal?.addEventListener("abort", cancel, { once: true });
			void hostPromise.then(async (host) => {
				if (settled) return;
				const grant = await host.prepareResultReader(handle, { read: (request, s) => reader.read(request, s), revoke }, signal);
				if (settled || generation !== this.generation || signal?.aborted) { grant.revoke(); cancel(); return; }
				cleanup();
				resolve(grant);
			}).catch(cancel);
		});
	}

	/** The adapter-facing deps, or undefined while the last start failed (children spawn bus-less). */
	adapterDeps(endpoint: string): EngineAdapterBroker | undefined {
		const failedBefore = this.state() === "failed";
		this.ensure(endpoint);
		if (failedBefore) return undefined;
		return {
			endpoint,
			register: (info) => {
				this.deps.bus.register(info.handle);
				this.expected.add(info.handle);
				if (info.peers) this.peers.set(info.handle, { label: info.label ?? info.handle, group: info.group ?? "" });
				this.hostRef?.expect(info.handle);
			},
			unregister: (handle) => {
				this.expected.delete(handle);
				this.preHostSteers.delete(handle);
				this.peers.delete(handle);
				this.deps.bus.unregister(handle);
				this.hostRef?.forget(handle);
			},
			steerFrame: (handle, text) => {
				if (this.hostRef) return this.hostRef.steer(handle, text);
				if (this.state() === "failed" || !this.expected.has(handle) || !text.trim()) return false;
				const queued = this.preHostSteers.get(handle) ?? [];
				queued.push(text);
				this.preHostSteers.set(handle, queued);
				return true;
			},
			hasPendingAskFrom: (handle) => this.deps.bus.hasPendingAskFrom(handle),
			prepareResultReader: (handle, reader, signal) => this.prepareResultReader(handle, reader, signal),
		};
	}

	doctorLine(): string {
		// Failed is reported on its own (spec §4.7: `broker: failed — <reason>`) rather than folded
		// into the "on — …" family: there is no host and no connected-children count to report while
		// down, so "broker: on — failed — …" was a confusing double dash for a state that isn't "on".
		if (this.state() === "failed") return `broker: failed — ${this.lastError}`;
		let status: string;
		switch (this.state()) {
			case "up":
				status = `endpoint ${this.hostRef?.endpoint}`;
				break;
			case "starting":
				status = "(starting…)";
				break;
			default:
				status = "(not started — no child-engine build yet)";
		}
		return `broker: on — ${status}, connected children: ${this.hostRef?.connectedHandles().length ?? 0}`;
	}

	async close(): Promise<void> {
		this.generation++;
		for (const cancel of this.preparingReaders) cancel();
		const host = this.hostRef;
		const pending = this.promise;
		this.hostRef = undefined;
		this.promise = undefined;
		this.lastError = undefined;
		this.peers.clear();
		this.expected.clear();
		this.preHostSteers.clear();
		try {
			// Invoke immediately: bound readers revoke before the first await.
			if (host) await host.close();
			else if (pending) await (await pending).close();
		} catch {
			/* best-effort — never block shutdown on a broker teardown error */
		}
	}
}
