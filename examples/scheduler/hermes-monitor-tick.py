#!/usr/bin/env python3
"""EXAMPLE for the owner's setup (Hermes cron on Windows, roadctl inside WSL). Other users adapt it.

What it does: a cheap, model-free monitor script for Hermes cron. It runs `roadctl tick --prompt` inside
WSL and prints the prompt ONLY when roadctl exits 0 (there is work and the owner's limits allow it). For every
other exit (4 idle, 1 reserve reached, 3 limits unknown, 5 busy, 2 error) it prints nothing, so all of those
states give the same empty output and the agent stays suppressed.

Why: Hermes (cron/monitor.py) hashes the exact stdout of the monitor script. Unchanged output: no agent run.
ANY change, including a change to empty output, starts the agent once with a diff. roadctl keeps the prompt
stable (no times, no percentages, sorted), so the agent runs when the work changed, not on every tick.
Going from "work" back to "nothing" is still a change: Hermes runs the agent once with an empty source. The
job's instruction must therefore say: if the monitored output is empty, reply 'idle' and stop (it is in the
command below). Why a state is blocked (reserve, unknown limits) is not shown to the agent; look at
`roadctl tick --ledger` for that.

How to create the job (the script must live in Hermes's scripts folder):

    hermes cron create "every 2h" --name road-orchestrator \\
        --monitor-script hermes-monitor-tick.py \\
        "Follow the tick prompt in the monitored output. If the monitored output is empty, reply 'idle' and stop."

Change AGENT and COMMAND below for your machine. AGENT must be listed in the registry with the role
`orchestrator` (see examples/agents-registry.example.json); `roadctl tick --as AGENT --no-pull` is a
good first manual run (it reads, it does not pull).
"""
import subprocess
import sys

AGENT = "hermes@home-host"  # who the scheduled run is for (an agent name from the registry)
TICK = f"roadctl tick --as {AGENT} --prompt"  # add --all or --no-pull if you want them
COMMAND = ["wsl.exe", "-e", "bash", "-lc", TICK]  # bash -l so that ~/.local/bin is on PATH
TIMEOUT_SECONDS = 150  # pull (15 s per repository) and the limits probe (up to 90 s) fit in


def main() -> int:
    try:
        done = subprocess.run(COMMAND, capture_output=True, timeout=TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        sys.stderr.write(f"hermes-monitor-tick: could not run roadctl: {error}\n")
        return 0
    # roadctl exits 0 (work), 4 (idle), 1 (reserve), 3 (limits unknown), 5 (busy), 2 (error).
    if done.returncode == 0:
        sys.stdout.buffer.write(done.stdout)  # the prompt, byte for byte
        sys.stdout.buffer.flush()
    elif done.returncode == 2:
        sys.stderr.write(done.stderr.decode("utf-8", "replace"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
