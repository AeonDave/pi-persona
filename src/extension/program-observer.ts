/** Binds one background process source to local rows, controls and session-owned output. */
import type { MonitorArchive } from "../monitor/archive.ts";
import type { MonitorObserver } from "../monitor/session.ts";
import type { AgentTree } from "../ui/agent-tree.ts";
import type { WakeRows, WakeRowChange } from "../ui/wake-rows.ts";

interface ProgramObserverDeps {
	archive: MonitorArchive;
	rows: WakeRows;
	tree: AgentTree;
	stops: Map<string, () => void>;
	disposed(): boolean;
	cancel(id: string): void;
	settle(change: WakeRowChange): void;
	requestRender(): void;
}

/** Archive before projecting. Cosmetic teardown must never discard the terminal record. */
export function createProgramObserver(d: ProgramObserverDeps): MonitorObserver {
	return {
		armed(entry) {
			d.archive.armed(entry);
			if (d.disposed()) return;
			const row = d.rows.monitorArmed(entry);
			d.stops.set(row.id, () => d.cancel(entry.id));
			d.tree.add(row);
		},
		output(output) {
			d.archive.output(output);
			if (!d.disposed() && d.rows.monitorOutput(output)) d.requestRender();
		},
		event(event) {
			d.archive.event(event);
			if (d.disposed()) return;
			const change = d.rows.monitorEvent(event);
			if (change.settled) d.settle(change);
			else d.tree.update(change.id, change.patch);
		},
		removed(entry, reason) {
			d.archive.removed(entry, reason);
			if (!d.disposed()) d.settle(d.rows.monitorRemoved(entry, reason));
		},
	};
}
