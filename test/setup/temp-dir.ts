/**
 * The test suite's temp-directory choke point — mint a fixture dir HERE and it is removed when the
 * process ends, without the caller writing a single line of cleanup.
 *
 * Nearly every test in this suite works in a `mkdtempSync` directory and, before this module,
 * nearly none of them removed it: tens of thousands of `pi-persona-*` dirs had piled up in the
 * developer's temp folder, at a rate of roughly five hundred per full run. Fixing that at the call
 * sites means fixing it forty times and hoping the forty-first author remembers, so instead the
 * only thing a test has to do right is ask for the dir from here.
 *
 * This is the same shape hermetic-env.ts already used for its own sandbox (a captured path, a
 * `process.on("exit")` removal, failures swallowed) — lifted out so there is ONE mechanism rather
 * than two. hermetic-env.ts now mints through it as well.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Dirs minted by this process and not yet removed. A set drained by ONE handler, rather than a
 *  handler per dir: a full run mints hundreds, and past ten listeners Node prints a
 *  MaxListenersExceededWarning over an otherwise green suite. */
const pending = new Set<string>();
let hooked = false;

/** Removes each dir and its contents, never throwing — not for one dir, and not for the ones after
 *  it. On Windows a removal fails transiently whenever Defender, the search indexer or a lingering
 *  child process still holds a handle inside the tree, and this runs at process exit: a throw there
 *  would report a crash after a suite that passed. A leaked directory is a nuisance; failing a
 *  green run over it is a defect. Hence the try INSIDE the loop. */
export function removeTempDirs(dirs: Iterable<string>): void {
	for (const dir of dirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Deliberately silent: nothing useful can be done at exit, and a warning per locked dir
			// would train everyone to ignore the suite's output.
		}
	}
}

/** Mints a temp dir under the OS temp dir with `prefix` (the `mkdtempSync` contract, prefix and
 *  all) and registers it for removal when this process exits.
 *
 *  Exit, not per-test: several tests deliberately read a fixture after the body that created it has
 *  ended, and some dirs are minted at module scope where no test hook is in play. Exit covers the
 *  module-scope mint, the passing test, the test that throws, and the unhandled crash with one
 *  rule — see test/integration/temp-dir.test.ts, which proves all four from outside the process. */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	if (!hooked) {
		// `pending` is read at exit, not captured now: dirs minted later must be drained too.
		process.on("exit", () => removeTempDirs(pending));
		hooked = true;
	}
	pending.add(dir);
	return dir;
}

/** The dirs this process is currently on the hook for. Exists so a test can assert that minting
 *  registered — the property that actually fixes the leak — without draining the registry and
 *  taking another test's fixture (or the hermetic sandbox) with it. */
export function registeredTempDirs(): readonly string[] {
	return [...pending];
}
