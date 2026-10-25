# Current-host cleanup and final requalification

Date: 2026-10-25. Follow-through on the explicit maintenance rule: latest stable Pi only (1.4.0),
remove obsolete implementations and dead code with their callers, and finish verification in the
same change. This supplements the [essential-package review](2026-10-25-essential-package-verification.md);
its earlier artifact and test counts describe the pre-cleanup state.

## Changes and boundaries

- Removed the CJS resolver fallback for Pi's import-only package exports, ignored session-factory
  and idle-notifier options, redundant internal re-exports and unproduced inbound identity aliases.
- Removed optional host API facades and fabricated process identities. Session ownership, branch
  reads, registry queries, context usage and lifecycle now use the Pi 1.4 contract directly. The
  absence of an extension context or an active model remains a valid lifecycle state.
- Model availability no longer falls back to the entire catalog when the host query throws.
  Explicit native bridge catalogs and credential-filtered models retain their existing policy.
- Identity read failures expose an unavailable state and block naming. Recovery rereads the native
  branch; persistence still precedes in-memory rename. A previous session cannot supply ownership.
- Updated stale test doubles to current native session managers and registry contracts. The
  qualification harness reads `persona/settings.json`, uses isolated model stores and separates
  interactive UI checks from a genuinely headless session. The settings smoke enforces the same
  supported host version as the other qualification scripts.

One-way data-root/settings migration, known seeded-file upgrades and bounded history readers still
protect existing user data. The telemetry wire reader is a shared data contract with Flow. These
are active persistence paths, not compatibility with historical Pi hosts; removing them would
change data recovery rather than eliminate dead code. No parallel old-host implementation remains
in the cleaned paths.

The source and ownership review used Luna xhigh and Sol 6.1, followed by supervisor integration.
No commit, push, version bump or publication was performed.

## Validation

Final full suite: **2,865 tests; 2,863 passed, two accepted Windows skips, zero failures**, in
37.541 seconds. Strict typecheck and whitespace checks pass. This run includes the updated native
fixtures and the deterministic bridge-readiness regression described below.

The final installed artifact contains 203 files, all byte-identical to their current repository
counterparts. SHA-256: `9b6becf485c92339d6155a9575a13e79c45ed177f18757f3b31134dc0562725b`.
Registry Pi 1.4.0 and the copied installed Pi 1.4.0 both pass with the in-process and child-process
engines: four passing combinations, 17 faux-provider requests per run, zero runtime network calls,
empty credential stores, successful stop and awaited shutdown.

Both source SDK smokes pass against the installed host: settings/UI uses zero model or network
requests; host qualification uses four local faux requests and zero network requests. The full
dependency audit reports zero vulnerabilities. A separate Sol 6.1 adversarial review found no new
actionable regression in credential filtering, session replacement or the cleaned lifecycle paths.

Fresh real-provider proof used `openai/gpt-6-luna` at `xhigh`: the two independent SDK sessions
completed discovery → task creation → optional offer → automatic wake → exact-generation read →
voluntary pickup → fixture read → evidence publication → finish in 55.2 seconds. Zero tool errors,
zero remaining claims/asks, correct `SMOKE_SUM=42`, unchanged fixture, both shutdowns joined at
55.3 seconds. The process used normal certificate validation. This remains a two-session smoke,
not a long-duration or multi-machine swarm benchmark.

Qualification artifacts and logs are retained in
`C:/Users/novad/AppData/Local/Temp/pi-persona-package-qualification-yceglJ/`.

The full-suite run also exposed a race in the bridge SDK test: a host-side registered handle did
not mean the client bridge had observed the acknowledgement. A deterministic gate now reproduces
that gap and asserts an honest undelivered receipt before readiness. The test then waits for the
native peer-list handshake, sends once, asserts the delivered receipt and checks actual bus text.
No production timeout was changed and the test's three-second delivery bound remains unchanged.
The failed run is retained as `bridge-race-suite.log`; passing focused broker/bridge checks cover
34 tests. `full-suite.log` records the final passing suite, and `live-collaboration.log` records the
real-provider trial. The final complete suite and typecheck passed after this test correction.

Execution platform: Windows, Node 26.3.0, Pi 1.4.0. The installed-package checks and real-provider
trial do not substitute for a fresh Linux/macOS or minimum-Node execution. Runtime sources and all
203 packaged files were compared with the installed qualified artifact; no drift remained.

## 1.17.4 release follow-through

The owner subsequently authorized commit, push, GitHub release and npm publication as 1.17.4.
The earlier statements above describe the pre-release cleanup. The version, lockfile, telemetry
producer metadata, README pins, artwork reference and changelog now agree on 1.17.4.

A user trial exposed a missing council launch-card detail: models were absent, while the role
hint extracted `PI_PERSONA_RESULT_READER_TOKEN` from review prose into a misleading label. This
was the variable name, not a credential value. Role hints now omit technical identifiers, code,
Git refs and terminal/bidi controls while retaining ordinary emphasis and bounded Unicode labels.
Saved participant assignment hashes still use the full role; display normalization does not
reassign a model. Council/flow receipts now store immutable model and requested-effort snapshots,
including repeated roster occurrences, auxiliary judges and phase context. Pending setup remains
explicit. The picker still deduplicates assignments; the receipt enumerates each declared occurrence.
Call titles use supplied arguments rather than rereading today's persona during history rendering.

The regression tests failed before each correction. Final independent review passed 75 focused
tests and 29 extension integration tests, including the exact judge-shaped fixture, different inline
pins on the same role, pending setup, saved history, malformed arguments and widths 1/12/24/60/80.
This is native renderer/component verification, not manual acceptance on every terminal/theme.

Final full suite: **2,882 tests; 2,880 passed, two accepted Windows skips, zero failures**, in
39.888 seconds. Strict typecheck, whitespace checks and the full dependency audit pass (zero
vulnerabilities). All 86 local document links checked across the 13 published Markdown files resolve
to included package paths. The README and canonical guides retain implemented behavior; completed
plans were removed, while the requested comparison, verification records and distinct future
compaction evaluation proposal remain accessible outside the npm artifact.

The final 1.17.4 tarball contains **204 files**, each byte-identical to the source tree.
SHA-256: `385761c0dc089a9fad11d8e334b1a406e256fded93659a8a50ef7335a3f6cc9b`.
Both engines pass again on registry Pi 1.4.0 and a copy of installed Pi 1.4.0: four passing
combinations with 17 faux requests each, zero runtime network calls, empty credential stores,
successful cancellation and awaited shutdown. Artifacts and the final suite log are retained in
`C:/Users/novad/AppData/Local/Temp/pi-persona-package-qualification-Q3K2Q9/`.
The real-provider behavioral evidence above remains applicable: these final corrections affect
presentation snapshots and labels, not engine execution or communication authority.
