# roadctl

Optional helper for a board-format project (see [board-spec.md](board-spec.md)). One file, [`scripts/roadctl.mjs`](../scripts/roadctl.mjs), Node standard library only (Node 18 or newer). It is **not installed with the skill**: copy the file into your project (for example `tools/roadctl.mjs`) and keep its version line. Files stay the source of truth; the skill and a person can edit cards by hand without it. It never sets `approved` on its own initiative and only checks that references exist, not that evidence is true.

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
roadctl hook <session-start|pre-compact|stop|pre-commit>
roadctl hook-install --claude|--git [--apply]      (dry run without --apply)
roadctl hook-uninstall --claude|--git [--apply]
```

Global flags: `--board <dir>` (default: search upwards for `board/config.json`), `--date YYYY-MM-DD`. Exit codes: 0 ok, 1 findings or refusal, 2 usage error.

## Hooks

Hooks are reinforcement, never the only mechanism, and they never change statuses, set `approved`, block an agent or fail a session (an internal error becomes a no-op).

- `session-start`: prints the brief as `additionalContext`. Also useful after compaction.
- `pre-compact`: asks that the active card, open criteria and decisions be kept in the summary.
- `stop`: when exactly one card is `doing`, the working tree has changes outside the board and the board was not touched, it reminds the agent **once** until the card's Log changes (a marker file in `.git` records it). It stays silent when `stop_hook_active` is set, with zero or several `doing` cards, and outside git.
- `pre-commit` (git): runs `lint`; errors block the commit, warnings never do.

`hook-install --claude` merges the three Claude Code hooks into the project's **local, uncommitted** `.claude/settings.local.json` after backing it up, keeps your existing hooks, is idempotent and is undone by `hook-uninstall`. `hook-install --git` writes `.git/hooks/pre-commit` only if none exists; an existing foreign hook is never touched. Codex and Hermes have comparable hook mechanisms in their documentation; installers for them are not written.

## What was tested

`node --test scripts/roadctl.test.mjs` runs 22 model-free tests (CI runs them too): lint rules with seeded errors, `sync` determinism and `--check`, brief content limits, `log` with CRLF files, `review`/`done` refusals, `approve`, `new`, `show`, hook outputs and the once-only Stop rule against a temporary git repository, hook installation and removal. They pass on WSL (Node 24) and on Windows (Node 26); the blocking-commit step of the git-hook test runs only on Linux. **Not tested:** real firing of the hooks inside Claude Code, Codex or Hermes, and any agent behavior; no model was run. Rules 15 and 16 of the spec (history-based warnings) are not implemented.
