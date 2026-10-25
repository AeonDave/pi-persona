import type { InProcessBus, MsgKind } from "./inproc.ts";

/** Child contact tools need delivery admission, not a concrete mailbox implementation.
 * A remote send awaits only the host's bounded receipt, never the recipient's answer. */
export interface ContactTransport {
	send(from: string, to: string, text: string, kind?: MsgKind, signal?: AbortSignal): boolean | Promise<boolean>;
	ask: InProcessBus["ask"];
}
