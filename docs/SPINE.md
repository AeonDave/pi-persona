# The spine — a shared behavioral layer

See [`docs/README.md`](./README.md) for the canonical doc map.

## Why it exists

Pi's own base system prompt (`buildSystemPrompt` in pi's coding-agent) is a tool manifest, pointers
to pi's documentation, the working directory, any project context and skills — and, for behavior,
two unconditional guidelines: *be concise* and *show file paths clearly* (plus one conditional
bash-usage line, and whatever the caller passes as `promptGuidelines`). It carries no behavioral
direction beyond that — nothing about scope discipline, verification, irreversibility, or how to
treat text produced by another agent. Every pi-persona persona has therefore grown its own copy of those rules, and the copies
drift: `elite.md` and `dev.md` each restate verify-before-claiming, untrusted-output handling, and
delegation reflexes in their own words.

The spine is that shared layer, written once. It sits between Pi's base prompt and the persona body,
so a persona can be about *identity and method* instead of restating the same baseline every time.

## What belongs in it

Behavioral altitude only. The spine states how work is delivered, verified, and reported. It does
**not** contain:

- **Tool names.** `delegate`, `council`, and web search are persona-gated and host-variable; a spine
  that urges a tool the gate will refuse creates phantom affordances. Tool mechanics stay Pi's,
  delegation policy stays the persona's.
- **Identity or model facts.** No "you are X", no model names, no vendor.
- **Environment facts.** Working directory, OS, and dates belong to Pi's base prompt, which already
  supplies them. A second, independently-filled environment block can only go stale or conflict.
- **Anything Pi's base already says.** The spine was authored against a dump of Pi's actual base
  prompt; `be concise` and file-path display are Pi's and are deliberately absent here.

The content lives in `prompts/spine.md` as plain prose — no frontmatter, and deliberately *not*
under `personas/`, where the loader would try to discover it as a persona.

## How it composes

Resolution is a pure function. The supervisor's layer is injected at the `before_agent_start` hook;
a delegated leg's is prepended inside the engines (`src/engine/adapter.ts`, `src/engine/inproc.ts`),
because a leg's prompt is built there and never passes through that hook.

```
[Pi base prompt]  [spine]  [persona body]  [delegation brief]  [exocom brief]  [orchestration result]
```

- **With a persona, `append` mode:** `base` → `spine` → `persona.body`.
- **With a persona, `replace` mode and a non-empty body:** `spine` → `persona.body`. An empty body
  is treated as no override at all and composes as `base` → `spine`, so a persona cannot blank the
  prompt by omission. Be aware of what `replace` costs: a
  `before_agent_start` result overwrites Pi's base prompt wholesale, so the tool manifest,
  `<project_context>` from AGENTS.md, the skills manifest and the working directory all disappear.
  The spine does not replace them — by its own charter it contains no tool, identity, or
  environment facts. A `replace` persona plus the spine is behavioral prose handed to a model that
  no longer knows its tools or its cwd. If you need `replace`, supply that context in the body.
- **With no persona (vanilla pi):** `base` → `spine`. Sessions without a persona are lifted too.
- **Sub-agents:** delegated legs get `prompts/spine.worker.md`, not the supervisor text. Both
  engines pass the agent prompt with `--append-system-prompt` (child) / `appendSystemPrompt`
  (in-process), so a leg has always received Pi's full base prompt with the agent persona appended
  — the worker spine adds behavioral consistency, it does not fill a scaffolding gap. Two
  paragraphs of the supervisor text would be actively wrong there: a leg has no interactive user to
  confirm with on either backend (the child backend spawns `pi -p --no-session`; the default
  in-process backend runs its own session with no UI attached), so "confirm before irreversible"
  would make it stall or return the question as its deliverable. The worker text carries proof
  discipline, untrusted-input handling, scope-keeping, and a report contract instead.

> `AgentConfig` carried a `systemPromptMode` field that was parsed and then read by nothing, with a
> `replace` default describing behavior agents never had. It was removed rather than honoured:
> neither engine can replace Pi's base prompt, so implementing the mode would have meant adding
> capability to both backends to satisfy a default nobody asked for. `SystemPromptMode` itself
> stays — the persona path is its real consumer.

The spine sits in the stable, cacheable prefix — ahead of the per-turn dynamic tail.

## Configuration

`PI_PERSONA_SPINE` selects the supervisor source; `PI_PERSONA_SPINE_LEGS` selects the one delegated
legs get, and follows `PI_PERSONA_SPINE` unless set.

