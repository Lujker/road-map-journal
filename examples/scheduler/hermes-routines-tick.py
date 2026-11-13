#!/usr/bin/env python3
"""Example: Hermes routines monitor plus external Claude routines via SSH.

Copy with monitor_common.py to Hermes's scripts directory and adapt EXTERNAL_AGENTS.
The local tick (roadctl tick --json, read as data, never parsed as text) only decides which external routines are due. The external host builds
the prompt with its own roadctl (its own paths, pull and limits gate) and starts Claude
only when that tick says work. The remote flock covers the tick and the whole Claude run, and timeout(1)
stops a Claude run that hangs (ROAD_CLAUDE_TIMEOUT, default 30m); the remote log and lock live in ~/.local/state/road-map-journal.
"""
import json
import os
import re
import shlex
import subprocess
import sys
from monitor_common import sticky, tick, TIMEOUT_SECONDS

AGENT = "hermes@home-host"
EXTERNAL_AGENTS = {"claude-code@work-notebook": "work-notebook"}
# How to reach the external hosts. On Windows, ["wsl.exe", "-e", "ssh"] reuses the WSL ssh config and keys.
SSH_COMMAND = ["ssh"]
# Permission rules for the unattended Claude run (passed as claude -p --settings). Only the roadctl subcommands that the RUN prompt names
# (limits --check, show, log, delegate, save and the finishing routine done), never Bash(roadctl:*): that would allow approve, done, accept...
# File writes are allowed with Edit(path) rules; Claude does not match Write(path) rules.
ALLOWED_TOOLS = [
    "Read",
    "Bash(roadctl limits --check:*)",
    "Bash(roadctl show:*)",
    "Bash(roadctl log:*)",
    "Bash(roadctl delegate:*)",
    "Bash(roadctl save:*)",
    "Bash(roadctl routine done:*)",
]
# The remote `claude -p` is stopped by timeout(1) after this long (a number with s, m, h or d; GNU coreutils syntax). ROAD_CLAUDE_TIMEOUT overrides it.
CLAUDE_TIMEOUT = os.environ.get("ROAD_CLAUDE_TIMEOUT", "30m")
if not re.fullmatch(r"[0-9]+[smhd]?", CLAUDE_TIMEOUT):
    sys.exit("hermes-routines-tick: ROAD_CLAUDE_TIMEOUT must look like 90, 90s, 30m or 2h")


def launch(host, agent, project, routine, model):
    # Only names go to the remote host, as quoted arguments; the remote roadctl builds the prompt.
    settings = json.dumps({"permissions": {"allow": ALLOWED_TOOLS}})
    args = " ".join(shlex.quote(a) for a in (agent, routine, project, model, settings, CLAUDE_TIMEOUT))
    script = f'''mkdir -p "$HOME/.local/state/road-map-journal"
export PATH="$HOME/.local/bin:$PATH"
lock="$HOME/.local/state/road-map-journal/external-routine.lock"
log="$HOME/.local/state/road-map-journal/external-routine.log"
nohup bash -c 'flock -n 9 || exit 0; cd "$HOME" || exit 0; echo "== $(date -u +%FT%TZ) $3/$2"; prompt=$(roadctl tick --as "$1" --routine "$2" --project "$3" --prompt) || {{ echo "remote tick: not started"; exit 0; }}; exec timeout --kill-after=30s "$6" claude -p --model "$4" --max-turns 30 --settings "$5" -- "$prompt"' _ {args} 9>"$lock" >>"$log" 2>&1 </dev/null &
'''
    try:
        subprocess.run([*SSH_COMMAND, host, "bash", "-c", shlex.quote(script)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        sys.stderr.write(f"external routine launch failed: {error}\n")


def due_routines(agent):
    """(project, routine id, model) of every RUN item of `roadctl tick --json`; empty on idle, a closed gate or an error."""
    result = tick(agent, "run", "--json")
    if result is None or result.returncode != 0:  # 0 is work; idle, reserve, unknown, busy and paused (6, roadctl pause) start nothing
        return []
    try:
        items = json.loads(result.stdout.decode("utf-8", "replace"))["items"]
        return [(i["project"], i["id"], i["routine"]["model"]) for i in items if i["kind"] == "RUN"]
    except (ValueError, KeyError, TypeError) as error:
        sys.stderr.write(f"tick --json of {agent} is not what this script expects: {error!r}\n")
        return []


def external(agent, host):
    # One launch per due routine, each with its own model.
    for project, routine, model in due_routines(agent):
        launch(host, agent, project, routine, model)


if __name__ == "__main__":
    sticky("road-routines", tick(AGENT, "run"))
    for agent, host in EXTERNAL_AGENTS.items():
        external(agent, host)
