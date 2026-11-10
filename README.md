# Road-map Journal

**English** · [Русский](README.ru.md)

Keep a project's roadmap, next steps and decision history useful across AI coding sessions. A portable [Agent Skill](https://agentskills.io/) for maintaining existing plans as well as starting a new one.

> Early development: the skill has received scoped installation and short behavioral checks. Cross-agent discovery and behavior on long-running projects are not fully verified; please review changes before accepting them.

## What it does

- Finds an existing roadmap and follows the project's conventions instead of replacing them.
- Keeps the current state and next actions concise; records significant decisions and evidence separately when useful.
- Resumes work using the actual project state, and distinguishes implemented, tested and accepted work.
- Supports starting, adopting, resuming and updating a plan, plus read-only status questions.
- Uses the language already used in a project, or agrees on one with the user for a new plan.

The skill is an instruction set, not a task tracker or a guarantee that an agent will follow every rule. Its operation depends on the model, host, permissions and project instructions. The skill itself adds no service, hooks, scheduled jobs or executable helpers. An optional maintenance script for updating an installed copy lives in `scripts/` outside the skill folder; it is not installed with the skill.

## Installation

With the [skills CLI](https://github.com/vercel-labs/skills), from a project where you want the skill available:

```sh
npx skills add Lujker/road-map-journal --skill road-map-journal
```

Review the source before installation and choose the intended agent and installation scope when prompted. A non-interactive project-scoped installation with `--agent claude-code --yes --copy` was tested in WSL. Separate user-scope discovery and explicitly invoked skill-use checks have since been performed on selected Claude Code and Codex installations; they do not establish automatic activation or compatibility on every host.

For a manual installation, copy the **entire** `skills/road-map-journal/` directory, including `references/`, into the skill directory documented by your agent. Consult the agent's documentation for the correct location; installing the files alone does not establish that the agent discovers or follows them.

### Updating an existing installation

First identify the installation scope, selected agents, installed revision and any local changes. Back up or reconcile local edits before replacing files. Reinstalling with `skills add` and `--copy` can **overwrite** the selected target; never run a broad update assuming it affects only one agent or preserves customizations. For a targeted global Codex copy, for example:

```sh
npx skills add Lujker/road-map-journal --skill road-map-journal --agent codex --global --copy --yes
```

This selects Codex only; it does not update other agents or environments. Inspect the complete installed skill and `references/`, check for duplicates and verify discovery using the host's own mechanism. For other agents use their documented name and intended scope; `--global` is optional and must not be assumed for project-scoped installations. Changed-version reinstalls and one targeted `skills update` with a prepared GitHub lock were verified in isolated WSL homes; these do not establish update behavior on every host. In one isolated `skills` 1.7.6 probe, `owner/repo@<commit>` printed the requested old commit but installed current content instead; verify actual files and do not assume ref pinning works for that version. Installation and file equality alone do not prove runtime behavior.

#### Optional per-host update script

`scripts/update-installed.mjs` wraps the targeted command above for **one host**: it reports where the skill is installed (canonical `.agents` copy, Claude/Codex/Hermes links, account-synced Claude copies), compares the installed content with the published version, and, only with `--apply`, backs up the existing copies, runs the pinned `skills` CLI for the selected agents, and verifies the result. It stops on locally modified or untracked installs unless `--force` is given. It requires Node 22.20 or newer (the `skills` CLI requirement) and Git. Run it with a new-enough `node`; on a host where an older Node comes first in `PATH`, call that binary explicitly.

```sh
node scripts/update-installed.mjs            # report only
node scripts/update-installed.mjs --apply    # back up, update, verify
node --test scripts/update-installed.test.mjs
```

It does not update copies the `skills` CLI does not manage, such as skills synced from a Claude account (reported only), and it does not reload an already running agent session. Use `--agent <id>` to choose agents; Hermes is not selected by default because the CLI would create a root Hermes link that can hide a categorised one. Model-free tests in isolated homes on WSL and Windows (Node 26) covered report-only, an outdated pristine install, and a locally edited install; hosts and customized installs beyond those are untested.

## Usage

Ask your agent, for example:

- “Adopt the existing project plan; don't change our structure.”
- “What is next on the roadmap?”
- “Continue the agreed item, but don't start another one.”
- “Record the decision and update what remains.”
- “Reconcile this item's status with the code and available evidence.”
- “Что дальше по дорожной карте?”
- “Продолжай разработку по согласованному пункту.”

When starting a new plan, the skill discusses the desired way of working and asks about decisions it cannot infer. For deeper planning it can use `grill-me` if available; otherwise it can offer to install it or continue with its own structured questions. The optional skill is not automatically installed. An ordinary read-only question should not trigger an interview or create files.

Synthetic examples in English and Russian, with expected behavior, are in [examples/](examples/README.md). They are proposed checks, not run results.

## Layout

```text
skills/road-map-journal/
├── SKILL.md
└── references/
    ├── multi-repo-sync.md
    ├── scenarios.md
    └── templates.md
```

The source skill is model-neutral. A particular agent may have different skill discovery rules or tooling. Project and user instructions take precedence over the skill's defaults.

## Development and limitations

See [ROADMAP.md](ROADMAP.md) for the next development tasks and [evaluation scenarios](evals/scenarios.md) for proposed behavioral checks. Those scenarios are not results. No superiority over alternatives or cross-agent compatibility is claimed without running comparable tests.

Issues and contributions are welcome. Do not include private project plans, tokens, customer information or session transcripts in reports. The public draft is available under the [MIT License](LICENSE). Do not copy substantial third-party material without compatible permissions and attribution.
