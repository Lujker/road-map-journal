#!/usr/bin/env bash
# EXAMPLE: one recurring routine, started by a scheduler (cron, a systemd timer, or a Hermes `no_agent` job that runs this script) and run under
# `roadctl supervise`: one run at a time for the whole run, a timeout, a result check and a record when the model reports nothing.
# Adapt it; it is not run by roadctl. The model is never started inside a Hermes job: the job runs this script, the script runs the model.
#
# Step 1 (no model): roadctl tick --as AGENT --routine ID --prompt  -> exit 0 only when the routine is due, allowed and the limits permit.
# Step 2 (model):    roadctl supervise --routine ID --as AGENT --timeout 30m -- claude -p ... "<the prompt that tick printed>"
# `supervise` checks again under its lock (pause, requires, due), refuses a second run (exit 5), kills the command's whole process group at the timeout
# (exit 7), and when the command ends without `roadctl routine done` it records `failed: no result` in the routine (Log line ends with src=supervisor),
# so the next tick does not run the model again at once. The board must say "requires": "0.6.0" in board/config.json. Exit codes: docs/roadctl.md, "Run supervisor".
#
# crontab:   */30 * * * *  AGENT=claude-code@home-wsl ROUTINE=server-watch WORKDIR=$HOME $HOME/bin/supervised-routine.sh >> $HOME/.local/state/server-watch.log 2>&1
# Variables: AGENT (the agent of the routine), ROUTINE (id), WORKDIR (where tick and the command run), PROJECT (a board name; default: the board of WORKDIR),
#            MODEL (default haiku), MAX_TURNS (default 30), TIMEOUT (default 30m), ROADCTL (default ~/.local/bin/roadctl),
#            CLAUDE_EXTRA_ARGS (split on spaces, no quoting; for example --settings FILE that allows only the roadctl subcommands the routine prompt names, never Bash(roadctl:*)).
set -u
AGENT="${AGENT:?set AGENT to the agent of the routine}"
ROUTINE="${ROUTINE:?set ROUTINE to the routine id}"
WORKDIR="${WORKDIR:?set WORKDIR to the directory tick and the command should run in}"
ROADCTL="${ROADCTL:-$HOME/.local/bin/roadctl}"
board=()
[ -n "${PROJECT:-}" ] && board=(--project "$PROJECT")

cd "$WORKDIR" || exit 1                              # tick finds the board from here, like the command will
prompt="$("$ROADCTL" tick --as "$AGENT" --routine "$ROUTINE" ${board[@]+"${board[@]}"} --prompt)"   # in a variable: no temporary file to leave behind
code=$?
case "$code" in
  0) ;;                                             # due and allowed: go on to step 2
  4) echo "tick: idle, nothing to do"; exit 0 ;;
  1 | 3 | 5 | 6) printf '%s\n' "$prompt" | head -n 1; exit 0 ;;     # reserve, limits unknown, busy or paused: nothing to start now
  *) echo "tick: roadctl failed with exit code $code" >&2; exit "$code" ;;
esac

read -r -a extra <<< "${CLAUDE_EXTRA_ARGS:-}"
exec "$ROADCTL" supervise --routine "$ROUTINE" --as "$AGENT" --timeout "${TIMEOUT:-30m}" ${board[@]+"${board[@]}"} -- \
  claude -p --model "${MODEL:-haiku}" --max-turns "${MAX_TURNS:-30}" ${extra[@]+"${extra[@]}"} "$prompt"
