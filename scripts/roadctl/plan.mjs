// `roadctl plan check FILE` (P5.34, the early read-only slice): one proposal file (JSON) for a collaborative session, a future mandate run and a future channel request, checked
// against the board and the mandate without a model, a network, a write or a start. The only positive results are "proposed" (a valid proposal; nothing is granted) and
// "in-mandate" (the card would be eligible for a START check by an approved L3/L4 mandate; the full admission of P5.33 is still made at START). Without a mandate, at L1/L2, or
// with a mandate that is not approved, unchanged and well formed, nothing is ever "in-mandate". Missing, template or unknown data never becomes permission.
//
//   { "plan": 1, "source": "collab|mandate|channel",
//     "cards": [ { "key": "c1", "title": "...", "goal": "...", "criteria": [ { "id": "a1", "text": "...", "check": "test: node --test x" } ],
//                  "kind": "fix", "size": "S", "env": "Local", "role": "worker", "needs": ["data:x"], "effects": "scripts/ only", "stop_conditions": "stop on a red test",
//                  "depends_on": ["c0", "P5.2"], "roadmap": "P5.34" | "mandate_goal": "G1" } ],
//     "milestones": [ { "title": "...", "cards": ["c1"], "meaning": "...", "goal_check": "how the overall goal is checked" } ] }   // form only; never applied here
// Node standard library only, no side effects at import.
import fs from 'node:fs';
import path from 'node:path';
import { KINDS, SIZES, readMandate } from './mandate.mjs';

