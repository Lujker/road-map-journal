#!/usr/bin/env python3
"""Example: a Hermes `no_agent` job that delivers the roadctl digest to the owner. No model is started.

Copy it to Hermes's scripts directory and adapt PROJECTS and STATE_NAME. Two jobs run it:
  - often (for example every 15 minutes):  hermes-digest.py            problems and questions, each told once
  - once a day, at the time the owner chose: hermes-digest.py --daily    one line per routine, overdue ones included
Hermes forwards what the script prints to the owner (Telegram; the reserve channel is configured in Hermes, not here); an empty output is silence.
roadctl itself sends nothing. The plain text suits any chat: no markdown, at most about 3500 characters, and never a raw tail of a failed command.
Known limit: the "told" mark moves when roadctl has printed the text, before Hermes has delivered it; a delivery that fails then loses that message
(the daily overview is the safety net: it is a snapshot, not a list of news).
"""
import shlex
import subprocess
import sys

TIMEOUT_SECONDS = 150
MAX_CHARS = 3500  # one chat message; roadctl keeps to it itself, this is a second guard
# Boards to `roadctl pull` first: the runs of other machines arrive through git. Names as in `roadctl boards list` (empty: no pull).
PROJECTS = []
# One delivery state per recipient or channel: what was told to "telegram" is not told to it again; "vk" would be a state of its own.
STATE_NAME = "telegram"


def roadctl(args):
    """Run roadctl in WSL (adapt the command for another host); (returncode, stdout) or (None, "") when it could not run."""
    command = "roadctl " + " ".join(shlex.quote(a) for a in args)
    try:
        done = subprocess.run(["wsl.exe", "-e", "bash", "-lc", command], capture_output=True, timeout=TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        sys.stderr.write(f"hermes-digest: roadctl could not run: {error}\n")
        return None, ""
    return done.returncode, done.stdout.decode("utf-8", "replace")


def main(argv):
    daily = "--daily" in argv
    for project in PROJECTS:
        roadctl(["pull", "--project", project])  # offline or a conflict is not a reason to stay silent: the digest reads what is there
    args = ["digest", "--all"] + (["--daily"] if daily else ["--since-state", STATE_NAME])
    code, text = roadctl(args)
    if code != 0:
        # one short line, never the output of the failed command
        sys.stdout.write(f"roadctl digest did not run ({'no answer' if code is None else 'exit ' + str(code)}); see the machine\n")
        return 0
    text = text.strip("\n")
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rsplit("\n", 1)[0] + "\n(cut)"
    if text:
        sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
