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

## Node 22 CI follow-through

The first pushed candidate (`51406e2`) failed CI on Node 22.23.3. Publication was held.
This exposed a real broker cancellation defect: closing during initial connection was treated as
a retryable failure, leaving registration behind an unref'ed backoff timer. A local close now
terminates that path immediately and interrupts an already scheduled backoff. Frozen-clock tests
prove settlement without advancing the retry clock or redialing; the uncancellable helper is removed.

Two independent fixture assumptions were also corrected without weakening their assertions:
directional-usage progress uses a semantic tool-event boundary instead of assuming stdout writes
arrive in separate chunks; worktree cleanup compares canonical native paths so Windows short and
long spellings of the same temporary directory agree. Binary export, checkout cleanliness and
exact remaining-registration checks remain intact. No skips or production timeout increases were added.

Independent review passed 73 focused checks on the official Node 22.23.3 Windows binary, verified
against its published SHA-256 manifest. The fresh complete suite on that runtime passed **2,883
tests: 2,881 passed, two accepted Windows skips, zero failures or cancellations**, in 48.227 seconds.
Typecheck and whitespace checks pass. A fresh real-provider child-engine trial with
`openai/gpt-6-luna` at `xhigh` completed in 57.7 seconds, exit zero: one leg completed and the
supervisor retrieved its exact `LIVE-COMM-OK` archived result through Intercom. The supervisor also
reported the progress message; the real broker/SDK regression supplies the direct transport proof.

This **supersedes the preceding candidate artifact**. Final qualification ran under Node 22.23.3
with registry and installed Pi 1.4.0, both engines: four passes, zero runtime network calls, empty
credential stores, successful stop and joined shutdown. All 204 package files match the source.
SHA-256: `59cd306414bc90f40675fdc9dc20d3d1bc61e5e337a06bb623e3a909891f0abd`.
The final artifact/report/suite log are in
`C:/Users/novad/AppData/Local/Temp/pi-persona-package-qualification-BxRAHN/`;
the first CI logs and live child transcript remain in the preceding `Q3K2Q9` directory.
GitHub publication remains gated on a fresh passing Windows/Linux CI run of the corrective commit.

## Post-release adversarial follow-through

The corrective release commit `782fff52` passed Windows/Linux CI and was published as 1.17.4
on GitHub and npm. The published artifact is the 204-file `BxRAHN` artifact above. The following
corrections are **subsequent, unreleased work**; they do not alter that release or its tag.

- Runtime callbacks now carry a frozen attempt identity (agent, full role, model and effort).
  Council, MAGI, auxiliary actors and flow rows resolve their metadata from that identity, not
  shortened labels. Identical role hints and identical full roles with different inline pins keep
  distinct models. Retries clear stale observations; terminal rows use observed engine metadata.
  The obsolete reverse lookup from display labels to participants was removed.
- Terminal capture observers retain their original tracker-lifetime position across archive-owner
  shutdown/reactivation. Tracking is idempotent, and revoked/late captures cannot append to a new
  owner. A regression uses one extension factory and tracker through start, delegate, shutdown,
  start, delegate, then retrieves the new receipt through Intercom. This proves the reused-instance
  defect. It does **not** establish failure on every native CLI `/new`: Pi 1.4.0's
  `AgentSessionRuntime.newSession` creates a new runtime; the CLI creates new services and a new
  `DefaultResourceLoader`, whose reload invokes extension factories again. Those installed host
  source paths were inspected directly.
- Broker one-way delivery now waits for a correlated, bounded host-bus admission receipt.
  Full inboxes, cancellation, timeout and disconnect report unconfirmed delivery; no replay is
  attempted. This is not a supervisor answer or approval. The concrete in-process subclass adapter
  was replaced by the small transport interface the contact tools actually need. Real socket/pipe
  tests cover both admission and rejection, including a saturated inbox with a pending ask.
- The defensive missing-reference flow excerpt is fenced. The existing public preflight already
  blocks a dependent phase when the reference is missing; hostile-output coverage verifies that
  it neither spawns that phase nor includes the worker's text in the failure report.
- If worktree capture fails but the worker returned a usable patch, the result now starts with an
  explicit warning that this patch was not verified against the worktree state. The regression
  breaks only disposable worktree metadata, checks the warning and patch, verifies cleanup, and
  confirms that the user's checkout remains unchanged.

