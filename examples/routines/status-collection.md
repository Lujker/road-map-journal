---
id: status-collection
title: EXAMPLE: collect merge request, issue and message state and update cards
every: 2h
enabled: false
agent: claude-code@work-notebook
model: claude-haiku-5-5
env: Work-notebook-wsl
---

> EXAMPLE, not a real routine. Copy it to `<board>/routines/<id>.md`, change every field (above all agent, model and env: they are the owner's choice for the machine and the account that will run it), then the owner turns it on with `roadctl routine on <id> --by NAME --source REF` and the board switch with `roadctl autonomy routines on --by NAME`. The text below is generic; replace the tools and names with the project's own.

## Goal
Keep the status lines of cards current without the owner collecting them by hand: what happened to the open merge requests, issues and messages that belong to cards of this board since the last run.

## Steps
1. Read the cards that are doing, review or blocked (`roadctl list`, `roadctl show <id>`), and note for each the merge request, issue or thread it names.
2. Read the current state of those items in the external systems (read only: the merge request tool, the issue tracker, the messages the owner pointed to). Look only at what changed since the last Log line of this routine.
3. For every card where something changed, add one Log line with the new state and a link: `roadctl log <id> "MR !123 merged; issue ABC-45 moved to testing" --author "<agent>"`.
4. Do not change statuses, approvals or acceptance criteria.

## May write
- Board: Log lines on cards (`roadctl log`), delegations (`roadctl delegate`) and questions for the owner, as the Escalate section says.
- External systems: read only. External writes (comments, status changes, messages) only if the approved scope has `external`.

## Escalate
- A change that needs work on a card (a failed pipeline to fix, a review comment to answer): `roadctl delegate <id> --to orchestrator --by <agent>` for a card that has an approved record; the orchestrator or a stronger worker takes it from there.
- A question only the owner can answer, or a card whose status should change: add a Log line that starts with `QUESTION for the owner:` and finish the run with `--result escalated`. A card becomes `blocked: decision: ...` only through the normal card tools, never by editing the file from this routine.
- Anything unclear, or a system you cannot read: stop, finish with `--result failed` and say what failed.

## Log
