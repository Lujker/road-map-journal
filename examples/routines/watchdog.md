---
id: server-watchdog
title: EXAMPLE: watchdog for servers and support requests, a script and no model
every: 30m
enabled: false
agent: cron:watchdog@work-notebook
model: none
env: Work-notebook-wsl
---

> EXAMPLE, not a real routine. Copy it to `<board>/routines/<id>.md`, change every field and the script (agent, env and `every` are the owner's choice), then the owner turns it on with `roadctl routine on <id> --by NAME --source REF` and the board switch with `roadctl autonomy routines on --by NAME`. `model: none` marks a script: no model starts and `tick` does not ask for subscription limits for it. The agent is a script agent of the registry (host `script`, a name like `cron:...`); the routine's `id` and the `--as` agent in the script must match this file.

## Goal
Notice a node that is down or a support request that stopped moving, without a model: a script collects the facts and decides, `roadctl routine observe` records the run.

## Steps
1. The scheduler runs `examples/scheduler/watchdog-example.py` (adapted) when `roadctl tick --as cron:watchdog@work-notebook --routine server-watchdog` says RUN.
2. The script reads the monitoring tool and the support queue (read only), applies its rules (a request is late by the time since its last movement in its status, not by its age; closed requests are ignored) and pipes the result to `roadctl routine observe server-watchdog --as cron:watchdog@work-notebook --heartbeat 12h --confirm-after 2`.
3. Nothing else: the `did` line carries the numbers ("nodes 7/7, requests open 1") so a quiet `ok` is visible in the daily overview.

## May write
- Board: the run line of this routine file, through `roadctl routine observe` only. External systems: read only.

## Escalate
- The owner hears about a problem through `roadctl digest` (one message per problem key, one line when it is gone). A script that cannot read its sources or prints bad input is a failed run (`transient`), not silence.

## Log