| Value | Effect |
|---|---|
| unset / `off` / `0` / `false` / `no` | No spine. Output is byte-identical to pre-spine behavior. |
| `on` / `1` / `true` / `yes` | User-dir file if present, else the bundled one (`prompts/spine.md`, `prompts/spine.worker.md`). |
| *a path* | That file. Unreadable, empty, or over 64 KiB → no spine, with a warning naming the reason; never a hard failure. |

One narrow upgrade exception protects users who seeded the original v1.8.0 pair before the prompts
were rewritten: if a user-dir file is byte-for-byte one of those shipped originals, pi-persona leaves
the user's bytes untouched but bypasses that legacy candidate, so selector `on` falls through to the
current bundled file. Detection first rejects anything that is not a single-link regular file of the
exact legacy size, then hashes a bounded descriptor read. Symlinks, hardlinks, oversized files, and
every edited/custom digest remain ordinary user copies and continue to shadow the bundle.

Activation and `/persona reload` inspect only roles whose selector is exactly `on`; an explicit path
does not inspect the unused user-dir copy. `/persona seed` preserves existing files, while the
explicit `/persona restore` operation force-restores both bundled originals. Seed, restore, reload, and
first-run auto-seed all refresh the cached resolution for the next supervisor turn and delegated leg
without a restart. `/doctor` shows each selector and its resolved source (or `off` / `degraded`) plus
the legacy paths being bypassed and any inspection warning.

Both word lists are matched case-insensitively and after trimming; a path is kept verbatim, case
included, because filesystems are case-sensitive. They are `OFF_WORDS` / `ON_WORDS` in
`src/core/config.ts`; `OFF_WORDS` is the shared definition of "off" that `PI_PERSONA_EXOCOM` and
`PI_PERSONA_LEDGER_V2` also use, while `ON_WORDS` exists only for the selectors whose value can also
be a path. The older boolean switches
(`PI_PERSONA_PERSIST`, `_NUDGE`, `_SEED`, `_BROKER`, `_DISABLE`, `_DELEGATE_DEFAULT`) keep
their own published conventions — changing those would silently alter what an existing user's
environment means. A selector whose value can also be a path has to recognise its on-words
explicitly: "not off" cannot imply "on" when anything unrecognised is a filename.

Two switches rather than one because the supervisor text and the worker text are different prompts
doing different jobs: a shared supervisor baseline and a rewritten prompt for every scout and
verifier leg are separable decisions, and the A/B below cannot isolate them otherwise.

Per-persona and per-agent frontmatter `spine: false` opts a definition out. No bundled persona or
agent sets it — it exists for definitions that carry their own complete instructions and want
nothing prepended, such as a short verdict-only persona. A persona's opt-out also suppresses the
layer for the legs it spawns; a leg can additionally opt itself out.

The path override is also the private-variant slot: point it at your own file, on your own machine,
without anything entering this repository.

## Default is off, on purpose

Following the same convention as exocom, the spine ships opt-in. A prompt layer
changes behavior on every turn and every delegated leg; flipping it on by default is a claim that it
helps, and that claim needs measurement, not conviction.

The measurement is an A/B in the live-drive arena: a fixed set of repo-representative tasks
(bugfix, small feature, refactor, review, a fanout delegation), scored blind on scope completion,
false-pass rate, and unnecessary questions. Run it on at least two model families — the point of a
model-agnostic spine is that it must not regress anything. DeepSeek V4 (pro or flash) is the
standing regression gate, being cheap enough to run the whole task set repeatedly.

Use **four arms**, which is what the two switches exist for: `off` (neither set), *supervisor-only*
(`PI_PERSONA_SPINE=on`, `PI_PERSONA_SPINE_LEGS=off`), *legs-only* (`PI_PERSONA_SPINE=off`,
`PI_PERSONA_SPINE_LEGS=on`), and *both* (`PI_PERSONA_SPINE=on`). With a single on/off switch a null
result on a fanout task is uninterpretable: a gain in one text can hide a loss in the other. Score
legs separately from the supervisor, and record the prompt-token delta **per leg**, not just per
run — that is where a wide fanout actually pays for the layer.

Watch one metric in both directions: "unnecessary questions" is the one thing the supervisor spine
pushes on from two sides at once — the scope paragraph suppresses questions, the irreversibility
paragraph mandates them. An unchanged score there is consistent with both rules firing and
cancelling, so read it alongside the transcripts rather than alone.

**Flip the default only if the improvement holds on one family with no regression on the other.**

## What comes after

Persona slimming — deleting from each persona the lines the spine now owns — is deliberately *not*
part of introducing the spine. The bundled personas are behavior-tuned, audited artifacts; they get
slimmed one at a time, each behind its own live-drive check. Until then the overlap is redundant but
consistent, which is the acceptable interim state.
