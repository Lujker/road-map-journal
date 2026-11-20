# Setup: connect once and use every day

For any agent (Claude Code, Codex, pi, Hermes, an OpenBot agent) or a person who wants the roadmap skill and the `roadctl` helper on one machine. Run once, then the daily cycle. No private data, agent ids or paths of this machine.

## Install

```sh
# the skill (what tells the agent to use roadctl and how)
npx skills add Lujker/road-map-journal --skill road-map-journal

# roadctl (the command the skill uses); from a checkout of the project
node scripts/update-installed.mjs --roadctl --apply
```

`update-installed.mjs` puts roadctl in `~/.local/share/road-map-journal/` and writes `installed.json` so `roadctl doctor` can compare it.

## Hooks

Hooks give a new session the brief (where it is, what is in work), remind it to save at stop, and watch for a limit stop. Install them for each harness on the machine:

```sh
roadctl hook-install --claude --apply      # also: --codex, --hermes, --git
```

Claude and Codex may ask you to review or trust the hooks once (`/hooks`); Hermes asks to approve on first use. The hooks stay silent where there is no board.

## Where the board is

```sh
roadctl where             # the board for the current directory
roadctl boards list       # every board known to this machine
```

Work from a folder that `roadctl where` resolves, or pass `--board DIR` / `--project NAME`.

## Registry and the agent name

The registry (`agents/registry.json` of the workspace) names the executors and the profiles. The agent name is who you are on the board; set it once per session:

```sh
export ROADCTL_AS=<name>
```

- **Direct harness (Claude Code, Codex, pi):** the executor name, for example `claude-code@home-wsl`, `codex@home-wsl`, `pi-worker@home-wsl`.
- **Agent of an orchestrator:** a profile or a pair `orchestrator/profile`, for example `pi-developer` or `openbot@home-wsl/pi-developer`; a variant like `pi-developer-small` is also accepted.

`roadctl claim`, `report`, `tick` and the limit checkpoint use it; `--as` on a command overrides it for that one call. Who may take what is in [Executors and the registry](executors.md). An unknown name is refused with a hint.

## Check the machine

```sh
roadctl doctor
```

Read-only. It reports the installed skill and roadctl, the hooks, whether `ROADCTL_AS` resolves, the boards and their `requires`, and gives the fix command for every problem. Run it on a new machine, after an update, and when "nothing runs".

## Daily cycle

```sh
roadctl pull                              # the latest board
roadctl next   # or: roadctl tasks --for "$ROADCTL_AS"
roadctl worktree add <id>                 # your own branch and worktree, never main
roadctl claim <id> --workdir <worktree>   # a ready card becomes doing (owner approval required)
roadctl lock -- <test command>            # tests never overlap with another run
# ...work, commit in small commits, one Evidence line per criterion...
roadctl report <id> --commit <sha> "<what changed, tested, left>"
roadctl worktree prune <id>               # after the merge; refuses dirty/unmerged without --force
```

Give a card to another agent with `roadctl handoff <id> --to <who>`, not a hand-written note. Review by the rule in [Handing work over](handoff.md).

## Update

```sh
node scripts/update-installed.mjs --roadctl --apply      # roadctl (and its modules)
node scripts/update-installed.mjs --apply                # the installed skill
```

Run `roadctl doctor` afterwards. Reinstalling can overwrite local edits; `update-installed.mjs` refuses to overwrite a locally modified copy without `--force`.
