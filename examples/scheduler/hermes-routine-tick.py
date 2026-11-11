#!/usr/bin/env python3
"""Example for one Hermes routine on Windows with roadctl in WSL.

Copy this file and monitor_common.py to Hermes's scripts folder and adapt AGENT
and ROUTINE. A successful work prompt is retained on idle or blocked ticks;
the previous-run field makes the next due cycle distinct. Each routine id uses
its own state file. This script does not start the model itself.
"""
import re
import subprocess
import sys
from monitor_common import sticky, TIMEOUT_SECONDS

AGENT = "hermes@home-host"
ROUTINE = sys.argv[1] if len(sys.argv) > 1 else "server-watch"
if not re.fullmatch(r"[A-Za-z0-9._-]+", ROUTINE):
    sys.exit("hermes-routine-tick: invalid routine id")
try:
    result = subprocess.run(["wsl.exe", "-e", "bash", "-lc", f"roadctl tick --as {AGENT} --routine {ROUTINE} --prompt"], capture_output=True, timeout=TIMEOUT_SECONDS)
except (OSError, subprocess.TimeoutExpired) as error:
    sys.stderr.write(f"tick failed: {error}\n")
    result = None
sticky("road-routine-" + ROUTINE, result)
