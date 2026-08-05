import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	bundledSpinePath,
	bundledWorkerSpinePath,
	MAX_SPINE_BYTES,
	readSpineFile,
	resolveSpine,
	type SpineRead,
	type SpineReader,
} from "../../../src/persona/spine.ts";

const USER = "/user/spine.md";
const BUNDLED = "/pkg/prompts/spine.md";
const USER_WORKER = "/user/spine.worker.md";
const BUNDLED_WORKER = "/pkg/prompts/spine.worker.md";

/** A reader over an in-memory filesystem that records every path it was asked for.
 *  A `{ bytes }` entry stands for a file that exists but is past the size cap. */
function reader(files: Record<string, string | { bytes: number }>): SpineReader & { seen: string[] } {
	const seen: string[] = [];
	const read = ((path: string): SpineRead => {
		seen.push(path);
		const f = files[path];
		if (f === undefined) return { kind: "missing" };
		return typeof f === "string" ? { kind: "ok", text: f } : { kind: "oversize", bytes: f.bytes };
	}) as SpineReader & { seen: string[] };
	read.seen = seen;
	return read;
}

/** `workerSelector` defaults to `selector` — the shipped default, where PI_PERSONA_SPINE_LEGS is
 *  unset and the legs follow the supervisor. The arms that separate them pass it explicitly. */
const resolveWith = (selector: string, read: SpineReader, workerSelector: string = selector) =>
	resolveSpine({ selector, workerSelector, userPath: USER, bundledPath: BUNDLED, workerUserPath: USER_WORKER, workerBundledPath: BUNDLED_WORKER, read });

test("off (the default selector) yields no spine and touches no file", () => {
	const read = reader({ [USER]: "USER", [BUNDLED]: "BUNDLED" });
	const r = resolveWith("", read);
	assert.equal(r.text, undefined);
	assert.equal(r.source, undefined);
	assert.equal(r.worker, undefined);
	assert.equal(r.warning, undefined);
	assert.deepEqual(read.seen, [], "disabled ⇒ not even a read attempt");
});

test("`on` prefers the user-dir spine.md and never reads the bundled one", () => {
	const read = reader({ [USER]: "USER SPINE", [BUNDLED]: "BUNDLED SPINE", [USER_WORKER]: "USER WORKER" });
	const r = resolveWith("on", read);
	assert.equal(r.text, "USER SPINE");
	assert.equal(r.source, USER);
	assert.equal(r.warning, undefined);
	assert.deepEqual(read.seen, [USER, USER_WORKER], "the user copies win before the bundled defaults are consulted");
});

test("`on` falls back to the bundled spine when the user has none", () => {
	const read = reader({ [BUNDLED]: "BUNDLED SPINE", [BUNDLED_WORKER]: "BUNDLED WORKER" });
	const r = resolveWith("on", read);
	assert.equal(r.text, "BUNDLED SPINE");
	assert.equal(r.source, BUNDLED);
	assert.equal(r.worker, "BUNDLED WORKER");
	assert.deepEqual(read.seen, [USER, BUNDLED, USER_WORKER, BUNDLED_WORKER]);
	// The DEFAULT `on` install has no user-dir copies at all. A candidate that simply isn't there
	// is the normal case, not a degradation — warning about it would put two lines of "cannot read"
	// in front of every user who never wrote their own spine, which trains them to ignore the
	// channel that reports the failures that DO matter.
	assert.equal(r.warning, undefined, "an absent user copy is the normal case and must be silent");
});

test("the worker variant resolves independently, with the same user-dir shadowing", () => {
	// The two texts are different prompts doing different jobs — a leg must never be handed the
	// supervisor text (it would stall confirming an irreversible action with a user it has none of).
	const bundledOnly = resolveWith("on", reader({ [BUNDLED]: "SUPERVISOR", [BUNDLED_WORKER]: "WORKER" }));
	assert.equal(bundledOnly.text, "SUPERVISOR");
	assert.equal(bundledOnly.worker, "WORKER");
	assert.equal(bundledOnly.workerSource, BUNDLED_WORKER);

	const shadowed = resolveWith("on", reader({ [BUNDLED]: "SUPERVISOR", [BUNDLED_WORKER]: "WORKER", [USER_WORKER]: "MY WORKER" }));
	assert.equal(shadowed.text, "SUPERVISOR", "shadowing one text does not disturb the other");
	assert.equal(shadowed.worker, "MY WORKER");
	assert.equal(shadowed.workerSource, USER_WORKER);
});

