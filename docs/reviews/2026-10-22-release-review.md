# Review since v1.17.1 — 2026-10-22

## Scope and conclusion

Reviewed `v1.17.1..fe3c5c2`: 16 commits, 139 changed files, plus the four additional commits through
`6504666` from `claude/gallant-lamport-fmkxj3`, included at the user's request. The review combines source tracing,
prompt/tool-contract checks, dependency review and executable checks. It is not an exhaustive
proof of every provider or operating-system behavior.

The changes support the intended product: distinct supervisor roles with independent workers,
visible progress, live steering and automatic completion wakes. Persona names remain data;
capabilities, orchestration defaults and delegation policy supply the behavioral differences.
The shared prose structure does not flatten those differences. No cosmetic prompt rewrite was
needed.

Interactive `delegate`, `council` and `flow` now share a useful interaction model: return a receipt,
let the supervisor finish independent work, then deliver completion when it is idle. Headless runs
join inline. Batch completion, bounded retention, honest restore notices and the removal of
`intercom wait` support that model. Timer/monitor rows make active watches visible without counting
them as agents or including them in stop-all.

## Findings

### P2 — stopping a run during initial model selection did not release it

In the reviewed baseline, `ensurePersonaModels` awaited `choosePersonaModels` without connecting
the tracked run's abort signal to either RPC `select` or the TUI picker. A newly backgrounded
council or flow could return its receipt and accept `intercom stop`, yet remain running and retain
its launch-pool slot until the operator dismissed the picker.

Reproduction used an interactive council, an active persona, two available models and an unresolved
model-selection dialog. The cancellation receipt was returned, but peek continued to show the run
waiting for the operator. Dismissing the dialog was the only action that settled it. This is a
control/lifecycle defect, not a problem with the persona text.

Corrected by passing cancellation through RPC selection, closing the TUI picker through its own
completion callback, refusing partial/late choices and sharing the checkpoint dialog queue.
Queued setup rechecks persona/session scope. Seven regressions failed before the correction and
passed afterward, covering both tools and UI modes, concurrent setup and stale queued scopes.

### P2 — inherited writeSet rejected read-only research fan-out

The additional Claude commits inherited an agent's declared `writeSet` before checking parallel
ownership. Two `research` legs explicitly restricted to `tools: [read]` therefore inherited the
same `.research/` directory and failed overlap validation, despite having no write capability.
A read-only research leg could similarly collide with an actual writer. The existing read-only
test used `scout`, which had no declared default, and did not expose this case.

The correction limits inherited defaults to effective potential writers using the existing
tool/MCP classifier. Explicit call-level declarations keep their existing semantics.

### P3 — model-selection advice named an unavailable tool

The additional standing brief unconditionally recommended `models`, although a custom persona
could permit delegation while denying that tool, or the host could deactivate it. The recurring
delegation nudge also named it. The runtime gate correctly rejected such a call; the guidance was
inconsistent with the available capabilities. Bundled persona defaults were not affected.

The correction makes the brief's tool advice depend on both active host tools and effective
persona permissions, and removes the same false affordance from recurring nudges and the static
delegate description while preserving the same-provider model-sizing guidance.

### P2 — a partial synthesis concealed missing review coverage

The `synthesize` strategy already omitted failed or blank gatherer reports in v1.17.1. It could
successfully merge the remaining reports without telling the synthesizer which lenses were missing.
The automatic completion delivered only that merged output, so even the retained usable-gatherer
count did not reach the supervisor. Audit therefore could not reliably satisfy its promise to
disclose failed or unread lenses. This is a pre-existing defect relevant to the expanded review
workflow, rather than a regression attributed to the overhaul.

The correction preserves useful partial synthesis but gives the merger and final result explicit
coverage information, including unavailable lenses. Fully successful synthesis retains its output
format. Regression checks cover both failed and empty gatherer results.

## Persona differentiation

