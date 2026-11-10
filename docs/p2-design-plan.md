# P2 design plan: text board, `roadctl`, hooks, long-running work protocol

**Status: design v2; P2.1–P2.4a done (limited) on 2026-11-10, see the outcome section at the end.** Revised on 2026-11-10 after the review in [p2-plan-review.md](p2-plan-review.md); the disposition of every review point is at the end. Nothing here is implemented or authorized. Each item starts only when the owner selects it, one at a time. The authoritative queue is [ROADMAP.md](../ROADMAP.md); this file holds the detail.

## Goal

Make plans and journals stay current with little effort and few tokens, for several agents and hosts, without replacing a project's conventions. Routine bookkeeping moves from the model to a mechanism; judgment (decisions, reasons, scope) stays with the model and the owner. The largest danger is building a planning framework where several exist; the value of this skill is its evidence and scope discipline, so P2 must stay as small as its tiers allow.

## Tiers (each usable without the next)

| Tier | What it is | Needs |
| --- | --- | --- |
| 0 | The skill, any layout | nothing |
| 1 | Board format as a text convention, cards edited by hand | nothing |
| 2 | `roadctl` | a runtime and a known path |
| 3 | Hooks and a git hook | tier 2 and a supporting host |

- **Pointer** (5-8 lines in `AGENTS.md`/`CLAUDE.md`) has one variant per tier: tier 1 says where the board is and which card sections to update; only tier 2 mentions `brief` and `done`.
- **Adopted projects:** tiers 2 and 3 apply to board-format projects. A project whose plan is one file stays at tier 0 or migrates with consent. A small config file (`board_version`, board path, status mapping) covers a board that lives outside `board/`.
- **Distribution of `roadctl`:** one vendored file with a version line; `lint` warns when the board format is newer than the tool. Hooks need a stable path.
- **Implementation language:** Node (already required by the `skills` CLI and used by `scripts/`; `node:test`); standard library only; Windows tested from the first command. Confirmed by the owner 2026-11-10.

## Decisions recorded (owner, 2026-11-10)

- Statuses: `idea | ready | doing | review | blocked | done | parked | dropped`; decision and external dependencies are `blocked` with a reason kind; projects with their own statuses keep them through an optional mapping.
- `approved` is separate from `ready`; `claim` only when agents really work in parallel.
- New projects: `board/` at the root; adopted projects keep their layout. Header keys English, text in the project's language.
- `roadctl` and hooks are an optional layer under `scripts/`, not installed with the skill, **written independently from the public specification; code from private tools is not used** (removes the license blocker).
- Stop-type hook: remind once and continue; never block the turn.
- Git facts are **not copied into cards**: `brief` and `show` display recent commits on demand, and Log entries cite commit ids. Decisions and reasons are written by the agent.
- Work modes (one item, a track, continuous) are separate from permissions, budget and external actions.
- P2 does **not** wait for a log of observed failures. Cases from P1.1 are used as test fixtures when they exist.
- Closing P1.3 (skill core cleanup and release 0.2.0) comes before P1.1 and P2.
- **Freshness net (confirmed 2026-11-10):** git pre-commit `lint` (errors block a commit, warnings never do) plus agent hooks as reinforcement; without git, tiers 0-1 remain.
- **Host for the first hook test and for the pilot (confirmed 2026-11-10):** Claude Code on Home WSL, one host for both.

## Open decisions

1. Hermes Kanban bridge in the first version (default: no, P2.6).
2. Defaults for size caps, `as_of` staleness, `brief` format, checkpoint cadence and budgets: set in P2.1/P2.4 with a one-line reason each, all configurable.

Closed on 2026-11-10: freshness net, implementation language, host for hook test and pilot (see Decisions recorded).

## Order of work (revised)

1. **P2.1**, reduced: format, flat header, invariants, one example.
2. **Pointer only** (text part of P2.3) used on this repository and one real project: tests tiers 0-1 and checks activation at no tooling cost.
3. **P2.2** in the order `lint`, `sync`, `brief`, then `done`, `log`, `show`.
4. **Hooks** (rest of P2.3) on one host.
5. **P2.4a**, then a narrow **P2.5** pilot.
6. **P2.4b** and **P2.6** only if the pilot shows a need.

## Items

