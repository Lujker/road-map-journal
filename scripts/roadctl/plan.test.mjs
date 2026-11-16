// P5.34 early slice: `roadctl plan check FILE` (module plan.mjs). Read only, no model, no network. Fixtures only.
// Run: node --test scripts/roadctl/plan.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HASH_KEY, approvalHash } from './approval-hash.mjs';
import { DEFAULT_MAX_CARDS } from './plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const MANDATE = (o = {}) => `---\nmandate: 1\nlevel: ${o.level ?? 'L3'}\nkinds: fix, docs\nmax_size: M\nbudget: cards_per_day=2, runs_per_week=10\n${o.extra ?? ''}---\n\n## Goals\n- G1 (priority 1): finish\n\n## Forbidden\n- main\n`;
const CARD = (id, title) => `---\nid: ${id}\ntitle: ${title}\nstatus: ready\nas_of: 2026-11-10\n---\n\n## Goal\nx\n\n## Acceptance\n- [ ] a1: it works\n`;
const good = (key, over = {}) => ({ key, title: `Task ${key}`, goal: 'do it', criteria: [{ id: 'a1', text: `works ${key}`, check: 'test: node --test x' }], kind: 'fix', size: 'S', env: 'Local', role: 'worker', effects: 'scripts/ only', stop_conditions: 'stop on a red test', roadmap: 'P5.34', mandate_goal: 'G1', ...over });

