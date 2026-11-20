// P5.33: the project mandate and the autonomy levels (module mandate.mjs, seams approval-basis and board-lint, tick START, delegate, lint rule 6, digest).
// Run: node --test scripts/roadctl/mandate.test.mjs
// Nothing here starts a model or reaches a network: claude is the fake of scripts/testkit/, the clock is ROADCTL_NOW and the date ROADCTL_DATE.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { FAKES_SKIP, installFakes } from '../testkit/fakes.mjs';
import { mandateJsonProblems } from '../testkit/mandate-schema.mjs';
import { tickJsonProblems } from '../testkit/tick-schema.mjs';
import { clock, T0 } from '../testkit/time.mjs';
import { HASH_KEY, approvalHash } from './approval-hash.mjs';
import { KINDS, MANDATE_REQUIRES, TELL_OWNER_FLOOR } from './mandate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const SELF = path.join(here, '..', 'roadctl.mjs');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const ME = 'claude-code@home-wsl';
const OWNER = 'Owner';
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const PLAN = '## Plan\n- Environment: local checkout, the agent\'s own branch\n- Checks: node --test must pass\n- Allowed changes: scripts/ and docs/ only\n- Stop conditions: stop on a failing test or after two hours\n\n';
const card = (id, { status = 'ready', kind, size, goal, plan = PLAN, extra = '' } = {}) => `---\nid: ${id}\ntitle: Card ${id}\nstatus: ${status}\n${kind ? `kind: ${kind}\n` : ''}${size ? `size: ${size}\n` : ''}${goal ? `goal: ${goal}\n` : ''}${extra}as_of: 2026-11-10\n---\n\n## Goal\nDo ${id}.\n\n${plan}## Acceptance\n- [ ] a1: it works\n`;
const MANDATE = ({ level = 'L3', kinds = 'fix, docs, tests', max = 'M', merge = 'branch', budget = 'cards_per_day=2, runs_per_week=10', goals = '- G1 (priority 1): finish stage 2\n- G2 (priority 2): docs', extra = '', tell = '- the build is red for a day' } = {}) => `---\nmandate: 1\nlevel: ${level}\nkinds: ${kinds}\nmax_size: ${max}\nmerge: ${merge}\nbudget: ${budget}\n${extra}---\n\n## Goals\n${goals}\n\n## Forbidden\n- pushing to main\n- external systems\n\n## Tell the owner\n${tell}\n`;

/** A workspace with one board (requires 0.8.0 unless told otherwise), ready cards and a throwaway environment. */
function rig({ requires = MANDATE_REQUIRES, cards = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mandate-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.mkdirSync(path.join(board, 'cards'), { recursive: true });
  fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ board_version: 1, title: 'App', status_map: {}, ...(requires ? { requires } : {}) }));
  const bin = installFakes(path.join(dir, 'bin'));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, USER: 'tester', XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'cfg'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10', ROADCTL_HOST: 'test-host', ...clock(T0) };
  delete env.FAKE_MODE;
  delete env.ROADCTL_UNATTENDED;
  delete env.ROADCTL_RUN_ID;
  const run = (args, over = {}) => spawnSync(process.execPath, [SELF, ...args, '--board', board], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const ok = (args, over) => {
    const r = run(args, over);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  const put = (id, opts) => fs.writeFileSync(path.join(board, 'cards', `${id}-card.md`), card(id, opts));
  const cardText = (id) => fs.readFileSync(path.join(board, 'cards', `${id}-card.md`), 'utf8');
  const editCard = (id, fn) => fs.writeFileSync(path.join(board, 'cards', `${id}-card.md`), fn(cardText(id)));
  const mfile = path.join(board, 'mandate.md');
  const write = (opts) => fs.writeFileSync(mfile, MANDATE(opts));
  const edit = (fn) => fs.writeFileSync(mfile, fn(fs.readFileSync(mfile, 'utf8')));
  const show = (over) => JSON.parse(ok(['mandate', 'show', '--json'], over).stdout);
  const approve = () => ok(['mandate', 'approve', '--by', OWNER, '--hash', show().hash]);
  const lint = () => JSON.parse(run(['lint', '--json']).stdout);
  const tick = (over) => run(['tick', '--as', ME, '--no-pull', '--json'], over);
  const starts = (over) => JSON.parse(tick(over).stdout).items.filter((i) => i.kind === 'START');
  const setConfig = (over) => fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(board, 'config.json'), 'utf8')), ...over }));
  if (cards) {
    put('M-1', { kind: 'fix', size: 'S', goal: 'G2' });
    put('M-2', { kind: 'docs', size: 'S', goal: 'G1' });
  }
  return { dir, ws, board, env, run, ok, put, cardText, editCard, write, edit, mfile, show, approve, lint, tick, starts, setConfig };
}