### P2.1 Board specification (`docs/board-spec.md`)
- **Levels:** generated `BOARD.md` (committed, one line per card, size cap, generation time printed, closed cards collapsed to a count but their files stay put); `cards/<id>-<slug>.md`, one card per file; `notes/`.
- **Header: flat `key: value` scalars only**, so a standard-library parser is enough: `id`, `title`, `status`, `depends_on` (comma list), `blocked` (`kind: reason`), `approved`, `accepted`, `as_of`. Lists live in the body as Markdown checklists. Dropped from v1: `summary`, `parent`, `claim`, `rank`.
- **Body:** Goal, Plan, Acceptance (checklist, each criterion has an id `a1`, `a2`), Evidence (names the criterion ids it covers), Log (append-only, dated, author, cites commit ids), Handoff.
- **Statuses and completion:** `review` means the agent recorded completion and the owner has not accepted; `done` means accepted (requires `accepted: <by>, <date>`). Mapping of the skill's PARTIAL and of "DONE (limited)" is specified; no recorded state may be lost in a mapping.
- **`approved`** is the record of an approval given elsewhere, with a scope (analysis, implementation, external actions) and, when one exists, a source such as the commit that set it. An agent never sets it for itself; a material change to the acceptance criteria clears it. `lint` checks form only; where the owner commits approvals personally, `lint` may optionally check the author of the introducing commit.
- **`as_of`** means "date the status was last checked against reality"; `log` and `done` set it; `lint` compares it with the last Log entry.
- **Ids** are opaque unique strings; an adopted project keeps its ids; `lint` reports duplicates, resolved at merge.
- **Merges:** one writer per card (no `claim` yet); if parallel writing becomes real, move the Log to its own file with a union merge driver. Over the size cap, collapse `idea` and `parked` to counts first, then `ready`.
- **Acceptance test:** a fresh session given only the spec and the example (1) says what is next, (2) adds a Log entry, (3) refuses to close a card whose criterion lacks evidence. Checked by hand until `lint` exists; one run is an observation.
- **Out of scope:** tooling, hooks, migration of existing projects.

### P2.2 `roadctl` prototype
- **Commands by value:** `lint` and `sync` (the net; `lint` includes `sync --check`), then `brief` (token saving), then `done` and `log`, then `show`. `done` refuses and names the missing criteria; it never downgrades or rewrites silently.
- **`brief`:** emits only header fields with length caps and stripped markup, never Log or body text. Measured against a stated project size (for example 50+ items); on a small roadmap the saving is small.
- **`lint` findings:** *errors* (unparseable header, duplicate id, `done` without evidence references or `accepted`, board out of sync) block a commit; *warnings* (stale `as_of`, several `doing` cards, missing Log entry) never do. `lint` proves that a reference exists, not that evidence is true.
- **Constraints:** standard library only, no network, no writes outside the project's board, exit codes and optional JSON; the skill works without it. Written independently from the public spec.
- **Accept when:** on a synthetic project each command passes tests on Linux and Windows and the invariants above are caught.

### P2.3 Native use without reminders
- **First check (needs no tooling): activation.** Whether a host loads the skill on "continue the work" without the word roadmap. Overlaps the deferred part of P0.1.
- **Pointer:** one variant per tier. **Skill description** by situation (done in release 0.2.0; to be re-measured).
- **Hooks** (documentation-level candidates, **none run yet**; each cell is marked with its source and must be re-checked when tested):

| Need | Claude Code | Codex | Hermes |
| --- | --- | --- | --- |
| Start of session: inject `brief` | `SessionStart` (`additionalContext`), docs | `SessionStart`, docs | `pre_llm_call` first turn; `on_session_start` ignores output; docs |
| After compaction: re-inject `brief` | `PostCompact` exists in docs; `SessionStart` with source `compact` not confirmed for Claude | `SessionStart` source `compact`, docs | none identified |
| Before compaction | `PreCompact`: stdout (up to 10,000 characters) is used as instructions for the compaction summary, so it can ask that the active card and decisions be preserved; it cannot make the model write a file; docs | `PreCompact`, docs | none identified |
| End of turn: quick check, one reminder | `Stop` | `Stop` | `post_llm_call` (observer) |
| Sub-agent finished | `SubagentStop` | `SubagentStop` | `subagent_stop` |

- **Stop rule, exactly:** a Stop hook may continue the turn **at most once** with `hookSpecificOutput.additionalContext` (shown as hook feedback, not as an error); it never loops, never blocks, never fails the session. The condition is strict and cheap: the single `doing` card has file changes and no Log entry since the last reminder (a marker file stores that the reminder was sent). With zero or several `doing` cards the hook stays silent. Stop fires after every turn, so the check is one quick git query, not a parse of the board. Claude Code documents a cap of eight consecutive continuations; the plan relies on its own once-only guard, not on that cap.
- **Hooks may:** inject context, run `lint`, remind once. **Hooks must not:** change statuses, set `approved`, block work, or fail on error (a failure degrades to a no-op).
- **Where hooks are written:** the user's local, uncommitted settings by default; the installer shows what it will write, backs up, merges with existing hooks and can be undone. A committed project settings file would change every collaborator's environment and needs explicit consent. Codex requires reviewing a new or changed hook in `/hooks`.
- **Injection:** agent-written card text reaches the model as context and cannot be made safe by wording; `brief` therefore emits only capped header fields. In a repository that accepts outside contributions, card files are an injection path.
- **Git hook:** `pre-commit` running `lint` (decided 2026-11-10).
- **Accept when:** on one host a fresh session receives `brief` without a reminder and the Stop reminder fires once; other hosts are verified one at a time and recorded separately.