| Persona | Decision and delivery contract |
|---|---|
| `dev` | Implement or fix; bounded writers, fresh verification and a repair loop |
| `audit` | Review without edits; correctness, security, performance and test lenses |
| `verify` | Run real checks; repair only within the requested scope; no unproved pass |
| `planner` | An architect/reviewer loop produces a bounded plan, dependencies and hand-offs |
| `researcher` | Investigate claims, cite sources and preserve uncertainty |
| `swarm` | Partition independent repeated work and report full batch coverage |
| `judge` | Compare rival complete answers through an anonymous arbiter |
| `magi` | Resolve a bounded decision through distinct perspectives and recorded dissent |
| `elite` | Coordinate security work with explicit scope, posture and evidence |

The review traced these prompts to the current tool schemas, team rosters and strategy defaults.
For example, Audit supplies diffs to shell-less reviewers, Dev and Verify use `repair`, Planner
uses the new `design` team with `architect` and `reviewer`, and Judge
supplies its required arbiter, and MAGI's voting contract matches its deterministic reducer.
Reviewer/scout tool grants, verifier check instructions and the worker report contracts reinforce
the supervisor roles. A persona's prose remains behavioral guidance; it does not create isolation
or capabilities beyond the runtime grants.

Prompt inspection establishes consistency, not measured superiority across models. A controlled
multi-model task comparison would be needed to quantify delegation frequency, task quality or
the optional spine's benefit. The live wake check tests delivery mechanics rather than that broader
behavioral claim.

## Critical product assessment

The strongest improvement is that the personas now choose different ways of working, rather than
merely describing different attitudes. Planner gains a read-only architect/critic loop; Audit gains
an explicit correctness lens; Dev and Verify sequence implementation and fresh verification; MAGI
and Judge preserve their different decision mechanisms. The common Method / Evidence / Reporting /
Boundaries shape makes those differences easier to compare. The MAGI cores also retain their
opportunity, risk and implementability biases. The reviewed text was preserved.

The new background interaction model also removes a real coordination burden: the supervisor no
longer needs to choose between wait modes or poll to collect healthy workers. Visible cancellation,
queued state, restore honesty and bounded completion reports make that behavior inspectable. The
model-picker and partial-coverage fixes matter here: a launch receipt must lead to a controllable
run, and a completed panel must reveal whether it actually covered every requested perspective.

The following tradeoffs remain to measure rather than describe as proven improvements:

- **Delegation overhead on short tasks.** The per-turn brief now sends even simple multi-step
  mechanical work to a worker and the reactive reminder starts after three substantive calls and
  4,000 output characters. This protects supervisor context on large work, but may add launch latency,
  briefing and cold-start token costs on short serial tasks. The one-tool inline exception and
  persona-specific simple-task guidance help; source inspection cannot establish that the threshold
  is optimal. Compare small local fixes and substantial independent tasks separately before tightening
  it further.
- **Choosing the lightest capable model.** The provider catalog supplies identifiers, not measured
  task competence. The sizing instruction is a useful default, not an automatic cost/quality optimizer.
  Explicit model/provider pins and visible failures should remain authoritative. Measure quality,
  supervisor rework and total usage together; lower worker price alone is not evidence of a cheaper
  completed task.
- **Setup and batch latency.** A first council can require several per-role model choices; saved
  assignments and the single-model shortcut help, but the interaction cost remains. A fan-out's
  single wake deliberately waits for the slowest leg, delaying useful early answers and failures.
  Measure time to useful evidence as well as total completion time.

Recommendation: keep the overhaul and its distinct role contracts. Avoid another broad prompt rewrite
without task evidence. Use a small, repeatable multi-model comparison to tune delegation thresholds
and model sizing; distinguish that product-quality question from the deterministic runtime fixes
and compatibility checks completed here.

## Reported live failure — missing Pi host provider chunk

The operator supplied a failed `research` delegation named `gridlock-consult`, resolved as
`openai/gpt-6.1-sol`. Its error references a missing provider chunk in the globally installed Pi:

```text
Cannot find module .../pi-coding-agent/dist/bundle/chunks/openai-responses-KCCCXI3B.js
```

This is a real delegation failure. The exact missing filename belongs to the Pi 1.3.0 bundle.
The globally installed Pi is now 1.4.0, with files written at 14:39 UTC on 2026-10-22; its current
loader references the existing `openai-responses-I2TBW7OL.js` instead. All 81 installed bundle JS
files matched the official npm artifact, whose integrity was verified against registry metadata.
A fresh process imported the current provider module successfully without network access.

