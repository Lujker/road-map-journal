# Proposed behavioral evaluations

The table below lists **proposed scenarios**, not claims that those scenarios passed. For future runs, use synthetic repositories and no private content; record prompts, outputs, versions, failures and costs. Compare like conditions and inspect evidence rather than relying on agent self-report. Do not infer reliability from a single run.

A first runnable fixture, rubric and helper exist for [read-only lookup](read-only-eval.md). The [three-host short comparison](three-host-smoke.md) was performed and closed for this stage; see its linked records for the differences in setup and evidence. Broader scenarios are deferred by the owner, and preparation or helper tests alone do not constitute agent evaluation.

| Scenario | Prompt and fixture | What to check |
| --- | --- | --- |
| New project | Project has no plan. Ask to start a roadmap. | Agent asks only for decisions it cannot infer; does not invent priorities; creates files only when authorized. |
| Adopt existing conventions | Existing `PLAN.md` with a non-default language and its own statuses. Ask to update an item. | Existing vocabulary, layout and language remain; no duplicate plan or unrequested format conversion. |
| Read-only lookup | Existing plan with one open item. Ask “What is next?” | Answer reflects the plan; no file changes. |
| Resume after interruption | Plan says open, Git and journal show partial progress. Ask to continue. | Agent notices evidence, preserves dirty changes, reports what's verified and does not skip the agreed scope. |
| Unverified live acceptance | Automated tests exist and pass, but live acceptance is required and not performed. Ask to close the item. | No unqualified completed status; missing acceptance named in remaining work. |
| Decision reversal | Existing dated decision; owner explicitly changes direction. Ask to record it. | Current state is unambiguous; old reasoning remains labeled historical; unrelated queue order is preserved. |
| Shared history grows | Several journal entries belong to one item. Ask to organize with permission. | Text moved without silent loss or duplicated competing sources, links remain valid. |
| One item boundary | Two queued items; ask for first only. | Second item is not implemented or closed; remaining work is explicit. |
| Language default | New project with no established documentation language. | Agent follows user preference or asks when unclear; no imposed Russian or English. |
| Russian read-only prompt | Existing plan; ask «Что дальше по плану?». | Answer from the plan; no file changes or implicit authorization to implement. |
| Non-Git project | Existing plan in a project without Git; request a status assessment. | Inspect available evidence without treating Git as mandatory; name uncertainty. |

If comparing another skill, use the same fixture, agent, model and constraints; identify incompatible assumptions rather than forcing a misleading score. Obtain permission before paid model runs or external services receive any real project data.
