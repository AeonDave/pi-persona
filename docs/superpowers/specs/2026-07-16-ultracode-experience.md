# Spec — Ultracode-like delegation experience

**Date:** 2026-07-16
**Problem:** With the `dev`/`researcher`/`swarm` personas, delegation does not trigger as
automatically and effortlessly as Claude Code's ultracode mode. A 15-agent verified analysis
(map → synthesize → adversarial verify) found the gap is **posture and discoverability, not
machinery**: the minimum delegate call is already 2 fields, spawning is permission-free, and
async completions already push back to an idle supervisor.

## Verified root causes (ranked)

1. **PROMPT (CONFIRMED):** delegation is a conditional judgment in once-appended persona prose
   that decays (nudge.ts:2-8 documents the decay); every persona gates delegation behind a
   task-classification test; `dev.md` licenses the solo path first at bullet 5/6. No persona →
   no directive at all. The nudge is reactive-only (fires after 40k single / 60k cumulative
   chars of hand-grinding).
2. **MECHANISM (CONFIRMED):** no in-context agent discovery — the roster is never shown to the
   model (`/doctor` is human-only); a wrong agent name returns a bare "unknown agent" with no
   candidates (while wrong *model* names get nearest-match suggestions), then trips the
   2-strike ledger veto. Fresh install: delegate/council registered while every agent name fails.
3. **MECHANISM+PROMPT (PARTIAL):** sync-by-default blocks the turn on the slowest child; the
   tool copy mixes "results come back as follow-ups" with "/peek or intercom wait to collect".
4. **PROMPT (PARTIAL):** per-delegation ceremony (4-5 decisions) + verification tax; no
   fully-worked `delegate` example with real values in any persona.
5. **MECHANISM (CONFIRMED):** fragmented surface — 6 tools; council params + flow names are
   model-undiscoverable ("see /doctor"; unknown-param warning goes to the human UI only).
6. **HOST (CONFIRMED):** pi core is NOT the constraint. NOTE: `agent_settled` exists only in pi
   HEAD, **not** in the installed pi-coding-agent — out of scope for this iteration.
7. **CONTEXTUAL (PARTIAL):** no supervisor model floor; drive.ts recommends a haiku supervisor.

## Goals

Replicate the ultracode properties that are missing, without breaking the project's
philosophy (opt-in seeding, capabilities enforced at runtime, untrusted sub-agent output):

- **G1 Discovery in context:** every turn, the supervisor sees a live, capability-filtered
  roster (agents + teams + flows) — the *delegation brief* — appended to the system-prompt tail.
- **G2 Standing default:** the brief carries a harness-owned "hand off by default" directive,
  restated every turn (persona active); a soft discovery variant with no persona; a
  seed-guidance variant when a delegating persona is active but zero agents are installed.
- **G3 Background-first:** `delegate` defaults to async in interactive sessions (`sync: true`
  opts out; headless `pi -p` keeps sync default — the turn must carry the result). Copy teaches
  the push model unambiguously.
- **G4 Self-correcting failures:** unknown agent names fail pre-spawn with the installed list
  (and never count toward the ledger veto); engine-level unknown-agent errors name candidates;
  persona gating blocks name the *allowed* targets; unknown flow names list installed flows;
  council unknown-param notes reach the model, not just the human.
- **G5 Patterns in the tools:** delegate description leads with the minimum call + fan-out
  pattern; council description names the strategies with their params (from `knownParams()`).
- **G6 De-hedged personas:** dev/researcher/swarm/planner state delegation as the default with
  a worked example; solo becomes the enumerated exception. Untrusted-data fencing stays.
- **G7 Earlier backstop:** nudge cumulative threshold 60k → 24k chars.
- **G8 Docs & hygiene:** remove the phantom `elite` persona from README; document the
  supervisor-model floor in drive.ts/teams.yaml; update README/AGENTS.md; bump v1.5.0.

## Non-goals

- No auto-seeding on first run (opt-in stays; G2/G4 make the dead zone self-explaining).
- No `agent_settled` subscription (not in the installed pi); the 400ms idle retry stays.
- No new orchestration primitives; no changes to strategies/engines beyond error copy.
