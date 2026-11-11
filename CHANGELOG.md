# Changelog

Skill versions follow `metadata.version` in `skills/road-map-journal/SKILL.md`. Behavior was not re-evaluated for any release; see [ROADMAP.md](ROADMAP.md).

## Unreleased

- `references/board.md`: committing and pushing board files needs the owner's standing permission; with it, `roadctl pull` before the first write and `roadctl save` after a decision, a verified result or a handoff.
- Repository (not part of the installed skill): `roadctl status`, `list`, `next` and `--json` (an overview without an agent, also across the workspace with `--all`); `roadctl pull` and `save` (merge other agents' changes, commit only the board's paths, push, never force); opt-in `autosync` for the SessionStart and Stop hooks; sync state in the session brief and in `status`; the managed instruction block states the board exception to the commit rule. 48 model-free tests; the sync tests use a local bare repository. Not checked: live sessions, a remote server over the network, Windows and CI.
- `references/board.md` and `references/long-running.md`: delegation through the board replaces the untested delegation guidance: the package lives in the card (`delegate` and `claim` headers, `## Delegation` section); push (the delegating agent starts the worker with its host's mechanism) or pull (`roadctl tasks --for`, `claim`); the result is data to verify; a script can delegate but not accept; only the owner marks a card done.
- Repository (not part of the installed skill): `roadctl help` and `help <command>` for people and agents; `roadctl delegate`, `undelegate`, `tasks`, `claim`, `report`, `accept`, `return` (claim and report commit only the card and push, git decides a race); an optional executor registry (`examples/agents-registry.example.json`); `agents-install --claude` writes the Claude Code subagents `road-worker` and `road-reviewer`; lint rules 17-20. 75 model-free tests on WSL (Node 24); not checked: live sessions, Windows and CI.
- `references/executors.md` (new): building or reviewing the list of agents and executors with the owner («давай составим список агентов и исполнителей»); the skill description names this trigger.
- Repository: `roadctl limits` reads remaining subscription limits (Codex through `codex app-server` without a model, Claude through one minimal light-model request, other providers through a configured command), keeps a configurable owner's reserve (default: 10% weekly, 15% five-hour), `--check` for scripts (exit 0 go, 1 reserve reached, 3 unknown) and `--confirm` for the owner. 87 model-free tests; checked live on WSL.
- Repository: `roadctl tick --as AGENT`, a model-free first step for a scheduled orchestrator: pulls the boards, lists work for the agent (take, accept, start, stale), checks limits only when there is work, prints byte-stable output (Hermes cron `--monitor-script` starts the model only when it changes), exit codes for schedulers, a per-agent lock and a local ledger (`tick --ledger`); `--prompt` gives a short instruction for the orchestrator model; examples in `examples/scheduler/` (Hermes monitor script, cron/systemd with Claude). 96 model-free tests.
- `references/autonomy.md` (new): the owner decides what goes to unattended work and what stays personal; agents change it only on the owner's explicit words. `references/board.md`: from a folder without a board, find the board of the repository actually worked on, or ask.
- Repository: autonomous or personal work (`autonomy` switch per board, approval scope `auto`, ordered `queue`; `tick` starts only the first eligible queued card; `roadctl autonomy`, `auto`, `queue`); finding the board (`where [path]` explains and lists known boards, global `--project NAME`, a user-level board list `roadctl boards` for setups without a central workspace, registry fallback to `~/.config/road-map-journal/registry.json`). Lint rules 21-24. 113 model-free tests.
- `references/routines.md` (new): recurring project routines created with the owner; the agent, the model and the environment are required (ask, never guess); default permissions: read external systems, write the board; hand over to an orchestrator, a stronger model or the owner.
- Repository: recurring routines (`board/routines/<id>.md`; board switch `autonomy.routines`, per-routine `enabled` and approval; `tick` offers a due routine as `RUN` only to its own agent; `roadctl routine new|list|show|on|off|done`, `done` publishes the routine file itself; lint rules 25-29; examples in `examples/routines/`). 127 model-free tests.
- `references/long-running.md`: autonomous code work uses its own git worktree, passed with `claim --workdir`; reconcile it after an interruption. `references/routines.md`: optional time window.
- Repository: `tick --routine <id>` and `--kinds` (one routine as its own scheduler job, e.g. a Hermes cron job with its own model; `examples/scheduler/hermes-routine-tick.py`); routine time window `hours` (`mon-fri 09:00-19:00 tz=Europe/Moscow`); `claim --workdir` and a warning when an expired claim is taken over while that directory has uncommitted changes (`tick` marks it `(workdir dirty)`). 133 model-free tests.

## 0.4.0 — 2026-11-10

- `references/board.md`: a board may live in a central workspace outside the project; where to create new boards when the owner's instructions say so.
- Repository (not part of the installed skill): `roadctl` finds a board in a central workspace (`where`, `lint --all`, `pre-commit-all`, Stop reminder across two repositories), 33 model-free tests; Codex and Hermes hook support; `update-installed.mjs --roadctl`; `hook-install --claude --user`; `instructions-install` writes a managed block into the user-level CLAUDE.md and AGENTS.md. Hooks were checked with the hosts' own model-free tools only.

## 0.3.0 — 2026-11-10

- New `references/board.md`: how to work in a project whose plan is a card board (core links to it only when `board/config.json` exists).
- `references/long-running.md`: checkpoint, handoff, recovery after an interruption, pause and stop, permissions bound to their source, and untested delegation guidance.
- Repository (not part of the installed skill): board specification `docs/board-spec.md` with a worked example, `scripts/roadctl.mjs` with 22 model-free tests, `docs/roadctl.md`, `docs/pointer-templates.md`. No agent behavior was evaluated; the hooks were not run inside any agent.

## 0.2.0 — 2026-11-10

- Skill description rewritten to list the situations that should activate it (including Russian triggers); adds `license` and `metadata.version`.
- Long-running, acceptance, checkpoint, budget and shared-checkout rules moved from `SKILL.md` into `references/long-running.md`; the core keeps one-item scope, the distinction of recorded, pending and accepted work, checkpoints, in-flight verification and the shared-checkout rule in short form. Meaning intended unchanged; not re-evaluated.
- Repository: shorter `ROADMAP.md` with evidence in `docs/evidence-p0.md`, update instructions in `docs/updating.md`, README opening restructured, CI, `PROVENANCE.md`.

## 0.1.0

- First published skill (commit `78c8ebf`): modes, record and reconcile, status and evidence, three references.