The review preserved explicit boundaries: ignored files are outside worktree input/export;
an isolated successful leg needs an artifact; a no-session reference flow may run its source
phase before the dependent phase rejects the unavailable durable handoff. These are documented
contracts. The broad session-card-spoof claim supplied no reproducible path in the reviewed
host-selected card types, attributed/fenced worker text and registry-backed Exocom attribution.
The two unspecified UI findings likewise cannot be reported as verified defects or fixes.

Luna xhigh handled the bounded regressions and provenance changes; Sol 6.1 handled lifecycle,
attempt identity and independent refutation. Supervisor source/diff review found no remaining
blocker. On official Node 22.23.3, the full suite passed **2,899 tests: 2,897 passed, two accepted
Windows skips, zero failures or cancellations**, in 46.042 seconds. Strict typecheck passes.
The final test-only assertion refinement also passed both affected integration cases.

Fresh installed-package qualification passed all four combinations: registry/installed Pi 1.4.0,
each with both engines, 17 faux calls per combination, zero runtime network requests, empty
credential stores, successful stop and joined shutdown. All **207 packaged files** match the
source bytes. Candidate SHA-256:
`2b0ac6385604969838fc13f3ffa4a671fd4abbb641ac8fdbb3a073452de13610`.
The artifact/report is retained in
`C:/Users/novad/AppData/Local/Temp/pi-persona-package-qualification-2IHn8m/`.
Its manifest still says 1.17.4: this is a qualification artifact, **not a publishable replacement**
for the immutable npm release. A subsequent publication requires a new version and qualification.

A real-provider judge trial completed in 34.3 seconds: three distinct rows with deliberately
colliding technical role labels retained their Luna/Sol/Luna model pins. A real child-engine
contact trial completed in 27.5 seconds with one successful leg and terminal receipt; the direct
broker tests, rather than the supervisor's prose, prove delivery admission. Logs and telemetry
evidence are in `C:/Users/novad/AppData/Local/Temp/pi-persona-tree-metadata-UL8nKA/`.
These are focused live checks, not an exhaustive terminal/theme or long-duration stress test.

## Critical follow-up on the remaining observations

The independent recheck of `5bb691b` confirmed the five fixes. Its three optional observations
were then checked against their reachable inputs, rather than accepted solely as "non-blocking":

- The occurrence/index join belongs to the launch snapshot, not the picker. A malformed internal
  roster could misalign it, but runtime members are rejected by `parseMembersBlock` before the
  snapshot, and named teams are normalized by `parseTeams` before either projection. No supported
  input reproduced the claimed shift. Auxiliary rows do not advance the roster index.
- The second assignment lookup repeats the first only when no role exists. For a role without
  its own assignment it supplies the required agent assignment fallback. Removing it would be a
  regression; it is not dead code.
- The exact identity-key assertion is an intentional allowlist that excludes tasks, grants and
  result references from lifecycle metadata. A future added field should require explicit review.

One additional defect was reproduced: the progress text concluded "progress dropped" after an
unconfirmed broker send, although the host may already have admitted the message. The exception
paths likewise said a message could not be sent even when an observer threw after inbox insertion.
These three messages now report uncertainty. Wire fields, delivery booleans and unresolved-decision
guidance are unchanged. Regressions prove real inbox admission with an unconfirmed receipt and with
a throwing observer; they also retain the no-answer/authorized-independent-work boundary for both
decision and interview requests. Tests failed before the text correction.

Luna xhigh implemented the small correction; Sol 6.1 independently reviewed its semantics.
Node 22.23.3 full suite: **2,902 tests; 2,900 passed, two accepted Windows skips, zero failures or
cancellations**, in 46.093 seconds. Typecheck passes. The log is
`C:/Users/novad/AppData/Local/Temp/pi-persona-tree-metadata-UL8nKA/unconfirmed-delivery-suite.log`.
This follow-up changes receipt wording only; the preceding installed-artifact hash describes the
earlier candidate, not these updated source bytes. No package publication is represented here.

The evidence supports the corrected contracts and tested scenarios. It does not establish flawless
UX across every terminal/theme, long-running swarm reliability, or comparative superiority over
another orchestration package. Those broader product claims remain unproven.
