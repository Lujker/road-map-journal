#!/usr/bin/env python3
"""Example watchdog script for a routine with `model: none` (P5.6). No model is started.

A scheduler (a Hermes `no_agent` job, cron, or `roadctl supervise`) runs it. It reads the facts, applies the rules below and pipes JSON to
`roadctl routine observe <id> --as <script agent> --heartbeat 12h --confirm-after 2`, which compares with the last set, publishes only a change
and tells the owner through `digest`. Adapt collect() to the project's monitoring tool; everything else is code, not a prompt.

Facts (the shape collect() must return; tests use a fixture file instead):
  {"now": "2026-11-16T10:00:00Z",
   "nodes":    [{"name": "srv-1", "up": true}],
   "requests": [{"id": "R-17", "status": "waiting_customer", "updated": "2026-11-16T07:00:00Z", "created": "2026-11-10T09:00:00Z"}]}

Rules:
  - A closed object is not a problem, whatever its age.
  - "Request age is not waiting time": a request is late by how long it has not MOVED in its current status (now - updated),
    against a threshold per status, never by now - created. A request opened a week ago and answered an hour ago is fine.
  - A problem key is stable (one per object and rule), so the same problem is one message however often it is observed.
"""
import json
import subprocess
import sys
from datetime import datetime, timezone

# status -> hours without movement before it is a problem. A status that is not listed (closed, resolved, ...) is never a problem.
WAIT_LIMIT_HOURS = {"new": 2, "open": 8, "waiting_support": 8, "waiting_customer": 72}
ROUTINE = "server-watch"
AGENT = "cron:watchdog@work-notebook"  # the registry's script agent; the routine's `agent` header is the same string


def parse(t):
    return datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(timezone.utc)


def observe(facts):
    """Facts -> the JSON roadctl routine observe reads: {"problems": [{"key", "text"}], "did": "nodes 7/7, requests open 1"}."""
    now = parse(facts["now"])
    problems = []
    nodes = facts.get("nodes", [])
    up = [n for n in nodes if n.get("up")]
    for n in nodes:
        if not n.get("up"):
            problems.append({"key": f"node-down-{n['name']}", "text": f"node {n['name']} is down"})
    open_requests = 0
    for r in facts.get("requests", []):
        limit = WAIT_LIMIT_HOURS.get(r.get("status"))
        if limit is None:
            continue  # closed objects are not problems
        open_requests += 1
        waited_h = (now - parse(r["updated"])).total_seconds() / 3600
        if waited_h > limit:
            problems.append({"key": f"request-stale-{r['id']}", "text": f"request {r['id']} has not moved for {int(waited_h)}h in {r['status']} (limit {limit}h)"})
    return {"problems": problems, "did": f"nodes {len(up)}/{len(nodes)}, requests open {open_requests}"}


def collect():
    """Replace with the project's own read-only collection (monitoring API, support queue). Here: a JSON file path from argv, else stdin."""
    raise SystemExit("adapt collect() to your monitoring tool, or pass --facts FILE")


def main(argv):
    if "--facts" in argv:
        with open(argv[argv.index("--facts") + 1], encoding="utf-8") as f:
            facts = json.load(f)
    else:
        facts = collect()
    payload = json.dumps(observe(facts))
    if "--print" in argv:  # show the JSON instead of calling roadctl (a dry run)
        sys.stdout.write(payload + "\n")
        return 0
    done = subprocess.run(["roadctl", "routine", "observe", ROUTINE, "--as", AGENT, "--heartbeat", "12h", "--confirm-after", "2"], input=payload, text=True, capture_output=True, timeout=120)
    sys.stdout.write(done.stdout)
    sys.stderr.write(done.stderr)
    return done.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
