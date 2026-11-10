---
name: road-map-journal
description: Use for project roadmaps and development journals.
---

# Roadmap and work journal

Maintain a useful current plan and a traceable record of decisions without imposing a new layout. Follow the user's instructions and the project's conventions. Preserve existing names, identifiers, language, links, uncommitted changes, and unrelated content. For a new plan, use the language the user specifies or reasonably indicates; ask if it is unclear. Do not impose a language.

## When to use

Use for requests about a roadmap, development plan, queue, work journal, item status, or continuing planned work. Examples include “what is next on the roadmap?”, “continue the agreed item”, «дорожная карта», «план разработки», «дневник разработки», «что дальше по плану?» and «продолжай разработку по плану». Determine the requested scope from context; a status question is read-only.

## Discover first

Identify the project root and read its instructions. Locate existing roadmaps, queues, item notes, and handoff documents; names and locations vary. Read the relevant item, its acceptance criteria, current queue and linked notes. Check the relevant implementation, version-control state if available, and evidence when the request needs a current-state assessment. Do not assume Git, a specific directory layout, or a particular status vocabulary. For multiple repositories, follow existing links; ask for an inaccessible authoritative location rather than inventing a replacement.

Select the mode implied by the request:

- **Read-only:** Answer from the relevant documents and evidence. Distinguish recorded claims from independently checked facts; make no edits.
- **Init:** If no plan exists, discuss the owner's desired way of working and propose a suitable structure, location, scope, initial items and ordering; include tracks, agent roles and initial cards when relevant. For deeper exploration, use `grill-me` if available and appropriate; if absent, offer to install it, but do not install without permission or block the workflow. Otherwise facilitate a concise structured discussion yourself, with recommendations for unresolved choices. Obtain informed user consent before creating files; do not invent priorities or commitments.
- **Adopt:** If planning material already exists, use it in place. When the owner requests a substantial review, use the same optional structured discussion as for initialization, tailored to what is unresolved. Explain any proposed new file, migration, or substantial rewrite and obtain informed consent first. Do not silently create a parallel source of truth.
- **Resume:** Read the latest directive, active queue, item notes, and relevant current state. Resolve contradictory or stale instructions against current evidence and the user's latest decision; ask if a consequential conflict remains. If the item is not already selected or delegated, agree on one before implementation. A saved plan or approval to document is not authorization to start work.
- **Update:** Make the requested, scoped changes to existing records. Keep the item's status, remaining work, and affected queue entries consistent; preserve history and unrelated ordering. For a new file or substantial rewrite, explain the proposed change and obtain informed consent first. A request limited to one item does not authorize implementing or rewriting the rest of the plan.

## Record and reconcile

Use the project's established arrangement. Typically, a roadmap summarizes items and their current order; a journal holds decisions, findings, evidence and history. Link rather than duplicate long details. Keep identifiers stable. Do not silently delete decisions or cancelled work: mark them superseded or cancelled with the reason when relevant.

When a decision, pause, or order changes, update affected current summaries and next-step instructions within the authorized scope; label prior instructions as historical. A paused or deferred plan must not appear to be an active instruction to continue. Do not reprioritize unrelated work merely because a note was added. If a necessary correction falls outside the authorized scope, flag it to the user rather than expanding the edit.

For sequential work, honor the selected item's acceptance boundary. A completed substage does not complete the parent item; record the remainder. Unless the owner has authorized a broader scope, work on one item at a time and do not automatically begin the next. When the owner prefers manual validation in real projects, do not require additional lengthy agent trials without agreement. When an owner permits a related track or a continuous range, respect that scope without silently replacing existing priorities. Keep work mode separate from permissions and budgets: authorization to continue is not blanket permission for production actions or external writes.

Keep recorded completion, pending user acceptance and fully accepted work distinct. If the owner authorizes a separate next track and it does not depend on pending acceptance, the earlier item remains pending while the authorized track proceeds. A proposed future pilot must not silently redefine an existing milestone's acceptance criteria. Closing a limited evaluation does not turn unperformed acceptance criteria into passing results. Keep concise checkpoints at handoffs, decisions, verified results, blockers and pauses, including what remains and how to resume. Distinguish a status request from a pause or stop; verify uncertain in-flight actions before repeating them.

For explicitly budgeted work, check available usage at agreed checkpoints and record the baseline immediately before the first authorized run. A shared subscription counter can include other activity; a list-price estimate is not a verified charge. If an agreed stop threshold is reached or a required reading is unavailable, stop the restricted work and obtain a decision; do not silently reset the baseline.

Before a multi-file update in a shared checkout, check the current version-control state and dirty paths immediately before writing where version control is available, and apply narrow edits against freshly read content; another agent may have committed or changed the tree during planning. Stop on ambiguous overlapping edits, preserve unrelated work, then verify the scoped changes and links without committing or publishing unless authorized.

## Status and evidence

Use the project's status vocabulary. If none exists, suggest OPEN, IN PROGRESS, BLOCKED, PARTIAL, and DONE, with meanings agreed for the project. Record status according to the acceptance criteria and actual evidence, not intention or a delegate's unsupported claim. For PARTIAL, name what remains and any blocker. Keep affected status references consistent.

Record checks actually performed, their outcomes and scope, and who performed them when relevant. Evidence may be historical or from another executor; label its source and applicability, and do not imply it was rerun. If later changes invalidate a check, identify or perform the appropriate verification. Never invent commands, results, test counts, approvals, or user acceptance. Automated tests, released code, and live operation are different claims: never infer live acceptance from implementation or tests. If required acceptance has not occurred, retain PARTIAL or the project's equivalent and state the missing environment or approval.

After an authorized edit, check the affected status, queue, links, and consistency with the evidence and scope. Report changes, checks actually made, and unresolved items. Do not claim verification that was not performed.

## References

- [Generic templates](references/templates.md) — optional starting points, adapted to the project.
- [Scenarios](references/scenarios.md) — concise examples of mode and scope choices.
- [Multi-repository reconciliation](references/multi-repo-sync.md) — preserve work and distinguish recorded, Git and live state across checkouts.
