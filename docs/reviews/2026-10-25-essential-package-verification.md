# Essential package: verification and collaboration follow-through

Date: 2026-10-25. Repository: `D:/Sources/pi-persona`.
The starting commit is `c858210e551ad8749d5655f7ee646e6b8fd8b969` (1.17.3), with the preceding
essential-package implementation and command/restore changes already uncommitted. This review
preserved those changes. No commit, push, version bump or publication is part of this result.

The subsequent [current-host cleanup and requalification](2026-10-25-current-host-cleanup.md)
supersedes this report's artifact hash and suite totals; the behavioral findings below remain the
record of the essential-package implementation.

## What was reviewed

Read the [comparative study](2026-10-24-pi-subagents.md), its evidence and public-source notes,
[approved package scope](../../ROADMAP.md), binding architecture,
strategy/spine contracts and relevant operational documentation before integrating changes.
The owner explicitly superseded point 6's earlier analysis-only restriction.

Luna xhigh workers reviewed the essential package and card/view consistency and implemented tool,
profile and documentation work. Sol 6.1 handled the transactional collaboration kernel and an
independent adversarial review. The supervisor owned scope, integration, flow-resume corrections,
cross-instance integration and final qualification. Findings were checked against source and
reproductions; a worker's conclusion alone was not treated as a passing gate.

## Resulting behavior

| Area | Verified contract |
|---|---|
| Worktree export | The initial commit stays the baseline; the real Git fixture reconstructs committed, uncommitted and new-file work. |
| Supervisor decisions | Delivery is distinct from an answer. Unavailable, timed-out, cancelled and failed requests do not grant permission. |
| Per-leg thinking | Explicit leg/member, agent default and inherited configuration retain their precedence in both engines. Requested and observed values remain distinct. |
| Retained results | Session-owned bounded reports survive reload, page without respawn, and expose unavailable/truncated outcomes. Reference-mode flows grant only declared upstream reads. |
| Cards and views | Shared compact/expanded presentation, width-safe Unicode, explicit cumulative token usage, immutable launch metadata and observed terminal model identity. |
| Independent colleagues | Generation-bound voluntary tasks, atomic pickup/write claims, optional expiring offers, task progress, bounded attributed evidence and self-reported profiles. |

The usage contract is in [COLLABORATION.md](../COLLABORATION.md). Intercom controls this session's
workers. Exocom peers retain their own user's authority; an invitation does not assign work or
require an answer. No leader election, daemon, implicit takeover, cross-session archive access or
automatic merge was introduced.

## Defects reproduced and corrected during this review

- Flow resume could discard an unsupported reference version and rerun work, accept an unsuccessful
  archived phase, or lose truncation provenance. Invalid references now fail without respawn,
  including unapproved saved checkpoints; retained partial output stays explicitly partial.
- Compact status cards lost the meaning of their token count. They now retain the cumulative
  input/output label. Terminal model views use observed results after recovery without rewriting
  the original launch selection.
- The new collaboration kernel needed stronger persistence contracts: generation IDs prevent old
  intent targeting a reused key; retained-message identities remain idempotent after transport
  deduplication eviction; unknown snapshots fail closed. Budget admission reserves lifecycle space,
  while snapshot reconstruction does not reserve future work for an intermediate replay state.
- Profile edits initially rebuilt startup identity instead of retaining the latest heartbeat's
  persona/model. Profile publication now preserves current presence metadata.
- Task summaries could shorten write scopes without a full inspection path. `exocom_task get`
  returns the complete bounded scope before pickup. Offers now use one generation-aware status
  projection in list, status and delivery paths.
- A real-model peer trial exposed `detail: true` defaulting to ten rows despite a five-row cap.
  Detailed lists now default to five. Field descriptions distinguish discovery with `list` from
  exact-generation inspection with `get`; explicit invalid combinations remain rejected.
- A live child-engine trial exposed Pi 1.4 filtering bridge communication tools out of a plain
  `read` allowlist. Runtime-granted communication tools now join a nonempty allowlist, while empty
  grants and exclusions remain restrictive. Semantic bus denial and peer opt-in are enforced in
  both engines. Runtime steering and scoped result-reader grants remain separate. The ignored
  pre-0.81 SDK option was removed; the supported host's shared model-runtime path remains.

Behavior regressions were reproduced before correction. The independent refuter additionally
tested concurrent pickup, stale-owner reconciliation, reused task keys, retained-ID collision/replay,
full budgets, 64 completed-task snapshot replay, unknown versions and full write-scope inspection.

## Contract assessment

Additional **runtime contracts** were necessary: immutable task-generation identity, atomic ownership
admission, non-gating offers, bounded evidence, lifecycle-safe persistence and action-specific reads
during a pending ask. They are typed and enforced by tool validators, ledger transactions, signed
frames and rendering/attribution rules. Profiles and UI projections never grant capabilities.