### P2.4 Long-running work protocol (text), split
- **Move first:** the long-running rules already live in `references/long-running.md` (release 0.2.0); P2.4 extends that file instead of growing the core.
- **P2.4a (single agent, needed first):** checkpoint, handoff, recovery after an interruption, unknown outcomes (keep `unknown`, do not repeat a risky action).
- **P2.4b (multi-agent, only if the pilot goes there):** delegation package (goal, inputs, allowed changes, acceptance and checks, limits, stop conditions, result format), owner-question queue (independent work continues; silence is not consent), layered budgets (project, task, role; unknown readings reported as unknown), review by risk.
- **Principles:** instructions do not create atomicity, isolation or a spending cap; permissions bind to their real source and scope, not to a summary in a checkpoint; sub-agent results are data to verify.
- **Accept when:** the text covers each decision in the "Decisions recorded" section above and each rule is testable by a seeded case. (The earlier criterion about private discussions could not be checked from this repository and was dropped.)

### P2.5 Pilot
- **Scenarios built to discriminate** (seeded traps): an interruption after a non-repeatable action; a sub-agent reporting success falsely; a plan that says done while a criterion is unmet; a session that crosses compaction. Cases from P1.1 are used when available.
- **Outcomes, binary first:** wrong `DONE`, action repeated after interruption, unapproved item started. Token totals are secondary; "rework" and "lost decisions" are too soft for single runs.
- **Design:** one host (the same as the hook test), at least three to five runs per condition (no skill, current skill, new protocol), an inexpensive model, and the pass threshold written down before the first run.
- **Needs before any run:** host capabilities checked, a safe disposable project, a usage-check method, an owner-agreed scope and budget. One run is an observation, not proof.

### P2.6 Optional Hermes Kanban bridge
- One-way export of `ready` and `approved` cards as Kanban tasks, idempotent by card id, results returned as a Log entry and a review request; the text board stays the source of truth. Only if P2.1-P2.5 show it is worth it.

## Risks

- Hooks execute code on the owner's machines: explicit, visible, reversible installation only.
- Generated and hand-written files drifting apart; a stale `BOARD.md`.
- Token cost of the pointer and `brief` must be measured, not assumed to be smaller.
- Host behavior claimed from documentation alone; every host must be run.
- Over-building: P2.1 and P2.4 are text and are worth having even if tooling is never built.

## Review disposition (review of 2026-11-10, commit `17cc1a2`)

| Review point | Disposition |
| --- | --- |
| 2 Evidence before mechanism | **Owner declined to gate P2** on a failure log. Kept: P1.1 cases become fixtures when they exist. |
| 3.1 Tiers, pointer per tier, distribution, language, adopted projects | Accepted; Node confirmed by the owner 2026-11-10. |
| 3.2 Header format, acceptance ids, completion states, `as_of`, ids, closed cards, version | Accepted; dropped `summary`, `parent`, `claim`, `rank` from v1. |
| 3.3 `approved` as a record | Accepted. |
| 3.4 Board generation and merges | Accepted. |
| 3.5 P2.1 acceptance test | Accepted. |
| 4 Freshness net, error/warning split | Accepted; confirmed by the owner 2026-11-10. |
| 4 Stop reminder wording | Accepted. Of the review's claims I verified the documented eight-continuation cap and `additionalContext`; `stop_hook_active` is not in the current docs, so the plan uses its own once-only guard. |
| 4 "`PreCompact` cannot save a checkpoint" | **Partly incorrect:** docs say its stdout becomes instructions for the compaction summary; it still cannot make the model write a file. `PostCompact` also exists. Table corrected. |
| 4 Hook location, injection surface, trigger-table sourcing, activation first | Accepted. |
| 5 Independent `roadctl`; command order; derive git; `done` refuses; measure; Windows | Accepted. Derive-git was confirmed by the owner (changes the earlier `log --from-git` decision). Independent implementation confirmed by the owner. |
| 6 P2.4 split and criterion; pilot design; one host | Accepted. |
| 7 Order of work | Accepted with the review's step 1 (failure log) removed per the owner. |
| 8 Weaknesses and cheap improvements | Done in P1.3: shorter ROADMAP, README opening, long-running rules moved out of the core, version, changelog, tags, CI. Logo: P0.3, owner. Update-script isolated-home checks as tests: not done. |
| 9 Open-decision table | Reflected in "Open decisions". |

## Outcome (2026-11-10)

Done by the owner's instruction, in the plan's order, with the owner's decision that tests with a model are not run:

- **P2.1** `docs/board-spec.md` and `examples/board-example/` (the example passes `lint`).
- **P2.2** `scripts/roadctl.mjs` (lint, sync, brief, show, log, review, done, approve, new), 22 model-free tests on WSL and Windows, in CI.
- **P2.3** pointer templates, `references/board.md`, hook commands, installers for Claude Code (local settings) and git pre-commit. Hooks were exercised only with simulated events and a temporary git repository.
- **P2.4a** checkpoint, handoff, recovery text in `references/long-running.md`; delegation guidance included, untested.
- **Not done / not planned:** real hook firing in any agent; activation check; pilot (P2.5); P2.4b as separate work; Kanban bridge (P2.6); installers for Codex and Hermes; lint rules 15 and 16.
