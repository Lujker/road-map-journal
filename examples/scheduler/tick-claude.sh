#!/usr/bin/env bash
# EXAMPLE: a scheduled orchestrator on Linux (cron or a systemd timer) that starts Claude Code only when
# `roadctl tick` finds work and the owner's limits allow it. Adapt it; it is not run by roadctl or its tests.
#
# Step 1 (no model): roadctl tick --as AGENT --prompt  -> exit 0 only when there is work and the limits allow.
# Step 2 (model):    claude -p ... "<the prompt that tick printed>"  -> only on exit 0.
# Exit codes of tick: 0 work, 4 idle, 1 reserve reached, 3 limits unknown, 5 another tick of this agent runs, 2 error.
#
# crontab:   0 */2 * * *  WORKDIR=$HOME/projects/agent-workspace $HOME/bin/tick-claude.sh >> $HOME/.local/state/tick-claude.log 2>&1
# Variables: AGENT (default claude-code@home-wsl, must be in the registry with the role orchestrator), WORKDIR (where claude starts),
#            MODEL (default opus), MAX_TURNS (default 30), ROADCTL (default ~/.local/bin/roadctl),
#            CLAUDE_TIMEOUT (default 30m: timeout(1) stops a claude run that hangs; exit 124 then), CLAUDE_EXTRA_ARGS (split on spaces, no quoting; for example:
#            --settings $HOME/.config/tick-claude.settings.json, a file that allows only the roadctl subcommands the prompt names:
#            {"permissions":{"allow":["Read","Bash(roadctl limits --check:*)","Bash(roadctl show:*)","Bash(roadctl claim:*)","Bash(roadctl report:*)","Bash(roadctl accept:*)","Bash(roadctl return:*)","Bash(roadctl delegate:*)","Bash(roadctl undelegate:*)","Bash(roadctl save:*)"]}}
#            and never Bash(roadctl:*), which would also allow approve and done).
set -u
AGENT="${AGENT:-claude-code@home-wsl}"
WORKDIR="${WORKDIR:?set WORKDIR to the directory claude should start in}"
ROADCTL="${ROADCTL:-$HOME/.local/bin/roadctl}"

prompt="$(mktemp)"
trap 'rm -f "$prompt"' EXIT

"$ROADCTL" tick --as "$AGENT" --prompt > "$prompt"
code=$?
case "$code" in
  0) ;;                                             # work and the limits allow: go on to step 2
  4) echo "tick: idle, nothing to do"; exit 0 ;;
  1 | 3 | 5) head -n 1 "$prompt"; exit 0 ;;         # reserve, limits unknown or busy: do nothing, try again next time
  *) echo "tick: roadctl failed with exit code $code" >&2; exit "$code" ;;
esac

cd "$WORKDIR" || exit 1
read -r -a extra <<< "${CLAUDE_EXTRA_ARGS:-}"
timeout --kill-after=30s "${CLAUDE_TIMEOUT:-30m}" claude -p --model "${MODEL:-opus}" --max-turns "${MAX_TURNS:-30}" ${extra[@]+"${extra[@]}"} "$(cat "$prompt")"
