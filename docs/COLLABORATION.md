# Supervised workers and independent colleagues

Use **Intercom** for workers launched by this session. Use **Exocom** for independent Pi sessions
that choose to collaborate. An Exocom peer is responsible to its own user; messages and shared tasks
do not make it a subordinate or grant it permission to act.

## Supervising a leg

Choose `thinking` independently of `model` in a delegate or roster entry. The runtime preserves an
explicit provider choice and reports requested and observed thinking separately. A compact tree
label is only a projection; it does not prove the provider's internal reasoning effort.

Use `intercom peek` to inspect a particular uncertainty, `steer` to queue an instruction, and `stop`
to stop work. A steering receipt proves acceptance, not that the worker acted on it. Interactive
completions wake the supervisor automatically; end the turn instead of polling or sleeping.

Intercom uses distinct addresses; the display name in a card is not a routing address:

| Operation | Address to use |
|---|---|
| `steer`, `stop`, `peek`, live `result` | `to: "run-3"` from the delegation receipt; cards show the worker's readable name |
| `send` | `to: "operator#3"`, the exact live bus handle returned by `list` |
| `reply` | `askId` from a currently pending question; a progress message cannot receive a reply |
| Archived `result` | `ref: "result:<UUID>"` from the retained report receipt |

A worker may support steering without having a bus handle. A settled worker cannot be steered;
read its result and delegate a new task if more work is needed. A failed `send` distinguishes an
unknown handle from an inbox full of pending questions; neither means the message was delivered.

`intercom results` lists terminal reports. `intercom result { ref, offset, limit }` reads a bounded
page after reload. A `result:<UUID>` identifies stored evidence, not a live worker. The receipt says
whether storage is durable or memory-only and whether retention truncated the original report.
The compact range uses zero-based UTF-16 offsets: the start is inclusive, the end exclusive, and
the total is the stored body length, not a page count. Follow `nextOffset` when more text remains.
Paging to the end cannot restore text that exceeded the retention ceiling.

An unanswered decision remains unresolved. Timeout, cancellation, disconnection and headless delivery
never imply approval. Continue only independent work already authorized, or return a partial result.

## Sharing an objective without a leader

