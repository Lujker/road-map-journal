#!/usr/bin/env python3
"""Example: Hermes routines monitor plus external Claude routines via SSH.

Copy with monitor_common.py to Hermes's scripts directory and adapt EXTERNAL_AGENTS.
The local tick only decides which external routines are due. The external host builds
the prompt with its own roadctl (its own paths, pull and limits gate) and starts Claude
only when that tick says work. The remote flock covers the tick and the whole Claude run;
the remote log and lock live in ~/.local/state/road-map-journal.
"""
import json
import re
import shlex
import subprocess
import sys
from monitor_common import sticky, tick, TIMEOUT_SECONDS

AGENT = "hermes@home-host"
EXTERNAL_AGENTS = {"claude-code@work-notebook": "work-notebook"}
# How to reach the external hosts. On Windows, ["wsl.exe", "-e", "ssh"] reuses the WSL ssh config and keys.
SSH_COMMAND = ["ssh"]
# Permission rules for the unattended Claude run (passed as claude -p --settings); keep them to what the routines need.
# File writes are allowed with Edit(path) rules; Claude does not match Write(path) rules.
ALLOWED_TOOLS = ["Read", "Bash(roadctl:*)"]
ENTRY_RE = re.compile(r"^  ([^/]+)/([^:]+): file .*; model ([^;]+); env .*; previous run: ")


def launch(host, agent, project, routine, model):
    # Only names go to the remote host, as quoted arguments; the remote roadctl builds the prompt.
    settings = json.dumps({"permissions": {"allow": ALLOWED_TOOLS}})
    args = " ".join(shlex.quote(a) for a in (agent, routine, project, model, settings))
    script = f'''mkdir -p "$HOME/.local/state/road-map-journal"
export PATH="$HOME/.local/bin:$PATH"
lock="$HOME/.local/state/road-map-journal/external-routine.lock"
log="$HOME/.local/state/road-map-journal/external-routine.log"
nohup bash -c 'flock -n 9 || exit 0; cd "$HOME" || exit 0; echo "== $(date -u +%FT%TZ) $3/$2"; prompt=$(roadctl tick --as "$1" --routine "$2" --project "$3" --prompt) || {{ echo "remote tick: not started"; exit 0; }}; exec claude -p --model "$4" --max-turns 30 --settings "$5" -- "$prompt"' _ {args} 9>"$lock" >>"$log" 2>&1 </dev/null &
'''
    try:
        subprocess.run([*SSH_COMMAND, host, "bash", "-c", shlex.quote(script)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        sys.stderr.write(f"external routine launch failed: {error}\n")


def external(agent, host):
    result = tick(agent, "run")
    if result is None or result.returncode != 0:
        return
    # One launch per due routine, each with its own model.
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        m = ENTRY_RE.match(line)
        if m:
            project, routine, model = m.groups()
            launch(host, agent, project, routine, model)


if __name__ == "__main__":
    sticky("road-routines", tick(AGENT, "run"))
    for agent, host in EXTERNAL_AGENTS.items():
        external(agent, host)