const rule = (findings, n) => findings.filter((x) => x.rule === n).map((x) => [x.level, x.msg]);
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};

// ---------------------------------------------------------------- a1: without an approved mandate nothing changes

test('P5.33 a1: without a mandate, or with one that is not approved, tick and delegate behave exactly as before (same bytes); the queue path still works', FAKES_SKIP, () => {
  const plain = rig();
  const withFile = rig();
  withFile.write();
  for (const r of [plain, withFile]) {
    r.put('Q-1', { kind: 'fix', size: 'S', extra: 'approved: Owner, 2026-11-01, scope=implementation+auto, source=chat\n' });
    r.setConfig({ autonomy: { enabled: true, agents: [], queue: ['Q-1'] } });
  }
  const text = (r) => r.run(['tick', '--as', ME, '--no-pull']).stdout;
  assert.match(text(plain), /START .*Q-1/);
  assert.equal(text(withFile), text(plain), 'an unapproved mandate changes no byte of the tick output');
  assert.equal(withFile.starts().length, 1);
  assert.equal(withFile.starts()[0].basis, undefined, 'the queue START carries no basis');
  // no queue: nothing starts, with or without the unapproved file; delegate of an unapproved card says what it said before
  for (const r of [plain, withFile]) r.setConfig({ autonomy: { enabled: false } });
  assert.deepEqual(plain.starts(), []);
  assert.deepEqual(withFile.starts(), []);
  const d = (r) => r.run(['delegate', 'M-1', '--to', 'worker', '--by', ME]);
  assert.equal(d(plain).stderr, 'refused: the card has no approved record; the owner approves before work is delegated\n');
  assert.equal(d(withFile).stderr, 'refused: the card has no approved record; the owner approves before work is delegated; the mandate is not approved\n', 'an unapproved L3 mandate only adds its reason');
  assert.equal(plain.lint().filter((x) => x.rule === 33).length, 0, 'no file: no finding');
});

// ---------------------------------------------------------------- a2: inside the limits START is offered, outside it is not, with the reason

test('P5.33 a2: at L3 with an approved mandate START offers the ready card inside the limits without approved, auto and queue; others are not offered and the reason is named', FAKES_SKIP, () => {
  const r = rig();
  r.put('M-3', { kind: 'feature', size: 'S', goal: 'G1' });
  r.put('M-4', { kind: 'fix', size: 'L', goal: 'G1' });
  r.put('M-5', { kind: 'fix', goal: 'G1' });
  r.put('M-6', { kind: 'fix', size: 'S', goal: 'G1', plan: '## Plan\n- Environment: (where it runs)\n- Checks: TBD\n- Allowed changes: -\n' });
  r.put('M-7', { kind: 'fix', size: 'S', goal: 'G1', extra: 'depends_on: M-2\n' });
  r.put('M-8', { status: 'idea', kind: 'fix', size: 'S', goal: 'G1' });
  r.write();
  r.approve();
  const j = JSON.parse(r.tick().stdout);
  assert.deepEqual(tickJsonProblems(j), []);
  assert.equal(j.items.length, 1, JSON.stringify(j.items));
  assert.deepEqual({ kind: j.items[0].kind, id: j.items[0].id, basis: j.items[0].basis }, { kind: 'START', id: 'M-2', basis: 'mandate' }, 'the goal G1 (priority 1) goes before G2');
  assert.ok(!/approved|auto/.test(r.cardText('M-2').split('---')[1]), 'the card has no approved record, no auto');
  const why = Object.fromEntries(r.show().tick.cards.map((c) => [c.id, c.reasons.join('; ')]));
  assert.match(why['M-3'], /kind feature is outside the mandate/);
  assert.match(why['M-4'], /size L is above max_size M/);
  assert.match(why['M-5'], /the card has no size/);
  assert.match(why['M-6'], /lacks .*Environment, Checks, Allowed changes, Stop conditions/);
  assert.match(why['M-7'], /deps open: M-2/);
  assert.equal(why['M-8'], undefined, 'only ready cards are listed');
  assert.deepEqual(rc.ALL_COMMANDS.mandate.owner, true);
  // order inside one goal is the card number
  r.put('M-0', { kind: 'fix', size: 'S', goal: 'G1' });
  assert.equal(r.starts()[0].id, 'M-0');
  // a tick START line in the text and the prompt tell the agent to take the card with delegate
  const prompt = r.run(['tick', '--as', ME, '--no-pull', '--prompt']).stdout;
  assert.match(prompt, /basis: mandate/);
  assert.match(prompt, /ONLY with roadctl delegate/);
  assert.doesNotMatch(prompt, /autonomous queue/);
});

