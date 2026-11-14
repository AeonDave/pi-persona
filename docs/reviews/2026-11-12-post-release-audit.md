# Post-release architecture and supervision audit

Date: 2026-11-12. Baseline: `v1.17.6` (`a2958a84`) through `0dddb786`, followed by
the corrections described here. The four original commits changed 138 files, with 5,688 additions
and 882 deletions. The working tree was clean at the start of this review.

The review covered runtime/process ownership, engines and orchestration, communications and UI,
permissions, retained results, package integration, tests, and current documentation. Luna, Terra
and Sol reviewed separate areas; Astra independently challenged the integration boundaries. The
supervisor integrated the findings and checked the final artifact and source snapshot.

## Value of the retained changes

| Commit | Concrete value | Review decision |
|---|---|---|
| `e9573546` | Shared standalone-card rendering and host keybinding/padding behavior; truthful evidence, checkout-delta and retained-output handling; current Pi alignment | Retained. Presentation, evidence and archive semantics have distinct owners; no second native tool shell is needed. |
| `1373842f` | Empty compact maintenance notes no longer fabricate an `(no output)` body | Retained. Full detail remains expandable and source content is unchanged. |
| `d95c545f` | Asynchronous scripts, grouped resource views, native OS/search tools and local multilanguage outlines | Retained. Scripts reuse monitor lifecycle and archives; native tools remain Pi implementations. The single lazy WASM backend adds roughly 21 MiB installed, in exchange for multilingual syntax extraction without a server or index. This does not establish a speed advantage over grep. |
| `0dddb786` | Consistent compact cards, assigned sender names, expandable launch requests, truthful parallel-writer rejection and final unread-message delivery | Retained with the delivery and structured-state corrections below. Ownership checks remain active; only tasks actually admitted to a parallel launch participate in that check. |

No post-release feature was removed merely to reduce line count. The changes answer actual user
requests or repair observable behavior. The audit found additional defects and a qualification gap;
the earlier green suites alone were insufficient evidence for the integrated checkout.

## Corrections from this audit

| Reproduced problem | Correction and regression evidence |
|---|---|
| Periodic Intercom delivery consumed unread notes before a host send that could throw | Completion and periodic delivery share one snapshot-and-consume helper; consumption commits after successful send. A failed-send/second-tick regression proves retry without duplicate consumption. |
| A large unread inbox produced an oversized periodic wake | Both paths share the 12,000-character formatter and a retained message-ID footer. A 200-message case verifies the bound and explicit retrieval references. |
| A multiline error or salvaged body could imitate a failed-run row in the compact card | New completion details contain bounded runtime settlement facts and aliases. The text parser was removed; clipped and forged bodies cannot supply run states. Old or malformed metadata falls back to literal expandable history. |
| A passive monitor observer could strand an admitted job, interrupt cancellation or suppress notification | One domain helper isolates passive observation in core/session adapters. Semantic delivery remains outside that passive catch boundary. Throwing-observer tests cover admission, cancellation and event delivery for the shared monitor/script lifecycle. |
| Windows `C:foo`/`C:` paths passed repository-relative ownership validation; drive roots lost their distinction during normalization | The shared ownership rule rejects drive-relative declarations and preserves drive-root normalization. Delegate and Exocom consumers keep the same canonical rule. |
| Child-engine registration/steering failures before spawn leaked a reader grant or broker handle; failed revocation skipped unregister | Preparation and execution share one `try/finally`; unregister still runs if revocation throws. Tests inject each failure before and after process execution. |
| A partial native builtin selection was expanded from one active base tool | Activation now requires all four real native base tools and no configured `defaultTools` selection. An actual SDK reproduction preserves `noTools: "builtin", tools: ["+read"]`. |
| Tarball qualification did not install or invoke the new lazy parser dependency | Preparation installs declared runtime dependencies only in the isolated candidate directory, with scripts disabled. Peer resolution is checked before/after; both engine runs execute JavaScript and TypeScript outlines from the extracted artifact. |