test("`on` treats an empty/whitespace user file as absent and falls through", () => {
	const r = resolveWith("on", reader({ [USER]: "  \n\t \n", [BUNDLED]: "BUNDLED SPINE", [BUNDLED_WORKER]: "W" }));
	assert.equal(r.text, "BUNDLED SPINE");
	assert.equal(r.source, BUNDLED);
	assert.match(r.warning ?? "", /\/user\/spine\.md is empty/, "the skipped candidate is named — an empty file is not a silent one");
});

test("`on` skips a candidate past the size cap and says so, then falls through", () => {
	const r = resolveWith("on", reader({ [USER]: { bytes: 8_000_000 }, [BUNDLED]: "BUNDLED SPINE", [BUNDLED_WORKER]: "W" }));
	assert.equal(r.text, "BUNDLED SPINE", "an oversize user copy does not take the session down with it");
	assert.match(r.warning ?? "", /8000000 bytes/);
	assert.match(r.warning ?? "", new RegExp(`${MAX_SPINE_BYTES}`), "the cap itself is in the message, so the user knows the bar");
});

test("`on` with neither file present degrades to no spine, naming both candidates", () => {
	const r = resolveWith("on", reader({}));
	assert.equal(r.text, undefined);
	assert.equal(r.source, undefined);
	assert.match(r.warning ?? "", /spine/);
	assert.match(r.warning ?? "", /\/user\/spine\.md/, "the warning names where it looked");
	assert.match(r.warning ?? "", /\/pkg\/prompts\/spine\.md/);
});

test("`on` with a supervisor spine but no worker one reports the worker gap separately", () => {
	const r = resolveWith("on", reader({ [BUNDLED]: "SUPERVISOR" }));
	assert.equal(r.text, "SUPERVISOR", "the supervisor layer still applies");
	assert.equal(r.worker, undefined, "no worker text ⇒ legs run bare rather than inheriting the supervisor text");
	assert.match(r.warning ?? "", /spine\.worker\.md/);
	assert.match(r.warning ?? "", /\/user\/spine\.worker\.md/);
});

test("supervisor-only: the legs' selector off leaves every worker candidate unread and unmentioned", () => {
	const read = reader({ [USER]: "SUPERVISOR", [USER_WORKER]: "WORKER", [BUNDLED_WORKER]: "BUNDLED WORKER" });
	const r = resolveWith("on", read, "");
	assert.equal(r.text, "SUPERVISOR");
	assert.equal(r.worker, undefined, "legs run bare — this is the arm that isolates the supervisor text");
	assert.equal(r.workerSource, undefined);
	assert.deepEqual(read.seen, [USER], "off ⇒ not even a read attempt for that role");
	assert.equal(r.warning, undefined, "a role deliberately turned off is not a degradation to warn about");
});

test("legs-only: the supervisor's selector off leaves the supervisor candidates unread and unmentioned", () => {
	const read = reader({ [USER]: "SUPERVISOR", [BUNDLED]: "BUNDLED", [USER_WORKER]: "WORKER" });
	const r = resolveWith("", read, "on");
	assert.equal(r.text, undefined, "supervisor turns stay byte-identical to pre-spine in this arm");
	assert.equal(r.source, undefined);
	assert.equal(r.worker, "WORKER");
	assert.equal(r.workerSource, USER_WORKER);
	assert.deepEqual(read.seen, [USER_WORKER]);
	assert.equal(r.warning, undefined);
});

test("the four measurement arms of docs/SPINE.md each produce their own composition", () => {
	// One selector cannot express the middle two, and a fanout A/B that cannot separate them
	// reads a gain in one text and a loss in the other as a null result.
	const files = { [BUNDLED]: "SUP", [BUNDLED_WORKER]: "WRK" };
	const arm = (selector: string, workerSelector: string) => {
		const r = resolveWith(selector, reader(files), workerSelector);
		return [r.text, r.worker];
	};
	assert.deepEqual(arm("", ""), [undefined, undefined], "off");
	assert.deepEqual(arm("on", ""), ["SUP", undefined], "supervisor-only");
	assert.deepEqual(arm("", "on"), [undefined, "WRK"], "legs-only");
	assert.deepEqual(arm("on", "on"), ["SUP", "WRK"], "both");
});

