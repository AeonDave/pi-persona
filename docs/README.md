# pi-persona documentation

This folder contains the long-form documentation that defines how the project is designed and run.

## Canonical docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
  - Core architecture, invariants, module boundaries, and design contracts.
- [`STRATEGIES.md`](./STRATEGIES.md)
  - Strategy SDK and built-in orchestration behavior.
- [`SPINE.md`](./SPINE.md)
  - Shared behavioral spine prompt layer and rollout controls.

## Quick map

- **For users / operators:** start from [README](../README.md) and follow links into these design docs as needed.
- **For contributors:** begin at `ARCHITECTURE.md`, then `STRATEGIES.md` for implementation details.
- **For behavior-layer changes:** consult `SPINE.md` and `src/core` / `src/persona/spine.ts` together.

## Documentation maintenance notes

When touching this folder:

- Keep names stable (`ARCHITECTURE.md`, `STRATEGIES.md`, `SPINE.md`) because many docs and comments link to them directly.
- Prefer links to this folder over copying duplicate prose into code comments.
- Update both this map and inbound links when adding new authoritative docs.
