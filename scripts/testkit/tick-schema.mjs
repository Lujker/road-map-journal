// The contract of `roadctl tick --json` (what scheduler examples and later modules may rely on), as a checker.
// tickJsonProblems(value) returns a list of problems; an empty list means the value fits the contract.
// The check is strict on purpose: an unknown key is a problem, so a change of the JSON must change this file (and docs/roadctl.md) too.
// A paused machine (P5.5, `roadctl pause`) prints decision `paused` with `items: []`, `limits: {provider: null, state: "not-checked"}` and the extra key `pause`
// { since, by, reason, until } (strings or null); exit 6. Nothing was pulled and no limits gate was asked.
// Not covered: `tick` prints no JSON when another tick of the agent runs (text "tick AGENT: busy", exit 5) and on a usage error (exit 2);
// a consumer treats anything that is not JSON as "no work", the exit code says why.

export const TICK_DECISIONS = ['idle', 'work', 'blocked-reserve', 'blocked-unknown', 'paused'];
export const TICK_KINDS = ['TAKE', 'ACCEPT', 'START', 'STALE', 'RUN'];
export const LIMIT_STATES = ['allowed', 'reserve', 'unknown', 'not-applicable', 'not-checked'];
/** Exit code per decision (the text mode has the same ones; busy is 5 and prints no JSON). */
export const TICK_EXIT_BY_DECISION = { work: 0, idle: 4, 'blocked-reserve': 1, 'blocked-unknown': 3, paused: 6 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const strOrNull = (v) => v === null || typeof v === 'string';

function shape(value, where, required, optional, problems) {
  if (!isObj(value)) {
    problems.push(`${where}: not an object`);
    return false;
  }
  for (const [k, check] of Object.entries(required)) if (!(k in value)) problems.push(`${where}: missing ${k}`);
  else if (!check(value[k])) problems.push(`${where}.${k}: wrong type or value (${JSON.stringify(value[k])})`);
  for (const [k, check] of Object.entries(optional)) if (k in value && !check(value[k])) problems.push(`${where}.${k}: wrong type or value (${JSON.stringify(value[k])})`);
  for (const k of Object.keys(value)) if (!(k in required) && !(k in optional)) problems.push(`${where}: unknown key ${k}`);
  return true;
}

export function tickJsonProblems(j) {
  const problems = [];
  if (!shape(j, 'tick', { agent: isStr, decision: (v) => TICK_DECISIONS.includes(v), limits: isObj, items: Array.isArray, sync: (v) => Array.isArray(v) && v.every(isStr), ...(j?.decision === 'paused' ? { pause: isObj } : {}) }, {}, problems)) return problems; // `pause` exists with the decision paused only (otherwise it is an unknown key)
  if (j.decision === 'paused') {
    shape(j.pause, 'tick.pause', { since: strOrNull, by: strOrNull, reason: strOrNull, until: strOrNull }, {}, problems);
    if (j.items.length) problems.push('tick: paused with items');
    if (j.limits?.state !== 'not-checked' || j.limits?.provider !== null) problems.push('tick: paused asks no limits gate (provider null, state not-checked)');
    if (j.sync.length) problems.push('tick: paused pulls nothing (sync is empty)');
  }
  shape(j.limits, 'tick.limits', { provider: strOrNull, state: (v) => LIMIT_STATES.includes(v) }, { windows: (v) => Array.isArray(v) && v.length > 0 && v.every(isStr) }, problems);
  if (isObj(j.limits) && 'windows' in j.limits && j.limits.state !== 'reserve') problems.push('tick.limits: windows only with state reserve');
  if (j.decision === 'idle' && j.items.length) problems.push('tick: idle with items');
  if (!['idle', 'paused'].includes(j.decision) && !j.items.length) problems.push(`tick: ${j.decision} without items`);
  if (j.decision === 'blocked-reserve' && j.limits?.state !== 'reserve') problems.push('tick: blocked-reserve needs limits.state reserve');
  if (j.decision === 'blocked-unknown' && j.limits?.state !== 'unknown') problems.push('tick: blocked-unknown needs limits.state unknown');
  if (j.decision === 'work' && ['reserve', 'unknown'].includes(j.limits?.state)) problems.push('tick: work with a closed limits gate');
  j.items.forEach((item, n) => {
    const at = `tick.items[${n}]`;
    const base = { kind: (v) => TICK_KINDS.includes(v), project: isStr, id: isStr, title: (v) => typeof v === 'string' };
    const kind = item?.kind;
    if (kind === 'RUN') shape(item, at, { ...base, routine: isObj }, {}, problems);
    else if (kind === 'START') shape(item, at, base, {}, problems);
    else shape(item, at, { ...base, delegate: isObj }, kind === 'STALE' ? { workdir_dirty: (v) => v === true } : {}, problems);
    if (!isObj(item)) return;
    if (kind === 'RUN' && isObj(item.routine)) shape(item.routine, `${at}.routine`, { agent: isStr, model: isStr, env: isStr, every: isStr, file: isStr, last_run: strOrNull }, { attempt: (v) => Number.isInteger(v) && v >= 2 }, problems); // attempt (0.3.0, P5.1): only after a crashed or failed run of the routine
    if (['TAKE', 'ACCEPT', 'STALE'].includes(kind) && isObj(item.delegate)) {
      shape(item.delegate, `${at}.delegate`, { to: isStr, host: isStr, criteria: (v) => v === 'all' || (Array.isArray(v) && v.every(isStr)), by: isStr, accept: isStr, state: isStr }, { claim: isObj }, problems);
      if (isObj(item.delegate.claim)) shape(item.delegate.claim, `${at}.delegate.claim`, { agent: isStr, until: isStr }, { workdir: isStr }, problems);
    }
  });
  return problems;
}