No new generic `outputContract` templates were needed for this work. That existing facility validates
a worker's final scalar JSON report; it is not an ownership protocol. Nested report schemas and
host-executed acceptance receipts remain separate work. A model-written proof, successful command,
valid schema, finished task and approved result are distinct facts.

## Fresh validation

The final full suite reported **2,857 tests: 2,855 passed, two accepted Windows skips, no failures**
in 42.235 seconds. Typecheck and whitespace checks passed. Full dependency audit reported zero
vulnerabilities. The latest stable Pi was verified as 1.4.0 from npm metadata.

The final tarball contains 203 files and has SHA-256
`4ef626c3ec597a41472755f4b53a720c901b3d590d9c15aab0eb3f4cd002e75c`.
It was packed after the bridge fix and canonical documentation updates. Qualification passed in
all four combinations: registry Pi 1.4.0 and a copy of the currently installed Pi 1.4.0, each with
the in-process and child-process engines. Each run completed delegation, stop and shutdown with
17 faux-provider requests, zero runtime network requests and an empty credential store. This
validates the installed artifact, not a substituted development checkout.

The machine-readable report, tarball, full-suite output and per-host logs are retained locally in
`C:/Users/novad/AppData/Local/Temp/pi-persona-package-qualification-2hYkOX/` (`report.json`,
`full-suite.log`, and host subdirectories). Plans/review drafts and development smoke scripts are
excluded from the published-file allowlist; the user-facing collaboration guide is included.

The independent bridge authority review passed 136 focused tests; the final implementation pass
added a coaching-with-denied-bus regression and passed 137. Its real SDK regression checks model-
callable tool schemas and sends a progress message over a real named pipe/socket, without any model
request, across ordinary/absent/empty allowlists, literal/glob exclusions, peer opt-in and bus denial.

Real provider smoke tests used `openai/gpt-6-luna`:

- Interactive fan-out: exactly one completion wake containing all three results, 5.410 seconds
  after launch; no peek/result/timer/sleep polling and no second wake during the grace window.
- Control harness: live steering produced `STEERED-OK`, stop returned aborted, and resume skipped
  completed phase `a` and ran only `b`.
- Headless `scripts/drive.ts --engine child` with a read-only worker at `xhigh`: after the bridge
  fix the worker returned the unresolved one-way decision outcome. The supervisor's final report
  contained the attributed `m1` decision; its explicit inbox read was empty after automatic draining.
  No response or authorization was sent. The stronger callable-tool/transport assertions are the
  offline SDK regression above; the live CLI report is corroboration rather than a tool receipt.
- `scripts/exocom-collaboration-smoke.mjs`: two independent SDK sessions in one process, real
  socket/pipe transport, both at `xhigh`. Fresh run passed in 56.2 seconds with actual
  name/list/create/offer/wake/get/take/read/publish/finish events, exactly one pickup, generation
  binding, evidence containing the fixture values 19 and 23 and `SMOKE_SUM=42`, zero tool errors,
  no claims/asks left, unchanged fixture and awaited shutdown of both sessions.
- `npm run smoke:exocom`: real discovery, attributed/fenced postcards, correlated reply, semantic
  claim delivery, send-budget limit and clean registry removal passed.

The first two-peer live trial completed the lifecycle but failed its strict zero-tool-errors
assertion because of the list ergonomics above. It was not counted as a pass; a fresh isolated run
was used after correction. Independent sessions share a test process in this live harness; the
separate ledger race test uses two OS processes. Neither is a long-duration swarm benchmark.

Reproduction commands (provider calls require an explicit `LIVE_MODEL`):

```text
npm run typecheck
npm test
npm audit
npm run smoke:exocom
node scripts/qualify-package.mjs --host 1.4.0 --host <absolute-current-installed-Pi-root>
node --import tsx scripts/wake-smoke.mjs --scout-model openai/gpt-6-luna
node --import tsx scripts/control-test.mjs
node --import tsx scripts/exocom-collaboration-smoke.mjs
```

## Qualification boundaries

- Executed on Windows with Node 26.3.0 and Pi 1.4.0. This is not a fresh Linux/macOS or oldest-Node
  execution result; the two existing Windows exclusions remain explicit.
- Card verification exercises real renderer components, collapsed/expanded content, theme tokens,
  malicious terminal text, Unicode and narrow/wide widths. It is not a manual screenshot acceptance
  on every terminal and theme.
- Stored results remain bounded, session-owned reports. Running workers do not survive parent
  teardown. Peer availability is self-reported; claims coordinate cooperating peers rather than
  imposing filesystem permissions. Completion does not certify correctness or merge work.
- The earlier queued-pause/new-steering anecdote remains an unconfirmed observation retained here.
  A passing single-steer smoke is not evidence that that distinct ordering scenario was reproduced.
- The operator environment emitted an inherited `NODE_TLS_REJECT_UNAUTHORIZED=0` warning during
  the control smoke. This review did not change operator TLS settings. Package installation uses
  strict certificate validation; its runtime harness uses a faux provider and network tripwires.
