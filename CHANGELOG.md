# Changelog

Skill versions follow `metadata.version` in `skills/road-map-journal/SKILL.md`. Behavior was not re-evaluated for any release; see [ROADMAP.md](ROADMAP.md).

## 0.4.0 — 2026-11-10

- `references/board.md`: a board may live in a central workspace outside the project; where to create new boards when the owner's instructions say so.
- Repository (not part of the installed skill): `roadctl` finds a board in a central workspace (`where`, `lint --all`, `pre-commit-all`, Stop reminder across two repositories), 31 model-free tests; Codex and Hermes hook support; `update-installed.mjs --roadctl`; `hook-install --claude --user`; `instructions-install` writes a managed block into the user-level CLAUDE.md and AGENTS.md. Hooks were checked with the hosts' own model-free tools only.

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
