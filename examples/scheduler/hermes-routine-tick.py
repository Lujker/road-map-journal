#!/usr/bin/env python3
"""EXAMPLE for the owner's setup (Hermes cron on Windows, roadctl inside WSL). Other users adapt it.

What it does: a cheap, model-free monitor script for ONE recurring routine. It runs
`roadctl tick --routine <id> --prompt` inside WSL and prints the instruction ONLY when roadctl exits 0 (the routine
is due, inside its hours, switched on and approved, and the owner's limits allow it). For every other exit (4 idle,
1 reserve reached, 3 limits unknown, 5 busy, 2 error) it prints nothing, so all of those states give the same empty
output and the model stays suppressed. It is hermes-monitor-tick.py (the general orchestrator tick) limited to one routine.

Why one job per routine: each Hermes cron job has its own model (`--model`), so a light model can run a mechanical
routine without the orchestrator's. The Hermes job runs often (for example every 30m) but the model starts only when
the routine is due: the routine's own `every` (and `hours`) in board/routines/<id>.md stay the source of truth.
Hermes hashes the exact stdout of the script: unchanged output starts nothing, any change (including a change to
empty output) starts the model once. After `roadctl routine done` the routine is not due until `every` has passed,
so the output goes back to empty.

How to create the job (the script must live in Hermes's scripts folder; ROUTINE is the routine id, edit it below or
pass it as the first argument if your Hermes version allows script arguments):

    hermes cron create "every 30m" --name road-routine-<id> --model <routine model> \\
        --monitor-script hermes-routine-tick.py \\
        "Follow the routine prompt in the monitored output. If the monitored output is empty, reply 'idle' and stop."

Change AGENT, ROUTINE and COMMAND below for your machine. AGENT must be the `agent` of the routine (a routine is offered
to its own agent only); `roadctl tick --as AGENT --routine ID --no-pull` is a good first manual run (it reads, it does not
pull). A routine tick has its own lock, so it does not make the general orchestrator tick busy.
"""
import re
import subprocess
import sys

AGENT = "hermes@home-host"  # the routine's own agent (the agent: header of the routine file)
ROUTINE = "server-watch"  # the routine id; the first command line argument overrides it
if len(sys.argv) > 1:
    ROUTINE = sys.argv[1]
if not re.fullmatch(r"[A-Za-z0-9._-]+", ROUTINE):
    sys.exit("hermes-routine-tick: the routine id may only have letters, digits, . _ -")
TICK = f"roadctl tick --as {AGENT} --routine {ROUTINE} --prompt"  # add --all or --no-pull if you want them
COMMAND = ["wsl.exe", "-e", "bash", "-lc", TICK]  # bash -l so that ~/.local/bin is on PATH
TIMEOUT_SECONDS = 150  # pull (15 s per repository) and the limits probe (up to 90 s) fit in


def main() -> int:
    try:
        done = subprocess.run(COMMAND, capture_output=True, timeout=TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        sys.stderr.write(f"hermes-routine-tick: could not run roadctl: {error}\n")
        return 0
    # roadctl exits 0 (work), 4 (idle), 1 (reserve), 3 (limits unknown), 5 (busy), 2 (error).
    if done.returncode == 0:
        sys.stdout.buffer.write(done.stdout)  # the instruction, byte for byte
        sys.stdout.buffer.flush()
    elif done.returncode == 2:
        sys.stderr.write(done.stderr.decode("utf-8", "replace"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
