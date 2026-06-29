# AGENTS.md — pi-persona

A single Pi coding-agent extension (`@earendil-works/pi-*`) that makes the agent a **supervisor**
of switchable **personas** + file-based **orchestration strategies**. Loaded by Pi via tsx/jiti —
no build step. Design specs (binding on any conflict, guardrails first):
`docs/superpowers/specs/2026-06-25-pi-persona-implementation-guardrails.md` then the architecture spec beside it.

## Commands

- Typecheck (must stay clean): `npm run typecheck`  (`tsc --noEmit`, strict)
- All tests: `npm test` · unit only: `npm run test:unit`
- One file: `node --import tsx --test test/unit/core/frontmatter.test.ts`
- Live end-to-end (REAL model calls, spends tokens): `npm run drive -- --persona <name> --model <provider/id> "<prompt>"`
  - Control ops: `LIVE_MODEL=<provider/id> node --import tsx scripts/control-test.mjs` (STEER/STOP/RESUME)
  - Models must be **provider-qualified**, e.g. `claude-pro-max-native/claude-opus-4-8` or `.../claude-haiku-4-5`.

## Conventions

- **Erasable-syntax-only** TS (no enums / namespaces / parameter-properties) — runs under
  strip-types, tsx, jiti, Bun. `erasableSyntaxOnly` is on; keep it that way.
- tsconfig is strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` +
  `noUnusedLocals` + `noUnusedParameters`. Keep `tsc` clean before moving on.
- `src/core/*` is **pure** (no Pi imports) and unit-tested. Import host packages from
  `@earendil-works/pi-*`; never bundle copies.
- **Cross-OS**: use Pi's spawn/kill/path/temp helpers (`getPiInvocation`, `killProcessTree`), not raw
  `child_process`. Windows kill goes straight to `taskkill /F /T`; always attach an `error` listener.
- Two engines behind the `StrategyEngine` seam: **InProcessEngine** (`engine/inproc`,
  `createAgentSession`, DEFAULT) and **ChildProcessEngine** (`engine/child`, spawns `pi --mode json -p`,
  the correctness baseline + the path worktree isolation uses). Opt out with `PI_PERSONA_ENGINE=child`.
- **Fork-bomb guard**: children run with env `PI_PERSONA_DISABLE=1` so pi-persona self-disables inside
  them. NEVER pass `noExtensions` (it blocks the pi-claude auth provider). The guard is **ref-counted**
  in `inproc.ts` — keep it concurrency-safe (parallel strategies build several sessions at once).
- Three disjoint comm planes: **EngineEvent** (runtime) / **Bus Msg** (semantic, `src/bus`) /
  **ProgressView** (derived UI, never a source of truth). Capabilities are enforced at call time via
  one `EffectiveCapabilities`, never prompt-only. Per-run pinning: `contract@hash` is frozen at start.
- **Sub-agent output is untrusted** — wrap it with `fenceUntrusted` (in `extension.ts`) before it
  reaches the supervisor as a follow-up or tool result (prompt-injection defense).

## Testing

- TDD: write the failing test first for `core/*` and any behavior change; watch it fail, then fix.
- Done = `npm run typecheck` clean **and** full suite green. The suite has **one** intentional skip
  (see Accepted diagnostics).
- When touching engines / strategies / the comm plane, also verify with a live `scripts/drive.ts`
  run (concurrency, steer, worktree, and contact_supervisor are not fully provable from unit tests).

## Project structure

- `src/core/` — pure kernel: frontmatter, permissions, contract (+`parseContract`), config, discovery, types.
- `src/engine/` — `child.ts`, `inproc.ts` (default), `adapter.ts`, `async.ts` (async tracker/peek), `worktree.ts` (git-worktree isolation), `stream.ts` (event→state).
- `src/orchestration/` — `sdk.ts` (`agent`/`parallel`/`reduce`), `strategy.ts` (registry), `strategies/*.ts`, `voting.ts`, `flow*.ts` (DAG + JSONL journal + checkpoint gates).
- `src/bus/` — `inproc.ts` (handle-based bus: send/ask/reply/onMessage), `contact.ts` (child `contact_supervisor` tool).
- `src/persona/` — `persona.ts` (parse + `expandCouncilPreset`), `controller.ts`, `gating.ts`, `orchestrate.ts`, `config-store.ts`.
- `src/tools/` — `delegate.ts`, `intercom.ts`. `src/ui/` — agent-tree/overlay, model-picker. `src/extension.ts` — the single ExtensionFactory (wires tools/commands/hooks/engines).
- Bundled data-driven assets (discovery precedence builtin < user `~/.pi/agent` < project `.pi/`):
  `personas/*.md`, `agents/*.md` (personas+agents share a folder, split by `persona: true` — a
  persona and an agent must NOT share a name; e.g. `researcher` is the persona, `research` the agent),
  `teams.yaml`, `flows/*.flow.json`, `contracts/*.contract.json`, `presets/*.preset.json`.
- First run copies the bundled assets into `~/.pi/agent/` (`src/core/seed.ts`, marker
  `.pi-persona-seeded`) so the user's copies (which shadow builtin) are what runs; `/persona seed`
  pulls new defaults, `/persona restore` force-restores originals. `PI_PERSONA_SEED=off` skips it.
- `scripts/` — `drive.ts` (headless `pi -p` log), `control-test.mjs`, `flow-test.ts`. `test/` — unit + integration.

## Adding a new X (data-driven — usually no core change)

1. **Strategy**: add `src/orchestration/strategies/<name>.ts` (export a `Strategy`), register it in `strategy.ts` `BUILTINS`, add a unit test.
2. **Persona**: `personas/<name>.md` — frontmatter `persona: true` + optional `council:` / `orchestration:` / `coaching: true`.
3. **Agent**: `agents/<name>.md` — optional `tools`, `model`, `isolation: worktree`.
4. **Team**: one line in `teams.yaml` (`name: [agent, ...]`).
5. **Flow**: `flows/<name>.flow.json` — phases + `needs`, optional `gate: true` (checkpoint).
6. **Contract**: `contracts/<name>.contract.json` (request via `outputContract`). **Preset**: `presets/<name>.preset.json`.

## Boundaries / deferred (do NOT rebuild as "missing")

- The **cross-process bus broker** and **`context: fork`** are deliberately deferred: the in-process
  bus covers the comm plane, process children are one-shot, and `fresh` is the right child default.
  Do not ship a fragile cross-OS socket/named-pipe broker.
- This repo is `D:\Sources\pi-persona`. The separate `D:\Sources\pi-subagents-persona` (flat
  `src/index.ts`, `VALID_THINKING`, …) is a **legacy** package — different project. Always use
  explicit `pi-persona` paths in shells and sub-agent prompts (the env default cwd is the legacy one).

## Accepted diagnostics

- One skipped test: `test/integration/child-engine.test.ts` is skipped on Windows (spawn flakiness) — intentional, do not "fix".
