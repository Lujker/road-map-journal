---
id: server-watch
title: EXAMPLE: watch servers and support requests
every: 30m
enabled: false
agent: hermes@work-notebook
model: claude-haiku-5-5
env: Work-notebook-wsl
---

> EXAMPLE, not a real routine. Copy it to `<board>/routines/<id>.md` and change every field; agent, model and env are required and are the owner's choice (a routine without them never runs). Replace the generic wording with the project's own tools. A run every 30 minutes leaves one Log line per run; roadctl keeps the last 50.

## Goal
Notice problems with the servers and unanswered support requests early, and make sure the owner or a stronger executor hears about them.

## Steps
1. Read the status of each server through the monitoring tool the owner named (read only; no restarts, no deployments).
2. Read the support queue (read only; do not answer, claim or close a request).
3. If everything is normal, finish with `--result ok` and a one-line summary ("5 servers up, 0 open requests"); no card needs a Log line.
4. If something is wrong, add a Log line to the card that tracks it (`roadctl log <id> "..."`) and follow Escalate.

## May write
- Board: Log lines on cards, delegations and questions for the owner.
- External systems: read only. No restarts, no replies to customers, no changes of any setting.

## Escalate
- A server is down or degraded, or a request waits longer than the owner agreed: `roadctl delegate <id> --to orchestrator --by <agent>` for the card that tracks it, or a Log line `QUESTION for the owner: ...` when no such card exists; finish with `--result escalated`.
- Do not repeat an alert that is already in the latest Log line of the card.
- A tool you cannot reach: finish with `--result failed` and say which.

## Log
