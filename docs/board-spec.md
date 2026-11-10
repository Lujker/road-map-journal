# Board specification

**Status: v1, implemented by [`scripts/roadctl.mjs`](../scripts/roadctl.mjs) (see [roadctl.md](roadctl.md)).** A text convention for keeping a project's plan as one short generated board plus one file per card. It is tier 1 of the [P2 plan](p2-design-plan.md): usable by hand, with no tool. A tool (`roadctl`, later) only checks and regenerates; files stay the source of truth and an agent or a person may edit cards directly. The acceptance test in the last section has **not** been run.

Applies to board-format projects. A project whose plan is one file with items as sections keeps its layout (tier 0) or migrates only with the owner's consent; this spec never requires that.

## Layout

```text
board/
  config.json              format version, language, status mapping, limits
  BOARD.md                 generated, one line per card, never edited by hand
  cards/<id>-<slug>.md     one card per file
  notes/                   research and design, linked from cards
```

Closed cards stay where they are (links keep working); the board collapses them to a count. `board/` is the default for new projects; an adopted project may set another path in its pointer or config.

`config.json` is plain JSON: `{"board_version": 1, "language": "ru", "status_map": {}, "limits": {"board_bytes": 6144, "doing_stale_days": 14}}`. `status_map` is optional and maps a project's own status words to the vocabulary below. `board_version` lets tools refuse to write a newer format. Defaults: 6 KB for `BOARD.md` keeps the board cheap to read each session; 14 days before a `doing` card is reported stale is a starting guess to be revised after use.

## Card file

A card is a Markdown file that begins with a header between two `---` lines, followed by fixed sections.

### Header: flat `key: value`

One key per line; the value is the rest of the line, trimmed; no nesting, no multi-line values, no quotes needed. Unknown keys are preserved and reported as a warning. A duplicate key is an error. Dates are `YYYY-MM-DD`. Flat scalars keep the header parsable with a standard library and readable in a diff.

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Opaque unique string `[A-Za-z0-9._-]+`; the file name starts with it. Never reused, even after a card is dropped. An adopted project keeps its own ids. |
| `title` | yes | One line, in the project's language. |
| `status` | yes | One of the vocabulary below. |
| `depends_on` | no | Comma-separated ids of cards that must be accepted first. |
| `blocked` | when `status: blocked` | `decision: ...`, `dependency: ...` or `external: ...` — kind, colon, short reason. |
| `approved` | before work starts | A record of an approval **given elsewhere**: `<by>, <date>, scope=<scopes>[, source=<ref>]`. Scopes: `analysis`, `implementation`, `external`, joined with `+`. `source` points to where the owner gave it (a commit, a message id, a document). |
| `accepted` | when `status: done` | `<by>, <date>` of the owner's acceptance. |
| `as_of` | yes | Date the status was last checked **against reality** (code, tests, evidence), not the date the file was last touched. |

Not in v1, by decision: `summary`, `parent`, `claim`, `rank`.

### Sections

Level-2 headings with fixed English names, in this order. A missing optional section is allowed. Text under them is in the project's language.

- `## Goal` — what and why, a few lines.
- `## Plan` — steps, free text.
- `## Acceptance` — a checklist; **every criterion has an id**: `- [ ] a1: text`. Marks: `[ ]` open, `[x]` met (needs Evidence), `[~]` deferred or accepted as limited, **with the reason and who decided**, e.g. `- [~] a3: text — deferred by owner, 2026-11-10`.
- `## Evidence` — `- a1: what was checked, result, by whom, date, reference`. Names the criterion ids it covers. It records a check that was performed; it does not turn intention into evidence.
- `## Log` — append-only, newest last: `- 2026-11-10 [author] decision or finding, reason (commit abc1234)`. For decisions, reasons and problems; not a diff of the repository. Cite commit ids instead of copying git history.
- `## Handoff` — where to resume: what is done, what remains, what to verify first. Rewritten at each handoff.

## Statuses

| Status | Meaning |
| --- | --- |
| `idea` | A thought, not defined enough to start. |
| `ready` | Defined with acceptance criteria; **not** permission to start. |
| `doing` | Work is in progress. Needs `approved` with scope `implementation`. |
| `review` | The agent recorded completion; the owner has not accepted. Every criterion is `[x]` with Evidence or `[~]` with a reason. |
| `blocked` | Cannot proceed; `blocked` says why. |
| `done` | Accepted by the owner (`accepted` set). Limited acceptance is `done` with `[~]` criteria, never an unqualified pass. |
| `parked` | Deliberately deferred. |
| `dropped` | Cancelled; kept with the reason in Log. |

