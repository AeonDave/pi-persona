# Architecture coherence review — 2026-11-18

## Scope and method

Review of the current, uncommitted checkout after the recent orchestration, worker-continuation,
Exocom, tool and TUI changes. Existing work was snapshotted before review and preserved.
This record qualifies that checkout, not a published version or every possible execution path.

Two independent reviews examined runtime/orchestration (Sol 6.1) and composition/lifecycle
(Astra 6). The supervisor inspected the proposed changes, shared UI and tool boundaries,
terminal-result storage and documentation. Findings required a concrete failure scenario;
module size and superficial similarity were not sufficient reasons to refactor.

## Demonstrated defects and selected changes

| Boundary | Failure | Change |
|---|---|---|
| Provider fallback | A failed, billable attempt disappeared from the returned usage when a later provider was tried. | Reuse `sumUsage` for cumulative input/output, cache usage, cost and turns; retain the final attempt's outcome and context snapshot. |
| Fallback notification | A throwing notification interrupted recovery and discarded an already obtained result. | Contain the observational callback, matching the strategy SDK's recovery boundary. |
| Child progress | A throwing progress consumer could escape a stream callback or prevent `finish()` from resolving after cleanup was started. | Route progress callbacks through one local contained emitter. Keep stream state, deadlines, terminal result and temporary-file cleanup under engine ownership. |
| Persona transitions | Rapid selections could finish model authentication out of order, leaving one persona active with another persona's model, effort and persisted choice. | Serialize persona changes and their persistence/Exocom reconciliation; resolve cycling when its queued operation starts and invalidate queued work on shutdown. |
| Startup and shutdown | Authentication finishing during another extension's shutdown cleanup could restart Persona telemetry after its teardown. | Check the existing disposed state after asynchronous startup handoffs before acquiring telemetry resources. |

Each behavior change has a regression that failed before the fix. Child observer regressions launch
short real Node processes in an isolated harness, exercising stream, synthetic tool completion and
terminal progress callbacks without an uncaught-exception handler.
The startup regression uses Pi 1.5.2's actual session runtime and `dispose()`, with a delayed model
selection and another extension's pending cleanup. It observes the real telemetry producer, makes
no provider request, and awaits shutdown before deleting its isolated profile.

Persona selection is ordered, not an atomic host transaction: an already running Pi `setModel`
call cannot be cancelled or rolled back. Generation invalidation prevents subsequent controller
steps and commits, and skips selections that had not started. Capability changes remain visible
when a transition starts so a restrictive persona does not defer its tool-call gate until auth ends.

## Shared boundaries retained

- **Engine contract, distinct backends:** `StrategyEngine` and the pure stream reducer are shared.
  In-process factory disposal and child-process tree termination have different lifecycle guarantees.
  Combining their implementations would hide those differences.
- **Scoped concurrency:** the launch pool and each strategy's worker semaphore govern different
  resources. Combining them can deadlock a run that holds a launch slot while starting its workers.
- **Communication planes:** runtime events, semantic bus messages, external peer delivery and UI
  projections keep separate identities and lifetimes. The broker relays into the existing bus;
  Exocom's own start/stop queue still protects socket ownership independently of persona changes.
- **Background resources:** script execution already reuses the monitor process lifecycle, with
  separate admission, namespaces and archives. A new generalized job framework would duplicate it.
- **Presentation:** cards share framing and communication projections; F9 and Mind's F10 share
  the inspector contract. Resource groups remain display projections rather than runtime agents.
- **Local tools:** outline and image preview share bounded regular-file reads. Grammar loading,
  image decoding and pure projections remain separate because their resource limits differ.
- **Continuation and results:** transcript ownership, quotas and leases belong to the conversation
  store; worker contract validation and terminal-report retention have distinct responsibilities.

The large extension factory remains a composition root. This review extracts a concrete transition
boundary instead of splitting it mechanically into modules with the same mutable references.

## Performance decision

The terminal-result list deliberately scans native history and checks identity collisions without
retaining another report-body cache. A local Node 22.19 / Windows measurement used 32 and 128
distinct records, each with a 60,000-character ASCII body, and requested up to 50 summaries:

| Records | Body bytes | First list, including hydration | Median of 12 subsequent lists |
|---|---:|---:|---:|
| 32 | 1,920,000 | 21.25 ms | 12.75 ms |
| 128 | 7,680,000 | 45.54 ms | 19.91 ms |

These are local diagnostic measurements, not a cross-platform benchmark or a speedup claim.
No cache was added: this bounded, explicit query did not demonstrate a bottleneck that justified
additional retained state or more complex corrupt/duplicate-history handling.

## Documentation

The README now presents capabilities and short workflows, including worker continuation and
post-compaction continuity. Detailed controls, permissions, provider routing, storage and parser
limits remain in the canonical guides. The documentation index links this review separately from
the product contracts.

## Qualification

- Strict typecheck passed.
- Full hermetic suite on Node 22.19 / Windows: **3,414 passed, 0 failed, 2 intentional Windows
  skips**. The 548-file snapshot remained unchanged throughout the final run. An earlier run
  caught the removed Git-tag installation example in the README; it was restored before this run.
- Native Pi 1.5.2 settings smoke passed, including settings persistence and panel rendering at
  multiple widths, with zero model or network requests.
- Live `scripts/drive.ts` runs with `claude-pro-max-native/claude-sonnet-5-5` and medium effort
  passed on both `child` and `inproc`: two parallel scout workers each, successful receipts and
  both exact requested output markers, with no file edits. Provider-failure accounting uses
  controlled regression fixtures; the live checks do not claim an actual provider-outage test.
- The final startup/shutdown fix is separately covered by the native SDK disposal regression.
- All 38 local README links and anchors resolve. `npm pack --dry-run` includes 264 files and
  excludes tests, review records and `.zcode`; no dependency or release metadata changed.
- Independent cross-review covered the persona transition changes, runtime observer/accounting
  fixes, startup guard and README. Existing uncommitted work was preserved. No commit or release
  is part of this qualification.

The verification record was appended after the frozen test run; production source remained unchanged.

## Release qualification: 1.18.1

The release pass updated the README pins, package/lock version and telemetry producer metadata.
Independent README review verified 39 local links and anchors. The npm artifact contains 264 files;
tests, review records, local scratch files and host dependencies remain outside the package.

The first combined qualification exposed two test-harness assumptions: concurrent skill requests
were attributed by arrival order, and a 500ms idle window could expire during process startup under
load. Requests are now identified by their assigned task, independently of the skill being checked.
A dedicated streaming fixture uses a 2000ms window and asserts an observed runtime beyond it.
Production timeout behavior is unchanged. The final full run passed **3,414 tests**, with **zero
failures and two intentional Windows skips**, and strict typechecking passed.

The extracted npm tarball passed installed Pi 1.5.2 qualification in both engines, including real
process cleanup, cancellation, native tool boundaries and WASM outline loading, with no network
requests. Full dependency audit found zero vulnerabilities. Sonnet 5.5 live qualification also
passed the three-worker single-wake contract and two independent Exocom sessions completing
discovery, offer, automatic wake, pickup, evidence publication and completion. The wake harness
reported a Windows temporary-directory cleanup warning after its assertions passed; this is not
counted as an additional functional check.
