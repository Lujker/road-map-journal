// "help = docs": the commands (and their flags) that `roadctl help` knows are the ones docs/roadctl.md describes.
// helpDocsProblems(table, { overview, docs }) works on plain data, so a test can feed it the real ALL_COMMANDS or an invented table.
//   table     { name: { hidden?, summary, purpose, usage, flags: [[flag, text], ...], examples, changes, exits, ... } }  (ALL_COMMANDS)
//   overview  the text of `roadctl help`
//   docs      the text of docs/roadctl.md
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
  return problems;
}
