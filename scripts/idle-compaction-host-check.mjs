/**
 * Offline Pi host lifecycle check for https://github.com/badlogic/pi-mono/issues/7738.
 * Run with: node scripts/idle-compaction-host-check.mjs
 * Scope: synthetic-summary overlapping-cancellation lifecycle only; no real provider or network requests.
 * Expected on installed Pi 1.4.0: nonzero exit until both cancellations have paired lifecycle events and notifications.
 * Passing this check is one prerequisite only; it never enables the Persona feature gate.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function installedSdkVersion() {
  try {
    let directory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    while (true) {
      const packagePath = join(directory, "package.json");
      try {
        const metadata = JSON.parse(await readFile(packagePath, "utf8"));
        if (metadata.name === "@earendil-works/pi-coding-agent") return metadata.version ?? "unknown";
      } catch { /* Continue to the package root containing the resolved entry. */ }
      const parent = dirname(directory);
      if (parent === directory) return "unknown";
      directory = parent;
    }
  } catch {
    return "unknown";
  }
}

const report = {
  qualification: "Pi idle compaction overlapping-cancellation host check",
  host: {
    sdk: "@earendil-works/pi-coding-agent",
    version: await installedSdkVersion(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  expected: {
    cancellations: ["Compaction cancelled", "Compaction cancelled"],
    starts: 2,
    ends: 2,
    abortedEnds: 2,
    failureHooks: 2,
    savedEntries: 0,
    providerCalls: 0,
    networkCalls: 0,
  },
  observed: {
    hookCalls: 0,
    hookDecisions: [],
    callbackOutcome: null,
    secondOutcome: null,
    events: [],
    failureHooks: 0,
    savedEntries: null,
    providerCalls: null,
    networkCalls: 0,
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  report.observed.networkCalls++;
  throw new Error("The host check must not access the network");
};

const profile = await mkdtemp(join(tmpdir(), "pi-persona-idle-host-check-"));
const entered = gate();
const released = gate();
const cancelled = gate();
const callbackSettled = gate();
const twoFailures = gate();
const twoEnds = gate();
let watchdog;
const timeout = new Promise((_, reject) => {
  watchdog = setTimeout(() => reject(new Error("Timed out waiting for Pi compaction lifecycle events")), 10_000);
});
let context;
let session;
let manager;
let faux;
let ownedPending = false;
let hookCalls = 0;
let runError = null;

try {
  const runtime = await ModelRuntime.create({
    authPath: join(profile, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(profile, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  faux = fauxProvider({ provider: "idle-host-check", models: [{ id: "local" }] });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey("idle-host-check", "synthetic-offline-fixture");

  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false, reserveTokens: 16, keepRecentTokens: 1 },
  });
  manager = SessionManager.inMemory(profile);
  for (let index = 0; index < 3; index++) {
    manager.appendMessage({
      role: "user", content: `synthetic ${index}${" x".repeat(200)}`, timestamp: 100 + index * 2,
    });
    manager.appendMessage({
      role: "assistant", api: "test", provider: "idle-host-check", model: "local",
      content: [{ type: "text", text: `reply ${index}` }], stopReason: "stop",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: 101 + index * 2,
    });
  }

  const loader = new DefaultResourceLoader({
    cwd: profile,
    agentDir: profile,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [pi => {
      pi.on("session_start", (_event, ctx) => { context = ctx; });
      pi.on("session_before_compact", async event => {
        hookCalls++;
        report.observed.hookCalls = hookCalls;
        if (hookCalls === 1) {
          const signal = event.signal;
          signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
          entered.resolve();
          await released.promise;
          if (signal.aborted) {
            report.observed.hookDecisions.push("idle request cancelled by overlapping manual request");
            return { cancel: true };
          }
        } else if (ownedPending) {
          report.observed.hookDecisions.push("overlapping manual request cancelled while idle request settles");
          return { cancel: true };
        }
        return { compaction: {
          summary: "Synthetic offline summary",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } };
      });
      pi.on("session_compact_failed", () => {
        report.observed.failureHooks++;
        if (report.observed.failureHooks >= 2) twoFailures.resolve();
      });
    }],
  });

  await loader.reload();
  ({ session } = await createAgentSession({
    cwd: profile,
    agentDir: profile,
    model: faux.models[0],
    modelRuntime: runtime,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    tools: [],
  }));
  session.subscribe(event => {
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      report.observed.events.push({ type: event.type, aborted: event.aborted });
      if (event.type === "compaction_end" && report.observed.events.filter(item => item.type === "compaction_end").length >= 2) {
        twoEnds.resolve();
      }
    }
  });
  await session.bindExtensions({ mode: "tui" });
  assert.equal(context.isIdle(), true);

  ownedPending = true;
  context.compact({
    onComplete: () => {
      report.observed.callbackOutcome = { kind: "completed" };
      ownedPending = false;
      callbackSettled.resolve();
    },
    onError: error => {
      report.observed.callbackOutcome = { kind: "error", message: errorMessage(error) };
      ownedPending = false;
      callbackSettled.resolve();
    },
  });
  await Promise.race([entered.promise, timeout]);

  const second = Promise.resolve().then(() => session.compact()).then(
    () => ({ kind: "completed" }),
    error => ({ kind: "error", message: errorMessage(error) }),
  );
  await Promise.race([cancelled.promise, timeout]);
  released.resolve();
  report.observed.secondOutcome = await Promise.race([second, timeout]);
  await Promise.race([callbackSettled.promise, timeout]);
  await Promise.race([
    Promise.all([twoFailures.promise, twoEnds.promise]),
    new Promise(resolve => setTimeout(resolve, 250)),
  ]);
} catch (error) {
  runError = errorMessage(error);
} finally {
  clearTimeout(watchdog);
  released.resolve();
  if (session) {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } catch (error) {
      report.cleanupError = `session_shutdown: ${errorMessage(error)}`;
    }
    try { session.dispose(); }
    catch (error) { report.cleanupError = `session dispose: ${errorMessage(error)}`; }
  }
  globalThis.fetch = originalFetch;
  try {
    assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
    await rm(profile, { recursive: true, force: true });
  } catch (error) {
    report.cleanupError = `profile cleanup: ${errorMessage(error)}`;
  }
}

report.runError = runError ?? null;
report.observed.providerCalls = faux?.state.callCount ?? null;
report.observed.savedEntries = manager?.getBranch().filter(entry => entry.type === "compaction").length ?? null;
const failures = [];
function check(label, assertion) {
  try { assertion(); }
  catch (error) { failures.push(`${label}: ${errorMessage(error)}`); }
}
check("scenario completed", () => assert.equal(runError, null));
check("profile and session cleanup completed", () => assert.equal(report.cleanupError, undefined));
check("both requests were cancelled by the fixture", () => assert.deepEqual(
  [...report.observed.hookDecisions].sort(),
  [
    "idle request cancelled by overlapping manual request",
    "overlapping manual request cancelled while idle request settles",
  ].sort(),
));
check("idle callback reports cancellation", () => assert.deepEqual(
  report.observed.callbackOutcome, { kind: "error", message: "Compaction cancelled" },
));
check("manual request reports cancellation", () => assert.deepEqual(
  report.observed.secondOutcome, { kind: "error", message: "Compaction cancelled" },
));
check("two compactions entered", () => assert.equal(
  report.observed.events.filter(event => event.type === "compaction_start").length, report.expected.starts,
));
const ends = report.observed.events.filter(event => event.type === "compaction_end");
check("both starts have matching ends", () => assert.equal(ends.length, report.expected.ends));
check("both ends report cancellation", () => assert.equal(
  ends.filter(event => event.aborted === true).length, report.expected.abortedEnds,
));
check("both failure notifications arrived", () => assert.equal(report.observed.failureHooks, report.expected.failureHooks));
check("no summary was saved", () => assert.equal(report.observed.savedEntries, report.expected.savedEntries));
check("the faux provider was never called", () => assert.equal(report.observed.providerCalls, report.expected.providerCalls));
check("no network call was attempted", () => assert.equal(report.observed.networkCalls, report.expected.networkCalls));
report.failures = failures;
report.lifecycleCheck = failures.length === 0 ? "PASS" : "FAIL";
report.activation = "BLOCKED: this lifecycle check is one prerequisite; activation still requires full qualification and a Persona release.";
console.log(JSON.stringify(report, null, 2));
assert.equal(failures.length, 0, failures.join("\n"));
