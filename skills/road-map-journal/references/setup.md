# Setup: connect once and use every day

For any agent (Claude Code, Codex, pi, Hermes, an OpenBot agent) or a person who wants the roadmap skill and the `roadctl` helper on one machine. Run once, then the daily cycle. No private data, agent ids or paths of this machine.

## Install

```sh
# the project (it holds scripts/update-installed.mjs; the skill install alone does not bring it)
git clone https://github.com/Lujker/road-map-journal && cd road-map-journal

# the skill (what tells the agent to use roadctl and how)
npx skills add Lujker/road-map-journal --skill road-map-journal

# roadctl (the command the skill uses), run from that checkout
node scripts/update-installed.mjs --roadctl --apply
```

`update-installed.mjs --roadctl --apply` puts roadctl in `~/.local/share/road-map-journal/`, writes `installed.json` so `roadctl doctor` can compare it, and writes the launcher `~/.local/bin/roadctl` (a small `#!/bin/sh` script that runs the installed file), so `roadctl` is a command. It writes the launcher only when there is none or it is its own; a launcher that someone else wrote is kept unless you add `--force`. If `~/.local/bin` is not in your `PATH` it prints one line saying so: add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile (and make cron, ssh or `wsl.exe -e` see it too). It also installs or refreshes the skill for the agents it finds, so the `npx skills add` line is for a machine that needs only the skill.

## Hooks

Hooks give a new session the brief (where it is, what is in work), remind it to save at stop, and write the limit checkpoint when the usage limit is near (see the section "Limit checkpoint" in docs/roadctl.md of the project; the explicit `limit-stop` event is wired by hand, `hook-install` does not write it). Install them once per harness on the machine, at user level, which is where `roadctl doctor` looks:

```sh
roadctl hook-install --claude --user --apply   # Claude Code: ~/.claude/settings.json (without --user: this project only)
roadctl hook-install --codex --apply           # Codex: ~/.codex/hooks.json (user-level already)
roadctl hook-install --hermes --apply          # Hermes: config.yaml (user-level already)
roadctl hook-install --git --apply             # optional, per repository: the pre-commit lint
```

Without `--apply` each command only shows what it would write. Claude and Codex may ask you to review or trust the hooks once (`/hooks`); Hermes asks to approve on first use. The hooks stay silent where there is no board.

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

- **Direct harness (Claude Code, Codex, pi):** the executor name, for example `<harness>@<machine>` as it is written in the registry.
- **Agent of an orchestrator:** a profile or a pair `orchestrator/profile`, for example `<profile>` or `<orchestrator>@<machine>/<profile>`; a variant of a profile is also accepted.

`roadctl claim`, `report` and the limit checkpoint use it (a profile or a pair is resolved to its executor); `tick` and `limits --check` need an executor name, so pass `--as <executor>` to them; `--as` on a command overrides it for that one call. Who may take what is in [Executors and the registry](executors.md). An unknown name is refused with a hint.

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

From the checkout of the project (`git pull` it first):

```sh
node scripts/update-installed.mjs --roadctl --apply      # roadctl, its modules, the launcher, and the installed skill
node scripts/update-installed.mjs --apply                # the installed skill only
```

Run `roadctl doctor` afterwards. Reinstalling can overwrite local edits; `update-installed.mjs` refuses to overwrite a locally modified skill copy, or a launcher it did not write, without `--force`.
