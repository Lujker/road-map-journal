# Review: P2 design plan and the project as a whole

**Status: review notes, proposals only.** Written 2026-11-10 at the owner's request by an agent (Claude Fable 5.2 in Claude Code) against commit `17cc1a2`. Nothing here is a decision, changes the queue in [ROADMAP.md](../ROADMAP.md) or authorizes implementation. The plan under review, [p2-design-plan.md](p2-design-plan.md), was not edited.

**What this review rests on.** All tracked files were read. The model-free tests were run on WSL with Node 24.21: `node --test scripts/update-installed.test.mjs` (3 passed) and `python3 -m unittest discover -s evals/tests` (6 passed). The Claude Code hook statements in section 4 were checked against the current hooks reference. **Not done:** no agent host was run, no hook was installed, and the Codex and Hermes columns of the trigger table were not checked at all.

## 1. Summary

The direction is right: the plan moves routine bookkeeping from the model to a mechanism and keeps judgment with the model and the owner. Its restraint (optional layers, hooks as reinforcement, "instructions do not create atomicity") is its best quality.

Seven things should change before any P2 item starts, most important first:

1. **The plan has no problem evidence.** Every short check so far gave the same correct answer with and without the skill. P2 builds a format, a CLI and hooks without one recorded case where the current skill failed. Record those cases first; they become the acceptance tests (section 2).
2. **The layers are not independent as claimed.** The pointer tells every agent to "start with `brief`, close through `done`", but `roadctl` is optional and is not installed with the skill. How it reaches a project is not specified (section 3.1).
3. **The card header cannot be parsed with a standard library as specified.** Nested objects and arrays imply YAML; neither Python nor Node ships a YAML parser. This decides the file format and belongs in P2.1 (section 3.2).
4. **"Remind once, never block" contradicts the recommended pre-commit net**, and on Claude Code a Stop reminder works by continuing the turn. The rule needs exact wording (section 4).
5. **`approved` is a text field any agent can write**, which is the "summary in a checkpoint" that the plan's own P2.4 principle says permissions must not bind to (section 3.3).
6. **The pilot as designed will not be convincing**: single runs, seven metrics, three hosts, and no scenario where the baseline is expected to fail (section 6).
7. **The license blocker on P2.2 is avoidable**: write `roadctl` from the public specification instead of generalizing private code (section 5).

Recommended order: observed failures → P2.1 (small) → pointer only, used on this repository → `lint`, `sync`, `brief` → hooks on one host → a narrow pilot → the rest of P2.4 only if the pilot shows a need (section 7).

## 2. Evidence before mechanism

The three-host comparison produced correct answers in both conditions on every host. That is recorded honestly, but its consequence for P2 is not drawn: the fixture was too easy to show a difference, and no harder case has been written down.

The owner's stated motive for P2 is real (agents need reminders to update plans, and each session re-discovers where the plan lives), yet it appears nowhere in the public repository as a checkable case.

**Proposal.** Turn P1.1 into the input of P2. Before P2.1, collect five to ten concrete, sanitized failures from real use, each as: situation, what the agent did, what it should have done, which layer could have prevented it (pointer, skill text, `lint`, hook). Expected categories: plan not updated after work, wrong `DONE`, next item started without permission, decision lost after compaction, stale plan trusted over the working tree. Each case becomes a synthetic fixture. A P2 layer that prevents none of the recorded cases is not built.

This also answers the over-building risk the plan names but does not guard against.

## 3. Board specification (P2.1)

### 3.1 Tiers and distribution

State four tiers and make each usable without the next:

| Tier | What it is | Needs |
| --- | --- | --- |
| 0 | Current skill, any layout | nothing |
| 1 | Board format as a text convention | nothing; cards are edited by hand |
| 2 | `roadctl` | a runtime and a known path |
| 3 | Hooks | tier 2 and a supporting host |

Consequences the plan should spell out:

