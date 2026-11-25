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
export ROADCTL_AS='codex@my-machine' # example; substitute your name from the registry
```

- **Direct harness (Claude Code, Codex, pi):** the executor name, for example `<harness>@<machine>` as it is written in the registry.
- **Agent of an orchestrator:** a profile or a pair `orchestrator/profile`, for example `<profile>` or `<orchestrator>@<machine>/<profile>`; a variant of a profile is also accepted.

`roadctl claim`, `report` and the limit checkpoint use it (a profile or a pair is resolved to its executor); `tick` and `limits --check` need an executor name, so pass `--as <executor>` to them; `--as` on a command overrides it for that one call. Who may take what is in [Executors and the registry](executors.md). An unknown name is refused with a hint.

## Check the connection from the session

A file on disk is not a connection: the agent must have loaded the skill, find the board and be able to report under its own name. Run this in the same session where the agent will work, before real work, and keep the result as evidence for a new agent or a new machine. Run `roadctl doctor` again on a new machine, after an update, and when "nothing runs": it is read-only and gives the fix command for every problem.

1. **The skill is loaded, not only installed.** Ask the agent to name the skill `road-map-journal` and quote its "Discover first" step before it reads any file. If it cannot, this session did not load it: install or update the skill and start a new session. The `skill` check of `doctor` sees the installed file only.
2. **The command is the one you think.**
   ```sh
   command -v roadctl
   roadctl --version
   ```
   `doctor` repeats this as `launcher`: the actual `roadctl` in `PATH`, the target of its launcher, and that copy's version and sha. A stale copy in `PATH` is the usual reason a claim reaches an old helper.
3. **The profile and the state directory.**
   ```sh
   export ROADCTL_AS='codex@my-machine' # example; substitute your name from the registry
   roadctl doctor
   ```
   Read `agent-name` (`ROADCTL_AS` resolves to an executor or a profile, not a guess), `state-dir` (the writable directory ticks, locks and the hook record use), `board-current`/`boards` (the actual board) and `hooks` (configured, and whether a run was confirmed).
4. **The board is the one you mean.**
   ```sh
   roadctl where
   ```
   If it is not, work from the project folder or pass `--board DIR` / `--project NAME`; `doctor` shows the same actual path.
5. **Hooks: configured is not confirmed.** A settings file proves only that the file was written. A hook is confirmed when `doctor` reports a recorded run with its event and time, after a real session start. If it says "configured, but no hook run has been recorded", start a new session of that harness in a project with a board, then run `doctor` again. Do not install or change hooks from this check; review and approve the host's own hook prompt once.
6. **A test card, end to end.** Use a scratch board or a test card, never a live one:
   ```sh
   roadctl worktree add TEST-1
   roadctl claim TEST-1 --workdir <worktree>
   roadctl lock -- <test command>
   roadctl report TEST-1 --commit <sha> "connection check: <result>"
   ```
   A second `claim` of the same card must be refused: that is the exclusivity check. A report the board accepts proves that the profile, the state directory and the board work together.

**What doctor cannot prove.** It reads files and a local hook record; it starts no session. It cannot show that the running agent loaded the skill, that the host called a hook, or that a model saw the context. Items 1 and 5 cover those; the rest is a result on a test card. For an orchestrator (OpenMausBot, OpenBot, Hermes), run the same steps inside the session it starts, under the name it gives you in `ROADCTL_AS`; the board side does not change.

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
