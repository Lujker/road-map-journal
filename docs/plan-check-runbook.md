# Runbook: the early L2 planning scenario (P5.34 a13)

For the owner. One safe, small task, run once, by hand. No production, no external writes, no mandate needed (L2: every card is approved by you). The contract tests do not replace this run; keep the evidence listed at the end.

Pick the task first: something in a sandbox or a scratch repository, reversible, with a result you can check yourself (for example "add a documented command to a throwaway project and a test for it"). Write the request in one or two sentences.

1. **Request.** Give the request to an agent in a normal session. Ask for a proposal file in the format of [roadctl.md](roadctl.md#plan-check-roadctl-plan-check-p534-early-slice): one card for a simple task, a few cards with `depends_on` for a big one, criteria with how each is checked, `env`, `role`, `effects`, `stop_conditions`. Save it outside the board (for example `/tmp/proposal.json`). The agent must not create cards yet.
2. **Check.** `roadctl plan check /tmp/proposal.json` (add `--json` to keep it). Exit 0 means the form is fine and every card is `proposed`; exit 1 lists refusals with reasons. Fix the file (or ask the agent to) and repeat. A note such as "no stop conditions" or "environment not described in the registry" is not an error but means the card is not ready for unattended work; fill the gap or leave it.
3. **Candidates.** For each card, `roadctl candidates --env ENV --role ROLE [--needs a,data:x]` (read only, P5.23). It says who is eligible and why others are refused; no candidate means no launch. Size does not choose the executor; you do, with this advice.
4. **Approve the plan.** You read the file and the result and decide. Nothing is created by `plan check`.
5. **Create the cards.** `roadctl new` for each card (the existing command), then fill Goal, Acceptance, `kind`, `size`, `env`, `role` and the Plan lines (Environment, Checks, Allowed changes, Stop conditions) from the file. Compare the board with the file card by card; `roadctl lint` should be clean.
6. **Approve and delegate.** `roadctl approve <id> --by <you>` for each card, then `roadctl delegate <id> --to ROLE --by AGENT` (or start it yourself). Dependencies go in order.
7. **Work.** The chosen executor works on the sandbox task and reports with `roadctl report` / `claim` as usual.
8. **Review.** Check the result yourself against each criterion's check method; `roadctl accept` or `return`. Run `roadctl stats` and note anything surprising.

Stop at any step that touches production or something outside the sandbox; that is outside this scenario.

**Evidence to keep** (for the card's a13): the request, the agent's proposal file, the `plan check` output (text and `--json`), the `candidates` output and which executor you chose, the created cards, and the report and your acceptance of the result. Note what was unclear or wrong in the proposal: that is the main product of this run.