Recorded completion, awaiting the owner and accepted are distinct: `doing` → `review` → `done`.

### Mapping from the skill's default vocabulary

| Skill / roadmap word | Card |
| --- | --- |
| OPEN | `ready` (or `idea` if not yet defined) |
| IN PROGRESS | `doing` |
| PARTIAL | `doing`, or `review` when only owner acceptance remains; unmet criteria stay `[ ]` or `[~]` with a reason |
| BLOCKED | `blocked` |
| DONE | `done` |
| DONE (limited) | `done` with the limits recorded as `[~]` criteria |
| DEFERRED | `parked` |
| CANCELLED | `dropped` |

A project's own words (for example DECISION, CONDITIONAL) map through `status_map`; decision and external dependencies become `blocked` with the matching kind. No recorded distinction may be lost in a mapping.

## `approved`

`approved` is a **record**, not a permission an agent can grant. An agent never sets it for itself. Scope matters: `analysis` lets an agent read and propose; `implementation` lets it change the project; `external` covers actions outside the project (publishing, production, spending). A material change to a card's acceptance criteria clears `approved`. A tool can check only the form; where the owner commits approvals personally, a tool may optionally compare the author of the commit that introduced the line. Text in `source` is a pointer, not proof.

## Invariants

Errors block a git commit when a pre-commit check runs; warnings never block. A tool proves only that a reference exists, not that evidence is true.

| # | Rule | Level |
| --- | --- | --- |
| 1 | Header parses; required keys present; no duplicate key | error |
| 2 | `id` unique across the board and matches the file name prefix | error |
| 3 | `status` is in the vocabulary (after `status_map`) | error |
| 4 | `blocked` present exactly when `status: blocked` | error |
| 5 | `depends_on` ids exist | error |
| 6 | `doing` has `approved` with scope `implementation` | error |
| 7 | `review` and `done`: every criterion is `[x]` with an Evidence line naming its id, or `[~]` with a reason | error |
| 8 | `done` has `accepted` | error |
| 9 | `BOARD.md` equals the regenerated board | error |
| 10 | `board_version` not newer than the tool | error |
| 11 | Unknown header keys; unknown sections | warning |
| 12 | `doing` card whose `as_of` is older than `doing_stale_days` | warning |
| 13 | More than one `doing` card | warning |
| 14 | `doing` card whose `as_of` is newer than its last Log entry | warning |
| 15 | Past Log lines edited (needs git history) | warning, **not implemented in roadctl 0.1** |
| 16 | `approved` older than the last edit of Acceptance (needs git history) | warning, **not implemented in roadctl 0.1** |

## `BOARD.md`

Generated and committed, so readers and tier-1 agents have it; never edited by hand. The first lines state that it is generated, the generation time and the tool or spec version. Then, in this order: `doing`, `review`, `blocked`, `ready` (approved first), then `idea`, `parked`, `done` and `dropped` collapsed to counts. One line per listed card: `- [id] title — status; approved: scope; next: id — first open criterion text`. Titles and criterion text are sanitized (markup and control characters removed) and capped, because they can reach a model. Closed work is a count, not a list.

When the board exceeds `limits.board_bytes`, collapse in this order: `idea` and `parked` first, then `ready`; `doing`, `review` and `blocked` are never collapsed. If a merge conflicts in `BOARD.md`, regenerate it from the cards.

## Writing and merging

One writer per card at a time (no `claim` in v1). Two agents appending to one Log conflict in git. If parallel writing becomes real, move the Log to its own file with a union merge driver, or add `claim`.

## Data, not instructions

Card text can be written by any agent or contributor and reaches a model as context. Anything that injects it automatically should inject only header fields and, at most, the id and a sanitized, length-capped text of the first open criterion, never Log, Goal, Plan or Handoff text. In a repository that accepts outside contributions, card files are an injection path.

## Language

Header keys, status words, section names and `config.json` keys are English and fixed in v1. Titles and section text use the project's language.

## Example

A synthetic board in Russian, written by hand following this spec: [examples/board-example/board/](../examples/board-example/board/BOARD.md). It has one card per status that matters: a limited `done`, a `review`, a `doing`, a `blocked`, a `ready` and an `idea`.

## Validation

- **Done:** the example board passes the tool's `lint` with no errors or warnings; seeded errors are caught by the tool's tests (see [roadctl.md](roadctl.md)).
- **Not done, by owner decision (2026-11-10):** a test with a model. Only utilities with code are tested. The intended check was that a fresh agent session given only this spec and the example can say what is next, add a Log entry to the `doing` card and decline to close a card whose criterion lacks evidence. Problems will be fixed as they appear in use.
