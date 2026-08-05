/**
 * Child bus-handle minting — ONE sequence shared by BOTH engines.
 *
 * The child engine (`adapter.ts`, via the broker host) and the in-process engine
 * (`inproc.ts`) register their handles into the SAME session bus, so a counter per
 * engine module is not enough: a mixed inproc + child pair of the same agent would
 * mint the same `agent#n`, share one inbox, and the first to settle would unregister
 * the other, still-running leg.
 *
 * Module-level (NOT per-engine): `buildEngine` makes a fresh engine per
 * delegate/council/flow-phase/async-launch, so a per-closure counter would restart at 0
 * and collide handles across concurrent runs.
 */

let globalChildSeq = 0;

/** The next unique bus handle for a child of `agent` (e.g. `scout#3`). */
export function nextChildHandle(agent: string): string {
	globalChildSeq += 1;
	return `${agent}#${globalChildSeq}`;
}