Start participating sessions with `--exocom` in the same workspace, or join an existing scope with
its code as described in [the user guide](EXPERIENCE.md#work-with-another-pi-through-exocom).
Use `exocom_list` to find stable qualified targets and self-reported profiles. A profile's capabilities
and availability are suggestions for choosing a colleague, not verified skills, reservations or tool
permissions. Missing availability is **unknown**. Profiles disappear when the Exocom plane stops.

1. Describe an independent slice with `exocom_task { action: "create", work_key, description,
   write_set }`. An empty write set means read-only work. Creation is an invitation to collaborate,
   not an assignment. Keep tasks within the users' authorized objective.
2. Inspect tasks using `exocom_task { action: "list", offset, limit, detail }`. Every task carries a
   `task_id`, the immutable creation message ID, alongside its human-selected `work_key`. Before
   taking a write task, use `exocom_task { action: "get", work_key, task_id }` to inspect the complete
   bounded write set; list previews may shorten paths.
3. Optionally send `exocom_offer { work_key, task_id, target, expiresInMinutes }`. Omitting target
   records a pool invitation for discovery; it does not broadcast a model wake. A targeted offer uses
   the existing signed wake path. Default expiry is one hour, maximum 24 hours. It never creates a
   response obligation; expiration is not acceptance or rejection.
4. A colleague voluntarily calls `exocom_task { action: "take", work_key, task_id }`. Pickup and the
   declared file claim commit atomically; a second pickup or overlapping claim fails. A stale task ID
   cannot act on a newly created task that reused the same key. Foreign-workspace members may take
   read-only tasks, but cannot create or take write tasks in the joined scope.
5. The taker posts `progress` with a bounded `note`, then `finish` with `outcome: "done"` or
   `"abandoned"` and a note, always supplying the same `work_key` and `task_id`. The latest progress
   note is retained. Finishing releases the task's claim; it never merges or approves code.

Task division does not need leader election. Each task has one taker and its own claim. Peers choose
separate open tasks; availability and execution remain up to each session. A peer may propose a different split, decline by doing
nothing with an offer, or discuss a conflict in a postcard. If a decision belongs to a user, bring it
to that user; there is no automatic arbitration or authority transfer between peers.

Use `exocom_ask` only when a peer's answer must gate the next action. Unlike an offer, an ask constrains
its addressee until `exocom_answer` or `exocom_decline`. Identity metadata and explicit read actions
remain available. `exocom_wait` arms a nonblocking wake; it does not block the current tool call.

## Publishing evidence

`exocom_publish { action: "publish", work_key, task_id, title, excerpt }` copies an explicit excerpt
into the shared ledger. A title is at most 160 characters; an excerpt is at most 4,096 UTF-16 units
and 8,192 UTF-8 bytes. No tool follows paths or archive references in that text. To share a retained
leg report, read the needed page through Intercom, select the relevant excerpt, then publish that text.

Discover evidence with `exocom_publish { action: "read", work_key, offset, limit }`, then retrieve one
excerpt with `msg_id`. Publisher identity is resolved from the registry or retained session ID, never
the envelope's claimed display name. The excerpt remains fenced peer data. Verify its claims before
using it; a peer's `done` means that peer finished its task, not that checks passed or a reviewer approved.

## Failure, retention and controls

`exocom_status` and `/exocom` show claims, questions, shared task states and invitations. Task lists
default to 10 entries (maximum 20); detailed pages default to 5 and allow at most 5. Evidence-title pages are bounded.
Tool cards collapse long content and expand using Pi's normal keybinding; this never changes the
stored evidence or the text supplied to the model.

Loss of a task owner's registry lease or explicit release marks unfinished work **stale**. It never
silently reopens the task. Inspect the work and create a newly scoped task if reassignment is needed.
Clean shutdown releases both write and read-only task ownership. `exocom_release` intentionally
releases this session's current ownership and outbound asks on a work key.

The ledger retains at most 64 tasks, 64 offers and 64 evidence excerpts in a 128 KiB collaboration
budget, including lifecycle headroom. Terminal/stale tasks remain visible for the existing one-hour
result retention window; offers remain until one hour after expiry, evidence for one hour after
publication. Removing a task also removes its related offers/evidence. Live open/taken tasks are not
evicted to admit new work. Limits fail explicitly; there is no silent ownership loss or global archive
access. Transactions perform durable cleanup; reads project current expiry without starting workers.

## Contract boundaries

| Boundary | Required meaning | Enforcement |
|---|---|---|
| Intercom vs Exocom | Worker supervision vs independent peers | Existing capability gates, attribution and distinct transports |
| Delivery vs decision | Accepted/delivered is not answered, acted or approved | Explicit outcomes and unresolved guidance |
| Task identity | A reused key cannot retarget old intent | Creation `task_id` checked inside the ledger transaction and signed on frames |
| Pickup and ownership | One taker, claim admitted together, no overlap | Atomic ledger transaction; scope/capability admission inside its lock |
| Optional offer vs ask | Invitations never gate; targeted asks do | Separate records, tool actions and pending-ask gate |
| Evidence | Explicit bounded copied text, no cross-session archive access | Schema validation, ledger budgets, registry attribution and fences |
| Persistence | Versioned authoritative state must not become an empty ledger on error | Snapshot validation, retained-message idempotency and lifecycle budget reservation |
| Retention | Stale is visible, expiry never implies takeover | First-stale timestamp, bounded retention, fresh generation on recreation |
| Profiles and views | Self-report/projection cannot grant authority | Separate presence metadata and runtime-owned status |
| Flow references | Only compatible, successful archived phases can resume | Journal-version/status checks, scoped reads, explicit unavailable/truncated outcomes |

These are runtime contracts. The existing `outputContract` facility validates a worker's final JSON
report with scalar fields; a model-written `proof` is not a command receipt. It is not the right place
to encode task ownership or ledger transitions. Nested report schemas and host-executed acceptance
receipts remain separate product work; this collaboration protocol does not claim to implement them.