test("the two selectors can name different files, and neither falls back to the other's", () => {
	const read = reader({ "/a.md": "MY SUPERVISOR", "/b.md": "MY WORKER", [BUNDLED]: "BUNDLED", [BUNDLED_WORKER]: "BUNDLED WORKER" });
	const r = resolveWith("/a.md", read, "/b.md");
	assert.equal(r.text, "MY SUPERVISOR");
	assert.equal(r.source, "/a.md");
	assert.equal(r.worker, "MY WORKER");
	assert.equal(r.workerSource, "/b.md");
	assert.deepEqual(read.seen, ["/a.md", "/b.md"]);
});

test("an explicit path the legs FOLLOW onto is one decision, read once and reported once", () => {
	// The default wiring points both roles at the same file. Resolving it twice would stat and
	// slurp it twice, and a mistyped path would come back as two warnings for one typo.
	const read = reader({});
	const r = resolveWith("/gone.md", read);
	assert.deepEqual(read.seen, ["/gone.md"], "one file, one read");
	assert.equal((r.warning ?? "").match(/cannot read/g)?.length, 1, `one typo, one warning — got: ${r.warning}`);
});

test("only the legs' explicit path being unusable degrades the legs alone", () => {
	const r = resolveWith("on", reader({ [BUNDLED]: "SUPERVISOR" }), "/gone-worker.md");
	assert.equal(r.text, "SUPERVISOR", "the supervisor role is unaffected by the other role's bad path");
	assert.equal(r.worker, undefined);
	assert.match(r.warning ?? "", /cannot read \/gone-worker\.md/);
	assert.match(r.warning ?? "", /delegated legs continue without one/, "the warning says which role lost its layer");
});

test("an explicit path is read verbatim — no user/bundled candidates are consulted", () => {
	const read = reader({ "/my/private.md": "PRIVATE", [USER]: "USER", [BUNDLED]: "BUNDLED" });
	const r = resolveWith("/my/private.md", read);
	assert.equal(r.text, "PRIVATE");
	assert.equal(r.source, "/my/private.md");
	assert.deepEqual(read.seen, ["/my/private.md"]);
});

test("an explicit path serves BOTH roles — the override names one file, not a pair", () => {
	const r = resolveWith("/my/private.md", reader({ "/my/private.md": "PRIVATE", [BUNDLED_WORKER]: "BUNDLED WORKER" }));
	assert.equal(r.worker, "PRIVATE", "the user's own file reaches the legs too — never the bundled worker default");
	assert.equal(r.workerSource, "/my/private.md");
});

test("an unreadable explicit path degrades to no spine with a warning — never a hard failure, never a fallback", () => {
	const read = reader({ [USER]: "USER", [BUNDLED]: "BUNDLED" });
	const r = resolveWith("/gone.md", read);
	assert.equal(r.text, undefined, "an explicitly requested spine that is missing does NOT silently become another one");
	assert.equal(r.worker, undefined);
	assert.match(r.warning ?? "", /cannot read \/gone\.md/);
	assert.deepEqual(read.seen, ["/gone.md"], "no fallback read");
});

test("an explicit path holding an empty file says EMPTY, not `cannot read`", () => {
	// The two failures send a user to opposite places: one to permissions, one to content.
	const r = resolveWith("/empty.md", reader({ "/empty.md": "\n \n" }));
	assert.equal(r.text, undefined);
	assert.match(r.warning ?? "", /\/empty\.md is empty/);
	assert.doesNotMatch(r.warning ?? "", /cannot read/, "the file was read perfectly — saying otherwise starts a permissions hunt");
});

test("an explicit path past the size cap degrades with the size in the message", () => {
	const r = resolveWith("/huge.log", reader({ "/huge.log": { bytes: 8_388_608 } }));
	assert.equal(r.text, undefined, "a mistyped path at a log must not be prepended to every turn and every leg");
	assert.equal(r.worker, undefined);
	assert.match(r.warning ?? "", /\/huge\.log/);
	assert.match(r.warning ?? "", /8388608 bytes/);
});

test("the spine text is trimmed so the composed joins stay exact", () => {
	const r = resolveWith("on", reader({ [USER]: "\n\nSPINE BODY\n\n\n", [USER_WORKER]: "\n WORKER BODY \n" }));
	assert.equal(r.text, "SPINE BODY");
	assert.equal(r.worker, "WORKER BODY");
});

