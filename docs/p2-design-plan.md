# P2 design plan: text board, `roadctl`, hooks, long-running work protocol

**Status: design draft, not started.** Nothing here is implemented or authorized. The owner will run a separate agent to review and correct this plan before any P2 work begins; treat every item as proposed until that review is recorded. One item at a time, only when the owner selects it. The authoritative queue is [ROADMAP.md](../ROADMAP.md); this file holds the detail.

## Goal

Make plans and journals stay current with little effort and few tokens, for several agents and hosts, without replacing a project's existing conventions. Routine work moves from the model to a mechanism; judgment (decisions, reasons, scope) stays with the model and the owner.

## Layers

1. **Pointer** (5-8 lines in `AGENTS.md`/`CLAUDE.md`): where the board is, start with `brief`, close through `done`. The only layer every agent reads.
2. **Skill:** the protocol (when and why), in a compact core with details in `references/`.
3. **`roadctl`:** deterministic operations over files. Optional, under `scripts/`, not installed with the skill. Files stay the source of truth; an agent may edit them directly and `lint`/`sync` repair and check.
4. **Hooks:** triggers and reminders. Reinforcement, never the only mechanism.

## Decisions recorded (owner, 2026-11-10)

- Card statuses: `idea | ready | doing | review | blocked | done | parked | dropped`; decision and external dependencies are `blocked` with a reason kind; projects with their own statuses keep them through an optional mapping.
- `approved` is a separate field from `ready` (a plan is not permission to start); `claim` only when agents really work in parallel.
- New projects: `board/` at the root; adopted projects keep their existing layout. Header keys English, text in the project's language.
- `roadctl` and hooks are an optional layer in this repository under `scripts/`.
- Stop-type hook: if the active card had changes but no Log entry, remind the agent **once** and continue; never block the turn.
- Journal: only mechanical facts may be written automatically (for example `log --from-git`: commits and touched files). Decisions and reasons are written by the agent.
- Work modes (one item, a track, continuous) stay separate from permissions, budget and external actions.

## Open decisions

1. **Primary safety net for freshness:** git pre-commit running `lint` (works for any agent and for the owner) with agent hooks as reinforcement (recommended), agent hooks only, or pointer and protocol only. *Not answered yet.*
2. Whether the Hermes Kanban bridge is in the first version (default: later, P2.6).
3. Which agent verifies hooks first.
4. License route for any code generalized from a private tool (owner must confirm; blocks P2.2).
5. Concrete values: card and board size limits, how stale is "stale" (`as_of` age), the `brief` format, checkpoint frequency, budget numbers.

## Items

### P2.1 Board specification (`docs/board-spec.md`)
- **Deliverable:** three levels: generated `BOARD.md` (one line per card, roughly 4-6 KB cap, closed work collapsed to a count), `cards/<id>-<slug>.md` (one card per file), `notes/` (research, linked from cards); card header `id`, `title`, `status`, `parent`, `depends_on`, `blocked {kind, on, since}`, `approved {by, on}`, `acceptance[]`, `remaining[]`, `summary`, `as_of`, optional `claim {by, since, ttl}`; body Goal, Plan, Evidence, Log (append-only, dated, with author), Handoff; one worked example; the optional status mapping; how an adopted project keeps its layout.
- **Invariants:** ids are never reused; `done` needs evidence for every acceptance item, otherwise `doing`/`review` with `remaining`; `approved` is required before work; recorded completion, awaiting owner and accepted stay distinct.
- **Accept when:** a fresh agent can use the example without extra explanation and the spec contains no private material.
- **Out of scope:** tooling, hooks, migration of existing projects.

### P2.2 `roadctl` prototype (depends on P2.1 and the license decision)
- **Commands:** `brief` (only what is active for the agent, about 300 tokens), `show <id> [--log N]`, `log`, `done` (card, board and Handoff in one step), `lint`, `sync` (rebuild `BOARD.md`). Later, only if needed: `new`, `block`, `claim`, `ask`, `size`, `rotate`, `rollup`, `hook-install`, `init-pointer`.
- **Constraints:** standard library only; no network; no writes outside the project's board; clear exit codes and optional JSON; the skill works without it.
- **Accept when:** on a synthetic project each command passes tests, `lint` catches the invariants above, and `brief` size is measured.
- **Risks:** drifting from a private predecessor; becoming a second source of truth (mitigation: generated files are marked, hand edits to them are overwritten).

