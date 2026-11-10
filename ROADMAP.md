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
**Status: PARTIAL.** MIT; origin of each part is in [PROVENANCE.md](PROVENANCE.md). Remaining: the owner confirms how `assets/logo.png` was made and that it may be published under the repository license. Decision: any `roadctl` will be written independently from the public specification; code from private tools is not used.

### P1.1 — Learn from real projects
**Status: OPEN.** The owner tests the skill on real projects; fix cases where it rewrites conventions, loses decisions or misstates verification. Observed failures should be written down as cases (situation, what happened, what should have happened).

### P1.2 — Improve international onboarding
**Status: DONE (limited).** [README.ru.md](README.ru.md) and three synthetic [examples](examples/README.md) were drafted by an agent; checked only for structure, no native-reader review, examples not run. No further languages planned.

### P1.3 — Skill core cleanup and first release
**Status: DONE (limited).** Released as 0.2.0 (tag `v0.2.0`): long-running rules moved into `references/long-running.md`, new skill description, version in the frontmatter, [CHANGELOG](CHANGELOG.md), CI (passing), shorter roadmap and README opening. Applied to three hosts, see P0.2. Meaning of the moved rules is intended unchanged; behavior and activation were not re-evaluated (that is P1.1 and the first P2.3 check).

### P2 — Long-running work and a text board
**Status: DESIGN, not started.** Plan: [docs/p2-design-plan.md](docs/p2-design-plan.md); review: [docs/p2-plan-review.md](docs/p2-plan-review.md). Corrections from the review and open discussions must be completed before any P2 item starts. Items P2.1–P2.6 are listed in the plan; each starts only when the owner selects it.

## Queue

P1.1 (owner) → owner confirmation for P0.3 → P2 plan corrections → P2 items one at a time. P0.1 broader coverage stays deferred.
