# pi-persona documentation

This folder contains the long-form documentation that defines how the project is designed and run.

## Canonical docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
  - Core architecture, invariants, module boundaries, and design contracts.
- [`STRATEGIES.md`](./STRATEGIES.md)
  - Strategy SDK and built-in orchestration behavior.
- [`SPINE.md`](./SPINE.md)
  - Shared behavioral spine prompt layer and rollout controls.
- [`TELEMETRY.md`](./TELEMETRY.md)
  - Vendor-neutral observer contract, privacy boundary, persistence, and consumer conformance.

## Supporting evidence

- [`REVIEW-2026-09-04.md`](./REVIEW-2026-09-04.md)
  - Quality review and real multi-Pi validation for the v1.13.0 release.

## Quick map

- **For users / operators:** start from [README](../README.md) and follow links into these design docs as needed.
- **For contributors:** begin at `ARCHITECTURE.md`, then `STRATEGIES.md` for implementation details.
- **For behavior-layer changes:** consult `SPINE.md` and `src/core` / `src/persona/spine.ts` together.
- **For telemetry producers or consumers:** start with `TELEMETRY.md` and its conformance corpus.

## Documentation maintenance notes

When touching this folder:

- Keep names stable (`ARCHITECTURE.md`, `STRATEGIES.md`, `SPINE.md`) because many docs and comments link to them directly.
- Prefer links to this folder over copying duplicate prose into code comments.
- Update both this map and inbound links when adding new authoritative docs.
- A few factual claims are machine-checked by `test/unit/docs/doc-claims.test.ts`. Know its blind
  spots before trusting it:
  - **Env names.** It collects the whole `PI_*` identifiers `src/**/*.ts` actually reads and fails
    when a documented name is not one of them, so a documented name that is merely a *prefix* of a
    real one is caught. It still never reads `scripts/`, so a variable only that tree consumes
    reads as undocumented-in-reverse: the check is one-directional (docs → source), and a source
    variable nothing documents is not flagged at all.
  - **Strategy tables.** It fails when a registered strategy has anything other than exactly one row
    in the strategy table proper (the one headed `| Strategy | … | Params …`) of the root README and
    `STRATEGIES.md`, or when a declared param is not backticked in a cell *after* the row's name — so
    neither a row that drifted into another table nor a row that only repeats its own name passes. It
    still cannot tell whether the *description* of a param or its default is correct.
  - **Skip count.** It scans every `test/**/*.test.ts` for skip markers (an options-object `skip` key
    or a `.skip` shorthand), and fails unless AGENTS.md's stated word, its `skipped N` on Windows and
    its `skipped 0` elsewhere all match, every marker is gated on `process.platform === "win32"`, and
    AGENTS.md names each file carrying one. It counts markers rather than running the runner, so a
    marker on a suite of several skipped subtests would count once where the runner counts each.
- Everything else here is prose a reader has to check against the code — so state behavior precisely
  enough to be falsifiable, and cite the module that settles it.
