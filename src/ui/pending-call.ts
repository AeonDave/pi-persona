/** The one pending line every pi-persona tool card shows while the model is still streaming that
 * call's arguments: `<title> ⠋ preparing…`, instead of a card built from half-parsed arguments
 * (`delegate ?` → `delegate parallel (3)` → rows). The full card replaces it once Pi reports the
 * arguments complete.
 *
 * Pi's flags alone cannot tell a call being composed from a restored one: its restore loop builds
 * every saved tool row partial, args-incomplete and not started, and only a following result
 * message marks it final. A call saved without its result (session killed mid-call, transcript
 * rebuilt while a tool ran) keeps those flags forever. So the pending line is tied to argument
 * ACTIVITY as well: it shows only while the row is partial, args-incomplete and not started AND
 * its arguments changed within the last {@link PENDING_CALL_QUIET_MS}. A streaming call re-renders
 * with new arguments many times a second; a restored, orphaned or stalled row does not, so after
 * the quiet period it stops ticking and renders its normal card from the arguments at hand. If the
 * arguments change again while still composing, the spinner resumes. A missing render context
 * (HTML export, tests) is never composing.
 *
 * Animation follows Pi's own tool-timer pattern (`setInterval(() => context.invalidate())` held in
 * the row's `context.state`), with Pi's Loader frames and colours (accent spinner, muted text). The
 * timer is unref'd (never keeps Node alive), cleared by the first non-composing render, and stops by
 * itself once the arguments go quiet — so a row discarded from the transcript, or left behind by a
 * session shutdown, stops requesting renders within the quiet period without any registry. */
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Pi exports the render context only through the renderer signature. */
export type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

/** pi-tui Loader's default frames and cadence. */
export const PENDING_CALL_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const PENDING_CALL_FRAME_MS = 80;
/** Unchanged arguments for this long mean nobody is composing the call any more. */
export const PENDING_CALL_QUIET_MS = 3_000;
const PENDING_CALL_TEXT = "preparing…";

type PendingContext = Partial<Pick<ToolRenderContext, "args" | "argsComplete" | "executionStarted" | "isPartial" | "invalidate" | "state">>;

interface Ticker {
	startedAt: number;
	/** Last seen arguments (reference) and their content signature; `changedAt` moves only when the content does. */
	args: unknown;
	signature: string | undefined;
	changedAt: number;
	timer: ReturnType<typeof setInterval> | undefined;
}

const TICKER = Symbol("pi-persona.pending-call");

export function isComposingCall(context: PendingContext | undefined): boolean {
	return context !== undefined && context.isPartial === true && context.argsComplete === false && context.executionStarted === false;
}

function rowState(context: PendingContext | undefined): Record<symbol, Ticker | undefined> | undefined {
	const state: unknown = context?.state;
	return state !== null && typeof state === "object" ? state as Record<symbol, Ticker | undefined> : undefined;
}

function signatureOf(args: unknown): string | undefined {
	try {
		return JSON.stringify(args);
	} catch {
		return undefined;
	}
}

function stopTicker(ticker: Ticker | undefined): void {
	if (ticker?.timer === undefined) return;
	clearInterval(ticker.timer);
	ticker.timer = undefined;
}

function isQuiet(ticker: Ticker, now: number): boolean {
	return now - ticker.changedAt >= PENDING_CALL_QUIET_MS;
}

/** {@link pendingCallLine} as the default-shell card; Pi's tool Box supplies the padding. */
export function renderPendingCall(title: string, theme: Pick<Theme, "fg" | "bold">, context: PendingContext | undefined): Text | undefined {
	const line = pendingCallLine(title, theme, context);
	return line === undefined ? undefined : new Text(line, 0, 0);
}

/** The styled pending line while the call is being composed; `undefined` once the caller should
 *  render its full card (and any ticker for this row is stopped). A `renderShell: "self"` card draws
 *  the line inside its own padding. */
export function pendingCallLine(title: string, theme: Pick<Theme, "fg" | "bold">, context: PendingContext | undefined): string | undefined {
	const state = rowState(context);
	const existing = state?.[TICKER];
	if (!isComposingCall(context)) {
		stopTicker(existing);
		return undefined;
	}
	const now = Date.now();
	const ticker: Ticker = existing ?? { startedAt: now, args: context?.args, signature: signatureOf(context?.args), changedAt: now, timer: undefined };
	if (existing && context?.args !== existing.args) {
		existing.args = context?.args;
		const signature = signatureOf(context?.args);
		if (signature !== existing.signature) {
			existing.signature = signature;
			existing.changedAt = now;
		}
	}
	if (isQuiet(ticker, now)) {
		stopTicker(ticker);
		return undefined;
	}
	if (state && !existing) state[TICKER] = ticker;
	const invalidate = context?.invalidate;
	if (state && ticker.timer === undefined && typeof invalidate === "function") {
		ticker.timer = setInterval(() => {
			// Going quiet stops the timer and repaints once more, so the row settles on its full card.
			if (isQuiet(ticker, Date.now())) stopTicker(ticker);
			invalidate();
		}, PENDING_CALL_FRAME_MS);
		(ticker.timer as { unref?: () => void }).unref?.();
	}
	const frame = PENDING_CALL_FRAMES[Math.floor(Math.max(0, now - ticker.startedAt) / PENDING_CALL_FRAME_MS) % PENDING_CALL_FRAMES.length]!;
	return `${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("accent", frame)} ${theme.fg("muted", PENDING_CALL_TEXT)}`;
}