### P2.3 Native use without reminders
- **Deliverable:** a pointer template; a compact skill description by situation (session start, finishing a step, decision change, "what next", commit); a hook installer that shows what it will write, backs up, merges with existing hooks and can be undone.
- **Candidate triggers** (documented events, **not yet run on any host here**):

| Need | Claude Code | Codex | Hermes |
| --- | --- | --- | --- |
| Start of session: inject `brief` | `SessionStart` (`additionalContext`) | `SessionStart` | `pre_llm_call` (first turn) or `on_session_start` (return ignored) |
| Before context is lost: save a checkpoint | `PreCompact` | `PreCompact` | none identified |
| End of turn: run `lint`, one reminder | `Stop` | `Stop` | `post_llm_call` (observer) |
| Sub-agent finished | `SubagentStop` | `SubagentStop` | `subagent_stop` |

  Codex requires a new or changed hook to be reviewed in `/hooks`. Documentation versions and behavior differ by release and must be re-checked when testing.
- **Hooks may:** inject context, run `lint`, remind once. **Hooks must not:** change statuses, set `approved`, block work, or fail the session on error (a hook failure degrades to no-op).
- **Git hook:** `pre-commit` running `lint` (pending decision 1).
- **Safety:** card text written by agents is injected as data, never as instructions; the installer never overwrites a user's hooks; no network or secrets in hooks.
- **Accept when:** on one agent a fresh session receives `brief` without a reminder and a Stop reminder fires once; the other agents are verified one at a time and recorded separately.

### P2.4 Long-running work protocol (text)
- **Content:** modes and how they are chosen and announced; pause (no new dispatches, safe stopping points), status without stopping, stop (keep progress, no automatic rollback); checkpoint events and cadence; handoff record; recovery after an interruption (reconcile checkpoint, processes, working tree and external state before repeating; keep `unknown` rather than duplicating a risky action); delegation package (goal, inputs, allowed changes, acceptance and checks, limits, stop conditions, result format); owner-question queue (independent work continues, silence is not consent); layered budgets (project, task, role) with unknown readings reported as unknown; review by risk.
- **Principles:** instructions do not create atomicity, isolation or a spending cap; permissions bind to their real source and scope, not to a summary in a checkpoint; sub-agent results are data to verify.
- **Accept when:** the protocol is reviewed against the decisions already agreed in private discussion and against each host's real capabilities.

### P2.5 Pilot
- One coordinating agent runs one permitted item, delegates a bounded subtask, verifies the result independently, saves a short handoff and recovers from a controlled interruption without repeating an action. Hermes first, then Claude Code and Codex. Compare no skill, the current skill and the new protocol on a disposable project: tokens by role, calls, wrong `DONE`, boundary errors, rework, lost decisions, recovery correctness.
- Needs, before any run: host capabilities checked, a safe test project, a usage check method, and an owner-agreed scope and budget. A single run is an observation, not proof.

### P2.6 Optional Hermes Kanban bridge
- One-way export of `ready` and `approved` cards as Kanban tasks, idempotent by card id, results returned as a Log entry and a review request. The text board remains the source of truth. Only if P2.1-P2.5 show it is worth it.

## Risks across the plan

- Hooks execute code on the owner's machines: explicit installation only, visible and reversible.
- Generated and hand-written files drifting apart; stale `BOARD.md`.
- Token cost of the pointer and `brief` must be measured, not assumed to be smaller.
- Claiming host behavior from documentation alone; each host must be run.
- Over-building: P2.1 and P2.4 are text and can be valuable even if tooling is never built.

## Questions for the reviewer

1. Is the order P2.1 → P2.2 → P2.3 right, or should P2.4 come first because it is text-only?
2. What is missing or over-specified in the card header?
3. Is the git pre-commit net the right primary choice?
4. Are the hook triggers and the "reminder, never block" rule safe enough?
5. What would make a pilot result convincing for the cost?