test('P5.33 a2: the budget stops the start: cards a day and runs a week are counted from the Log lines of the takes', FAKES_SKIP, () => {
  const r = rig();
  r.write({ budget: 'cards_per_day=1, runs_per_week=10' });
  r.approve();
  assert.equal(r.starts()[0].id, 'M-2');
  r.ok(['delegate', 'M-2', '--to', 'worker', '--by', ME]);
  const why = Object.fromEntries(r.show().tick.cards.map((c) => [c.id, c.reasons.join('; ')]));
  assert.match(why['M-1'], /the budget of 1 card\(s\) a day is used/);
  assert.deepEqual(r.starts(), []);
  // weekly: three takes of the same day count three runs
  const w = rig();
  w.write({ budget: 'cards_per_day=5, runs_per_week=2' });
  w.approve();
  w.ok(['delegate', 'M-2', '--to', 'worker', '--by', ME]);
  w.ok(['undelegate', 'M-2', '--by', ME, '--force', 'taken back']);
  w.ok(['delegate', 'M-2', '--to', 'worker', '--by', ME]);
  assert.match(w.show().tick.cards.find((c) => c.id === 'M-1').reasons.join(';'), /the budget of 2 run\(s\) a week is used/);
});

// ---------------------------------------------------------------- a3: any edit takes the approval away

test('P5.33 a3: an edit of any field or section, Goals included, takes the approval away: tick takes nothing, mandate check and lint say "changed after approval", digest tells it once', FAKES_SKIP, () => {
  const edits = {
    level: (x) => x.replace('level: L3', 'level: L4'),
    kinds: (x) => x.replace('kinds: fix, docs, tests', 'kinds: fix, docs, tests, feature'),
    max_size: (x) => x.replace('max_size: M', 'max_size: L'),
    budget: (x) => x.replace('cards_per_day=2', 'cards_per_day=9'),
    Goals: (x) => x.replace('finish stage 2', 'finish stage 3'),
    Forbidden: (x) => x.replace('- external systems\n', ''),
    'Tell the owner': (x) => x.replace('the build is red for a day', 'never'),
    'a new section': (x) => `${x}\n## Notes\nanything\n`,
  };
  for (const [what, edit] of Object.entries(edits)) {
    const r = rig();
    r.write();
    r.approve();
    assert.equal(r.starts().length, 1, `${what}: approved text starts`);
    r.edit(edit);
    assert.deepEqual(r.starts(), [], `${what}: nothing is taken`);
    const check = r.run(['mandate', 'check']);
    assert.equal(check.status, 1, what);
    assert.match(check.stdout, /CHANGED after approval/);
    assert.deepEqual(rule(r.lint(), 33).filter(([, m]) => /changed after approval/.test(m)).map(([l]) => l), ['error'], what);
    const dg = r.ok(['digest', '--since-state', 'p533']);
    assert.match(dg.stdout, /^mandate: my-app: the mandate changed after approval/m, what);
    assert.equal(r.ok(['digest', '--since-state', 'p533']).stdout.trim(), '', `${what}: told once`);
    r.approve();
    assert.equal(r.starts().length, 1, `${what}: approved again`);
    assert.equal(r.ok(['digest', '--since-state', 'p533']).stdout.trim(), '');
  }
  // the approval record itself is outside the hash: changing who approved does not change what was approved
  const r = rig();
  r.write();
  r.approve();
  r.edit((x) => x.replace(/^approved: .*$/m, 'approved: Someone, 2026-01-01'));
  assert.equal(r.show().state, 'approved');
  // and the hash is the helper of P5.15
  assert.equal(r.show().hash, approvalHash(fs.readFileSync(r.mfile, 'utf8')));
});