Behavior regressions were reproduced before their fixes. Removing the mock-only API fallback also
exposed incomplete Pi test fixtures. Those fixtures now provide the current required API and tool
source metadata; production code does not keep a compatibility branch solely for old mocks.

## Architectural conclusions

- Script and monitor processes share lifecycle, capture, archive and view binding. Their IDs and
  histories remain separate; a timer and an independent peer do not acquire worker controls.
- Cards share the frame and host expansion contract. Runtime state is structured metadata;
  worker prose remains fenced content. Rendering does not become a source of runtime truth.
- Completion and periodic notes share their consumption and size rules. Both preserve live asks
  and messages arriving after the delivered snapshot.
- Native OS tools retain host execution and schemas. Outlines have one filesystem adapter, one
  lazy WASM adapter and a pure AST projection; Babel, indexing services and parser fallbacks are absent.
- Engine setup stays backend-specific where SDK sessions and child processes have different
  cancellation/resource contracts. A universal task class or more inheritance would conceal these
  distinctions rather than remove a duplicated policy.

The SDK's `noTools: "builtin"` is a mutable initial selection, not a hard allowlist. If a caller
explicitly restores all four base tools, the public extension API cannot distinguish that from
implicit defaults. This limitation is documented; strict allowlists, exclusions and explicit
`defaultTools` remain the appropriate host controls. No private Pi introspection was added.

README, the experience guide, architecture, native-tool reference, monitor/script guide, docs map
and Unreleased changelog were updated. Historical qualification reports remain dated evidence;
the README distinguishes current source from the published `1.17.6` release.

## Final verification

Execution environment: Windows, Node.js 26.3.0, Pi 1.5.2. Registry metadata confirmed Persona
1.17.6 and Pi 1.5.2 as the published versions during this audit.

- `npm run typecheck`: exit 0.
- `npm test`: 3,121 passed, zero failures, two documented Windows-only skips (3,123 total).
- `npm audit`, including development dependencies: zero reported vulnerabilities.
- `npm pack --dry-run`: exit 0; the actual artifact inventory contains 238 allowlisted files.
- Installed-artifact qualification on registry Pi 1.5.2: both in-process and child engines passed,
  including actual WASM JS/TS outlines, completion/retrieval, stop, shutdown and process cleanup.
  Runtime network requests: zero; the 21 requests per engine used the local faux provider.
  Registry access was used during package preparation.
- Final real-model RPC smoke with `openai/gpt-6-luna`, medium effort: both engines passed.
  Each produced one launch turn and one completion turn, with the assigned alias, final unread note,
  message ID and coherent runtime settlement snapshot. No supervisor polling was used.
- Independent focused reviews also passed their relevant tests; these are subsets of the checks,
  not additional unique test counts.

Local evidence directories under `%TEMP%`:

- `pi-persona-postrelease-final-full.log`: complete suite output.
- `pi-persona-package-qualification-udoHLI/`: artifact, report, host/engine outcomes, dependency
  paths, preparation logs and runtime receipts.
- `pi-persona-audit-final-live-1794503642680/`: real-model harness, requests, event streams and summary.

The local candidate retains package version `1.17.6` but contains unreleased changes; it is not
the published release artifact. Its SHA-256 is
`096a651e0532ce5af1ad34a3d741d82d0a4c68ace47b35dd012834dd0b8f05b9`.
All 238 distributed files were compared byte-for-byte with the final checkout, with no mismatches.
The ordered file/content digest in `current-tree-check.json` is
`5875ab35a42acd5471eb644214c9f45a356da4098639aad824fd71daebc9e4e4`.

This audit did not rerun Linux/macOS or the minimum supported Node version, visually inspect a
terminal by hand, or qualify every supported language from the installed artifact. The native
component tests cover expansion/click behavior, and source parser tests cover the other language
samples. No companion source changes, publication or push were part of this audit.
