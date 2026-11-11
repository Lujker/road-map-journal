# roadctl

Optional helper for a board-format project (see [board-spec.md](board-spec.md)). One file, [`scripts/roadctl.mjs`](../scripts/roadctl.mjs), Node standard library only (tests pass on Node 20, 24 and 26). It is **not installed with the skill**: copy the file into your project (for example `tools/roadctl.mjs`) and keep its version line. For hooks at user level (Codex, Hermes) it needs one stable path: `node scripts/update-installed.mjs --roadctl --apply` installs or refreshes `~/.local/share/road-map-journal/roadctl.mjs`. Files stay the source of truth; the skill and a person can edit cards by hand without it. It never sets `approved` on its own initiative and only checks that references exist, not that evidence is true.

Not sure where to start? `roadctl help` prints an overview grouped by task (what each command is for, and whether it only reads, writes board files or uses git), a quick start for all projects, one project and one card, and the boundaries for agents. `roadctl help <command>` (or `roadctl <command> --help`) gives purpose, usage, flags, examples, what the command changes and its exit codes; `--help` never runs the command and writes nothing.

## Commands

```text
roadctl lint [--json]             check invariants; exit 1 on errors
roadctl lint --all                lint every board of the central workspace
roadctl where                     print the board found for the current directory
roadctl sync [--check]            regenerate board/BOARD.md, or verify it is current
roadctl brief                     short summary for an agent: header fields and a sanitized next criterion
roadctl show <id> [--log N] [--commits N]
roadctl status [--all]            counts by status per project, the doing cards, oldest as_of of active cards, lint totals; read-only
roadctl list [--status S[,S]|all] [--all]   cards; by default everything except done and dropped
roadctl next [--all]              doing cards, then ready cards whose depends_on are all done, then ready cards still waiting (and on what)
                                  brief, show, status, list and next accept --json
roadctl pull                      fetch, then rebase the board's repository on its upstream (a conflict only in BOARD.md is regenerated)
roadctl save ["message"]          lint, commit only the board's paths, rebase on the upstream, push; never forces
                                  status --fetch asks the server first; pull and save accept --json
roadctl log <id> "text" [--author A] [--commit SHA]
roadctl review <id>               doing -> review when every criterion is met with evidence or deferred with a reason
roadctl done <id> --by NAME       review/doing -> done; refuses without evidence; run only after the owner accepted
roadctl approve <id> --by NAME --scope implementation[+analysis+external] [--source REF]   the owner approves; an agent must not run this for itself
roadctl new <id> "title" [--status ready|idea]
roadctl hook <session-start|pre-compact|stop|hermes-pre-llm|pre-commit|pre-commit-all> [--host claude|codex]
roadctl hook-install --claude [--user]|--codex|--hermes|--git [--all] [--apply]   (dry run without --apply)
roadctl hook-uninstall --claude [--user]|--codex|--hermes|--git [--all] [--apply]
roadctl instructions-install --claude --codex [--apply]    (managed block in ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md)
roadctl instructions-uninstall --claude --codex [--apply]
      [--claude-home DIR] [--codex-home DIR] [--hermes-home DIR] [--node PATH] [--helper PATH]
```

Global flags: `--board <dir>` (default: search upwards for `board/config.json`, then the central workspace, see [board-spec.md](board-spec.md)), `--workspace DIR` (or `ROADCTL_WORKSPACE`), `--date YYYY-MM-DD`. Exit codes: 0 ok, 1 findings or refusal, 2 usage error.

## Overview without an agent

`status`, `list` and `next` only read the board files; they need no model and write nothing. `--all` covers every board of the central workspace (the first workspace root found, as for `lint --all`). `status` prints one row per project (counts per status, `oldest as_of` among doing, review and blocked cards, lint errors and warnings) and one line per doing card. `next` is a view, not a decision: `ready` means defined, **not** permission to start, so a ready card without `approved` is marked as needing the owner's approval, and a ready card is "waiting" until every id in `depends_on` is `done`. Card titles in text output are sanitized like in `brief`; `--json` returns the raw values for scripts. What these commands cannot tell is whether a status matches reality: that still needs a person or an agent reading the evidence. How far a board is behind its server is not shown yet (P3.2).

