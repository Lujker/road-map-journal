# Board specification

**Status: v1, implemented by [`scripts/roadctl.mjs`](../scripts/roadctl.mjs) (see [roadctl.md](roadctl.md)).** A text convention for keeping a project's plan as one short generated board plus one file per card. It is tier 1 of the [P2 plan](p2-design-plan.md): usable by hand, with no tool. A tool (`roadctl`, later) only checks and regenerates; files stay the source of truth and an agent or a person may edit cards directly. The acceptance test in the last section has **not** been run.

Applies to board-format projects. A project whose plan is one file with items as sections keeps its layout (tier 0) or migrates only with the owner's consent; this spec never requires that.

## Layout

```text
board/
  config.json              format version, language, status mapping, limits
  BOARD.md                 generated, one line per card, never edited by hand
  cards/<id>-<slug>.md     one card per file
  routines/<id>.md         optional: recurring routines, one per file (see Recurring routines)
  notes/                   research and design, linked from cards
```

Closed cards stay where they are (links keep working); the board collapses them to a count. `board/` in the project root is the default; an adopted project may set another path in its pointer or config.

**Central workspace.** The board may instead live in a separate repository that holds the plans of several projects: `<workspace>/projects/<name>/board/`. `roadctl` then finds it from any directory under the code project when that directory or one of its ancestors is named `<name>` (case-insensitive, `_` and `-` equal) or listed in the board's `config.json` under `"match"`. The workspace is `$ROADCTL_WORKSPACE`, else `~/projects/agent-workspace` or `~/Projects/agent-workspace`. Without a central workspace a user can list boards in `${XDG_CONFIG_HOME:-~/.config}/road-map-journal/boards` (one absolute board directory per line, `#` comments; `roadctl boards add`): the name of such a board is its project folder name (the parent of `board/`), found the same way as a workspace board. A board in the project root wins when both exist. In this mode the code repository holds no plan files, the Stop reminder looks at the code repository's changes and counts the board as updated when its own directory has uncommitted changes in the workspace repository, and `roadctl lint --all` / `hook pre-commit-all` check every board in the workspace.