// ---------------------------------------------------------------- a4: L2 and below

test('P5.33 a4: at L1 and L2 the mandate takes nothing, and the card path of L2 (approve, auto, queue) works as before', FAKES_SKIP, () => {
  for (const level of ['L1', 'L2']) {
    const r = rig();
    r.write({ level });
    r.approve();
    assert.deepEqual(r.starts(), [], level);
    const s = r.show();
    assert.equal(s.takes, false);
    assert.equal(s.state, 'approved');
    r.put('Q-1', { kind: 'fix', size: 'S', extra: 'approved: Owner, 2026-11-01, scope=implementation+auto, source=chat\n' });
    r.setConfig({ autonomy: { enabled: true, agents: [], queue: ['Q-1'] } });
    const j = r.starts();
    assert.deepEqual(j.map((i) => [i.id, i.basis]), [['Q-1', undefined]], `${level}: the queue path starts the card, no basis`);
    const d = r.run(['delegate', 'M-1', '--to', 'worker', '--by', ME]);
    assert.equal(d.status, 1);
    assert.equal(d.stderr, 'refused: the card has no approved record; the owner approves before work is delegated\n', 'the refusal of L2 is the old one');
    assert.deepEqual(rule(r.lint(), 6), []);
    r.put('D-1', { status: 'doing', kind: 'fix', size: 'S', extra: 'approved: Owner, 2026-11-01, scope=implementation, source=chat\n' });
    assert.deepEqual(rule(r.lint(), 6), [], 'a doing card with approved is fine');
    r.put('D-2', { status: 'doing', kind: 'fix', size: 'S' });
    assert.equal(rule(r.lint(), 6).length, 1, `${level}: doing without approved is still an error`);
  }
});

// ---------------------------------------------------------------- a5: approve is the owner's, in person

