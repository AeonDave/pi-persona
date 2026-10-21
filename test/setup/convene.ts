/**
 * Test helper: convene a `council` the way the model experiences it.
 *
 * An interactive council is ONE background run: the call returns a receipt at once and the outcome
 * arrives as the run's single completion wake. A headless council is joined inside the call. This helper
 * answers with what the model would end up holding — the headless result as is, or the wake wrapped as a
 * result (`isError` = the wake reports a failed run) — so a test about routing, prompts or models need not
 * care which mode it runs in.
 */

// biome-ignore lint: a deliberately loose mock of the Pi ExtensionAPI surface
type AnyFn = (...args: any[]) => any;

export interface ConveneHost {
	m: { tool(name: string): unknown; sentMessages(): Array<{ message: unknown; options?: unknown }> };
	ctx: unknown;
}

export async function waitUntil(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export async function convene(
	h: ConveneHost,
	id: string,
	params: Record<string, unknown>,
): Promise<{ isError: boolean; content: Array<{ type: string; text: string }>; details?: unknown }> {
	const council = h.m.tool("council") as { execute: AnyFn };
	const wakes = h.m.sentMessages().length;
	const result = await council.execute(id, params, undefined, undefined, h.ctx);
	if ((h.ctx as { hasUI?: boolean }).hasUI !== true) return result;
	await waitUntil(() => h.m.sentMessages().length > wakes, `the ${id} completion`);
	const text = String((h.m.sentMessages()[wakes]?.message as { content?: string }).content ?? "");
	return { isError: /\b[1-9]\d* failed/.test(text.split("\n")[0] ?? ""), content: [{ type: "text", text }] };
}
