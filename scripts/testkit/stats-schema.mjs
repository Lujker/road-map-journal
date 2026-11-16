// The contract of `roadctl stats --json` (P5.27), as a checker like mandate-schema.mjs: strict, an unknown key is a problem, so a change of the JSON changes this file
// and docs/roadctl.md in the same commit. statsJsonProblems(value) returns a list of problems; empty means it fits.
// Fields of the parts not built yet (P5.24, P5.34, P5.35) are already here as number-or-null, so they fill in later without a change of the schema.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = (v) => Number.isInteger(v) && v >= 0;
const numOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
const intOrNull = (v) => v === null || int(v);
const shareOrNull = (v) => v === null || (typeof v === 'number' && v >= 0 && v <= 1);
const strs = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function shape(value, where, spec, problems) {
  if (!isObj(value)) return problems.push(`${where}: not an object`);
  for (const [k, check] of Object.entries(spec)) if (!(k in value)) problems.push(`${where}: missing ${k}`);
  else if (!check(value[k])) problems.push(`${where}.${k}: wrong type or value (${JSON.stringify(value[k])})`);
  for (const k of Object.keys(value)) if (!(k in spec)) problems.push(`${where}: unknown key ${k}`);
}

export function statsJsonProblems(j) {
  const problems = [];
  const group = (v, where) => isObj(v) && Object.entries(v).forEach(([k, g]) => shape(g, `${where}[${k}]`, { runs: int, without_owner: int, share: shareOrNull }, problems));
  shape(j, 'stats', { stats: (v) => v === 1, generated: (v) => typeof v === 'string', since: (v) => v === null || typeof v === 'string', accept_from: (v) => v === null || typeof v === 'string', projects: strs, sources: isObj, runs: isObj, autonomy: isObj, owner_wait: isObj, escalations: isObj, returns: isObj, mandate: isObj }, problems);
  if (!isObj(j)) return problems;
  if (isObj(j.sources)) shape(j.sources, 'stats.sources', { board_logs: int, local_runs: int, owner_audit: int, owner_git: int }, problems);
  if (isObj(j.runs)) shape(j.runs, 'stats.runs', { total: int, ok: int, escalated: int, failed: int, crashed: int, timeout: int, aborted: int, skipped: (v) => isObj(v) && Object.values(v).every(int), duration_s: isObj }, problems);
  if (isObj(j.runs?.duration_s)) shape(j.runs?.duration_s, 'stats.runs.duration_s', { n: int, median: numOrNull, p90: numOrNull }, problems);
  if (isObj(j.autonomy)) shape(j.autonomy, 'stats.autonomy', { runs: int, without_owner: int, share: shareOrNull, by_routine: isObj, by_track: isObj }, problems);
  group(j.autonomy?.by_routine, 'stats.autonomy.by_routine');
  group(j.autonomy?.by_track, 'stats.autonomy.by_track');
  if (isObj(j.owner_wait)) shape(j.owner_wait, 'stats.owner_wait', { review_to_acceptance: isObj, question_to_answer: isObj }, problems);
  if (isObj(j.owner_wait?.review_to_acceptance)) shape(j.owner_wait?.review_to_acceptance, 'stats.owner_wait.review_to_acceptance', { n: int, median_days: numOrNull, p90_days: numOrNull, open: int, open_oldest_days: intOrNull, unknown_start: int }, problems);
  if (isObj(j.owner_wait?.question_to_answer)) shape(j.owner_wait?.question_to_answer, 'stats.owner_wait.question_to_answer', { n: int, median_days: numOrNull, p90_days: numOrNull }, problems);
  if (isObj(j.escalations)) shape(j.escalations, 'stats.escalations', { escalated_runs: int, asks: int, top_problems: Array.isArray }, problems);
  for (const [n, p] of (Array.isArray(j.escalations?.top_problems) ? j.escalations.top_problems : []).entries()) shape(p, `stats.escalations.top_problems[${n}]`, { key: (v) => typeof v === 'string', kind: (v) => typeof v === 'string', n: int }, problems);
  if (isObj(j.returns)) shape(j.returns, 'stats.returns', { returned: int, cards: int, task_reports: int, share_of_reports: shareOrNull }, problems);
  if (isObj(j.mandate)) shape(j.mandate, 'stats.mandate', { boards: Array.isArray, started_by_mandate: isObj, proposed: intOrNull, undone_share: shareOrNull, blocking_questions_per_week: numOrNull, milestone_returns: intOrNull }, problems);
  for (const [n, b] of (Array.isArray(j.mandate?.boards) ? j.mandate.boards : []).entries()) shape(b, `stats.mandate.boards[${n}]`, { project: (v) => typeof v === 'string', level: (v) => v === null || typeof v === 'string', state: (v) => typeof v === 'string' }, problems);
  if (isObj(j.mandate?.started_by_mandate)) shape(j.mandate?.started_by_mandate, 'stats.mandate.started_by_mandate', { n: int, cards: strs }, problems);
  return problems;
}
