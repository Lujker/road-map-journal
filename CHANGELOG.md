# Changelog

Skill versions follow `metadata.version` in `skills/road-map-journal/SKILL.md`. Behavior was not re-evaluated for any release; see [ROADMAP.md](ROADMAP.md).

## Unreleased

- `references/board.md`: committing and pushing board files needs the owner's standing permission; with it, `roadctl pull` before the first write and `roadctl save` after a decision, a verified result or a handoff.
- Repository (not part of the installed skill): `roadctl status`, `list`, `next` and `--json` (an overview without an agent, also across the workspace with `--all`); `roadctl pull` and `save` (merge other agents' changes, commit only the board's paths, push, never force); opt-in `autosync` for the SessionStart and Stop hooks; sync state in the session brief and in `status`; the managed instruction block states the board exception to the commit rule. 48 model-free tests; the sync tests use a local bare repository. Not checked: live sessions, a remote server over the network, Windows and CI.
- `references/board.md` and `references/long-running.md`: delegation through the board replaces the untested delegation guidance: the package lives in the card (`delegate` and `claim` headers, `## Delegation` section); push (the delegating agent starts the worker with its host's mechanism) or pull (`roadctl tasks --for`, `claim`); the result is data to verify; a script can delegate but not accept; only the owner marks a card done.
- Repository (not part of the installed skill): `roadctl help` and `help <command>` for people and agents; `roadctl delegate`, `undelegate`, `tasks`, `claim`, `report`, `accept`, `return` (claim and report commit only the card and push, git decides a race); an optional executor registry (`examples/agents-registry.example.json`); `agents-install --claude` writes the Claude Code subagents `road-worker` and `road-reviewer`; lint rules 17-20. 75 model-free tests on WSL (Node 24); not checked: live sessions, Windows and CI.

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
