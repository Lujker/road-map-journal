# Long-running work

Read this when work spans several items, agents or sessions, has a budget, or the owner authorizes a track or continuous mode. These rules were moved here from the skill core; their meaning is unchanged.

## Scope and mode

- Honor the selected item's acceptance boundary. A completed substage does not complete the parent item; record the remainder.
- Unless the owner has authorized a broader scope, work on one item at a time and do not automatically begin the next. When the owner permits a related track or a continuous range, respect that scope without silently replacing existing priorities.
- Keep work mode separate from permissions and budgets: authorization to continue is not blanket permission for production actions or external writes.
- When the owner prefers manual validation in real projects, do not require additional lengthy agent trials without agreement.

## Acceptance

- Keep recorded completion, pending user acceptance and fully accepted work distinct.
- If the owner authorizes a separate next track and it does not depend on pending acceptance, the earlier item remains pending while the authorized track proceeds.
- A proposed future pilot must not silently redefine an existing milestone's acceptance criteria.
- Closing a limited evaluation does not turn unperformed acceptance criteria into passing results.

## Checkpoints, pause and stop

- Keep concise checkpoints at handoffs, decisions, verified results, blockers and pauses, including what remains and how to resume.
- Distinguish a status request from a pause or stop. Verify uncertain in-flight actions before repeating them.

## Budgets

- For explicitly budgeted work, check available usage at agreed checkpoints and record the baseline immediately before the first authorized run.
- A shared subscription counter can include other activity; a list-price estimate is not a verified charge.
- If an agreed stop threshold is reached or a required reading is unavailable, stop the restricted work and obtain a decision; do not silently reset the baseline.

## Checkpoint, handoff and recovery

- **Checkpoint:** a short dated record in the project's own journal or card Handoff: what is done, what was verified and how, what remains, the next action, what is in flight, and the source of any permission being used (not a paraphrase of it). It is data for resuming, not a new permission.
- **Handoff:** the next session or agent reads the last checkpoint, then the plan and the working tree, before acting. State what it may do and what it must not.
- **Recovery after an interruption:** reconcile the last checkpoint with the real state first: running processes, the working tree and version control, and any external effect. Classify each in-flight action as done, not done or unknown. Do not repeat an unknown action that is not safely repeatable; keep it `unknown`, report it and ask. Re-check budget and permissions; a timeout or lost connection does not prove that a process stopped.
- **Pause and stop:** a pause starts no new work and reaches safe stopping points; a stop keeps progress without automatic rollback. Report in-flight or unknown outcomes honestly.
- **Permissions** bind to their real source and scope. Silence is not consent to expand scope, spending or external actions. Independent permitted work may continue while a question to the owner is open.

## Delegating (untested guidance)

- Give a sub-agent a bounded package: goal, the inputs it needs, allowed changes, acceptance and checks, limits, stop conditions, result format.
- Treat its result as data to verify, not as proof: check the actual files, tests and effects before recording completion. A report that it succeeded is not evidence.
- Instructions do not create atomicity, isolation or a spending ceiling; use the host's real mechanisms and say what is unknown.

## Shared checkouts

- Before a multi-file update in a shared checkout, check the current version-control state and dirty paths immediately before writing where version control is available, and apply narrow edits against freshly read content; another agent may have committed or changed the tree during planning.
- Stop on ambiguous overlapping edits, preserve unrelated work, then verify the scoped changes and links without committing or publishing unless authorized.