function rig({ mandate, cards = {}, reg } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-plan-'));
  const board = path.join(dir, 'ws', 'projects', 'app', 'board');
  fs.mkdirSync(path.join(board, 'cards'), { recursive: true });
  fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ board_version: 1, title: 'App', status_map: {}, requires: '0.8.0' }));
  for (const [id, t] of Object.entries(cards)) fs.writeFileSync(path.join(board, 'cards', `${id}.md`), CARD(id, t));
  const approve = (t) => `${t.replace(/\n---\n/, `\napproved: Owner, 2026-11-10\n${HASH_KEY}: ${approvalHash(t)}\n---\n`)}`;
  if (mandate) fs.writeFileSync(path.join(board, 'mandate.md'), mandate.approved === false ? mandate.text : approve(mandate.text));
  const regFile = path.join(dir, 'registry.json');
  if (reg) fs.writeFileSync(regFile, JSON.stringify(reg));
  const env = { ...process.env, HOME: dir, USER: 'tester', XDG_STATE_HOME: path.join(dir, 's'), XDG_CONFIG_HOME: path.join(dir, 'c'), ROADCTL_WORKSPACE: path.join(dir, 'ws'), ROADCTL_REGISTRY: reg ? regFile : path.join(dir, 'none.json'), ROADCTL_DATE: '2026-11-10' };
  const snap = () => fs.readdirSync(dir, { recursive: true }).map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`).sort().join('\n');
  const check = (plan, extra = []) => {
    const f = path.join(dir, 'proposal.json');
    fs.writeFileSync(f, typeof plan === 'string' ? plan : JSON.stringify(plan));
    const before = snap();
    const r = spawnSync(process.execPath, [SELF, 'plan', 'check', f, '--board', board, ...extra], { cwd: dir, encoding: 'utf8', env });
    assert.equal(snap(), before, 'plan check writes nothing');
    return r;
  };
  const json = (plan) => { const r = check(plan, ['--json']); return { status: r.status, ...JSON.parse(r.stdout) }; };
  return { check, json, board };
}
const L3 = { text: MANDATE() };
const codes = (r, i = 0) => r.cards[i].reasons.map((x) => x.code);

test('P5.34 a1: correct cards are accepted; inside an approved L3 mandate they are in-mandate, exit 0', () => {
  const r = rig({ mandate: L3 }).json({ plan: 1, cards: [good('c1'), good('c2', { depends_on: ['c1'], mandate_goal: 'G1', criteria: [{ id: 'a1', text: 'other', check: 'review: owner reads it' }] })] });
  assert.equal(r.status, 0);
  assert.equal(r.result, 'proposed');
  assert.deepEqual(r.cards.map((c) => c.result), ['in-mandate', 'in-mandate']);
  assert.equal(r.limit, DEFAULT_MAX_CARDS);
});

test('P5.34 a1: refusal table: no goal, no criterion, no link, unknown goal', () => {
  const r = rig({ mandate: L3 }).json({ plan: 1, cards: [good('c1', { goal: '' }), good('c2', { criteria: [] }), good('c3', { criteria: [{ id: 'a1', text: 'x', check: '' }] }), good('c4', { mandate_goal: '', roadmap: '' }), good('c5', { mandate_goal: 'G9' })] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.cards.map((c) => codes(r, r.cards.indexOf(c))), [['no-goal'], ['no-criterion'], ['no-criterion'], ['no-link'], ['unknown-goal']]);
  assert.ok(r.reasons_table['no-goal'] && r.reasons_table['dependency-cycle'], 'the output carries the table of reasons');
});

test('P5.34 a1: card limit (mandate plan_max_cards, else the built-in default), duplicates, dependencies', () => {
  const m = { text: MANDATE({ extra: 'plan_max_cards: 2\n' }) };
  const r = rig({ mandate: m, cards: { 'P1.1': 'Fix The Login!' } }).json({ plan: 1, cards: [good('c1', { title: 'fix the login' }), good('c2'), good('c3')] });
  assert.equal(r.limit, 2);
  assert.deepEqual(codes(r, 0), ['duplicate']);
  assert.deepEqual(codes(r, 2), ['over-limit']);
  const d = rig({}).json({ plan: 1, cards: [good('c1', { mandate_goal: '' }), good('c2', { title: 'TASK c1', mandate_goal: '' }), good('c3', { title: 'z', depends_on: ['c4', 'P1.1', 'nope'], mandate_goal: '' }), good('c4', { title: 'y', depends_on: ['c3'], mandate_goal: '' })] });
  assert.deepEqual(codes(d, 1), ['duplicate-in-file']);
  assert.deepEqual(codes(d, 2).sort(), ['dependency-cycle', 'unknown-dependency', 'unknown-dependency']);
  assert.deepEqual(codes(d, 3), ['dependency-cycle']);
  const g = rig({ mandate: L3 }).json({ plan: 1, cards: [good('c1'), good('c2', { title: 'another title' })] }); // same goal, same criteria
  assert.deepEqual(codes(g, 1), []);
  const same = rig({ mandate: L3 }).json({ plan: 1, cards: [good('c1'), good('c2', { title: 'another title', criteria: good('c1').criteria })] });
  assert.deepEqual(codes(same, 1), ['duplicate-in-file']);
  assert.deepEqual(rig({}).json({ plan: 1, cards: [good('c1', { depends_on: ['c1'] })] }).cards[0].reasons.map((x) => x.code), ['dependency-cycle']);
});

test('P5.34 a1: kind or size outside the mandate is a valid proposal, not an error; unclear size is not normalised to S', () => {
  const r = rig({ mandate: L3 }).json({ plan: 1, cards: [good('c1', { kind: 'feature' }), good('c2', { size: 'L' }), good('c3', { size: '' }), good('c4', { mandate_goal: '' })] });
  assert.equal(r.status, 0);
  assert.deepEqual(r.cards.map((c) => c.result), ['proposed', 'proposed', 'proposed', 'proposed']);
  assert.match(r.cards[0].notes.join(';'), /outside the mandate/);
  assert.match(r.cards[1].notes.join(';'), /above max_size/);
  assert.match(r.cards[2].notes.join(';'), /no size/);
});

test('P5.34 a1: a milestone section is checked for form only and never applied', () => {
  const ok = rig({}).json({ plan: 1, cards: [good('c1', { mandate_goal: '' })], milestones: [{ title: 'M', cards: ['c1'], meaning: 'm', goal_check: 'g' }] });
  assert.deepEqual([ok.status, ok.milestones], [0, { checked: true, problems: [], applied: false }]);
  const bad = rig({}).json({ plan: 1, cards: [good('c1', { mandate_goal: '' })], milestones: [{ title: 'M', cards: ['zz'], meaning: 'm' }] });
  assert.equal(bad.status, 1);
  assert.equal(bad.file_reasons[0].code, 'bad-milestone');
});

test('P5.34 a1: not a proposal at all is refused with bad-file; text output has the table of reasons', () => {
  const r = rig({});
  assert.equal(r.json('{').status, 1);
  assert.equal(r.json({ plan: 2, cards: [] }).file_reasons[0].code, 'bad-file');
  const t = r.check({ plan: 1, cards: [good('c1', { goal: '' })] });
  assert.equal(t.status, 1);
  assert.match(t.stdout, /refusal reasons:\n\s+no-goal\s+the card has no goal/);
  assert.equal(r.check({ plan: 1, cards: [good('c1')] }).status === 0, true);
});

test('P5.34 a11: without a mandate the only positive result is proposed', () => {
  const r = rig({}).json({ plan: 1, cards: [good('c1')] });
  assert.deepEqual([r.status, r.mandate, r.cards[0].result], [0, null, 'proposed']);
  assert.match(r.cards[0].notes.join(';'), /no mandate/);
});

test('P5.34 a11: L2, unapproved, changed and malformed mandates never give in-mandate', () => {
  for (const m of [{ text: MANDATE({ level: 'L2' }) }, { text: MANDATE(), approved: false }, { text: MANDATE({ extra: 'plan_max_cards: x\n' }) }]) {
    const r = rig({ mandate: m }).json({ plan: 1, cards: [good('c1')] });
    assert.equal(r.cards[0].result, 'proposed', JSON.stringify(m));
  }
  const c = rig({ mandate: L3 });
  fs.appendFileSync(path.join(c.board, 'mandate.md'), '- more\n'); // an edit after approval
  assert.equal(c.json({ plan: 1, cards: [good('c1')] }).cards[0].result, 'proposed');
});

test('P5.34 a11: missing, template or unknown env, role, effects, stop conditions and check methods never become permission', () => {
  const reg = { environments: { Local: { machine: 'm' } }, preference: { worker: ['a@m'] } };
  const m = rig({ mandate: L3, reg });
  assert.equal(m.json({ plan: 1, cards: [good('c1')] }).cards[0].result, 'in-mandate', 'the control: a fully defined card');
  const variants = { env: ['', 'TBD', '(env)', 'Nowhere'], role: ['', 'todo', 'wizard'], effects: ['', 'n/a', '...'], stop_conditions: ['', '<fill in>', 'none'] };
  for (const [k, vs] of Object.entries(variants)) for (const v of vs) assert.equal(m.json({ plan: 1, cards: [good('c1', { [k]: v })] }).cards[0].result, 'proposed', `${k}=${JSON.stringify(v)}`);
  for (const check of ['TBD', 'magic: do it', 'test:', 'just look']) {
    const r = m.json({ plan: 1, cards: [good('c1', { criteria: [{ id: 'a1', text: 'x', check: 'test: ok' }, { id: 'a2', text: 'y', check }] })] });
    assert.equal(r.cards[0].result, 'proposed', check);
  }
  const x = m.json({ plan: 1, cards: [good('c1', { env: 'Nowhere' })] });
  assert.match(x.cards[0].notes.join(';'), /not described in the registry/);
});

test('P5.34 a11: read only: no write, no start; the command is a help-documented read command', () => {
  const r = rig({ mandate: L3 }); // rig.check asserts that no file changed or appeared
  assert.equal(r.check({ plan: 1, cards: [good('c1')] }).status, 0);
  const help = spawnSync(process.execPath, [SELF, 'help', 'plan'], { encoding: 'utf8' });
  assert.match(help.stdout, /\[read\]|read/);
  assert.equal(spawnSync(process.execPath, [SELF, 'plan', 'apply', 'x'], { encoding: 'utf8' }).status, 2);
});
