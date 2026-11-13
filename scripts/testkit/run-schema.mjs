// The contract of a run record, the element of `roadctl runs --json` (P5.1), as a checker. docs/roadctl.md ("Run ledger") describes the same fields.
// runRecordProblems(value) returns a list of problems; an empty list means the value fits. Strict on purpose: an unknown key, a missing key or a
// wrong type is a problem, so a change of the schema must change this file and the docs in the same commit.
import { KINDS, OUTCOMES, PROBLEM_KINDS, RUN_FIELDS, SKIP_REASONS, SOURCES } from '../roadctl/run-store.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v.length > 0;
const strOrNull = (v) => v === null || str(v);
const iso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v);
const isoOrNull = (v) => v === null || iso(v);
const strList = (v) => Array.isArray(v) && v.every((x) => str(x));

const CHECKS = {
  run_id: (v) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v),
  kind: (v) => KINDS.includes(v),
  id: str,
  project: strOrNull,
  agent: strOrNull,
  model: strOrNull,
  host: strOrNull,
  source: (v) => SOURCES.includes(v),
  started: isoOrNull,
  finished: isoOrNull,
  duration_s: (v) => v === null || (Number.isInteger(v) && v >= 0),
  outcome: (v) => OUTCOMES.includes(v),
  reason: strOrNull,
  attempt: (v) => Number.isInteger(v) && v >= 1,
  roadctl: strOrNull,
  usage: (v) => v === null, // reserved: P5.20 fills it
  did: strList,
  decisions: strList,
  problems: (v) => Array.isArray(v) && v.every((p) => isObj(p) && PROBLEM_KINDS.includes(p.kind) && str(p.key) && typeof p.text === 'string' && Object.keys(p).length === 3),
  needs_owner: strOrNull,
  not_checked: strOrNull,
  writes: strList,
  ref: strOrNull,
  note: strOrNull,
  count: (v) => Number.isInteger(v) && v >= 1,
  deadline: isoOrNull,
};

export function runRecordProblems(r) {
  if (!isObj(r)) return ['run: not an object'];
  const problems = [];
  for (const k of RUN_FIELDS) {
    if (!(k in r)) problems.push(`run: missing ${k}`);
    else if (!CHECKS[k](r[k])) problems.push(`run.${k}: wrong type or value (${JSON.stringify(r[k])})`);
  }
  for (const k of Object.keys(r)) if (!RUN_FIELDS.includes(k)) problems.push(`run: unknown key ${k}`);
  if (Object.keys(CHECKS).join() !== RUN_FIELDS.join()) problems.push('checker and RUN_FIELDS disagree (update both)');
  if (r.outcome === 'skipped' && !SKIP_REASONS.includes(r.reason)) problems.push(`run: skipped needs a reason of ${SKIP_REASONS.join('|')}`);
  if (r.outcome !== 'skipped' && SKIP_REASONS.includes(r.reason)) problems.push('run: a skip reason on a run that was not skipped');
  if (r.outcome === 'started' && r.finished !== null) problems.push('run: started with a finish time');
  if (r.outcome !== 'started' && r.finished === null) problems.push(`run: ${r.outcome} without a finish time`);
  return problems;
}
