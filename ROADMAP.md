# Roadmap

Tracked milestones and integration plans for `@aeondave/pi-persona`.
Items marked **🔒** are committed; **🔍** need design/research; **💡** are candidates.

---

## 1.17.1 — Unified settings and stall-detection fixes

**Status: released.**

This patch also adds the unified `/persona-settings` panel and canonical preferences/model store
for Persona and the loaded Mind/Flow companions. Native compaction remains unchanged.
The requested patch increment is an explicit exception to the feature/minor guidance below.

Three structural defects in the async stall-detection subsystem cause false positives
and wasted model context:

| Fix | Summary |
|-----|---------|
| **Tool-output liveness** | `applyEvent()` now processes `tool_execution_update` — bash liveness resets the stall clock without polluting transcript/output. |
| **Queued-run exemption** | Runs waiting for semaphore admission carry `queued: true` and no `lastAdvanceAt`; `PeekWatcher` ignores them until `markAdmitted()`. |
| **Operator-only stall routing** | Interactive stalls → durable operator entry only (no model wake). Headless → at most one model wake per run lifetime. |

Files: `stream.ts`, `async.ts`, `inproc.ts`, `child.ts`, `adapter.ts`, `sdk.ts`,
`extension.ts`, `delegate-tool.ts` + docs + 14 test additions.

---

## 1.18.0 — Permission integration & companion ecosystem

### 🔒 1. `pi-persona-policy` adapter — `@gotgenes/pi-permission-system` integration

**Priority: highest.** The permission system is the natural enforcement complement to
pi-persona's capability/visibility layer.

#### The two-layer model (already documented by the permission system)

```
┌───────────────────────────────────────────────────┐
│ Layer 1 — Visibility (pi-persona)                 │
│ Which tools are registered/active before the      │
│ agent session starts. EffectiveCapabilities gate.  │
├───────────────────────────────────────────────────┤
│ Layer 2 — Policy (pi-permission-system)           │
│ allow / ask / deny on every tool call, bash       │
│ command, MCP op, path, skill, special operation.  │
└───────────────────────────────────────────────────┘
```

pi-persona already controls Layer 1 (tool visibility via `EffectiveCapabilities`,
`canCallTool`, `canDelegateTo`, glob-based allow/deny in frontmatter). The permission
system controls Layer 2 (per-invocation enforcement with `allow`/`ask`/`deny`, bash
command patterns, path protection through symlinks, MCP gating, fail-closed on
unparseable commands).

#### What `pi-persona-policy` must do

| Responsibility | Detail |
|----------------|--------|
| **Persona → policy projection** | Read the active persona's `permission:` frontmatter block and project it into the permission system's config format at session activation. |
| **Per-agent policy in children** | Forward persona-scoped policy to in-process children via `getPermissionsService(sessionId)` and to child-process children via `PI_SUBAGENT_PARENT_SESSION`. |
| **Tool visibility + policy composition** | pi-persona's `tools:` frontmatter controls visibility (Layer 1); `permission:` controls enforcement (Layer 2). Both compose: a tool not in `tools:` is invisible; a visible tool can still be `deny`/`ask` by policy. |
| **Council/strategy policy** | Strategy children (magi, council-rounds, etc.) inherit the persona's policy unless the roster member overrides it. |
| **MCP allowlist** | `permission.mcp` gates which MCP servers/tools a persona can invoke. |
| **Sandbox/network profile** | Per-persona sandbox and network constraints, mapped to permission system surfaces. |

#### Frontmatter design (persona `.md` files)

```yaml
permission:
  "*": ask                    # universal fallback
  read: allow
  grep: allow
  find: allow
  write: deny
  edit: deny
  bash:
    "*": ask
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "rm -rf *": deny
    "git push --force*": deny
  mcp:
    "*": deny
  external_directory:
    "*": deny
```

#### Persona policy profiles (target presets)

| Persona | Profile |
|---------|---------|
| `researcher` | Read-only, web allowed, no writes |
| `planner` | Read-only, no mutating shell |
| `implementer` | Write in worktree, test/build allowed, push denied |
| `reviewer` | Read, diff, diagnostics; no modifications |
| `release` | Tag/push/workflow with `ask` confirmation |
| `red-lab` | Permissive **only inside sandbox/VM** |
| `untrusted-auditor` | Read-only, network denied, credentials absent |

#### Integration surface with the permission system

- **Service accessor**: `Symbol.for("@gotgenes/pi-permission-system:session-services")` →
  `getPermissionsService(sessionId)` — synchronous, type-safe, per-session.
- **Event bus**: `permissions:ready` broadcast at `session_start` and first `before_agent_start`.
- **Child forwarding**: in-process children query their own session's service; child-process
  children inherit via `PI_SUBAGENT_PARENT_SESSION` env var. `ask`-state forwarding
  bubbles to parent UI with scoped grants (per-child or whole-session).
- **No required peer dependency**: dynamic `import()` + `Symbol.for()` — graceful no-op
  when the permission system is not installed.

