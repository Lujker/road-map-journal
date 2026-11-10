# Road-map Journal

**English** · [Русский](README.ru.md)

A portable [Agent Skill](https://agentskills.io/) that keeps a project's roadmap, next steps and decision history useful across AI coding sessions. It follows your project's own plan and conventions instead of replacing them.

**Install:** `npx skills add Lujker/road-map-journal --skill road-map-journal`

**Try:** ask your agent "What is next on the roadmap?" or «Что дальше по плану?»

> Early development: installation and a few short behavioral checks were done. Discovery by every agent and behavior on long-running projects are not fully verified; review changes before accepting them. See [ROADMAP.md](ROADMAP.md).

## What it does

- Finds an existing roadmap and follows the project's conventions instead of replacing them.
- Keeps the current state and next actions concise; records significant decisions and evidence separately when useful.
- Resumes work using the actual project state, and distinguishes implemented, tested and accepted work.
- Supports starting, adopting, resuming and updating a plan, plus read-only status questions.
- Uses the language already used in a project, or agrees on one with the user for a new plan.

The skill is an instruction set, not a task tracker or a guarantee that an agent will follow every rule. Its operation depends on the model, host, permissions and project instructions. It adds no service, hooks, scheduled jobs or executable helpers. An optional maintenance script lives in `scripts/` outside the skill folder and is not installed with it.

## Usage

Ask your agent, for example:

- “Adopt the existing project plan; don't change our structure.”
- “What is next on the roadmap?”
- “Continue the agreed item, but don't start another one.”
- “Record the decision and update what remains.”
- “Reconcile this item's status with the code and available evidence.”
- «Что дальше по дорожной карте?»
- «Продолжай разработку по согласованному пункту.»

When starting a new plan, the skill discusses the desired way of working and asks about decisions it cannot infer. For deeper planning it can use `grill-me` if available; otherwise it can offer to install it or continue with its own structured questions. The optional skill is not automatically installed. An ordinary read-only question should not trigger an interview or create files.

Synthetic examples in English and Russian, with expected behavior, are in [examples/](examples/README.md). They are proposed checks, not run results.

## Installation

```sh
npx skills add Lujker/road-map-journal --skill road-map-journal
```

Review the source before installation and choose the intended agent and scope when prompted. A non-interactive project-scoped installation with `--agent claude-code --yes --copy` was tested in WSL. Separate user-scope discovery and explicitly invoked skill-use checks were performed on selected Claude Code and Codex installations; they do not establish automatic activation or compatibility on every host.

For a manual installation, copy the **entire** `skills/road-map-journal/` directory, including `references/`, into the skill directory documented by your agent. Installing the files alone does not establish that the agent discovers or follows them.

**Updating** is a manual, per-host action; reinstalling can overwrite local edits. See [docs/updating.md](docs/updating.md), including an optional update script.

## Layout

```text
skills/road-map-journal/
├── SKILL.md
└── references/
    ├── long-running.md
    ├── multi-repo-sync.md
    ├── scenarios.md
    └── templates.md
```

The source skill is model-neutral. A particular agent may have different discovery rules or tooling. Project and user instructions take precedence over the skill's defaults.

## Development and limitations

See [ROADMAP.md](ROADMAP.md) for the plan, [CHANGELOG.md](CHANGELOG.md) for releases and [evaluation scenarios](evals/scenarios.md) for proposed behavioral checks. Those scenarios are not results. No superiority over alternatives or cross-agent compatibility is claimed without comparable tests.

See [PROVENANCE.md](PROVENANCE.md) for the origin of the repository's material. Issues and contributions are welcome. Do not include private project plans, tokens, customer information or session transcripts in reports. The public draft is available under the [MIT License](LICENSE). Do not copy substantial third-party material without compatible permissions and attribution.