- **The pointer needs a variant per tier.** A tier 1 pointer says where the board is and which card sections to update. Only a tier 2 pointer mentions `brief` and `done`.
- **How `roadctl` reaches a project is undecided.** Options: a single file vendored into the project (simple, works offline, goes stale), or run from a checkout of this repository (one copy, needs a path on every host). Hooks need a stable path either way. Recommended: one vendored file with a version line, plus a `lint` warning when the board format is newer than the tool.
- **The implementation language is undecided.** "Standard library only" does not say which one. The repository already uses Node for `scripts/` and Python for `evals/`; the owner works on both Windows and WSL, and the Windows Node version already caused trouble in P0.2. Pick one and record why.
- **`roadctl` cannot serve "adopted projects keep their layout" in general.** A project whose plan is one file with items as sections (this repository's own `ROADMAP.md`) has no one-card-per-file structure to operate on. Say plainly: tiers 2 and 3 apply to board-format projects; an adopted project either stays at tier 0 or migrates with consent. A small config file with the board path and the status mapping covers the case of a board that lives somewhere other than `board/`.

### 3.2 Card header

- **Format.** Choose one that a hand-written parser handles safely: flat `key: value` scalars in the header, and lists in the body as Markdown sections. `acceptance` and `remaining` are better as body checklists than as header arrays. That removes the nesting problem and reads well in a diff.
- **Acceptance items need ids.** "`done` needs evidence for every acceptance item" is only checkable if each criterion has an id (`a1`, `a2`) and each Evidence entry names the ids it covers. State also what `lint` proves: that a reference exists, not that the evidence is true.
- **Three completion states, eight statuses, no mapping.** The plan keeps "recorded completion, awaiting owner and accepted" distinct but does not say which status is which. Proposed: `review` means the agent recorded completion and the owner has not accepted; `done` means accepted; add `accepted: <by>, <date>` beside `approved` so `lint` can require it for `done`. Say where the skill's `PARTIAL` and this repository's "DONE (limited)" go; without that the mapping loses information the current skill protects.
- **`as_of` will go stale if written by hand.** Define it as "date the status was last checked against reality", have `log` and `done` set it, and let `lint` compare it with the last Log entry.
- **Fields that can be dropped from the first version:** `summary` (the title plus the first `remaining` line serves `brief`), `parent` (unless a real project needs epics), `claim` (already deferred). Each stored field is one more thing to keep current.
- **Ids.** "Never reused" needs an allocation rule that survives two branches: treat an id as an opaque unique string, keep the ids of an adopted project, let `lint` report duplicates and resolve them at merge.
- **Closed cards stay where they are.** Moving them to an archive breaks links. The board collapses them to a count; the files do not move.
- **Format version.** Put a `board_version` in the config from the first day; migrations are otherwise guesswork.

### 3.3 `approved`

An agent can write `approved: owner, 2026-11-10` as easily as any other line, and a later agent will read it as permission. The field should therefore be defined as a **record of an approval given elsewhere**, with:

- a scope (analysis, implementation, external actions), since the plan itself separates these;
- a pointer to the source when one exists (for example the commit in which the owner set it);
- a rule that an agent never sets it for itself, and that a material change to the acceptance criteria clears it.

`lint` can check form only. Where the owner commits approvals personally, `lint` could optionally check the author of the commit that introduced the line; that is cheap and is the only mechanical link to a real source.

### 3.4 Generated board and merges

- `BOARD.md` is committed (readers and tier 1 agents need it), so it will go stale whenever a card is edited without `sync`. Add `sync --check` to `lint` and print the generation time in the file.
- **An append-only Log at the end of a file conflicts on every parallel edit.** Two agents appending to the same card always collide in git. Without `claim` the rule should be one writer per card; if parallel writing becomes real, move the Log to its own file with a union merge driver rather than applying one to the whole card.
- Define what happens when the board exceeds its size cap: collapse `idea` and `parked` to counts first, then `ready`.

### 3.5 Acceptance of P2.1

"A fresh agent can use the example without extra explanation" needs a test: a new session gets only the spec and the example and performs three tasks (say what is next; add a Log entry; try to close a card with one criterion lacking evidence and decline). File results are checked by hand until `lint` exists. One run is an observation, as the plan already says elsewhere.

## 4. Hooks and the freshness net (P2.3)

**Answer to reviewer question 3.** Pre-commit `lint` is the right primary net, with two conditions. First, split findings: **errors** block the commit (unparseable header, duplicate id, `done` without evidence references, board out of sync) and **warnings** never do (stale `as_of`, missing Log entry). Second, state that this net exists only where git does; the skill promises not to assume git, so tier 0 and 1 remain the fallback. As written, "hooks must not block work" and "pre-commit running `lint`" contradict each other.

**Answer to reviewer question 4.** The rule is safe in intent but imprecise in three places:

1. **On Claude Code a Stop reminder is a continuation.** A Stop hook reminds either with `decision: "block"` or with `hookSpecificOutput.additionalContext`; both keep the conversation going for another model turn, with `stop_hook_active` and a cap on consecutive continuations as loop protection. Use `additionalContext` (it is shown as hook feedback, not as an error), exit immediately when `stop_hook_active` is true, and word the rule as "may continue the turn at most once; never loops; never fails the session". Each reminder costs a model turn, so the condition must be strict and cheap.
2. **"The active card" is undefined once `claim` is deferred.** Proposed: the active card is the single `doing` card; with zero or several, the hook stays silent. `lint` warns on several `doing` cards.
3. **`PreCompact` cannot save a judgment checkpoint.** It runs a command and can block compaction; it cannot make the model write anything. It can only save mechanical state. The useful trigger is the other side: `SessionStart` fires again after compaction (source `compact`) and can re-inject `brief`. Change that row of the table.

Further points:

- **"Injected as data, never as instructions" is not enforceable.** Whatever a hook injects is read by the model as context. Reduce the surface instead: `brief` emits only header fields with length caps and stripped markup, never Log or body text. In a repository that accepts outside contributions, card files are an injection path; say so.
- **Where hooks are written.** A committed project settings file applies hooks to every collaborator. The installer should default to the user's local, uncommitted settings and ask before anything else.
- **Stop fires after every turn**, including read-only questions. The check must be a quick git query, not a parse of the whole board.
- **The trigger table mixes verified and unverified cells.** Mark each cell with its source and date when tested. The Codex and Hermes columns are documentation claims until run.
- **Activation is the real P2.3 question and it overlaps the deferred part of P0.1.** The skill's description is one line ("Use for project roadmaps and development journals."). Whether a host loads the skill on "continue the work" without the word roadmap is unknown. Make that the first P2.3 check; it needs no tooling.

## 5. `roadctl` (P2.2)

- **Write it from the public spec.** The dependency on the license decision exists only if code is generalized from the private predecessor. The predecessor is small and the spec will be public, so an independent implementation costs less than settling rights, and removes "drifting from a private predecessor" as a risk. This is the owner's decision; it is recommended here.
- **Order the commands by value.** `lint` and `sync` first (they are the net), then `brief` (the token saving), then `done` and `log`. `show` is `cat` with a tail and can wait.
- **Prefer deriving to storing.** `log --from-git` copies git history into the card, where it becomes noise and a second record. Let `brief` and `show` display recent commits on demand, and let Log entries cite commit ids. The Log then stays what the plan wants: decisions and reasons.
- **`done` must refuse, not repair.** If evidence is missing, `done` exits non-zero and names the criteria; it never downgrades or rewrites silently.
- **Measure `brief` against a stated baseline.** On this repository the whole roadmap is about 10 KB, so a 300-token brief saves little. Name the project size the tooling is meant for (for example fifty or more items) and measure there.
- **Windows.** Line endings and paths already affected the update script. Test `roadctl` on Windows from the first command.

## 6. Protocol and pilot (P2.4, P2.5)

**P2.4.** Much of its content is already in `SKILL.md` in compressed form (modes, checkpoints, budgets, in-flight actions). The risk is that P2.4 becomes more prose in a core that is already dense. Proposed shape: move the long-running rules out of the core into `references/long-running.md`, and shrink the core. Split the item:

- **P2.4a** — checkpoint, handoff, recovery after interruption. Single agent, needed now, testable.
- **P2.4b** — delegation package, owner-question queue, layered budgets. Multi-agent, needed only if the pilot goes there.

Its acceptance criterion ("reviewed against the decisions already agreed in private discussion") cannot be checked from this repository. List the generalized decisions in the plan itself, or reword the criterion.

**P2.5 and reviewer question 5.** A result is convincing when the baseline fails a seeded trap and the protocol does not, repeatedly. That requires:

- **Scenarios built to discriminate**, taken from the failures of section 2: an interruption after a non-repeatable action; a sub-agent reporting success falsely; a plan that says `DONE` while a criterion is unmet; a session that crosses compaction.
- **Binary outcomes first**: wrong `DONE` (yes/no), action repeated after interruption (yes/no), unapproved item started (yes/no). Token totals are secondary; "rework" and "lost decisions" are too soft to score on single runs.
- **Repeats on one host** rather than one run on three: at least three to five runs per condition, on an inexpensive model, with the pass threshold written down before the first run.
- **One host for both P2.3 and P2.5.** The plan verifies hooks on Claude Code first but pilots on Hermes first, the host with the weakest hook surface in the plan's own table and the one tested so far only through a modified harness. Either use the same host or state why not.

## 7. Order of work

**Answer to reviewer question 1.** Neither order as written. Proposed:

1. Record observed failures (section 2). No code.
2. P2.1, reduced: format, flat header, invariants, one example.
3. Pointer only (the text part of P2.3) and use of the board on this repository and one real project. This tests tiers 0 and 1 at no tooling cost and checks activation.
4. P2.2 in the command order of section 5.
5. Hooks on one host.
6. P2.4a, then a narrow pilot.
7. P2.4b and P2.6 only if the pilot shows a need.

Step 3 is the cheapest experiment in the plan and may show that the pointer alone removes most reminders.

**Answer to reviewer question 2** is in section 3.2.

## 8. The project as a whole

**Strengths.**

- The core idea is sound and differentiated: keep a project's own conventions, and keep implemented, tested and accepted apart. Comparable tools mostly impose a layout; this one's value is the evidence and scope discipline. `lint` enforcing "no `done` without evidence" is the natural extension of exactly that.
- The records are unusually honest. Limits are stated, an inconclusive run is kept as inconclusive, and nothing is claimed from documentation alone.
- The skill is small and has no dependencies; the tests that exist pass.

**Weaknesses.**

- **No demonstrated benefit yet.** With and without the skill gave the same answers. This is the main open risk, more than any design detail.
- **The project does not use its own advice.** `ROADMAP.md` carries the P0.2 status as one paragraph of about five hundred words, where the skill says to keep the summary short and link the evidence. Item statuses are also repeated in the "Development queue", which is the two-places drift that P2 aims to remove. Moving the evidence into linked notes, and later making this roadmap the first board, would be the most persuasive example the project could offer.
- **Process weight exceeds product size.** Eight commits and an 8 KB skill carry a 10 KB roadmap and an elaborate isolation harness for a one-question check. The caution is appropriate for paid runs and credentials; applied to everything, it slows a project that has one user.
- **The public documentation is hard to approach.** The README qualifies nearly every sentence. A newcomer needs three lines (what it is, install, try this prompt) before the caveats; the verification detail can live in one linked page.
- **Owner-specific rules sit in the public core.** Sentences such as the one about preferring manual validation, or about a pilot not redefining a milestone, read as lessons from particular incidents. They cost tokens for every user on every activation and belong in a reference file.
- **P1.1 has no mechanism.** "Invite feedback" with no channel, template or user base will stay open. Section 2 reframes it as something the owner can complete alone.

**Small, cheap improvements.**

- Close P0.3 for the logo: the owner records how it was made, or replaces it with a simple self-made image.
- Add a CI workflow that runs the two existing test commands and a link check.
- Give the skill a version, a changelog and a tag per release. P0.2 says the first real update "will be the next skill release", but nothing defines a release.
- The update script is about 13 KB with three unit tests on pure functions; the isolated-home checks described in the roadmap are not in the repository as tests.

**Overall.** A careful, honest early-stage project with a good central idea and no proof yet that it changes agent behavior. P2 is the right bet only if it starts from recorded failures and stays as small as the tiers allow; the largest danger is building a planning framework, where several already exist, instead of sharpening the one thing this skill does better than they do.

## 9. Open decisions: recommendations

| Open decision in the plan | Recommendation |
| --- | --- |
| 1. Primary freshness net | Pre-commit `lint` with the error and warning split of section 4; agent hooks as reinforcement. |
| 2. Hermes Kanban bridge in the first version | No. Keep it as P2.6. |
| 3. Which agent verifies hooks first | Claude Code, and use the same host for the pilot. |
| 4. License route for private code | Independent implementation from the public spec. |
| 5. Concrete values | Set defaults in P2.1 with a one-line reason each, all configurable; revise after measurement. |
