# P0.1: small three-host comparison plan

Status: **the short comparisons are closed for this stage; broader P0.1 coverage is deferred**. See [Claude](results/2026-11-10-claude-second-attempt.md), [Codex](results/2026-11-10-codex-text-control.md) and [Hermes](results/2026-11-10-hermes-text-comparison.md); Codex and Hermes used narrower text-only harnesses and Codex logged a known code-mode error. The owner wants future evaluation to reflect management of long-running work; this exploratory plan does not demonstrate general reliability or autonomous-orchestration acceptance.

## Smallest planned batch

- Use [status-and-acceptance-eval.md](status-and-acceptance-eval.md): a single short synthetic fixture and one question about the status and next step.
- Run at most one session **without** and one **with** the public skill on each host: six sessions total. Each session may require multiple model/tool API calls, so six sessions are not a six-call or hard-cost guarantee. Execute serially and inspect the result, resolved model and quota between sessions; stop on a model mismatch, and do not retry, switch provider or launch extra sessions automatically after an error.
- Before running, verify the same read-only tool surface in both conditions can discover the fixture file, e.g. scoped `Glob` plus `Read`; alternatively provide the filename explicitly and document the narrower scenario.
- Within each host pair use the same model, fixture, question, permissions and settings. The only intended change is skill content. Hosts, prompts used to explicitly activate a skill, and chosen model families may differ; record these differences and avoid cross-host model-ranking claims.
- Record the raw transcript/tool events and usage in a disposable private output area; before publishing anything, inspect and remove private data or credentials. Record provider-reported tokens and cost basis, not invented subscription percentages or charges.
- A successful pair only describes this scenario on that specific setup. It cannot establish general reliability, economy, agent coordination, pause, recovery or budget controls. Extend only after separately agreeing on further work.

## Fixture preparation, no model calls

Run from the project root, replacing the destination with a **new, nonexistent directory outside the checkout**:

```sh
python3 evals/prepare_small_comparison.py /absolute/path/to/new-eval-directory
```

The preparer makes six disposable cases, each with a pristine `before` and `work` copy and a `not-run` manifest entry. Skill copies are scoped to the case: isolated Hermes home, or `.agents/skills` / `.claude/skills` inside the Codex / Claude work copies. It does not copy credentials, start agents or contact a provider. It refuses an existing destination and symlinks in the source. Different skills directories do not by themselves prove that a host loads or uses the intended skill. Never rely on the manifest as evidence of a model run.

`python3 -m unittest discover -s evals/tests -v` checks the preparer and read-only comparator without model calls. Compare `before` and `work` with `evals/check_read_only.py`, and inspect actual tool/action records: the comparator cannot detect an attempted or reverted write, metadata-only effects or effects outside the copied work directory.

## WSL preflight completed without model calls

| Host | Installed version | What was verified | What remains |
| --- | --- | --- | --- |
| Hermes | `v0.21.5+7752.g3285923` | Isolated loader distinguishes present/absent skill; offline synthetic peer exercised real `read_file` and explicit system-message injection. | Prove actual networked run with correct payload, tool boundary and subscription credentials. Native `-s` injection was not established by the synthetic peer. See [read-only-eval.md](read-only-eval.md). |
| Codex | `codex-cli 0.165.0` | `app-server` initialized offline in clean temporary homes; `skills/list` found the copied repo skill only in the skill condition. Installed CLI advertises `read-only` sandbox, `--ignore-user-config`, `--ephemeral`, and JSON events. | Discovery is not behavioral use; verify actual skill activation, auth, command execution boundary and logs at run time. Never use `danger-full-access` to work around a failed sandbox. |
| Claude Code | `2.1.319` | Offline native-control initialization with no user prompt succeeded in isolated temporary homes. With project settings and external filesystem/network isolation, `commands` listed the project skill only when copied into `.claude/skills`. | Model use and actual invocation are not tested. In a separate preflight, `--restricted` did **not** list that project skill; do not claim it is active merely because files exist. A safe alternative is explicit source-text system-prompt injection, but that tests instruction behavior, not native discovery; prove the exact runtime behavior and disclose it. |

A separate [Codex text-only preflight](codex-text-only-preflight.md) observed an empty tool list and an instruction marker using a local synthetic peer. It is narrower than the original fixture-discovery scenario and does not establish live provider behavior or authorize changing the comparison without owner agreement.

The first Claude probe without sufficient filesystem masking saw the skill even in the control condition; a follow-up with home and mounted host filesystem hidden produced the separate results above. A clean `HOME` variable alone is not evidence that inherited skills and instructions are absent. The `--restricted` and non-restricted probes used the same otherwise isolated setup; they establish command-list observations only.

## Model and quota decisions at execution time

Select models or subscription aliases only after checking their availability and securing authorization; keep each host's with/without pair on the same model and record its resolved identity. Do not silently fall back to a different provider or an API-billed route.

Immediately before the first authorized run, the owner and executor must have an agreed current per-provider budget/reserve and stopping rule. Read the actual usage where available before and after each session, identify shared-account effects, and stop if the agreed limit is reached, data are unavailable, or a run has an uncertain outcome. A wall-clock limit, iteration cap, estimated list price or number of sessions is not a guaranteed monetary cap. Prior threshold authorization does not authorize resetting a reached baseline. A fresh owner instruction to start is required; it does not automatically select numeric limits, authorize provider changes or prove the experiment sandbox is safe.
