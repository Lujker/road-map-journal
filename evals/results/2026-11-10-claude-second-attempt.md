# P0.1: Claude Code status scenario — second attempt

Date: 2026-11-10. **Observed answers: both correct. Full skill-condition verdict remains inconclusive**, because the live provider-bound system prompt was not captured independently. One run per condition is an exploratory observation, not a reliability or token-economy measurement.

## Setup

Claude Code 2.1.319 in WSL, model explicitly requested and observed as `claude-haiku-5-5` in both assistant message events and result `modelUsage`. Each used a fresh synthetic work copy and the identical question from [the scenario](../status-and-acceptance-eval.md). The allowed tools were `Glob,Read`, with `--restricted`, `--safe-mode`, permission mode `default`, strict MCP selection, no session persistence, and a four-turn ceiling. These restrictions are not claimed as a general OS-level sandbox. The `with` condition passed the public skill revision `bf4312098b524005f9f6d59081a858823dc54832` using `--append-system-prompt`; the `without` condition did not. This is explicit instruction injection, not a native project-skill discovery test.

## Observations

| Condition | Answer | Tool events and file comparison |
| --- | --- | --- |
| Without skill | A1 is PARTIAL; automated checks passed; the owner's manual acceptance remains; A2 must wait. | Two `Glob` calls followed by `Read PLAN.md`; pristine/work comparison returned `unchanged`. |
| With skill text specified | Same correct status and next step. Additionally noted that automated checks were recorded and had not been rerun in the session. | Three `Glob` calls and one `Read PLAN.md`; pristine/work comparison returned `unchanged`. |

The recorded events show no write-tool calls. The comparator checks fixture content and entries only, not every possible external, transient or metadata effect. A single run cannot establish that the skill caused the difference in wording or that the difference recurs.

## Instruction-injection preflight

A separate **model-free** preflight ran the same installed Claude CLI, model selector, safe/restricted modes, tools, permission mode and append option against a synthetic local Anthropic-compatible HTTP peer. With a synthetic-only API key and masked home directories, the peer captured outgoing JSON: the complete skill text was absent without the append option and present with it. The peer returned fixed scripted text; no real model output is claimed from that probe. The probe used host networking with the base URL explicitly pointed at loopback; it was not network-namespace isolated. It establishes behavior for the comparable local-peer path, but not an independent capture of the actual live provider-bound payload, so strict evaluation of the live skill condition remains inconclusive.

## Usage and model clarification

The CLI reported list-price estimates, not confirmed billing; individual usage details are withheld.

The [first attempt](2026-11-10-claude-first-attempt.md) used the `haiku` alias **with plan mode**: its init event named Haiku, but assistant events and usage reported Sonnet. The official [model configuration documentation](https://code.claude.com/docs/en/model-config) states that plan mode can upgrade a Haiku session to Sonnet. That is consistent with the observed events; the second attempt deliberately used default mode, a full Haiku model ID and a restricted read-only tool selection, and its actual assistant events reported Haiku.

Hermes and Codex also received narrower text-only checks. The owner closed the short comparison for this stage and deferred broader P0.1 coverage; see [Hermes](2026-11-10-hermes-text-comparison.md) and [Codex](2026-11-10-codex-text-control.md). This result does not test the broader autonomy concept.