#### Design questions to resolve (🔍)

1. **Config ownership**: should `pi-persona-policy` write a transient
   `.pi/extensions/pi-permission-system/config.json` on persona switch, or inject
   policy programmatically via the service accessor?
2. **Override precedence**: the permission system already does
   `global < project < per-agent frontmatter`. Where does persona-level policy sit?
   Proposal: persona `permission:` is a per-agent override applied to children; the
   supervisor's own policy is the project/global config.
3. **Worktree isolation**: worktree children run in a separate cwd. Does the permission
   system's project-scoped config follow the worktree, or does the parent's policy
   propagate via session forwarding?
4. **Exocom peers**: exocom participants are independent top-level Pi instances. Policy
   cannot be forwarded cross-process; each peer loads its own config. Document this
   boundary explicitly.

---

### 🔍 2. RTK output-policy modes

`pi-skill-optimizer`'s RTK companion rewrites shell output before archival. This is
correct for compact development but destructive for evidence-bearing workloads.

#### Problem

RTK reduces output **before** `pi-skill-optimizer` can archive the original. The
archived output is the transformed version, not the raw evidence. This is dangerous for:
debugger output, crash/sanitizer reports, `objdump`/`readelf`/`dumpbin`, scanner/fuzzer
results, network logs, forensic artifacts, and any output a finding depends on.

#### Proposed output modes

| Mode | Behavior |
|------|----------|
| `compact` | RTK active + optimizer reduction (default for routine dev) |
| `recoverable` | RTK disabled, optimizer archives raw output with a retrieval handle |
| `raw-evidence` | No rewriting, no automatic reduction |

#### Per-persona defaults

| Profile | Mode |
|---------|------|
| Development (implementer, planner) | `compact` |
| Complex build/test | `recoverable` |
| Cyber, RE, exploit, forensics (red-lab, researcher) | `raw-evidence` |

#### Implementation

- Persona frontmatter: `output_policy: compact | recoverable | raw-evidence`
- Runtime: export `RTK_DISABLED=1` for `recoverable`/`raw-evidence` modes
- pi-skill-optimizer integration: respect the mode via its existing configuration hooks

---

### 💡 3. `pi-atelier` compatibility study

[`pi-atelier`](https://github.com/michaelmjhhhh/pi-atelier) (291 ⭐, v41+, Pi ≥1.0.0)
provides session visibility, live activity, workspace context, subagent cost curves,
and an extensible sidebar.

#### Integration opportunity

| Surface | Detail |
|---------|--------|
| **Persona status panel** | Show active persona, council config, permission profile in the sidebar |
| **Agent tree integration** | pi-atelier renders subagent costs; pi-persona renders the agent tree. Coordinate without conflict. |
| **Stall/progress overlay** | Atelier's activity panel could surface pi-persona's stall entries and queued-run state |
| **Model/thinking controls** | Atelier offers model and thinking-level controls; pi-persona offers `/persona models`. Avoid overlap. |

#### Constraints

- pi-atelier owns the footer and sidebar UI slots; pi-persona must not compete for them
- Both extensions register `session_start` / `before_agent_start` hooks — ordering matters
- Atelier's subagent cost tracking reads accounting events that pi-persona also emits
- Previous compatibility study was for Pi 0.99; needs re-evaluation against Pi ≥1.0.0 APIs

#### Status

Needs a fresh compatibility audit against current pi-atelier and Pi 1.x host APIs.
No code changes planned until the audit completes.

---

## Beyond 1.18 — candidates

| Item | Description | Priority |
|------|-------------|----------|
| **Configurable `STALL_FLAG_MS`** | `PI_PERSONA_STALL_MS` env var for operators with unusual workloads | Low (1.17.1 fixes the root causes) |
| **Progress contract redesign** | Replace length-based output comparison with structured liveness states (queued/initializing/generating/executing/waiting) | Medium |
| **`context: fork`** | Child context forking (deliberately deferred per AGENTS.md) | Deferred |
| **Token-budget alerting** | Operator-visible warning when a child approaches its token budget | Low |
| **Permission system built-in presets** | Ship `permission:` blocks in bundled persona seed files | Blocked on `pi-persona-policy` |

---

## Versioning

- Patch (`x.y.z+1`): bugfixes, doc updates, no new features
- Minor (`x.y+1.0`): new features, new integrations, backward-compatible
- The project follows [Keep a Changelog](https://keepachangelog.com/) in `CHANGELOG.md`
- Pi host floor: ≥ 1.0.0 (`MIN_PI_VERSION`)
- Node.js floor: ≥ 22.19

## References

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design contract
- [`docs/STRATEGIES.md`](docs/STRATEGIES.md) — orchestration layer
- [`docs/SPINE.md`](docs/SPINE.md) — behavioral prompt layer
- [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) — permission enforcement extension
- [`pi-atelier`](https://github.com/michaelmjhhhh/pi-atelier) — status/sidebar extension
