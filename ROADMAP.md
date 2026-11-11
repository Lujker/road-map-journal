# Roadmap

The project's current development plan, not a promise of delivery dates. Evidence for P0 is in [docs/evidence-p0.md](docs/evidence-p0.md). Documentation validation does not prove an agent follows the skill.

## Current state

The portable skill, documentation in English and Russian, an update script and proposed evaluation scenarios are published. Installation, discovery and explicitly requested skill use were checked on several hosts; automatic activation, behavior on long-running projects and independent user feedback remain open.

## Items

### P0.1 — Verify real agent behavior
**Status: PARTIAL — short comparison complete; broader coverage deferred.** On three hosts the short checks gave correct answers with and without the skill, so they show no benefit and do not establish reliability, native activation or effect on long tasks. Remaining scenarios in [evals/scenarios.md](evals/scenarios.md) are deferred, not passed; any future evaluation targets long-running work with a separately agreed scope and budget. [Evidence](docs/evidence-p0.md).

### P0.2 — Verify installation and discovery
**Status: DONE (limited).** Installation, discovery, a per-host update script and removal of a conflicting account-synced Claude copy were checked, model-free, on Home WSL, Windows and the laptop (report-only on the real installs; changed-version updates in isolated homes). Updating is manual by design: the script or the targeted `npx skills` command, see [docs/updating.md](docs/updating.md). The first real changed-version update (release 0.2.0) was applied with the script on Home WSL, the laptop and Windows and verified at file level, with Claude Code listing the skill on all three; Hermes loaded the new reference on Windows and Codex discovery was checked only in an isolated home. Limits: Hermes layouts on other hosts are unverified; agent behavior with 0.2.0 was not re-evaluated. [Evidence](docs/evidence-p0.md).

### P0.3 — Establish provenance and license
**Status: DONE (limited).** MIT; origin of each part is in [PROVENANCE.md](PROVENANCE.md). The owner confirmed on 2026-11-10 that `assets/logo.png` is the owner's own work with rights to publish it under MIT; the tool and method are not recorded. Decision: any `roadctl` is written independently from the public specification; code from private tools is not used. Contributions from others still need review when they arrive.

### P1.1 — Learn from real projects
**Status: OPEN.** The owner tests the skill on real projects; fix cases where it rewrites conventions, loses decisions or misstates verification. Observed failures should be written down as cases (situation, what happened, what should have happened).

### P1.2 — Improve international onboarding
**Status: DONE (limited).** [README.ru.md](README.ru.md) and three synthetic [examples](examples/README.md) were drafted by an agent; checked only for structure, no native-reader review, examples not run. No further languages planned.

### P1.3 — Skill core cleanup and first release
**Status: DONE (limited).** Released as 0.2.0 (tag `v0.2.0`): long-running rules moved into `references/long-running.md`, new skill description, version in the frontmatter, [CHANGELOG](CHANGELOG.md), CI (passing), shorter roadmap and README opening. Applied to three hosts, see P0.2. Meaning of the moved rules is intended unchanged; behavior and activation were not re-evaluated (that is P1.1 and the first P2.3 check).

### P2 — Long-running work and a text board
**Status: DONE (limited) for P2.1–P2.4a; P2.4b, P2.5 and P2.6 are not planned.** Plan: [docs/p2-design-plan.md](docs/p2-design-plan.md), revised after the [review](docs/p2-plan-review.md). Owner decision 2026-11-10: tests with a model are not run; only utilities with code are tested, and problems are fixed as they appear in use.

- **P2.1 — Board specification:** [docs/board-spec.md](docs/board-spec.md) with a worked example in `examples/board-example/`. The example passes the tool's lint.
- **P2.2 — `roadctl`:** [scripts/roadctl.mjs](scripts/roadctl.mjs), documented in [docs/roadctl.md](docs/roadctl.md); 33 model-free tests pass on WSL (Node 24) and Windows (Node 26) and run in CI. History-based lint rules 15 and 16 are not implemented.
- **P2.3 — Native use:** [pointer templates](docs/pointer-templates.md), `references/board.md` in the skill, hook commands and installers for Claude Code (local settings), Codex (user-level `hooks.json`), Hermes (`config.yaml` block) and git pre-commit. The Codex and Hermes hooks are installed on the owner's hosts and accepted by those tools' own model-free checks (`hooks/list`, `hermes hooks test`), but wait for the owner's trust or approval. **Not verified:** the hooks firing inside a live session in Claude Code, Codex or Hermes, skill activation without the word "roadmap", and any agent behavior. Codex and Hermes also need your one-time trust or approval of the hook.
- **P2.4 — Protocol text:** P2.4a (checkpoint, handoff, recovery, pause and stop, permissions) is in `references/long-running.md`; short delegation guidance is included but untested. P2.4b as a separate piece of work is not planned.
- **P2.5 — Pilot:** not planned (needs model runs; owner decision above).
- **P2.6 — Kanban bridge:** not planned; reconsider only if needed.

Released as skill 0.3.0, see [CHANGELOG](CHANGELOG.md).

