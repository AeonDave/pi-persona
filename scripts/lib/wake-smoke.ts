import { coerceDelegateParams } from "../../src/tools/delegate.ts";

/** Reuse the delegate tool's input normalization at the RPC event boundary. */
export function coerceWakeSmokeDelegateTasks(args: unknown) {
	const result = coerceDelegateParams(args);
	if (!result.ok) return result;
	return { ok: true as const, tasks: result.params.tasks ?? [] };
}
