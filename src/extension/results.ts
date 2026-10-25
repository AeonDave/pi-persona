/** Session-native terminal archive ownership. Owners are frozen before asynchronous work starts. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TerminalResultArchive } from "../results/archive.ts";
import { resultReceipt, type ResultReceipt } from "../results/retrieval.ts";
import type { TerminalResultInput, TerminalStatus } from "../results/types.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { emptyUsage } from "../engine/stream.ts";
import { type AsyncRun, type AsyncRunTracker } from "../engine/async.ts";

export interface CaptureMetadata {
	originRunId?: string;
	label?: string;
	status?: TerminalStatus;
	partial?: string;
}
export type CaptureResult = (origin: string, result: AgentResult, meta?: CaptureMetadata) => ResultReceipt;
interface Owner {
	id: string;
	file: string | undefined;
	manager: ExtensionContext["sessionManager"];
	generation: string;
	archive: TerminalResultArchive;
}

export class SessionResults {
	private owner: Owner | undefined;
	private disposed = false;
	private readonly captures = new Map<AsyncRun, CaptureResult>();
	private readonly detach: Array<() => void> = [];

	constructor(privateApi: Pick<ExtensionAPI, "appendEntry">) {
		this.append = (type, data) => privateApi.appendEntry(type, data);
	}
	private readonly append: (type: string, data: unknown) => void;

	activate(ctx: ExtensionContext): TerminalResultArchive {
		// A session_shutdown revokes the previous owner; a later session_start in the same process
		// (the documented multi-activation lifecycle) starts a FRESH owner, never a zombie.
		if (this.disposed) {
			this.disposed = false;
			for (const off of this.detach.splice(0)) {
				try { off(); } catch { /* teardown must not block a new activation */ }
			}
		}
		const manager = ctx.sessionManager;
		// A context without a session manager (e.g. --no-session / UI-less runs) still gets an
		// honest MEMORY-ONLY owner: bounded runtime retention, no persistence claims.
		const id = manager ? manager.getSessionId() : `memory:${randomUUID()}`;
		const file = manager ? manager.getSessionFile() : undefined;
		const previous = this.owner;
		// File identity owns persisted history. A memory owner additionally needs manager identity.
		if (previous && previous.id === id && previous.file === file && (file !== undefined || previous.manager === manager)) return previous.archive;
		const generation = randomUUID();
		// Freeze all-branch history now. A storage read failure belongs to archive accounting,
		// not to the ordinary work being launched; never retry through a mutable future context.
		let entries: readonly unknown[] = [];
		let historyError: unknown;
		let historyFailed = false;
		try { entries = manager ? manager.getEntries() : []; } catch (error) { historyError = error; historyFailed = true; }
		const owner: Owner = {
			id, file, manager, generation,
			archive: new TerminalResultArchive({
				entries: () => { if (historyFailed) throw historyError; return entries; },
				persistent: file !== undefined,
				append: (type, data) => {
					if (this.owner !== owner || (manager && (manager.getSessionId() !== id || manager.getSessionFile() !== file))) {
						throw new Error("Terminal archive owner was revoked");
					}
					this.append(type, data);
				},
			}),
		};
		this.owner = owner;
		return owner.archive;
	}

	get archive(): TerminalResultArchive | undefined { return this.owner?.archive; }

	/** Bind at logical creation, not at settlement through lastCtx. Each scope has its own origin namespace. */
	bind(scope: string): CaptureResult {
		const owner = this.owner;
		const prefix = `${owner?.generation ?? randomUUID()}:${scope}`;
		return (origin, result, meta = {}) => {
			if (!owner || this.owner !== owner || (owner.manager && (owner.manager.getSessionId() !== owner.id || owner.manager.getSessionFile() !== owner.file))) {
				return { warning: "Terminal report not archived: owning session activation is no longer current." };
			}
			const status = meta.status ?? (result.ok ? "done" : result.failureKind === "abort" ? "stopped" : "failed");
			const output = result.output.trim() ? result.output : meta.partial?.trim() ? meta.partial : result.error ?? "(no output)";
			const input: TerminalResultInput = {
				originKey: `${prefix}:${origin}`, status, agent: result.agent.slice(0, 128), body: output,
				provenance: result.output.trim() ? "result-output" : meta.partial?.trim() ? "partial-output" : result.error ? "error" : "result-output",
				...(meta.originRunId ? { originRunId: meta.originRunId.slice(0, 128) } : {}),
				...(meta.label ? { label: meta.label.slice(0, 256) } : {}),
				...(result.modelUsed ? { model: result.modelUsed.slice(0, 512) } : {}),
				...(result.thinkingRequested ? { thinkingRequested: result.thinkingRequested } : {}),
				...(result.thinkingEffective ? { thinkingEffective: result.thinkingEffective } : {}),
				...(result.error ? { error: result.error.slice(0, 2048) } : {}),
				usage: { input: result.usage.input, output: result.usage.output,
					...(result.usage.cacheRead !== undefined ? { cacheRead: result.usage.cacheRead } : {}),
					...(result.usage.cacheWrite !== undefined ? { cacheWrite: result.usage.cacheWrite } : {}),
					...(result.usage.cost !== undefined ? { cost: result.usage.cost } : {}),
					...(result.usage.turns !== undefined ? { turns: result.usage.turns } : {}),
				},
			};
			try { return resultReceipt(owner.archive.save(input)); }
			catch { return { warning: "Terminal report not archived: storage callback failed." }; }
		};
	}

	/** Register before the ordinary completion listener. onCreate precedes even a synchronous thunk failure. */
	track(tracker: AsyncRunTracker): void {
		this.detach.push(tracker.onCreate((run) => this.captures.set(run, this.bind("tracker"))));
		this.detach.push(tracker.onComplete((run) => {
			const capture = this.captures.get(run);
			this.captures.delete(run);
			if (!capture) return;
			const result = run.result ?? { agent: run.agent, output: "", usage: emptyUsage(), ok: false, ...(run.error ? { error: run.error } : {}) };
			run.resultReceipt = capture(run.id, result, {
				originRunId: run.id, ...(run.label ? { label: run.label } : {}),
				status: run.status === "running" ? "failed" : run.status,
				partial: run.progress.output,
			});
			if (run.result) run.result.resultReceipt = { ...run.resultReceipt };
		}));
	}

	dispose(): void {
		this.disposed = true;
		this.owner = undefined;
		this.captures.clear();
		for (const off of this.detach.splice(0)) {
			try { off(); } catch { /* best-effort teardown */ }
		}
	}
}