### P3 — Autonomous operation and observation
**Status: OPEN (planned 2026-11-10 after the owner's first use).** Short sessions (status and plan questions) worked well. Observed gaps: the agent asks the owner before committing and pushing its own board changes, does not pull other agents' changes before writing, and there is no agent-free way to see cards and statuses across projects. Tools, hooks, automation and long sessions are untested in real use; the checks are in [docs/live-testing.ru.md](docs/live-testing.ru.md). Owner decision 2026-11-10: tests with a model are still not run by the agent; the owner runs the live checks.

- **P3.1 — Overview without an agent:** `roadctl status [--all]`, `list --status`, `next`, `--json` for `brief` and `show`. **Status: PARTIAL.** Implemented and tested without a model (2026-11-10); remaining: the owner's check on the real workspace.
- **P3.2 — Synchronization with the server:** `roadctl pull` and `save` (pull before the first write; commit only the board's paths, lint first, push; stop on conflicts), opt-in `autosync` (`board/config.json` or `ROADCTL_AUTOSYNC`) for the SessionStart and Stop hooks, and sync state in the `SessionStart` brief and in `status`. **Status: PARTIAL.** Implemented and tested without a model against a local bare repository (2026-11-10); remaining: the owner's check in live sessions. Autosync is off by default, so the rule that hooks change nothing still holds unless the owner opts in.
- **P3.3 — Autonomous recording of board changes:** a scoped exception to "commit only when the owner asks" for the board files this skill writes. **Status: PARTIAL.** Done: the instruction block (`roadctl instructions-install`) and the owner's `~/.claude/CLAUDE.md`, 2026-11-10. Also done in the repository: the mention in `references/board.md`, and the generator names `roadctl pull` and `save`. The installed `roadctl` copy was updated and the block was applied to the owner's `CLAUDE.md` (2026-11-10). Remaining: the Codex `AGENTS.md` (owner's choice) and the owner's check that agents stop asking (scenario C8).
- **P3.4 — Live checks by the owner:** tools, hooks inside real sessions, synchronization and long sessions, per [docs/live-testing.ru.md](docs/live-testing.ru.md). **Status: OPEN** (owner's work; no agent runs).

### P4 — Usability and delegation
**Status: OPEN (planned 2026-11-11).** A `roadctl` command on PATH (`~/.local/bin/roadctl`, a small launcher for the installed copy) was set up on the owner's WSL machines on 2026-11-11.

- **P4.1 — Clear help for people and agents:** `roadctl help` and `roadctl help <command>`: what each command is for, whether it only reads or changes files, examples for one project and for all projects, and a short section for agents (what they may run without asking, what only the owner does). **Status: DONE** (implemented and accepted by the owner 2026-11-11).
- **P4.2 — Orchestration and delegation through the board:** one provider-neutral mechanism for handing a card or a criterion to another agent (Claude Code, Codex, Hermes, a script or a scheduled job) and taking the result back, based on Anthropic's orchestrator-workers guidance and the hosts' own sub-agent mechanisms. Replaces the parked P2.4b. Design agreed with the owner on 2026-11-11: any agent can orchestrate for a given task; the delegation lives in the card itself (flat header fields plus a `Delegation` section, one delegation per card at a time); hand-off by push (the delegating agent starts the worker with its host's mechanism) or by pull (a worker or a scheduled job claims open delegations through git, with a lease); a script or a scheduled job can delegate but cannot accept; only an agent that verifies the evidence moves a card to `review`, and only the owner marks it `done`. **Status: PARTIAL.** Implemented and tested without a model (2026-11-11): `delegate`, `undelegate`, `tasks`, `claim`, `report`, `accept`, `return`, an optional executor registry, Claude Code subagents through `agents-install`; remaining: the owner's check in live sessions.
- **P4.3 — Subscription limits and the owner's reserve:** `roadctl limits` reads each provider's remaining limits without a model where possible (Codex: `codex app-server` `account/rateLimits/read`; Claude Code: the `rate_limit_event` of one minimal request to a light model, checked 2026-11-11) and through a configurable command for other providers (Hermes, Kimi, Z.ai and others later). Default reserve for subscriptions, configurable: keep 10% of the weekly and 15% of the five-hour limit for the owner. An unknown limit is first checked by one light-model request; if it stays unknown, nothing starts automatically until the owner confirms. Every automatic start is recorded with the limits seen before it. **Status: PARTIAL.** Implemented and checked live on WSL (2026-11-11); remaining: a live check on the laptop.
- **P4.4 — Scheduled orchestrator:** `roadctl tick` run by any scheduler (Hermes cron, systemd timer, Windows Task Scheduler) for any agent in the registry. A model-free first step pulls the board, collects work (open delegations this agent can take, results to accept, expired leases, approved ready cards) and checks the limits; a model is started only when there is work and the reserve allows it, with a short JSON input and turn, time and effort limits. One orchestrator at a time; never `approve`, `done` or external actions outside the approved scope. **Status: IDEA** (after P4.2 and P4.3).
- **P4.5 — Hermes as orchestrator and launcher:** how Hermes's subscriptions and API keys report limits and how it starts other agents. **Status: IDEA** (separate discussion).
- **P4.6 — Research: a general launcher:** whether `roadctl` should grow into a scheduler with a TUI and scenarios that may run without any model, or reuse an existing tool. Candidates to review: Dagu (cron and DAG workflows in YAML, one binary, web UI), Backlog.md (Markdown task board with TUI, web UI and MCP), ORCH and 5dive (agent task queues and scheduled agents), Claude Squad and agent-deck (TUI for several agent sessions), ccusage (local usage reports). **Status: IDEA.**

## Queue

P1.1 (the owner's own use, fix problems as they appear). P3.1 and P3.2 once the owner approves them; P3.4 in the owner's normal work. P0.1 broader coverage stays deferred.
