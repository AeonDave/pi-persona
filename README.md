# pi-persona

A single [Pi](https://github.com/earendil-works/pi) extension that unifies subagent
delegation, agent coordination, and switchable **supervisor personas** with a clear
orchestration grammar.

Cycle personas with **`f8`**; each persona defines *how the agent works* — from
opportunistic delegation ("plan this, solve that") to mandatory multi-agent strategies
("you are 3 agents doing a/b/c"), parallel fan-out, voting, and adversarial critique.

> Replaces and supersedes `pi-subagents`, `pi-subagents-comtac`, and
> `pi-subagents-persona` with one modular, cross-OS codebase — a clean rewrite on
> Pi-native primitives (no third-party fork).

## Status

**v0.1 vertical built and green** — the full path works: `persona.md` → `f8`/`/persona` →
`delegate` (or `/orchestrate`) → **real `pi` child processes** → structured result. ~107
tests (`node --test`), strict `tsc --noEmit` clean. Loadable in Pi (the extension
typechecks against the real `@earendil-works` ExtensionAPI). Binding design lives in
[`docs/superpowers/specs/`](docs/superpowers/specs/):

- [Architecture](docs/superpowers/specs/2026-06-25-pi-persona-architecture.md)
- [Implementation Guardrails (binding)](docs/superpowers/specs/2026-06-25-pi-persona-implementation-guardrails.md)

## Orchestration in one screen

- **L0** — prompt-driven, *opportunistic* delegation. The simple case stays simple
  (a `researcher` that delegates one subagent per search is just a prompt).
- **L1** — declarative shape: `orchestration: { mode: parallel | pipeline, per: … }`.
- **L2** — strategy files on a core SDK (`magi`, `critic-loop`, `triumvirate`, …).
- **L3** — declarative flows (deferred to a later release).

Spawning is **opportunistic by default** and **mandatory only when the persona declares
it**. `sync` waits actively for completion; `async` lets the supervisor go idle and coach
running children (notifications + an opt-in periodic peek).

## Develop

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
