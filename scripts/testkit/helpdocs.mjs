// "help = docs": the commands (and their flags) that `roadctl help` knows are the ones docs/roadctl.md describes.
// helpDocsProblems(table, { overview, docs }) works on plain data, so a test can feed it the real ALL_COMMANDS or an invented table.
//   table     { name: { hidden?, summary, purpose, usage, flags: [[flag, text], ...], examples, changes, exits, ... } }  (ALL_COMMANDS)
//   overview  the text of `roadctl help`
//   docs      the text of docs/roadctl.md
// Owner flag (P5.28): every command with `owner: true` is listed in the docs line "Owner-only commands: `a`, `b`" and that line names no other command.
// Returns problems as strings; an empty list means help and docs agree. A hidden command is exempt from the overview and the docs.

const FIELDS = ['summary', 'purpose', 'changes', 'exits'];
const flagsOf = (spec) => [...new Set((spec.flags ?? []).flatMap((f) => String(f[0]).match(/--[a-z][a-z0-9-]*/g) ?? []))];

export function helpDocsProblems(table, { overview, docs, exempt = {} }) {
  const problems = [];
  for (const [name, spec] of Object.entries(table)) {
    for (const f of FIELDS) if (!String(spec[f] ?? '').trim()) problems.push(`${name}: help field ${f} is empty`);
    for (const f of ['usage', 'examples']) if (!Array.isArray(spec[f]) || !spec[f].length) problems.push(`${name}: help field ${f} is empty`);
    if (spec.hidden) continue;
    if (!new RegExp(`^  ${name} +\\[(read|write|git)\\]`, 'm').test(overview)) problems.push(`${name}: not in the overview (roadctl help)`);
    if (exempt.docs?.includes(name)) continue;
    if (!new RegExp(`roadctl ${name}\\b`).test(docs)) problems.push(`${name}: not described in docs/roadctl.md (no "roadctl ${name}")`);
    for (const flag of flagsOf(spec)) if (!docs.includes(flag)) problems.push(`${name}: flag ${flag} is not in docs/roadctl.md`);
  }
  // P5.28: the owner flag of a command entry and the one "Owner-only commands:" line of the docs name the same commands
  const line = docs.match(/^Owner-only commands: (.+)$/m);
  const listed = new Set(line ? [...line[1].matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]) : []);
  const owners = Object.entries(table).filter(([, spec]) => spec.owner === true).map(([name]) => name);
  if (owners.length && !line) problems.push('docs/roadctl.md has no "Owner-only commands:" line');
  for (const name of owners) if (line && !listed.has(name)) problems.push(`${name}: owner command not listed in the "Owner-only commands:" line of docs/roadctl.md`);
  for (const name of listed) if (Object.hasOwn(table, name) && table[name].owner !== true) problems.push(`${name}: listed as owner-only in docs/roadctl.md but its command entry has no owner flag`);
  return problems;
}
