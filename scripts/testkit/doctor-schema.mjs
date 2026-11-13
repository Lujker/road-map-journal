// The contract of `roadctl doctor --json` (P5.9), checked strictly: an unknown key is a problem, so a change of the JSON changes this file
// and docs/roadctl.md in the same commit. doctorJsonProblems(json) returns problems as strings; an empty list means the shape is right.
const TOP = ['schema', 'roadctl', 'platform', 'node', 'online', 'agent', 'ok', 'summary', 'checks'];
const CHECK = ['id', 'subject', 'status', 'detail', 'hint'];
const STATUSES = ['ok', 'warn', 'fail', 'skip'];
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const strOrNull = (x) => x === null || typeof x === 'string';

export function doctorJsonProblems(j) {
  const p = [];
  if (!isObj(j)) return ['not an object'];
  for (const k of Object.keys(j)) if (!TOP.includes(k)) p.push(`unknown key ${k}`);
  for (const k of TOP) if (!(k in j)) p.push(`missing key ${k}`);
  if (j.schema !== 1) p.push('schema must be 1');
  if (!isObj(j.roadctl) || typeof j.roadctl.version !== 'string' || !(typeof j.roadctl.sha === 'string' || j.roadctl.sha === null) || Object.keys(j.roadctl).length !== 2) p.push('roadctl must be {version: string, sha: string|null}');
  if (typeof j.platform !== 'string') p.push('platform must be a string');
  if (typeof j.node !== 'string') p.push('node must be a string');
  if (typeof j.online !== 'boolean') p.push('online must be a boolean');
  if (!strOrNull(j.agent)) p.push('agent must be a string or null');
  if (typeof j.ok !== 'boolean') p.push('ok must be a boolean');
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  if (!Array.isArray(j.checks)) p.push('checks must be an array');
  else {
    j.checks.forEach((c, i) => {
      if (!isObj(c)) return p.push(`checks[${i}] is not an object`);
      for (const k of Object.keys(c)) if (!CHECK.includes(k)) p.push(`checks[${i}]: unknown key ${k}`);
      if (typeof c.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(c.id)) p.push(`checks[${i}]: id must be like "board-git"`);
      if (!strOrNull(c.subject)) p.push(`checks[${i}]: subject must be a string or null`);
      if (!STATUSES.includes(c.status)) p.push(`checks[${i}]: bad status ${c.status}`);
      else counts[c.status]++;
      if (typeof c.detail !== 'string' || !c.detail) p.push(`checks[${i}]: detail must be a non-empty string`);
      if (!strOrNull(c.hint)) p.push(`checks[${i}]: hint must be a string or null`);
      if (c.status === 'fail' && !c.hint) p.push(`checks[${i}] (${c.id}): a failure needs a hint`);
    });
  }
  if (!isObj(j.summary) || Object.keys(j.summary).sort().join() !== 'fail,ok,skip,warn') p.push('summary must be {ok, warn, fail, skip}');
  else if (Array.isArray(j.checks)) {
    for (const k of STATUSES) if (j.summary[k] !== counts[k]) p.push(`summary.${k} is ${j.summary[k]} but ${counts[k]} checks have it`);
    if (j.ok !== (j.summary.fail === 0)) p.push('ok must be true exactly when summary.fail is 0');
  }
  return p;
}