The evidence strongly supports an old lazy loader surviving an in-place host update. The failing
process's loaded code was not inspected, so that final link remains an inference. The current host
artifact is intact; this trace does not establish a wrong provider choice or a persona-text defect.
Source tracing found a related Persona defect: a streamed local module-load failure was classified
as a provider failure, making it eligible for irrelevant provider/model recovery. Both engines now
recognize this narrow missing-host-chunk shape, preserve the original error and attach an explicit
host diagnostic. It stays terminal; aborts and timeouts still take precedence. The remedy is a fresh
Pi process with the same provider/model, and installation repair only if that fresh process fails too.

Automatic replay would need proof that no useful work started and proper attempt accounting; an
empty final result alone does not supply that proof. The current package needs no repair. No active
user session or global installation was changed. This fixes Persona's classification and diagnostic,
not Pi's handling of modules already cached in an older running process.

The later OpenRouter HTTP 402 was a separate credit/request-budget rejection. Session evidence
showed an explicit `openrouter/openai/gpt-6.1-sol` selection in that second tool call, not an engine
fallback rewriting the original pin. No routing or token-limit change was made for that report.

## Dependabot disposition

All three open PR scopes were accepted together, preserving the newer main-branch scripts and
runtime changes:

| PR | Integrated update | Reason and compatibility check |
|---|---|---|
| [#10](https://github.com/AeonDave/pi-persona/pull/10) | Four Pi development packages `1.0.0` → `1.3.0` | Keep the SDK packages aligned; retain optional wildcard peers and the Pi 1.0.0 support floor |
| [#12](https://github.com/AeonDave/pi-persona/pull/12) | setup-node 7.1.0, Scorecard 2.5.0, upload-artifact 7.0.2, CodeQL 4.39.0 | Full commit pins verified against upstream version tags; existing permissions and checkout credential controls preserved |
| [#13](https://github.com/AeonDave/pi-persona/pull/13) | TypeBox 1.4.2; locked Node typings 22.20.5 | Keep Node 22 typings; no relevant mutation of shared nested schema references found |

These are development/tooling updates. The production dependency tree remains empty. At review
completion, package version was `1.17.1`; tagging and publication were outside this review's scope.

## Additional Claude branch

`origin/claude/gallant-lamport-fmkxj3` at `6504666` contains four additional commits beyond
`fe3c5c2`. Its architect agent, correctness lens, declared ownership and earlier delegation guidance
were accepted after reviewing the additional code and fixing the two issues above. Existing user
or project team overrides retain precedence; an existing overridden `review` roster does not
automatically gain the new correctness member. Fresh bundled `design` resolves through the normal
team discovery layer.

## Validation

- Final full suite: 2,338 tests, 2,336 passed, zero failures and the two intentional Windows skips.
  `npm run typecheck` and `git diff --check` passed.
- `npm pack --dry-run` inspected 177 allowlisted files, including the new architect agent and host
  diagnostic. No tests, scripts, review drafts or private configuration were included.
- Full dependency audit: zero vulnerabilities, including development dependencies.
- Settings SDK smoke passed on development Pi 1.3.0, an isolated, fully aligned Pi 1.0.0
  installation and the current global Pi 1.4.0. These exercise real SDK dispatch, persistence, migration and UI paths without model
  or network calls.
- Live interactive wake smoke on `zai/glm-5.3`: three scout results, exactly one completion wake,
  no `peek`/`result`/timer/sleep polling before it. The smoke initially miscounted JSON-string `tasks`
  as zero legs; its parser now reuses the runtime's argument normalization, with two regressions.
  Scout identity, all task/result markers and the three-leg assertion remain enforced.
- Live headless `scripts/drive.ts` on `zai/glm-5.3`, in-process engine: one `synthesize` council,
  two gatherers and one merger, both source markers returned, no false incomplete-coverage warning,
  exit 0 in 22.1 seconds. The disposable profile loaded this checkout's extension explicitly; its
  copied credentials were removed. Partial failures are covered by deterministic regressions.
- These live runs prove the exercised delivery and strategy paths. They do not establish comparative
  persona quality, delegation economy or universal provider behavior.
