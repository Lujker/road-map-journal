# P0.1: Hermes text-only comparison

Date: 2026-11-10. **Both answers were correct in this narrow text-only setup.** This is not an ordinary CLI file-discovery test or complete validation of agent behavior.

## Setup

Hermes Agent `v0.21.5+7752.g3285923` in WSL, using the installed `AIAgent` Python runtime directly (not a new `hermes chat` CLI session), provider `openai-codex` and requested model `gpt-6.1-terra`. Actual provider-returned model identity was not retained independently; do not treat the requested ID as proof of it.

The synthetic plan was supplied in the user prompt, and there was no file-discovery task. Each run had isolated HOME/HERMES_HOME in Bubblewrap, with the existing Hermes auth store mounted read-only, no credential copy, user home/mounted drives hidden, source/runtime mounted read-only and disposable runtime state. No general sandbox-security guarantee is claimed.

In the skill condition, `build_preloaded_skills_prompt` returned `loaded=['road-map-journal']`; its result was explicitly passed in the system message. In the control condition no skill content was loaded or passed. To reduce access, the harness cleared `AIAgent.tools` and `valid_tool_names` and replaced its invocation method with a deny function. This is a modified runtime harness, not an unmodified CLI preload test.

A model-free preflight against a synthetic local HTTP peer captured no tool definitions and observed the target skill marker in a with-condition conversation request but not in the control requests. A scripted unsolicited `terminal` tool call in a further preflight returned `Tool 'terminal' does not exist. Available tools:`; no terminal invocation was observed. These synthetic probes are not model answers and do not establish every possible escape or independently capture the live provider payload.

## Actual model-backed runs

| Condition | Observed answer | Tool events |
| --- | --- | --- |
| Without skill | A1 is PARTIAL; checks passed; manual acceptance is pending and must happen before DONE. | No tool calls in returned messages. |
| With explicitly preloaded skill text | Same conclusion and next step. | No tool calls in returned messages. |

Both runs reported `completed=true`. They did not mark A2 ready. No token-usage or actual served-model values were retained in the evaluation summary; do not infer costs or call totals. One observation each cannot demonstrate that the skill improves accuracy, efficiency, native discovery or long-running work. The short comparison is closed for this stage; broader P0.1 coverage is PARTIAL and deferred by the owner.