export const DEFAULT_MAX_CARDS = 5; // used when the mandate has no plan_max_cards
export const CHECK_METHODS = ['test', 'command', 'inspect', 'review', 'owner'];
const MAX_FILE = 1 << 20;
const ROADMAP_RE = /^[A-Za-z]+\d+(?:\.\d+)*$/;
const TEMPLATE_RE = /^(\(.*\)|<.*>|tbd|todo|n\/a|none|unknown|template|\.\.\.|-|\?)$/i;
const clean = (s, n = 100) => String(s ?? '').replace(/[\u0000-\u001f\u007f`<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const str = (x) => (typeof x === 'string' ? x.trim() : '');
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const defined = (x) => str(x) !== '' && !TEMPLATE_RE.test(str(x));
const list = (x) => (Array.isArray(x) ? x : x === undefined ? [] : [x]).map((v) => str(v)).filter(Boolean);

/** The table of refusal reasons: a card (or the file) with one of these is refused. Everything else is a note on a proposal. */
export const REASONS = {
  'bad-file': 'the file is not a proposal: not JSON, not an object, `plan` is not 1, or `cards` is not a list',
  'no-goal': 'the card has no goal',
  'no-criterion': 'no checkable criterion: none, or none with a check method written',
  'no-link': 'no link to a ROADMAP item (`roadmap`) or a mandate goal (`mandate_goal`)',
  'unknown-goal': 'the mandate goal is not in the mandate Goals',
  'over-limit': 'more cards than the limit of one plan (plan_max_cards of the mandate, else the built-in default)',
  duplicate: 'same normalised title as an existing card, or the same mandate goal with the same criteria',
  'duplicate-in-file': 'the same, against an earlier card of this file',
  'unknown-dependency': 'depends_on names neither an existing card nor a card of this file',
  'dependency-cycle': 'the card is in a dependency cycle (or depends on itself)',
  'bad-milestone': 'a milestone has the wrong form: title, cards (of this file or existing), meaning and goal_check are required',
};

const statusOf = (board, c) => board.config.status_map?.[c.header.status ?? ''] ?? c.header.status ?? '';
const setKey = (c) => norm(c.criteria.map((x) => norm(x.text)).filter(Boolean).sort().join('|'));

function registryView(api, env) {
  let reg = null;
  try { reg = api.loadRegistry(env); } catch { /* a broken registry judges nothing */ }
  const envs = reg?.environments ? Object.keys(reg.environments).map((k) => k.toLowerCase()) : null;
  const roles = reg ? [...Object.keys(reg.preference ?? {}), ...Object.values(reg.agents ?? {}).flatMap((a) => (Array.isArray(a?.roles) ? a.roles : []))].map((r) => String(r).toLowerCase()) : null;
  return { envs, roles: roles?.length ? roles : null };
}

/** Pure check of a parsed proposal. `board` gives existing cards, `mandate` is readMandate() or null, `reg` is { envs, roles } (null = not judged). */
export function checkPlan(plan, { board, mandate, reg = {} }) {
  const fileReasons = [];
  const cards = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.plan !== 1 || !Array.isArray(plan.cards)) {
    return { result: 'refused', file_reasons: [{ code: 'bad-file', text: REASONS['bad-file'] }], limit: null, cards, milestones: { checked: false, problems: [] } };
  }
  const live = Boolean(mandate && mandate.state === 'approved' && !mandate.problems.length && (mandate.level === 'L3' || mandate.level === 'L4'));
  const limit = mandate?.plan_max_cards ?? DEFAULT_MAX_CARDS;
  const existing = board.cards.filter((c) => c.header.id && statusOf(board, c) !== 'dropped');
  const existingIds = new Set(existing.map((c) => c.header.id));
  const titles = new Map(existing.map((c) => [norm(c.header.title), c.header.id]));
  const goalSets = new Map(existing.filter((c) => c.header.goal && c.criteria.length).map((c) => [`${c.header.goal}\n${setKey(c)}`, c.header.id]));
  const keys = plan.cards.map((c, i) => str(c?.key) || `#${i + 1}`);
  const keySet = new Set(keys);
  const deps = plan.cards.map((c) => list(c?.depends_on));
  const inCycle = new Set();
  const visit = (i, stack) => {
    if (stack.includes(i)) { for (const j of stack.slice(stack.indexOf(i))) inCycle.add(j); return; }
    for (const d of deps[i]) { const j = keys.indexOf(d); if (j >= 0 && !inCycle.has(i)) visit(j, [...stack, i]); }
  };
  plan.cards.forEach((_, i) => visit(i, []));
  const seenTitle = new Map();
  const seenGoal = new Map();
  plan.cards.forEach((raw, i) => {
    const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const reasons = [];
    const notes = [];
    const refuse = (code, extra) => reasons.push({ code, text: extra ? `${REASONS[code]}: ${extra}` : REASONS[code] });
    if (i >= limit) refuse('over-limit', `${plan.cards.length} cards, limit ${limit}; this one is not recorded`);
    if (!defined(c.goal)) refuse('no-goal');
    const crit = (Array.isArray(c.criteria) ? c.criteria : []).filter((x) => x && typeof x === 'object' && defined(x.text));
    const checks = crit.map((x) => str(x.check));
    if (!crit.length || !checks.some((x) => defined(x))) refuse('no-criterion');
    const unknownMethod = checks.some((x) => !CHECK_METHODS.includes(x.split(':')[0].trim().toLowerCase()) || !defined(x.slice(x.indexOf(':') + 1)));
    if (crit.length && unknownMethod) notes.push(`a check method is missing, a template or unknown (known: ${CHECK_METHODS.join(', ')}; "test: <what is run>")`);
    const goalId = str(c.mandate_goal);
    const road = str(c.roadmap);
    if (!goalId && !ROADMAP_RE.test(road)) refuse('no-link');
    else if (goalId && mandate && !mandate.goals.some((g) => g.id === goalId)) refuse('unknown-goal', clean(goalId, 30));
    else if (goalId && !mandate) notes.push('mandate_goal cannot be verified: the board has no mandate');
    const t = norm(c.title);
    if (!t) notes.push('the card has no title');
    if (t && titles.has(t)) refuse('duplicate', `${titles.get(t)} has the same title`);
    else if (t && seenTitle.has(t)) refuse('duplicate-in-file', `same title as ${keys[seenTitle.get(t)]}`);
    const gk = goalId && crit.length ? `${goalId}\n${setKey({ criteria: crit })}` : null;
    if (gk && goalSets.has(gk)) refuse('duplicate', `${goalSets.get(gk)} has the same goal and criteria`);
    else if (gk && seenGoal.has(gk)) refuse('duplicate-in-file', `same goal and criteria as ${keys[seenGoal.get(gk)]}`);
    if (t && !seenTitle.has(t)) seenTitle.set(t, i);
    if (gk && !seenGoal.has(gk)) seenGoal.set(gk, i);
    for (const d of deps[i]) if (!existingIds.has(d) && !keySet.has(d)) refuse('unknown-dependency', clean(d, 30));
    if (inCycle.has(i)) refuse('dependency-cycle');
    // what is needed before a START could ever look at the card; none of it is permission
    const k = str(c.kind);
    const s = str(c.size);
    if (!KINDS.includes(k)) notes.push(k ? `kind ${clean(k, 20)} is unknown` : 'no kind');
    if (!SIZES.includes(s)) notes.push(s ? `size ${clean(s, 20)} is unknown (it is not normalised to S)` : 'no size');
    const env = str(c.env);
    const role = str(c.role);
    if (!defined(env)) notes.push('no environment (env)');
    else if (reg.envs && !reg.envs.includes(env.toLowerCase())) notes.push(`environment ${clean(env, 40)} is not described in the registry`);
    if (!defined(role)) notes.push('no role');
    else if (reg.roles && !reg.roles.includes(role.toLowerCase())) notes.push(`role ${clean(role, 30)} is not in the registry`);
    if (!defined(c.effects)) notes.push('no permitted effects (effects)');
    if (!defined(c.stop_conditions)) notes.push('no stop conditions (stop_conditions)');
    const definite = !notes.length;
    if (!reasons.length) {
      if (!mandate) notes.push('no mandate: a proposal only');
      else if (!live) notes.push(`the mandate does not take cards now (state ${mandate.state}, level ${mandate.level ?? '?'}${mandate.problems.length ? ', malformed' : ''}): a proposal only`);
      else {
        if (KINDS.includes(k) && !mandate.kinds.includes(k)) notes.push(`kind ${k} is outside the mandate (${mandate.kinds.join(', ')}): not for auto-admission`);
        if (SIZES.includes(s) && mandate.max_size && SIZES.indexOf(s) > SIZES.indexOf(mandate.max_size)) notes.push(`size ${s} is above max_size ${mandate.max_size}: not for auto-admission`);
        if (!goalId) notes.push('no mandate goal (only a ROADMAP link): not for auto-admission');
      }
    }
    const inMandate = !reasons.length && live && definite && !notes.length;
    cards.push({ key: keys[i], title: clean(c.title, 80), result: reasons.length ? 'refused' : inMandate ? 'in-mandate' : 'proposed', reasons, notes });
  });
  const problems = [];
  if (plan.milestones !== undefined) {
    if (!Array.isArray(plan.milestones)) problems.push('milestones must be a list');
    else plan.milestones.forEach((m, i) => {
      const ok = m && typeof m === 'object' && defined(m.title) && defined(m.meaning) && defined(m.goal_check) && list(m.cards).length;
      if (!ok) problems.push(`milestone ${i + 1}: needs title, meaning, goal_check and cards`);
      else for (const x of list(m.cards)) if (!keySet.has(x) && !existingIds.has(x)) problems.push(`milestone ${i + 1}: card ${clean(x, 30)} is neither in this file nor on the board`);
    });
  }
  if (problems.length) fileReasons.push({ code: 'bad-milestone', text: `${REASONS['bad-milestone']}: ${problems.join('; ')}` });
  const refused = fileReasons.length || cards.some((c) => c.result === 'refused');
  return { result: refused ? 'refused' : 'proposed', file_reasons: fileReasons, limit, cards, milestones: { checked: plan.milestones !== undefined, problems, applied: false } };
}

function planCommand(ctx) {
  const { flags, args, out, api, env } = ctx;
  const usage = 'usage: roadctl plan check FILE [--json]';
  if (args[1] !== 'check' || !args[2] || args.length > 3) throw new Error(usage);
  const dir = api.findBoard(process.cwd(), typeof flags.board === 'string' ? flags.board : undefined, env);
  if (!dir) throw new Error('no board found; run inside the project or use --board DIR / --project NAME');
  const board = api.loadBoard(dir);
  const file = path.resolve(args[2]);
  let raw;
  try {
    if (fs.statSync(file).size > MAX_FILE) throw new Error(`${clean(args[2], 60)} is larger than ${MAX_FILE} bytes`);
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${clean(args[2], 60)}: ${clean(e.message, 80)}`);
  }
  let plan = null;
  try { plan = JSON.parse(raw); } catch { /* bad-file below */ }
  const mandate = readMandate(board, api);
  const r = checkPlan(plan, { board, mandate, reg: registryView(api, env) });
  const res = { file: args[2], mandate: mandate ? { state: mandate.state, level: mandate.level, hash: mandate.hash } : null, ...r, reasons_table: REASONS, summary: { cards: r.cards.length, refused: r.cards.filter((c) => c.result === 'refused').length, proposed: r.cards.filter((c) => c.result === 'proposed').length, in_mandate: r.cards.filter((c) => c.result === 'in-mandate').length } };
  if (flags.json) out(JSON.stringify(res, null, 2));
  else {
    out(`plan check ${clean(args[2], 60)}: ${r.result} | mandate ${mandate ? `${mandate.state}, level ${mandate.level ?? '?'}` : 'none'} | card limit ${r.limit ?? '-'} | ${res.summary.cards} card(s): ${res.summary.in_mandate} in-mandate, ${res.summary.proposed} proposed, ${res.summary.refused} refused`);
    for (const f of r.file_reasons) out(`  FILE refused [${f.code}]: ${f.text}`);
    for (const c of r.cards) {
      out(`  [${c.key}] ${c.title || '(no title)'}: ${c.result}`);
      for (const x of c.reasons) out(`      refused [${x.code}] ${x.text}`);
      for (const x of c.notes) out(`      note: ${x}`);
    }
    if (r.milestones.checked) out(`  milestones: form ${r.milestones.problems.length ? 'has problems' : 'ok'} (checked only, not applied)`);
    const used = [...new Set([...r.file_reasons, ...r.cards.flatMap((c) => c.reasons)].map((x) => x.code))];
    if (used.length) { out('  refusal reasons:'); for (const code of used) out(`    ${code.padEnd(18)} ${REASONS[code]}`); }
    out('  "proposed" grants nothing: approve, or a START by an approved L3/L4 mandate, comes later. Nothing was written.');
  }
  return r.result === 'refused' ? 1 : 0;
}

export default {
  name: 'plan',
  commands: {
    plan: {
      group: 'Look', effect: 'read', hidden: true, // the overview is at its 70-line cap; docs/roadctl.md names it
      summary: 'check a card proposal (JSON) against the board and the mandate; read only',
      purpose: 'Reads one proposal file and says, per card, "refused" (with the reason from the table), "proposed" (valid; grants nothing) or "in-mandate" (an approved L3/L4 mandate could take it at START; the full admission is made then). Refusals: no goal, no checkable criterion, no link to a ROADMAP item or mandate goal, a mandate goal that does not exist, more cards than plan_max_cards (built-in default 5), a duplicate of an existing card or inside the file, a dependency on an unknown card, a dependency cycle, a milestone of the wrong form. Kind or size outside the mandate, and a missing, template or unknown env, role, effects, stop conditions or check method, leave a valid proposal and are never permission. Without a mandate, at L1/L2 or with an unapproved, changed or malformed mandate the result is at most "proposed". No model, no network, no write, no start.',
      usage: ['roadctl plan check FILE [--json]'],
      flags: [['--json', 'machine-readable output (cards, reasons, notes, the table of refusal reasons)']],
      examples: ['roadctl plan check proposal.json', 'roadctl plan check proposal.json --json'],
      changes: 'Nothing.',
      exits: '0 no refusal (every card proposed or in-mandate); 1 the file or a card is refused; 2 usage error, no board, unreadable file',
      run: planCommand,
    },
  },
};