## Synchronization with the server

Plans live in a git repository (a central workspace, or the project). `pull` and `save` keep a board in step with other agents and machines without anyone typing git commands.

- `pull`: `git fetch`, then `git rebase --autostash` on the upstream. Uncommitted changes are kept. If the rebase conflicts **only** in generated `BOARD.md` files they are regenerated from the merged cards and the rebase continues; any other conflict aborts the rebase, leaves the tree as it was and reports the files (status `conflict`): two agents edited the same text, so a person decides. If the server cannot be reached the status is `offline` and work continues on the local state.
- `save ["message"]`: regenerates a stale `BOARD.md`, runs `lint` (errors refuse the save, nothing is committed), commits **only the board's paths** (the project folder `projects/<name>` in a central workspace, `board/` in a project; other changed or staged files are left alone and counted in the message), rebases on the upstream like `pull`, lints the merged result, pushes. It never forces. If someone pushed in between it integrates once more and retries. If the server is unreachable the commit stays local (`saved-local`, exit 0) and the next `save` pushes it. It refuses to push when unpushed commits touch paths outside the board (`foreign-commits`), and when the merged board has lint errors (`lint-after-merge`). Without a message the commit is `board <project>: update <card ids>`.
- Statuses that are not failures (exit 0): `up-to-date`, `pulled`, `offline`, `no-remote`, `saved-local`, `nothing-to-save`, `pushed`. Everything else exits 1 with the reason.
- `status` shows an `origin` column (`in sync`, `behind N`, `ahead N`, `N uncommitted`, `no remote`) from the last known state; `status --fetch` asks the server first.
- `log`, `new` and `review` print a warning to stderr when the board is known to be behind origin (no network is used for that check).
- Network limits: `ROADCTL_GIT_TIMEOUT_MS` (default 15000); git never prompts (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode`).

**Autosync (opt-in).** Hooks keep their rule of never changing anything unless the owner opts in, with `"autosync": true` in `board/config.json` (shared by every host and agent that uses this board) or `ROADCTL_AUTOSYNC=1` (`0` forces it off). Then the `SessionStart` hook runs `pull` before the brief, and the `Stop` hook runs `save` when the board has uncommitted changes or unpushed commits. Without autosync `SessionStart` only fetches (4 second limit, `ROADCTL_NO_FETCH=1` disables it) and adds one line to the brief ("behind origin by N commit(s)", "N local commit(s) not pushed", "origin unreachable", "up to date"). A successful autosave is silent; a problem (conflict, lint error, rejected push) is passed to the agent once so it can tell the owner. The reminder check runs before the autosave, and a successful autosave records the card's Log state so the reminder is not triggered for work that was already written down. Hooks have short timeouts (Codex kills a hook after 10 seconds); a kill during `fetch` or `push` is harmless, and the rebase itself is local and fast.

## Hooks

Hooks are reinforcement, never the only mechanism, and they never change statuses, set `approved`, block an agent or fail a session (an internal error becomes a no-op).

- `session-start`: prints the brief as `additionalContext`. Also useful after compaction.
- `pre-compact`: asks that the active card, open criteria and decisions be kept in the summary.
- `stop`: when exactly one card is `doing`, the working tree has changes outside the board and the board was not touched, it reminds the agent **once** until the card's Log changes (a marker file in `.git` records it). It stays silent when `stop_hook_active` is set, with zero or several `doing` cards, and outside git. Claude Code gets `additionalContext`; with `--host codex` it answers `{"decision":"block","reason":...}`, which Codex turns into one continuation prompt.
- `hermes-pre-llm`: Hermes only uses the return value of `pre_llm_call`, so this one hook gives the brief on the first turn of a session and the same one-time reminder on a later turn (`{"context": ...}`). Hermes hooks see only the session's working directory, so they work when Hermes runs inside the project.
- `pre-commit` (git): runs `lint`; errors block the commit, warnings never do.

Installers (dry run by default, backup before writing, existing hooks kept, idempotent, undone by `hook-uninstall`):

- `--claude`: the three Claude Code hooks into the project's **local, uncommitted** `.claude/settings.local.json`; with `--user` into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) instead, which is the right place when boards live in a central workspace. The hooks are silent in directories without a board.
- `--codex`: `SessionStart` (all sources, so it also runs after compaction) and `Stop` into the user-level `~/.codex/hooks.json` (or `$CODEX_HOME`), with `command` (plus `commandWindows` when installed from Windows) and a 10 second timeout. User level is used because the hooks are silent outside board projects and a project `.codex/hooks.json` would be committed. Codex does not run a new hook until you review and trust it in `/hooks`; roadctl never edits the trust state. `PreCompact` is not installed for Codex because Codex ignores its output.
- `--hermes`: one marked block (`# roadctl-managed begin/end`) appended to Hermes `config.yaml`; it refuses to edit a file that already has a top-level `hooks:` key and prints the entry to merge by hand. Hermes asks you to approve a new hook the first time it sees it (`hermes hooks list` shows the status; non-interactive runs need `--accept-hooks`, `HERMES_ACCEPT_HOOKS=1` or `hooks_auto_accept`, which roadctl does not set).
- `--git`: writes `.git/hooks/pre-commit` only if none exists; an existing foreign hook is never touched. With `--all` (run inside the workspace repository) the hook lints every board of the workspace.

## What was tested

`node --test scripts/roadctl.test.mjs` runs 52 model-free tests (CI runs them too): lint rules with seeded errors, `sync` determinism and `--check`, brief content limits, `log` with CRLF files, `review`/`done` refusals, `approve`, `new`, `show`, `status`/`list`/`next`/`--json` (including `--all` over two boards and a check that they write nothing), `pull`/`save` and the sync hooks against a local bare repository with two clones (merging different cards, regenerating a conflicting `BOARD.md`, stopping on a conflict in one card, offline, lint refusal, commits outside the board, autosync at session start and at Stop), the help overview and per-command help (every dispatcher command has an entry, `--help` writes nothing, an unknown command exits 2), hook outputs and the once-only Stop rule against a temporary git repository, hook installation and removal for Claude Code, Codex, Hermes and git. The first 33 passed on WSL (Node 24) and on Windows (Node 20 and 26); the blocking-commit step of the git-hook test runs only on Linux. The 52 were run on WSL (Node 24) only; Windows and CI were not rerun after the overview and sync commands were added. The sync tests use a local bare repository, not a remote over the network or ssh. **Checked against the real tools, without a model (2026-11-10):** Codex 0.165 `app-server hooks/list` parsed the installed `hooks.json` with 3 hooks, no warnings or errors, all `untrusted` until you trust them in `/hooks`; Hermes 0.22.6 `hermes hooks test pre_llm_call` fired the installed hook through Hermes's own dispatcher (exit 0, valid `{"context": ...}` with the brief), and `hermes hooks list` shows it as not yet allowlisted. **Not tested:** the hooks firing inside a live Claude Code, Codex or Hermes session, and any agent behavior; no model was run. Rules 15 and 16 of the spec (history-based warnings) are not implemented.

## Instruction blocks

`instructions-install --claude --codex` adds or refreshes one marked block (`<!-- ROADMAP-JOURNAL:START -->` ... `:END -->`) in the user-level `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, so that every session in every project knows about the skill, keeps existing plans where they are, creates new boards in the central workspace and finds the helper. Text outside the block is never changed; a file that is a symlink is not edited (the block is printed instead); a backup is made before writing; `instructions-uninstall` removes the block. Where the workspace is not under `~/projects/agent-workspace` or `~/Projects/agent-workspace` (for example on Windows), put its path on the first line of `~/.local/share/road-map-journal/workspace` or set `ROADCTL_WORKSPACE`.