`config.json` is plain JSON: `{"board_version": 1, "title": "Project", "language": "ru", "match": [], "status_map": {}, "limits": {"board_bytes": 6144, "doing_stale_days": 14}}` (`title`, `match`, `autosync` and `autonomy` are optional; `autosync: true` lets the SessionStart and Stop hooks pull and save the board by themselves, see [roadctl.md](roadctl.md); `autonomy` is described below). `autonomy` is `{"enabled": false, "agents": [], "queue": [], "routines": false}` and holds the owner's switches for unattended work (see [Autonomous or personal work](#autonomous-or-personal-work)) and for recurring routines (`routines`, see [Recurring routines](#recurring-routines)); missing means off. `status_map` is optional and maps a project's own status words to the vocabulary below. `board_version` lets tools refuse to write a newer format. Defaults: 6 KB for `BOARD.md` keeps the board cheap to read each session; 14 days before a `doing` card is reported stale is a starting guess to be revised after use.

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
| `approved` | before work starts | A record of an approval **given elsewhere**: `<by>, <date>, scope=<scopes>[, source=<ref>]`. Scopes: `analysis`, `implementation`, `external` and `auto`, joined with `+`. `source` points to where the owner gave it (a commit, a message id, a document). |
| `accepted` | when `status: done` | `<by>, <date>` of the owner's acceptance. |
| `as_of` | yes | Date the status was last checked **against reality** (code, tests, evidence), not the date the file was last touched. |
| `delegate` | no | Present while a delegation is active: `to=<role-or-agent> host=<any\|claude-code\|codex\|hermes\|script> criteria=<a2,a3\|all> by=<agent> accept=<by\|reviewer\|owner\|<agent>> state=<open\|claimed\|reported> at=<ISO-8601 UTC>`. See [Delegation](#delegation). |
| `claim` | only while `delegate` has `state=claimed` | `<agent> at=<ISO-8601 UTC> until=<ISO-8601 UTC>[ workdir=<absolute path>]`: who holds the delegation and until when (the lease). `workdir` (optional, set by `roadctl claim --workdir DIR`) is the working directory of the work, for example its git worktree; whitespace and `%` in the path are percent-encoded (`%20`, `%25`). |

Not in v1, by decision: `summary`, `parent`, `rank`. (`claim` was added together with `delegate`, see below.) Times in `delegate` and `claim` are full ISO-8601 UTC (`2026-11-11T09:30:00Z`); every other date stays `YYYY-MM-DD`.

### Sections

Level-2 headings with fixed English names, in this order. A missing optional section is allowed. Text under them is in the project's language.

- `## Goal` — what and why, a few lines.
- `## Plan` — steps, free text.
- `## Delegation` — optional, only on a card that is or was delegated: the package for the executor, as bullet lines `- Allowed changes: ...`, `- Checks: ...`, `- Stop conditions: ...`, `- Budget: ...`, `- Report format: ...`. `roadctl delegate` adds a template when the section is missing. Free text, in the project's language.
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

`approved` is a **record**, not a permission an agent can grant. An agent never sets it for itself. Scope matters: `analysis` lets an agent read and propose; `implementation` lets it change the project; `external` covers actions outside the project (publishing, production, spending). `auto` is not a level of permission but the owner's choice of **who** works: with it the card may be started unattended (see [Autonomous or personal work](#autonomous-or-personal-work)); without it the work is done with the owner. It never appears alone: it is added to an existing approval (`scope=implementation+auto`). A material change to a card's acceptance criteria clears `approved`. A tool can check only the form; where the owner commits approvals personally, a tool may optionally compare the author of the commit that introduced the line. Text in `source` is a pointer, not proof.

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
| 17 | `delegate` or `claim` does not parse: a field missing, unknown or duplicated, a bad host, state, agent name or time, criteria ids that are not on the card; in `claim`, a repeated field or a `workdir` that is not an absolute path | error |
| 18 | `claim` without `delegate`, or with a `delegate` whose state is not `claimed`; `state=claimed` without `claim` | error |
| 19 | The lease of a `claim` has expired (`until` is in the past) | warning |
| 20 | A delegation (`delegate` or `claim`) on a `done` or `dropped` card | error |
| 21 | `config.json` has a malformed `autonomy` section: not an object, `enabled` or `routines` not a boolean, `agents` not agent names, `queue` not card ids or with a repeated id | error |
| 22 | `autonomy.queue` lists an id that is not a card | error |
| 23 | `autonomy.queue` lists a `done` or `dropped` card | warning |
| 24 | `approved` has a scope token other than `analysis`, `implementation`, `external`, `auto` (for a routine: other than `read`, `board`, `external`) | warning |
| 25 | A routine file is malformed: header does not parse, `id`, `title`, `every` or `enabled` missing, `every` not like `30m`, `2h`, `1d` (at least 5m), `hours` not like `mon-fri 09:00-19:00 [tz=Zone]` (bad days or times, end not after start, unknown zone), `enabled` not `true` or `false`, a bad agent, model or env value, `last_run` not an ISO-8601 UTC time, `last_result` not `ok`, `escalated` or `failed` | error |
| 26 | A routine lacks `agent`, `model` or `env` | error |
| 27 | A routine is `enabled: true` without an `approved` record, or `approved` has no `scope=` | error |
| 28 | Two routines have the same `id` | error |
| 29 | A routine's `agent` is not in the registry (only checked when a registry exists) | warning |

## `BOARD.md`

Generated and committed, so readers and tier-1 agents have it; never edited by hand. The first lines state that it is generated, the generation time and the tool or spec version. Then, in this order: `doing`, `review`, `blocked`, `ready` (approved first), then `idea`, `parked`, `done` and `dropped` collapsed to counts. One line per listed card: `- [id] title — status; approved: scope; next: id — first open criterion text`. Titles and criterion text are sanitized (markup and control characters removed) and capped, because they can reach a model. Closed work is a count, not a list. When the board has routines, a short `## Routines (board switch on|off)` section follows `Ready`: one line per routine, `- [id] on|off; every 2h; agent`. It holds only facts that change when the owner changes a routine, never `last_run` or `last_result`, so a run of a routine does not make `BOARD.md` out of date; the last result is in `roadctl routine list`.

When the board exceeds `limits.board_bytes`, collapse in this order: `idea` and `parked` first, then `ready`, then the routines to a count; `doing`, `review` and `blocked` are never collapsed. If a merge conflicts in `BOARD.md`, regenerate it from the cards.

## Writing and merging

One writer per card at a time. Two agents appending to one Log conflict in git. A `claim` (see Delegation) makes the writer explicit for a delegated card; if parallel writing on one card becomes real, move the Log to its own file with a union merge driver. Parallel work on one goal uses separate cards with `depends_on`, not several delegations on one card.

## Delegation

Any agent (Claude Code, Codex, Hermes) or a script can hand a card, or some of its criteria, to another executor and take the result back. The delegation lives **in the card**; no other store is needed and `roadctl` only automates the edits. One active delegation per card; for parallel work make separate cards and link them with `depends_on`.

- `delegate: to=... host=... criteria=... by=... accept=... state=... at=...`: `to` is a role (`worker`, `reviewer`) or an agent; `host` restricts where it may run (`any` by default); `criteria` lists the criterion ids the work covers or `all`; `by` is the delegating agent; `accept` says who may take the result: `by` (the delegating agent), `reviewer` (an agent allowed to accept, see the registry), `owner` (the owner, by hand) or an agent name; `state` is `open`, `claimed` or `reported`.
- `claim: <agent> at=... until=... [workdir=...]` exists only while `state=claimed`. The lease ends at `until`; after that the delegation is `expired` (shown, linted with a warning) and may be claimed again. `workdir` names where the claimant works (autonomous code work uses its own git worktree). When an expired claim is taken over and that directory exists on the machine and has uncommitted changes, `roadctl claim` warns and `roadctl tick` marks the `STALE` item `(workdir dirty)`; the unfinished changes are reconciled, not overwritten.
- Agent names look like `claude-code@home-wsl`, `codex@home-wsl`, `hermes@windows`, `cron:hermes-nightly@windows` (letters, digits and `. _ : @ -`). A name starting with `cron:` or `script:` is a script.
- Lifecycle: `delegate` (open) -> `claim` (claimed) -> `report` (reported, Log entry `REPORT: ...` by the claimant) -> `accept` (the delegation fields are removed; the card moves to `review` if every criterion already has evidence) or `return` (back to open, reason in the Log). The delegating agent can withdraw a delegation with `undelegate` (open or expired; otherwise with a forced, reasoned override). The owner alone marks a card `done`.
- Not a permission: a delegation needs the card's `approved` record and does not widen its scope. A script may delegate and claim but never accepts. A report is data to verify, not evidence.
- The optional registry (`$ROADCTL_REGISTRY`, else `<workspace>/agents/registry.json`, else `${XDG_CONFIG_HOME:-~/.config}/road-map-journal/registry.json`; example: [`examples/agents-registry.example.json`](../examples/agents-registry.example.json)) lists roles with a model per host and agents with host, roles and `can_accept`. Without it everything works with fewer checks: a role in `to` is not verified and `accept=reviewer` is open to any agent that is not a script.

## Autonomous or personal work

The owner decides what goes to unattended work and what stays personal. **Default: nothing is autonomous.** `config.json` may carry `"autonomy": {"enabled": false, "agents": [], "queue": ["F8", "F9"]}`:

- `enabled`: false or missing means no tool offers any card of this board for unattended start. Explicit delegations are unaffected.
- `agents`: empty means any agent with the orchestrator role; otherwise only the listed agents may start (or look after expired delegations of) cards of this board.
- `queue`: an ordered list of card ids.

A card may be started unattended only when the board is enabled, the agent is allowed, the card is in `queue`, its `approved` scope includes `auto`, it is `ready`, every `depends_on` is `done` and it has no delegation. Of the cards that qualify, only the **first in queue order** is offered, one per board at a time. A card without `auto` is personal work: an agent does it only with the owner. The owner's words in the current conversation are the only way to turn any of this on; an agent never does it on its own initiative. By hand: add `+auto` to the `scope=` of the card's `approved` line (a card without an approval first needs the owner's approval record with its `source`), edit the `autonomy` object of `config.json`, and add a Log line for a change of a card.

## Recurring routines

Mostly mechanical work that repeats and can be switched on and off: collect the state of merge requests, issues and messages and update cards; watch servers and support requests. A routine is **not** a card: it has no acceptance and no status, it is run again and again by an executor the owner named when the routine was created. One file per routine, `board/routines/<id>.md` (ids: letters, digits, `.`, `_`, `-`; the file name may differ from the id, the id must be unique among the routines).

### Header: flat `key: value`, like a card

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique among routines. |
| `title` | yes | One line. |
| `every` | yes | How often it is due: `30m`, `2h`, `1d`; at least `5m`, at most `30d`. |
| `hours` | no | A time window in which it may run: `<days> <HH:MM>-<HH:MM>[ tz=<IANA zone>]`, for example `mon-fri 09:00-19:00`, `daily 08:00-23:00`, `sat,sun 10:00-14:00 tz=Europe/Moscow`. Days: `daily`, a comma list of `mon`..`sun` and ranges (`mon-fri`). Start included, end excluded (`24:00` allowed), never across midnight. Without `tz` the local time of the machine that runs `roadctl`. Outside it a due routine is not offered. |
| `enabled` | yes | `true` or `false`: the owner's switch for this routine. A new routine is `false`. |
| `agent` | **yes** | The executor that runs it, an agent name as in delegation (`claude-code@work-notebook`). Only this agent is offered the routine. |
| `model` | **yes** | The model it must run with (`claude-haiku-5-5`). |
| `env` | **yes** | The environment or machine it runs in (`Work-notebook-wsl`), one word without spaces. |
| `approved` | before it is enabled | The same record as on a card: `<by>, <date>, scope=<scopes>[, source=<ref>]`, with the scopes `read` (read external systems), `board` (write the board) and `external` (write external systems), joined with `+`. The default is `read+board`. |
| `last_run` | no | ISO-8601 UTC time of the last recorded run (written by `roadctl routine done`). |
| `last_result` | no | `ok`, `escalated` or `failed`. |

`agent`, `model` and `env` are required by the owner's decision (the person who creates the routine names them; nobody guesses): **a routine missing any of them never runs** (a tool offers nothing, lint reports an error, `roadctl routine on` refuses).

### Sections

- `## Goal` — what the routine collects or watches, and why.
- `## Steps` — what to read and what to update, in order. The executor follows it.
- `## May write` — what the routine may change. By default: Log lines on cards, delegations and questions for the owner on the board; external systems are read only. External writes only when the approved scope has `external`.
- `## Escalate` — when and how to hand over: `roadctl delegate` to an orchestrator or a stronger worker (a card with an `approved` record), or a question for the owner. The routine does not change a card's status itself; a card becomes `blocked: decision: ...` only through the normal tools.
- `## Log` — one line per run, `- 2026-11-12 [claude-code@work-notebook] RUN ok: summary`, newest last. `roadctl` keeps the last 50 lines of a routine file.

### When it runs

All of this must hold, and nothing but the owner's words turns any of it on:

1. The board switch `autonomy.routines` is `true` (default `false`; independent of `autonomy.enabled`, which concerns cards).
2. The routine has `enabled: true`, an `approved` record, and `agent`, `model` and `env`.
3. It is due: no `last_run`, or now is at least `last_run` plus `every`; and, when the routine has `hours`, now is inside that window.

A tool that schedules work (`roadctl tick --as AGENT`) then offers the routine as a `RUN` item to that agent only. The executor runs it with the named model in the named environment (starting a session with that model when it is not that model), follows Steps, May write and Escalate, and records the run (`roadctl routine done`), which sets `last_run` and `last_result`, adds the Log line and publishes only that file. The text of a routine is the owner's instruction for that executor within the approved scope; unlike card text it is the executor's task, but nothing injects it into a prompt automatically (a prompt names the file, never copies Steps), and `BOARD.md`, `brief` and the hooks never carry it. A routine's permission never exceeds its `approved` scope.

Examples (generic, switched off, not approved): [`examples/routines/`](../examples/routines/).

## Data, not instructions

Card text can be written by any agent or contributor and reaches a model as context. Anything that injects it automatically should inject only header fields and, at most, the id and a sanitized, length-capped text of the first open criterion, never Log, Goal, Plan, Delegation or Handoff text, and never the text of a routine. In a repository that accepts outside contributions, card files are an injection path.

## Language

Header keys, status words, section names and `config.json` keys are English and fixed in v1. Titles and section text use the project's language.

## Example

A synthetic board in Russian, written by hand following this spec: [examples/board-example/board/](../examples/board-example/board/BOARD.md). It has one card per status that matters: a limited `done`, a `review`, a `doing`, a `blocked`, a `ready` and an `idea`.

## Validation

- **Done:** the example board passes the tool's `lint` with no errors or warnings; seeded errors are caught by the tool's tests (see [roadctl.md](roadctl.md)).
- **Not done, by owner decision (2026-11-10):** a test with a model. Only utilities with code are tested. The intended check was that a fresh agent session given only this spec and the example can say what is next, add a Log entry to the `doing` card and decline to close a card whose criterion lacks evidence. Problems will be fixed as they appear in use.