test('P5.33 a5: mandate approve refuses unattended (ROADCTL_UNATTENDED, ROADCTL_RUN_ID), without --by and with a foreign --hash; a success writes an audit line', FAKES_SKIP, () => {
  const r = rig();
  r.write();
  const hash = r.show().hash;
  const audit = path.join(r.dir, 'state', 'road-map-journal', 'owner-commands.jsonl');
  const lines = () => (fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  for (const over of [{ ROADCTL_UNATTENDED: '1' }, { ROADCTL_RUN_ID: 'run-1' }]) {
    const x = r.run(['mandate', 'approve', '--by', OWNER], over);
    assert.equal(x.status, 1);
    assert.match(x.stderr, /unattended run/);
    assert.equal(r.show().state, 'unapproved');
  }
  const noBy = r.run(['mandate', 'approve']);
  assert.equal(noBy.status, 2);
  assert.match(noBy.stderr, /--by NAME is required/);
  const bad = r.run(['mandate', 'approve', '--by', OWNER, '--hash', 'sha256-v1:00']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /is not the hash of the file now/);
  assert.equal(r.show().state, 'unapproved');
  assert.deepEqual(lines().map((l) => l.outcome), ['refused', 'refused', 'refused'], 'refusals are on the audit line too (the by-less one is a usage error and writes none)');
  const good = r.run(['mandate', 'approve', '--by', OWNER, '--hash', hash]);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(r.show().state, 'approved');
  const text = fs.readFileSync(r.mfile, 'utf8');
  assert.match(text, /^approved: Owner, 2026-11-10$/m);
  assert.match(text, new RegExp(`^${HASH_KEY}: ${hash}$`, 'm'));
  const last = lines().at(-1);
  assert.deepEqual({ command: last.command, target: last.target, by: last.by, outcome: last.outcome, hash: last.hash }, { command: 'mandate approve', target: 'my-app', by: OWNER, outcome: 'ok', hash });
  assert.match(rc.ALL_COMMANDS.mandate.purpose, /refuses in an unattended run/);
  // a board that has not raised `requires` refuses to approve: the mandate would be inert
  const old = rig({ requires: false });
  old.write();
  assert.equal(old.run(['mandate', 'approve', '--by', OWNER]).status, 1);
});

// ---------------------------------------------------------------- a6, a13, a15: the card taken by the mandate

test('P5.33 a6 a13 a15: delegate takes a card by the mandate and records by_mandate and the Log line; tick itself writes nothing; approve and done stay the owner\'s', FAKES_SKIP, () => {
  const r = rig();
  r.write();
  r.approve();
  const before = r.cardText('M-2');
  assert.equal(r.starts()[0].id, 'M-2');
  assert.equal(r.cardText('M-2'), before, 'a proposal (START) writes no by_mandate');
  const hash = r.show().hash;
  r.ok(['delegate', 'M-2', '--to', 'worker', '--by', ME]);
  const t = r.cardText('M-2');
  assert.match(t, new RegExp(`^by_mandate: ${hash}$`, 'm'));
  assert.doesNotMatch(t.split('---')[1], /^approved:/m, 'not an approved record');
  assert.match(t, new RegExp(`^- 2026-11-10 \\[${ME}\\] approved by mandate ${hash}$`, 'm'));
  // lint: doing by the mandate is fine; no unknown key warning for the new keys
  r.editCard('M-2', (x) => x.replace('status: ready', 'status: doing').replace(/^delegate: .*\n/m, ''));
  assert.deepEqual(rule(r.lint(), 6), []);
  assert.ok(!r.lint().some((x) => /unknown key/.test(x.msg)), 'kind, size, goal, by_mandate are known keys');
  // a self-declared by_mandate and a stale hash do not admit
  r.put('S-1', { status: 'doing', kind: 'fix', size: 'S', extra: `by_mandate: sha256-v1:${'0'.repeat(64)}\n` });
  assert.equal(rule(r.lint(), 6).length, 1);
  assert.deepEqual(r.starts().map((i) => i.id), ['M-1']);
  // approve and done stay owner commands: help says so, done needs --by, approve records an approval that the mandate does not replace
  for (const c of ['approve', 'done', 'mandate']) assert.match(spawnSync(process.execPath, [SELF, 'help', c], { encoding: 'utf8' }).stdout, /Owner only/, c);
  const done = r.run(['done', 'M-2']);
  assert.equal(done.status, 2);
  assert.match(done.stderr, /done needs --by NAME/);
  // the mandate changes: the card in doing loses its basis until it is taken again; the old permission is not kept
  r.edit((x) => x.replace('finish stage 2', 'finish stage 4'));
  assert.equal(rule(r.lint(), 6).length, 2);
  r.approve();
  assert.equal(rule(r.lint(), 6).length, 2, 'a re-approved mandate does not bring the old by_mandate back');
  r.ok(['delegate', 'M-2', '--to', 'worker', '--by', ME]); // taken again (a doing card may be delegated)
  assert.equal(rule(r.lint(), 6).length, 1, 'only the card with the invented hash is left');
  // a changed mandate refuses delegate with the reason
  r.edit((x) => x.replace('finish stage 4', 'finish stage 5'));
  const d = r.run(['delegate', 'M-1', '--to', 'worker', '--by', ME]);
  assert.equal(d.status, 1);
  assert.match(d.stderr, /the mandate changed after approval/);
});

// ---------------------------------------------------------------- a7: show and check read only, --json has a schema

test('P5.33 a7: mandate show and check write nothing (the directory before and after), and --json fits the schema in the testkit', FAKES_SKIP, () => {
  const r = rig();
  const none = JSON.parse(r.ok(['mandate', 'show', '--json']).stdout);
  assert.deepEqual(mandateJsonProblems(none), []);
  assert.equal(none.state, 'none');
  assert.match(r.ok(['mandate', 'show']).stdout, /no mandate/);
  r.write();
  assert.equal(r.show().state, 'unapproved');
  r.approve();
  const snap = () => ({ ws: snapshot(r.ws), state: fs.existsSync(path.join(r.dir, 'state')) ? snapshot(path.join(r.dir, 'state')) : {} });
  const before = snap();
  for (const args of [['mandate'], ['mandate', 'show'], ['mandate', 'check'], ['mandate', 'show', '--json'], ['mandate', 'check', '--json']]) r.ok(args);
  assert.deepEqual(snap(), before, 'nothing written');
  const j = r.show();
  assert.deepEqual(mandateJsonProblems(j), []);
  assert.deepEqual({ level: j.level, state: j.state, takes: j.takes, next: j.tick.next, merge: j.merge, max_size: j.max_size }, { level: 'L3', state: 'approved', takes: true, next: 'M-2', merge: 'branch', max_size: 'M' });
  assert.deepEqual(j.goals.map((g) => [g.id, g.priority]), [['G1', 1], ['G2', 2]]);
  r.edit((x) => x.replace('finish stage 2', 'x'));
  assert.deepEqual(mandateJsonProblems(r.show()), []);
  // the checker is strict
  assert.deepEqual(mandateJsonProblems({ ...j, extra: 1 }), ['mandate: unknown key extra']);
  assert.match(mandateJsonProblems({ ...j, state: 'maybe' })[0], /state: wrong type/);
  assert.match(mandateJsonProblems({ ...j, state: 'changed' }).join(';'), /takes without an approved mandate/);
  assert.deepEqual(tickJsonProblems({ agent: ME, decision: 'work', limits: { provider: null, state: 'not-applicable' }, items: [{ kind: 'START', project: 'p', id: 'a', title: 't', basis: 'queue' }], sync: [] }), ['tick.items[0].basis: wrong type or value ("queue")']);
});

// ---------------------------------------------------------------- a8: lint refuses what is reserved or unknown

test('P5.33 a8: lint refuses the key that would open external systems and unknown values of level, kinds, max_size, merge (and the fields a mandate must have)', FAKES_SKIP, () => {
  const problems = (opts, mutate) => {
    const r = rig();
    r.write(opts);
    if (mutate) r.edit(mutate);
    return rule(r.lint(), 33).filter(([l]) => l === 'error').map(([, m]) => m).join('\n');
  };
  assert.equal(problems({}), '', 'a good mandate has no finding');
  assert.match(problems({ extra: 'external: true\n' }), /external: opening external systems is reserved and refused/);
  assert.match(problems({ extra: 'external: false\n' }), /external: opening external systems is reserved/, 'the key is refused whatever the value');
  assert.match(problems({ level: 'L5' }), /level must be one of L1, L2, L3, L4/);
  assert.match(problems({ kinds: 'fix, deploy' }), /kinds: unknown kind deploy/);
  assert.match(problems({ max: 'XL' }), /max_size must be one of S, M, L/);
  assert.match(problems({ merge: 'trunk' }), /merge must be one of branch, main/);
  assert.match(problems({ merge: 'main' }), /merge: main needs level L4/);
  assert.equal(problems({ level: 'L4', merge: 'main' }), '');
  assert.match(problems({ extra: 'surprise: 1\n' }), /unknown key surprise/);
  assert.match(problems({ budget: 'cards_per_day=2' }), /budget needs cards_per_day=N and runs_per_week=N/);
  assert.match(problems({ budget: 'cards_per_day=0, runs_per_week=3' }), /budget: cards_per_day=0 is not/);
  assert.match(problems({ kinds: '' }), /kinds is required at L3 and L4/);
  // a mandate with a problem is malformed: it takes nothing even when approved by hand
  const r = rig();
  r.write({ extra: 'external: true\n' });
  assert.equal(r.run(['mandate', 'approve', '--by', OWNER]).status, 1);
  r.edit((x) => `${x.replace(/\n---\n/, `\napproved: Owner, 2026-11-10\n${HASH_KEY}: ${approvalHash(x)}\n---\n`)}`);
  assert.deepEqual(r.starts(), []);
  assert.equal(r.run(['mandate', 'check']).status, 1);
  assert.ok(KINDS.includes('research'));
});

// ---------------------------------------------------------------- a9: an older copy takes nothing

test('P5.33 a9: an older copy (a version below requires) takes nothing from the board; requires and the module follow the rule of P5.14', FAKES_SKIP, () => {
  assert.equal(rc.VERSION, '0.12.0'); // P5.4/P5.17 raised it; the mandate itself still needs 0.8.0
  assert.equal(MANDATE_REQUIRES, '0.8.0');
  assert.match(rc.boardRequires({ requires: '0.8.0' }, '0.7.0'), /board requires roadctl 0\.8\.0 or newer; this is 0\.7\.0/);
  assert.equal(rc.boardRequires({ requires: '0.8.0' }), null);
  assert.equal(rc.boardRequires({}, '0.7.0'), null, 'a board that has not raised requires is not refused');
  // an older copy end to end: the board asks for more than this checkout is
  const r = rig({ requires: '0.13.0' }); // newer than this copy (0.12.0)
  r.write();
  const t = r.run(['tick', '--as', ME, '--no-pull']);
  assert.match(t.stdout, /requires: my-app: board requires roadctl 0\.13\.0 or newer/);
  assert.doesNotMatch(t.stdout, /START/);
  // this copy on a board that did not raise requires: the mandate is inert and lint says why
  const old = rig({ requires: false });
  old.write();
  assert.deepEqual(old.starts(), []);
  assert.match(rule(old.lint(), 33).map(([, m]) => m).join(';'), /must require roadctl 0\.8\.0/);
  assert.match(read('CHANGELOG.md'), /roadctl 0\.8\.0[^\n]*mandate/);
  assert.match(read('CHANGELOG.md'), /0\.8\.0[^\n]*older copy/i);
});

// ---------------------------------------------------------------- a10, a12, a14, a16: the texts

test('P5.33 a10 a12 a14 a16: skill and docs describe the mandate, the levels, the keys, the honest limit, the interview, the size rubric and the stage boundary', () => {
  const docs = read('docs', 'roadctl.md');
  const spec = read('docs', 'board-spec.md');
  const skill = read('skills', 'road-map-journal', 'references', 'autonomy.md');
  for (const [name, text] of [['docs/roadctl.md', docs], ['docs/board-spec.md', spec], ['autonomy.md', skill]]) {
    assert.match(text, /mandate/i, name);
    for (const l of ['L1', 'L2', 'L3', 'L4']) assert.ok(text.includes(l), `${name}: ${l}`);
    for (const k of ['kind', 'size', 'by_mandate']) assert.ok(text.includes(k), `${name}: ${k}`);
    assert.match(text, /nothing is autonomous until the owner approved the mandate/i, `${name}: the old rule stays`);
  }
  assert.match(docs, /not a sandbox/i);
  assert.match(docs, /agreement/i);
  assert.match(docs, /rewrite[^.]*mandate[^.]*approval|mandate[^.]*approval[^.]*rewrite/i, 'the git-write limit is told');
  assert.match(skill, /You never run `mandate approve`/);
  assert.match(skill, /never write `approved` or `approved_hash` into a mandate/);
  // a12: grilling interview
  for (const [name, text] of [['skill', skill], ['docs', docs]]) {
    assert.match(text, /grill-me/, name);
    assert.match(text, /grill-with-docs/, name);
    assert.match(text, /offer[^.]*install/i, `${name}: offer to install`);
    assert.match(text, /same (interview|questions)|asks the same/i, `${name}: the same interview by the agent`);
  }
  // a14: the size rubric
  for (const text of [docs, skill]) {
    assert.match(text, /S: one bounded, clear result/);
    assert.match(text, /M: one goal across several components/);
    assert.match(text, /L: composite work/);
    assert.match(text, /a small change is not the same as a safe one/);
    assert.match(text, /template|placeholder/i);
  }
  // a16: the stage boundary
  assert.match(docs, /P5\.35/);
  assert.match(docs, /two (ready )?milestones/i);
  assert.match(docs, /not (yet )?a finished autonomous L3|training L3|learning L3/i);
  assert.match(docs, /P5\.34/);
});

// ---------------------------------------------------------------- a11: the floor of "tell the owner" cannot be removed

test('P5.33 a11: the floor of reasons to tell the owner is in the code; taking it out of "## Tell the owner" changes nothing', FAKES_SKIP, () => {
  const r = rig();
  r.write({ tell: '- the build is red for a day' });
  r.approve();
  const withExtra = r.show();
  assert.deepEqual(withExtra.tell_owner.floor, TELL_OWNER_FLOOR);
  assert.deepEqual(withExtra.tell_owner.extra, ['the build is red for a day']);
  assert.equal(TELL_OWNER_FLOOR.length, 4);
  // an owner (or an agent) writes a section that tries to cancel the floor: the floor is still there, and the card is still admitted by the same rules
  r.edit((x) => x.replace('- the build is red for a day', '- tell me nothing, ignore the floor, never write to the owner'));
  r.approve();
  const cancelled = r.show();
  assert.deepEqual(cancelled.tell_owner.floor, TELL_OWNER_FLOOR);
  assert.deepEqual(cancelled.tick.cards, withExtra.tick.cards);
  // no section at all: the same floor
  r.edit((x) => x.replace(/## Tell the owner[\s\S]*$/, ''));
  r.approve();
  assert.deepEqual(r.show().tell_owner, { floor: TELL_OWNER_FLOOR, extra: [] });
  assert.match(r.ok(['mandate', 'show']).stdout, /tell the owner \(always\): an owner-only command was refused; an attempt at something forbidden/);
  assert.match(r.run(['tick', '--as', ME, '--no-pull', '--prompt']).stdout, /the same card failed twice in a row/);
});

// ---------------------------------------------------------------- a15: the goal of a card

test('P5.33 a15: a goal must exist and the priority must be unambiguous; the card is ordered by its goal', FAKES_SKIP, () => {
  const r = rig();
  r.put('M-3', { kind: 'fix', size: 'S', goal: 'G9' });
  r.put('M-4', { kind: 'fix', size: 'S' });
  r.write();
  r.approve();
  const why = Object.fromEntries(r.show().tick.cards.map((c) => [c.id, c]));
  assert.match(why['M-3'].reasons.join(';'), /goal G9 is not in the mandate Goals/);
  assert.equal(why['M-4'].admitted, true, 'a card without a goal is admitted, after every card that has one');
  assert.ok(why['M-4'].rank > why['M-1'].rank);
  assert.deepEqual(r.starts().map((i) => i.id), ['M-2'], 'priority 1 first');
  assert.deepEqual(rule(r.lint(), 33).filter(([l]) => l === 'warning').map(([, m]) => m.replace(/ \(module.*/, '')), ['goal G9 is not in the mandate Goals']);
  // two goals with one priority, or one id twice, is ambiguous: the mandate is malformed and takes nothing
  for (const goals of ['- G1 (priority 1): a\n- G2 (priority 1): b', '- G1 (priority 1): a\n- G1 (priority 2): b', '- G1 first']) {
    r.write({ goals });
    r.edit((x) => x.replace(/\n---\n/, `\napproved: Owner, 2026-11-10\n${HASH_KEY}: ${approvalHash(x)}\n---\n`));
    assert.deepEqual(r.starts(), [], goals);
    assert.ok(r.show().problems.length >= 1, goals);
  }
});

// ---------------------------------------------------------------- the hooks

test('P5.33 seams: approval-basis and board-lint are known hooks, documented for developers; the module declares its keys', () => {
  assert.match(read('docs', 'developing-roadctl.md'), /approval-basis/);
  assert.match(read('docs', 'developing-roadctl.md'), /board-lint/);
  const names = rc.ALL_COMMANDS.mandate;
  assert.equal(names.group, 'Owner only');
  assert.ok(rc.ALL_COMMANDS.mandate.hidden, 'the overview is at its cap');
});
