// The contract of `roadctl mandate show|check --json` (P5.33), as a checker like tick-schema.mjs: strict, an unknown key is a problem, so a change of the JSON
// changes this file and docs/roadctl.md in the same commit. mandateJsonProblems(value) returns a list of problems; empty means it fits.
export const MANDATE_STATES = ['none', 'unapproved', 'approved', 'changed'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v) => v === null || typeof v === 'string';
const strs = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function shape(value, where, spec, problems) {
  if (!isObj(value)) return problems.push(`${where}: not an object`);
  for (const [k, check] of Object.entries(spec)) if (!(k in value)) problems.push(`${where}: missing ${k}`);
  else if (!check(value[k])) problems.push(`${where}.${k}: wrong type or value (${JSON.stringify(value[k])})`);
  for (const k of Object.keys(value)) if (!(k in spec)) problems.push(`${where}: unknown key ${k}`);
}

export function mandateJsonProblems(j) {
  const problems = [];
  shape(j, 'mandate', {
    project: (v) => typeof v === 'string' && v.length > 0, file: strOrNull, exists: (v) => typeof v === 'boolean', state: (v) => MANDATE_STATES.includes(v), hash: strOrNull,
    approved: (v) => v === null || (isObj(v) && typeof v.by === 'string'), level: strOrNull, kinds: strs, max_size: strOrNull, merge: strOrNull, budget: (v) => v === null || isObj(v),
    goals: (v) => Array.isArray(v) && v.every((g) => isObj(g) && typeof g.id === 'string' && Number.isInteger(g.priority) && typeof g.text === 'string'), forbidden: strs, tell_owner: isObj, problems: strs,
    takes: (v) => typeof v === 'boolean', tick: isObj,
  }, problems);
  if (!isObj(j)) return problems;
  if (isObj(j.tell_owner)) {
    shape(j.tell_owner, 'mandate.tell_owner', { floor: (v) => strs(v) && v.length > 0, extra: strs }, problems);
  }
  if (isObj(j.tick)) {
    shape(j.tick, 'mandate.tick', { next: strOrNull, cards: Array.isArray }, problems);
    for (const [n, c] of (Array.isArray(j.tick.cards) ? j.tick.cards : []).entries()) shape(c, `mandate.tick.cards[${n}]`, { id: (v) => typeof v === 'string', admitted: (v) => typeof v === 'boolean', reasons: strs, rank: (v) => v === null || Number.isInteger(v) }, problems);
  }
  if (!j.exists && j.state !== 'none') problems.push('mandate: no file but a state');
  if (j.takes && j.state !== 'approved') problems.push('mandate: takes without an approved mandate');
  return problems;
}
