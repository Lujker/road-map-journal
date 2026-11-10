# Roadmap

This is the project's current development plan, not a promise of delivery dates. Evidence and decisions belong in linked notes when needed. Documentation validation does not prove an agent follows the skill.

## Current state

The public draft defines the portable skill, documentation and proposed evaluation scenarios. Scoped installation, discovery and explicitly requested skill-use checks have been performed; automatic activation, behavior on long-running projects and independent user feedback remain open.

## Items

### P0.1 — Verify real agent behavior

**Status: PARTIAL — short comparison complete; broader coverage deferred.** The owner considers the short three-host checks sufficient for the present stage and wants the project to focus on managing long-running work, rather than proving benefit on a brief status question. The [Claude](evals/results/2026-11-10-claude-second-attempt.md), [Codex](evals/results/2026-11-10-codex-text-control.md), and [Hermes](evals/results/2026-11-10-hermes-text-comparison.md) checks produced correct answers with and without the skill; Codex and Hermes used narrower text-only harnesses. These results do not establish reliability, native activation or effectiveness on long tasks. The remaining scenarios in [evals/scenarios.md](evals/scenarios.md) and live-payload verification are not complete and are deferred, not silently accepted as passing. Further short tests are not a prerequisite for discussing the next stages; any future evaluation should target long-running work and use a separately agreed scope and budget.

### P0.2 — Verify installation and discovery

**Status: PARTIAL — installation and update workflow has priority.** A project-scoped Claude Code installation was tested in WSL. Global installation from the public repository and a no-change targeted update were tested on Windows (the `.agents` target) and WSL (Codex). Model-free WSL tests in isolated homes verified both a changed local-source update and an update from the public GitHub repository: an older source was installed, then the published version was installed with `skills add --copy` and its files matched the current source. This does not prove changed-version updates on other hosts. Installed copies may contain local additions and must not be overwritten without reconciliation. Codex app-server on WSL and Hermes on Windows have discovered installed copies; the latter warned that the symlink resolves outside its trusted skills directory, and the warning was not bypassed. A subsequent model-free native discovery probe found `road-map-journal` in Claude Code on Windows, WSL and a second WSL host, and in Codex on both WSL hosts. One explicitly invoked, short model session per installation used the native skill mechanism; Codex command events showed the user-scope file read, while Claude invocation events did not independently identify its resolved file path. All gave the basic existing-plan and optional-dependency guidance; one Claude answer incorrectly claimed the optional dependency was not relevant to adoption. Discovery and explicit invocation do not prove automatic activation or reliable long-task behavior. A per-host update script (`scripts/update-installed.mjs`: report by default, `--apply` backs up, updates and verifies) has model-free tests in isolated homes on WSL and Windows; it is not run on other hosts, has no schedule or session-reload handling, and does not cover copies the `skills` CLI does not manage. Windows needs Node 22.20 or newer (the default `npx skills` resolved to an old cached 1.5.18 under Node 20). An account-synced Claude copy of the skill (installed from a Claude account, with the same name) is not updated by `npx`; the local skill keeps the short name and the synced one loads only as `anthropic-skills:road-map-journal`; removing it requires the owner to delete it in the Claude account UI. Deployment across customized copies and other hosts remains unresolved. No long agent sessions are required for this stage.

### P0.3 — Establish provenance and license

**Status: PARTIAL.** The independently redrafted public material is offered under the MIT License. Review provenance and rights for any future contributions or material proposed from other sources.

### P1.1 — Learn from real projects

**Status: OPEN.** Invite feedback from people using existing project plans. Fix cases where the skill rewrites conventions, loses decisions or misstates verification.

### P1.2 — Improve international onboarding

**Status: OPEN.** Add and review a Russian README and representative examples in more than one language after the English workflow is validated.

## Development queue

1. **P0.1 — Real agent behavior.** Short comparison complete; broader scenarios deferred. Do not claim general reliability from these results.
2. **P0.2 — Installation and discovery.** Verify the documented path for each supported host.
3. **P0.3 — Provenance and license.** Review provenance and rights for future contributed material.
4. **P1.1 — Real project feedback.** Improve behavior from actual use.
5. **P1.2 — International onboarding.** Expand reviewed translations and examples.
