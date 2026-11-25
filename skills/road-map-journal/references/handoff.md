# Handing work over: assignment, review, lock, worktree, savings

For a coordinator that gives cards to other agents and for an agent that takes or reviews one. Works the same for a harness (Claude Code, Codex, pi) and for an orchestrator (a chat bot, a scheduler). Needs a board project with a `roadctl` that has `handoff`, `lock` and `worktree` (P5.41); without it write the same things by hand.

## Give a card

1. The card has an `approved` record, criteria with ids (`a1`, `a2`) and, ideally, a `Checks` line in its Delegation section with the test command.
2. `roadctl handoff <id> --to <who> [--role worker|reviewer|fixer]` prints the standard assignment: goal, open criteria, branch and worktree, test command under the lock, prohibitions, report format, savings advice. Send that text as it is; add a `--note` for one fact only you know. A fixer gets the review findings in `--note`.
3. Delegate on the board (`roadctl delegate`), as before. Who may take it is described in the roadctl docs ("Who takes the work").

## Work a card

- Work in your own worktree and branch: `roadctl worktree add <id>`. Never in the main checkout, never in the worktree of another card.
- Work under your own name (`ROADCTL_AS` or `--as`) and claim with the worktree: `roadctl claim <id> --as <you> --workdir <worktree>`. Without the claim and its workdir the limit checkpoint cannot bind to your card.
- Run tests only through the shared lock: `roadctl lock -- <test command>`. Two runs of one project never overlap.
- Commit in small separate commits. Do not merge into main, push, tag, `approve` or `done`; the coordinator does that after acceptance.
- Report with `roadctl report <id> --as <you> "<SHA, test result, what is not done>"` after one Evidence line per criterion. A report without code or evidence is a claim, not a result.
- After the merge `roadctl worktree prune <id>` removes the worktree and branch; it refuses a dirty or unmerged one without `--force`, and `--force` is the owner's or coordinator's call.

## Review a card

Return the work only for: (1) a violated criterion of the card, (2) a failing test or an incompatibility, (3) a defect you can reproduce with a concrete scenario (input, wrong result). Everything else (style, naming, a better idea, a risk without a scenario) goes into a "later" list in the verdict. It is not a return.

- At most two review rounds per card. After the second, stop and escalate any remaining blocker; only non-blocking follow-ups go to another card.
- A second review looks only at the earlier blockers and the new diff, not at the whole card.
- The verdict starts with one line: accept, accept with follow-ups, or return. Then each blocker with `file:line` and the scenario, then the "later" list.
- A reviewer is read-only: no commits, no `approve`, `done` or `accept`.
- Prefer a reviewer from a different model family than the author when the card is risky; one reviewer is enough for the rest.

## Save limits (work and answers)

- Short caveman style also while working: short plans, short commit messages, short Log and Evidence lines, no retelling of steps; read files in pieces, not whole.
- Questions about code: `codegraph explore "<symbol or question>"` before reading files, where it is installed.
- Output of git, gh and tests through `rtk` (`rtk git diff`, `rtk test <command>`), where it is installed; run without it when it hides what you need.
- A searched answer beats a rewritten one: look for the symbol, read that part, change that part.
