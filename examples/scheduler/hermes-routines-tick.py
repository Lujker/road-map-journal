#!/usr/bin/env python3
"""Example: Hermes routines monitor plus external Claude routines via SSH.

Copy with monitor_common.py to Hermes's scripts directory and adapt EXTERNAL_AGENTS.
SSH and Claude run only for a successful external tick. The remote flock covers the
whole Claude run; the remote log and lock live in ~/.local/state/road-map-journal.
"""
import base64
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
ALLOWED_TOOLS = ["Read", "Bash(roadctl:*)"]


def launch(host, prompt, model):
    # Send the prompt as base64 inside a quoted remote shell command, not shell code.
    encoded = base64.b64encode(prompt).decode("ascii")
    script = f'''mkdir -p "$HOME/.local/state/road-map-journal"
export PATH="$HOME/.local/bin:$PATH"
lock="$HOME/.local/state/road-map-journal/external-routine.lock"
log="$HOME/.local/state/road-map-journal/external-routine.log"
nohup bash -c 'flock -n 9 || exit 0; prompt=$(printf %s "$1" | base64 -d); exec claude -p --model "$2" --max-turns 30 --settings "$3" -- "$prompt"' _ {shlex.quote(encoded)} {shlex.quote(model)} {shlex.quote(json.dumps({"permissions": {"allow": ALLOWED_TOOLS}}))} 9>"$lock" >>"$log" 2>&1 </dev/null &
'''
    try:
        subprocess.run([*SSH_COMMAND, host, "bash", "-c", shlex.quote(script)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        sys.stderr.write(f"external routine launch failed: {error}\n")


def external(agent, host):
    result = tick(agent, "run")
    if result is None or result.returncode != 0:
        return
    lines = result.stdout.decode("utf-8", "replace").splitlines()
    entries = [line for line in lines if re.match(r"^  [^/]+/[^:]+: file .*; model .*; env .*; previous run: ", line)]
    # Give each invocation its own item and model, even when several routines are due.
    for entry in entries:
        item, model = re.match(r"^  ([^:]+): file .*; model ([^;]+); env .*; previous run: ", entry).groups()
        selected = [line for line in lines if (not line.startswith("  ") or ": file " not in line or line == entry) and (not line.startswith("RUN ") or " a recurring routine " in line or line.startswith("RUN " + item + " "))]
        launch(host, ("\n".join(selected) + "\n").encode(), model)


if __name__ == "__main__":
    sticky("road-routines", tick(AGENT, "run"))
    for agent, host in EXTERNAL_AGENTS.items():
        external(agent, host)
