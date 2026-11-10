# P0.1: Claude Code status scenario — first attempt

Date: 2026-11-10. **Verdict: inconclusive for both conditions.** This document records actual model-backed runs, not the earlier synthetic HTTP-peer preflight. It does not establish whether the skill is useful or reliable.

## Setup

- Host: Claude Code CLI 2.1.319 on WSL, using an authenticated provider. Project source skill revision: `bf4312098b524005f9f6d59081a858823dc54832`, with no source-skill changes in the checkout.
- Two fresh synthetic copies of `fixtures/status-and-acceptance/`, both using the prompt in [the scenario](../status-and-acceptance-eval.md). `--safe-mode`, `--restricted`, plan permission mode, strict MCP selection, no session persistence, and the `Read` tool only. The `with` condition passed the public `SKILL.md` text explicitly through `--append-system-prompt`; the `without` condition did not. Actual provider-side system-prompt contents were not captured, so effective injection is not independently proven. This was not a native project-skill discovery test.
- The CLI was requested with `--model haiku` and low effort. **Both final results reported canonical model `claude-sonnet-5-5` instead.** Subsequent inspection found the init event named Haiku while assistant events named Sonnet; the official documentation describes upgrading Haiku to Sonnet in plan mode. See the [second-attempt record](2026-11-10-claude-second-attempt.md).

## Observed results

| Condition | Result | File activity | Evaluation |
| --- | --- | --- | --- |
| Without skill | The agent reported it could not find A1 or a roadmap and asked for a file path. | Tried `Read` on the working directory, `ROADMAP.md`, and `README.md`; fixture comparison returned `unchanged`. | Inconclusive: the harness exposed no directory listing/search tool. |
| With skill | The agent likewise could not locate the plan and requested its path. | Tried `Read` on the working directory and several guessed files; fixture comparison returned `unchanged`. | Inconclusive: same tool restriction, plus actual skill injection not independently captured. |

The fixture's plan was named `PLAN.md`. The selected `Read`-only tool surface could not list the directory or search for it; neither agent tried that filename. This is a test-harness limitation, not proof that either model or the skill failed to understand the plan. The comparator establishes only unchanged fixture contents/entries after each session, not the absence of transient or external side effects. Tool events were retained separately outside the public repository.

The CLI produced list-price estimates, not confirmed billing; individual usage details are withheld.

## Follow-up before any new run

Expose an appropriately scoped way to find the plan (for example Claude's `Glob` plus `Read`) and verify the actual agent/tool boundary first, or choose a deliberately explicit file path and record the reduced scope. Ensure the same tool surface in both conditions. Resolve model identity and the injection evidence separately. No automatic repeat, provider switch or additional model call is authorized by this observation.
