"""Shared sticky Hermes monitor state and model-free tick runner."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

TIMEOUT_SECONDS = 150


def tick(agent, kinds, output="--prompt"):
    # output: "--prompt" for a monitor that hands the text to a model, "--json" for a script that decides by itself
    # (the JSON is a contract, see docs/roadctl.md; scripts read it instead of parsing the text).
    command = f"roadctl tick --as {agent} --kinds {kinds} {output}"
    try:
        return subprocess.run(["wsl.exe", "-e", "bash", "-lc", command], capture_output=True, timeout=TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        sys.stderr.write(f"tick failed: {error}\n")
        return None


def sticky(name, result):
    root = Path(os.environ.get("ROAD_MONITOR_STATE_DIR", Path.home() / ".road-map-journal"))
    state = root / (name + ".state")
    if result is not None and result.returncode == 0 and result.stdout:
        root.mkdir(parents=True, exist_ok=True)
        # Atomic replacement keeps an interrupted write from changing the monitored output.
        with tempfile.NamedTemporaryFile(dir=root, delete=False) as f:
            temp = f.name
            f.write(result.stdout)
        os.replace(temp, state)
    try:
        sys.stdout.buffer.write(state.read_bytes())
    except FileNotFoundError:
        pass
    if result is not None and result.returncode == 2:
        sys.stderr.buffer.write(result.stderr)