test("a reader that reports every path missing is not the resolver's problem", () => {
	// The production reader swallows fs errors; the resolver just sees "no content".
	const r = resolveWith("/denied.md", () => ({ kind: "missing" }));
	assert.equal(r.text, undefined);
	assert.match(r.warning ?? "", /\/denied\.md/);
});

test("the cap is 64 KiB — the bound itself, not just 'some bound'", () => {
	// Every other test here derives its fixture from MAX_SPINE_BYTES, so all of them keep passing
	// if the constant is raised. The number IS the safety property: the layer is prepended to every
	// supervisor turn AND every delegated leg, so a cap loose enough to admit a log file gives back
	// exactly the cost the bound exists to prevent (and would make the fixtures below write it).
	assert.equal(MAX_SPINE_BYTES, 65536, "64 KiB — orders of magnitude past any hand-written layer, well short of one worth paying for per turn");
});

test("readSpineFile refuses a file past the cap instead of loading it", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-persona-spine-cap-"));
	const huge = join(dir, "huge.md");
	writeFileSync(huge, "x".repeat(MAX_SPINE_BYTES + 1));
	const r = readSpineFile(huge);
	assert.equal(r.kind, "oversize", "an oversize file is refused at the reader — it never becomes prompt bytes");
	assert.equal(r.kind === "oversize" ? r.bytes : 0, MAX_SPINE_BYTES + 1);

	const ok = join(dir, "ok.md");
	writeFileSync(ok, "y".repeat(MAX_SPINE_BYTES));
	assert.equal(readSpineFile(ok).kind, "ok", "exactly at the cap is still fine — the bound is inclusive");
	assert.equal(readSpineFile(join(dir, "nope.md")).kind, "missing");
});

test("readSpineFile stats BEFORE it reads — the refusal is what keeps an oversize file's bytes out", () => {
	// Reading first and measuring the string afterwards refuses exactly the same files, so the
	// refusal alone witnesses nothing. The ORDER is the property: a 400 MB log at the end of a
	// mistyped PI_PERSONA_SPINE must not be slurped into memory on the way to being rejected.
	const calls: string[] = [];
	const spy = (bytes: number) => ({
		size: (p: string) => {
			calls.push(`size ${p}`);
			return bytes;
		},
		text: (p: string) => {
			calls.push(`text ${p}`);
			return "BODY";
		},
	});

	const big = readSpineFile("/huge.log", spy(MAX_SPINE_BYTES + 1));
	assert.equal(big.kind, "oversize");
	assert.deepEqual(calls, ["size /huge.log"], "the oversize file is never opened for its contents");

	calls.length = 0;
	const fine = readSpineFile("/fine.md", spy(10));
	assert.equal(fine.kind === "ok" ? fine.text : "", "BODY");
	assert.deepEqual(calls, ["size /fine.md", "text /fine.md"], "and on the happy path the stat still comes first");

	// The seam must not have changed what the resolver is handed: the parameter is optional, so
	// the production reader is still a plain SpineReader over the real filesystem.
	const asReader: SpineReader = readSpineFile;
	assert.equal(asReader(join(tmpdir(), "pi-persona-no-such-spine.md")).kind, "missing");
});

test("the bundled spine paths are package-root relative, so they resolve from an INSTALLED package too", () => {
	// Simulated install layout: the module sits at <pkg>/src/persona/spine.ts, so the bundled
	// prompt must land at <pkg>/prompts/spine.md wherever <pkg> happens to be.
	const pkg = resolve(process.platform === "win32" ? "C:\\opt\\app\\node_modules\\pi-persona" : "/opt/app/node_modules/pi-persona");
	const moduleUrl = pathToFileURL(join(pkg, "src", "persona", "spine.ts")).href;
	assert.equal(bundledSpinePath(moduleUrl), join(pkg, "prompts", "spine.md"));
	assert.equal(bundledWorkerSpinePath(moduleUrl), join(pkg, "prompts", "spine.worker.md"));

	// And in this checkout they point at files that actually exist.
	assert.ok(existsSync(bundledSpinePath()), `bundled spine missing at ${bundledSpinePath()}`);
	assert.ok(existsSync(bundledWorkerSpinePath()), `bundled worker spine missing at ${bundledWorkerSpinePath()}`);
});

test("the bundled prompts folder is shipped — package.json `files` carries it", () => {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };
	assert.ok(pkg.files.includes("prompts"), "without `prompts` in `files` the bundled spine never reaches an installed package");
});
