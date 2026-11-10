# roadctl

Optional helper for a board-format project (see [board-spec.md](board-spec.md)). One file, [`scripts/roadctl.mjs`](../scripts/roadctl.mjs), Node standard library only (tests pass on Node 20, 24 and 26). It is **not installed with the skill**: copy the file into your project (for example `tools/roadctl.mjs`) and keep its version line. For hooks at user level (Codex, Hermes) it needs one stable path: `node scripts/update-installed.mjs --roadctl --apply` installs or refreshes `~/.local/share/road-map-journal/roadctl.mjs`. Files stay the source of truth; the skill and a person can edit cards by hand without it. It never sets `approved` on its own initiative and only checks that references exist, not that evidence is true.

## Commands

```text
roadctl lint [--json]             check invariants; exit 1 on errors
roadctl sync [--check]            regenerate board/BOARD.md, or verify it is current
roadctl brief                     short summary for an agent: header fields and a sanitized next criterion
roadctl show <id> [--log N] [--commits N]
roadctl log <id> "text" [--author A] [--commit SHA]
roadctl review <id>               doing -> review when every criterion is met with evidence or deferred with a reason
roadctl done <id> --by NAME       review/doing -> done; refuses without evidence; run only after the owner accepted
roadctl approve <id> --by NAME --scope implementation[+analysis+external] [--source REF]   the owner approves; an agent must not run this for itself
roadctl new <id> "title" [--status ready|idea]
roadctl hook <session-start|pre-compact|stop|hermes-pre-llm|pre-commit> [--host claude|codex]
roadctl hook-install --claude|--codex|--hermes|--git [--apply]   (dry run without --apply)
roadctl hook-uninstall --claude|--codex|--hermes|--git [--apply]
      [--codex-home DIR] [--hermes-home DIR] [--node PATH]
```

Global flags: `--board <dir>` (default: search upwards for `board/config.json`), `--date YYYY-MM-DD`. Exit codes: 0 ok, 1 findings or refusal, 2 usage error.

## Hooks

Hooks are reinforcement, never the only mechanism, and they never change statuses, set `approved`, block an agent or fail a session (an internal error becomes a no-op).

- `session-start`: prints the brief as `additionalContext`. Also useful after compaction.
- `pre-compact`: asks that the active card, open criteria and decisions be kept in the summary.
- `stop`: when exactly one card is `doing`, the working tree has changes outside the board and the board was not touched, it reminds the agent **once** until the card's Log changes (a marker file in `.git` records it). It stays silent when `stop_hook_active` is set, with zero or several `doing` cards, and outside git. Claude Code gets `additionalContext`; with `--host codex` it answers `{"decision":"block","reason":...}`, which Codex turns into one continuation prompt.
- `hermes-pre-llm`: Hermes only uses the return value of `pre_llm_call`, so this one hook gives the brief on the first turn of a session and the same one-time reminder on a later turn (`{"context": ...}`). Hermes hooks see only the session's working directory, so they work when Hermes runs inside the project.
- `pre-commit` (git): runs `lint`; errors block the commit, warnings never do.

Installers (dry run by default, backup before writing, existing hooks kept, idempotent, undone by `hook-uninstall`):

- `--claude`: the three Claude Code hooks into the project's **local, uncommitted** `.claude/settings.local.json`.
- `--codex`: `SessionStart` (all sources, so it also runs after compaction) and `Stop` into the user-level `~/.codex/hooks.json` (or `$CODEX_HOME`), with `command` (plus `commandWindows` when installed from Windows) and a 10 second timeout. User level is used because the hooks are silent outside board projects and a project `.codex/hooks.json` would be committed. Codex does not run a new hook until you review and trust it in `/hooks`; roadctl never edits the trust state. `PreCompact` is not installed for Codex because Codex ignores its output.
- `--hermes`: one marked block (`# roadctl-managed begin/end`) appended to Hermes `config.yaml`; it refuses to edit a file that already has a top-level `hooks:` key and prints the entry to merge by hand. Hermes asks you to approve a new hook the first time it sees it (`hermes hooks list` shows the status; non-interactive runs need `--accept-hooks`, `HERMES_ACCEPT_HOOKS=1` or `hooks_auto_accept`, which roadctl does not set).
- `--git`: writes `.git/hooks/pre-commit` only if none exists; an existing foreign hook is never touched.

## What was tested

`node --test scripts/roadctl.test.mjs` runs 27 model-free tests (CI runs them too): lint rules with seeded errors, `sync` determinism and `--check`, brief content limits, `log` with CRLF files, `review`/`done` refusals, `approve`, `new`, `show`, hook outputs and the once-only Stop rule against a temporary git repository, hook installation and removal for Claude Code, Codex, Hermes and git. They pass on WSL (Node 24) and on Windows (Node 20 and 26); the blocking-commit step of the git-hook test runs only on Linux. **Checked against the real tools, without a model (2026-11-10):** Codex 0.165 `app-server hooks/list` parsed the installed `hooks.json` with 3 hooks, no warnings or errors, all `untrusted` until you trust them in `/hooks`; Hermes 0.22.6 `hermes hooks test pre_llm_call` fired the installed hook through Hermes's own dispatcher (exit 0, valid `{"context": ...}` with the brief), and `hermes hooks list` shows it as not yet allowlisted. **Not tested:** the hooks firing inside a live Claude Code, Codex or Hermes session, and any agent behavior; no model was run. Rules 15 and 16 of the spec (history-based warnings) are not implemented.
