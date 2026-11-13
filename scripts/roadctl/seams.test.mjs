// P5.28: the stage-2 seams a module gets (routine reasons, header keys and sections, tick kinds, the owner flag, help topics,
// START admission and dependency states), tried through the real CLI with a fixture module appended to a temp copy of roadctl.
// Run: node --test scripts/roadctl/seams.test.mjs
// The lock and the state directory (a6, a7) are in state.test.mjs. Nothing here starts a model or reaches a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { FAKES_SKIP, installFakes } from '../testkit/fakes.mjs';
import { helpDocsProblems } from '../testkit/helpdocs.mjs';
import { tickJsonProblems } from '../testkit/tick-schema.mjs';
import { clock, T0 } from '../testkit/time.mjs';
import { buildRegistry } from './registry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const EXAMPLE_BOARD = path.join(here, '..', '..', 'examples', 'board-example', 'board');
const DOCS = fs.readFileSync(path.join(here, '..', '..', 'docs', 'roadctl.md'), 'utf8');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const ME = 'claude-code@home-wsl';
const OWNER = 'Owner';
const AUTO_APPROVED = 'approved: owner, 2026-11-11, scope=implementation+auto, source=chat';

const FIXTURE = `export default {
  name: 'fixture-seams',
  headerKeys: ['rule_ok', 'by_mandate'],
  routineKeys: ['hold'],
  cardSections: ['Questions'],
  routineSections: ['Checks'],
  helpTopics: { 'fixture-topic': { summary: 'a fixture topic', text: ['line one', 'line two'] } },
  tickKinds: { RESUME: { prompt: ({ agent, items }) => 'RESUME roadctl show <id>; continue ' + items.length + ' card(s) as ' + agent, text: (i) => 'resume ' + i.title } },
  hooks: {
    'routine-reasons'({ routine }) { return routine.header.hold ? { reasons: ['on hold: ' + routine.header.hold] } : {}; },
    'tick-items'({ env }) { return env.FIXTURE_RESUME ? { items: [{ kind: 'RESUME', id: env.FIXTURE_RESUME, title: 'answered by the owner' }] } : {}; },
    'start-admit'({ card }) { return card.header.by_mandate === 'no' ? { admit: false, reason: 'outside the mandate' } : {}; },
    'dep-satisfied'({ by }) { return by.header.rule_ok === 'yes' ? { satisfied: true } : {}; },
  },
};
`;

/** A copy of roadctl.mjs and its roadctl/ folder with the fixture module appended to index.mjs. */
function install() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-seams-bin-'));
  fs.copyFileSync(SELF, path.join(dir, 'roadctl.mjs'));
  fs.cpSync(here, path.join(dir, 'roadctl'), { recursive: true, filter: (s) => !s.endsWith('.test.mjs') });
  fs.writeFileSync(path.join(dir, 'roadctl', 'fixture-seams.mjs'), FIXTURE);
  const f = path.join(dir, 'roadctl', 'index.mjs');
  const index = fs.readFileSync(f, 'utf8').replace("import probe from './probe.mjs';", "import probe from './probe.mjs';\nimport fixtureSeams from './fixture-seams.mjs';");
  fs.writeFileSync(f, index.replace(/(export const MODULES = \[[^\]]*)\]/, '$1, fixtureSeams]'));
  return path.join(dir, 'roadctl.mjs');
}
const WITH = install();

/** The example board as project my-app in a temp workspace; `run(bin, args)` runs either copy against it. */
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-seams-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  const bin = installFakes(path.join(dir, 'bin')); // a fake claude answers the limits probe: nothing reaches a network
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, USER: 'tester', XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'cfg'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10', ROADCTL_HOST: 'test-host', ...clock(T0) };
  delete env.FAKE_MODE;
  const run = (bin, args, over = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const ok = (args) => {
    const r = run(SELF, [...args, '--board', board]);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
  };
  const tick = (bin, args = [], over = {}) => run(bin, ['tick', '--as', ME, '--no-pull', ...args], over);
  const edit = (rel, fn) => {
    const f = path.join(board, rel);
    fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8')));
  };
  const cardFile = (id) => `cards/${fs.readdirSync(path.join(board, 'cards')).find((x) => x.startsWith(`${id}-`))}`;
  const routine = () => {
    ok(['routine', 'new', 'mr-status', 'Collect MR status', '--agent', ME, '--model', 'haiku', '--env', 'laptop', '--every', '2h']);
    ok(['routine', 'on', 'mr-status', '--by', OWNER, '--source', 'chat 2026-11-12']);
    ok(['autonomy', 'routines', 'on', '--by', OWNER]);
  };
  /** W-5 approved for auto work and queued; its dependency is W-2 (review). */
  const queueW5 = (extra = '') => {
    edit(cardFile('W-5'), (x) => x.replace('depends_on: W-2', `depends_on: W-2\n${AUTO_APPROVED}${extra}`));
    ok(['autonomy', 'on']);
    ok(['queue', 'add', 'W-5']);
  };
  return { dir, board, env, run, ok, tick, edit, cardFile, routine, queueW5 };
}

const lintOf = (r, bin) => JSON.parse(r.run(bin, ['lint', '--json', '--board', r.board]).stdout);
const kindsOf = (out) => [...out.matchAll(/^(TAKE|ACCEPT|START|STALE|RUN|RESUME) /gm)].map((m) => m[1]);

// ---------------------------------------------------------------- a1: a module reason why a routine would not run

test('P5.28 a1: a module reason (routine-reasons) is the same in tick, routine list, lint and digest; without the module nothing changes', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  r.edit('routines/mr-status.md', (x) => x.replace('id: mr-status', 'id: mr-status\nhold: owner asked'));
  // without the module: the routine runs as before (an unknown key is only a warning)
  assert.deepEqual(kindsOf(r.tick(SELF).stdout), ['RUN']);
  const plain = lintOf(r, SELF);
  assert.ok(plain.some((x) => x.level === 'warning' && /hold/.test(x.msg)), 'unknown key: a warning');
  assert.ok(!plain.some((x) => x.rule === 30));
  // with the module: no RUN, and every view gives the same reason
  const t = r.tick(WITH);
  assert.equal(t.status, 4, t.stdout);
  assert.deepEqual(kindsOf(t.stdout), []);
  const list = r.run(WITH, ['routine', 'list', '--board', r.board]).stdout;
  assert.match(list, /would not run: [^\n]*on hold: owner asked/);
  const rows = JSON.parse(r.run(WITH, ['routine', 'list', '--json', '--board', r.board]).stdout);
  assert.deepEqual(rows[0].module_reasons, [{ text: 'on hold: owner asked', lint: 'warning', module: 'fixture-seams' }]);
  assert.equal(rows[0].run_now, false);
  const l = lintOf(r, WITH);
  assert.deepEqual(l.filter((x) => x.rule === 30).map((x) => [x.level, x.msg]), [['warning', 'would not run: on hold: owner asked (module fixture-seams)']]);
  assert.ok(!l.some((x) => /unknown key hold/.test(x.msg)), 'the module key is known');
  const d = r.run(WITH, ['digest', '--daily', '--board', r.board]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /on hold: owner asked/);
});

// ---------------------------------------------------------------- a2: header keys and sections of modules

test('P5.28 a2: a module declares a routine key, a card key and sections; unknown ones stay warnings, the module ones are not reported', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  r.edit('routines/mr-status.md', (x) => `${x.replace('id: mr-status', 'id: mr-status\nhold: x')}\n## Checks\n\n- one\n`);
  r.edit(r.cardFile('W-6'), (x) => `${x.replace('id: W-6', 'id: W-6\nby_mandate: yes\nfuture_key: 1')}\n## Questions\n\n- q1\n\n## Unheard\n\n- x\n`);
  const plain = lintOf(r, SELF).map((x) => x.msg).join('\n');
  for (const s of ['hold', 'by_mandate', 'Questions', 'Checks', 'future_key', 'Unheard']) assert.match(plain, new RegExp(s), `${s}: reported without the module`);
  const withMod = lintOf(r, WITH);
  const text = withMod.map((x) => x.msg).join('\n');
  for (const s of ['by_mandate', 'Questions', 'Checks']) assert.doesNotMatch(text, new RegExp(`unknown[^\\n]*${s}`), `${s}: known with the module`);
  assert.ok(withMod.some((x) => x.level === 'warning' && /future_key/.test(x.msg)), 'an unknown key is still a warning');
  assert.ok(withMod.some((x) => x.level === 'warning' && /Unheard/.test(x.msg)), 'an unknown section is still a warning');
  assert.ok(!withMod.some((x) => x.level === 'error' && /future_key|Unheard/.test(x.msg)));
  // a module cannot take a name the core or another module has
  const opts = { knownKeys: new Set(['id']), knownRoutineKeys: new Set(['every']), knownSections: ['Goal'], knownRoutineSections: ['Steps'] };
  assert.throws(() => buildRegistry([{ name: 'x', routineKeys: ['every'] }], opts), /routine key every is already known/);
  assert.throws(() => buildRegistry([{ name: 'x', cardSections: ['Goal'] }], opts), /card section Goal is already known/);
  assert.throws(() => buildRegistry([{ name: 'x', routineSections: ['Steps'] }], opts), /routine section Steps is already known/);
  assert.throws(() => buildRegistry([{ name: 'x', cardSections: ['bad name'] }], opts), /bad card section/);
});

// ---------------------------------------------------------------- a3: a tick kind of a module

test('P5.28 a3: a module adds a tick kind: item, text, prompt, --kinds, ledger count; without it the tick --json schema and the counts are unchanged', FAKES_SKIP, () => {
  const r = rig();
  const over = { FIXTURE_RESUME: 'W-3' };
  const t = r.tick(WITH, [], over);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^RESUME my-app\/W-3 resume answered by the owner$/m);
  assert.match(r.tick(WITH, ['--prompt'], over).stdout, /^RESUME roadctl show <id>; continue 1 card\(s\) as claude-code@home-wsl$/m);
  const j = JSON.parse(r.tick(WITH, ['--json'], over).stdout);
  assert.deepEqual(j.items.filter((i) => i.kind === 'RESUME').map((i) => [i.project, i.id]), [['my-app', 'W-3']]);
  assert.ok(tickJsonProblems(j).some((p) => /RESUME|kind/.test(p)), 'the strict core schema does not know a module kind: the module that adds it extends the schema');
  assert.equal(r.tick(WITH, ['--kinds', 'resume'], over).status, 0);
  assert.equal(r.tick(WITH, ['--kinds', 'take'], over).status, 4, 'filtered out');
  assert.equal(r.tick(SELF, ['--kinds', 'resume']).status, 2, 'unknown kind without the module');
  const ledger = fs.readFileSync(path.join(r.env.XDG_STATE_HOME, 'road-map-journal', 'ticks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger[0].counts.resume, 1);
  // without the module, or with it but no such items: the same JSON and the same ledger counts as before
  const base = JSON.parse(r.tick(SELF, ['--json']).stdout);
  assert.deepEqual(tickJsonProblems(base), []);
  assert.deepEqual(JSON.parse(r.tick(WITH, ['--json']).stdout), base);
  const last = fs.readFileSync(path.join(r.env.XDG_STATE_HOME, 'road-map-journal', 'ticks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual(Object.keys(last.counts).sort(), ['accept', 'stale', 'start', 'take']);
  assert.throws(() => buildRegistry([{ name: 'x', tickKinds: { RUN: { prompt: 'x' } } }], { knownTickKinds: ['RUN'] }), /tick kind RUN already exists/);
  assert.throws(() => buildRegistry([{ name: 'x', tickKinds: { lower: { prompt: 'x' } } }]), /bad tick kind/);
});

// ---------------------------------------------------------------- a4: the owner flag

test('P5.28 a4: the owner flag is read from the command entry; help says so; "help = docs" checks it against the docs line', () => {
  const owners = Object.entries(rc.ALL_COMMANDS).filter(([, c]) => c.owner === true).map(([n]) => n).sort();
  assert.deepEqual(owners, ['approve', 'auto', 'done', 'pause', 'queue', 'resume']);
  assert.match(rc.helpFor('approve'), /^Owner only: /m);
  assert.doesNotMatch(rc.helpFor('status'), /Owner only: /);
  assert.deepEqual(helpDocsProblems(rc.ALL_COMMANDS, { overview: rc.helpOverview(), docs: DOCS }), []);
  const spec = { summary: 's', purpose: 'p', usage: ['u'], examples: ['e'], changes: 'c', exits: '0', flags: [], hidden: true };
  const docs = 'Owner-only commands: `a`, `b`.\n';
  assert.deepEqual(helpDocsProblems({ a: { ...spec, owner: true }, b: { ...spec, owner: true } }, { overview: '', docs }), []);
  assert.deepEqual(helpDocsProblems({ a: { ...spec, owner: true }, b: spec }, { overview: '', docs }), ['b: listed as owner-only in docs/roadctl.md but its command entry has no owner flag']);
  assert.deepEqual(helpDocsProblems({ a: { ...spec, owner: true }, c: { ...spec, owner: true } }, { overview: '', docs }), ['c: owner command not listed in the "Owner-only commands:" line of docs/roadctl.md']);
  assert.deepEqual(helpDocsProblems({ a: { ...spec, owner: true } }, { overview: '', docs: 'nothing\n' }), ['docs/roadctl.md has no "Owner-only commands:" line']);
  assert.throws(() => buildRegistry([{ name: 'x', commands: { c: { ...spec, group: 'Look', effect: 'read', run: () => 0, owner: 'yes' } } }], { groups: ['Look'] }), /owner must be true or false/);
});

// ---------------------------------------------------------------- a5: help topics

test('P5.28 a5: roadctl help unattended prints the topic; a module topic works; the overview stays at most 70 lines', FAKES_SKIP, () => {
  const r = rig();
  const u = r.run(SELF, ['help', 'unattended']);
  assert.equal(u.status, 0);
  assert.match(u.stdout, /^roadctl help unattended: what an agent may do without the owner/);
  assert.match(u.stdout, /Owner-only commands/);
  assert.ok(rc.helpOverview().split('\n').length <= 70);
  assert.deepEqual(r.run(WITH, ['help', 'fixture-topic']).stdout, 'roadctl help fixture-topic: a fixture topic\n\nline one\nline two\n');
  assert.ok(r.run(WITH, ['help']).stdout.split('\n').filter(Boolean).length <= 70);
  assert.equal(r.run(SELF, ['help', 'fixture-topic']).status, 2, 'unknown without the module');
  assert.throws(() => buildRegistry([{ name: 'x', helpTopics: { unattended: { summary: 's', text: 'x' } } }], { knownTopics: ['unattended'] }), /help topic unattended already exists/);
  assert.throws(() => buildRegistry([{ name: 'x', helpTopics: { t: { text: 'x' } } }]), /needs \{ summary, text \}/);
});

// ---------------------------------------------------------------- a9: START admission and dependency states

test('P5.28 a9: a module START refusal and a module state that meets depends_on agree in tick, autonomy, next, status and lint; without the module nothing changes', FAKES_SKIP, () => {
  // dependency state: W-5 depends on W-2 (review); the module counts rule_ok: yes as met
  const d = rig();
  d.queueW5();
  d.edit(d.cardFile('W-2'), (x) => x.replace('id: W-2', 'id: W-2\nrule_ok: yes'));
  for (const bin of [SELF, WITH]) {
    const met = bin === WITH;
    assert.deepEqual(kindsOf(d.tick(bin, ['--kinds', 'start']).stdout), met ? ['START'] : [], `tick (${met ? 'with' : 'without'} the module)`);
    const au = d.run(bin, ['autonomy', '--board', d.board]).stdout;
    if (met) assert.match(au, /\[W-5\] ready auto \| eligible now/);
    else assert.match(au, /\[W-5\][^\n]*not eligible: deps open: W-2 \(review\)/);
    const next = d.run(bin, ['next', '--board', d.board]).stdout;
    if (met) assert.match(next, /READY \[W-5\]/);
    else assert.doesNotMatch(next, /READY \[W-5\]/);
  }
  // START refusal: the same queued card, the module says it is outside the mandate
  const s = rig();
  s.queueW5('\nby_mandate: no');
  s.edit(s.cardFile('W-2'), (x) => x.replace('id: W-2', 'id: W-2\nrule_ok: yes'));
  assert.deepEqual(kindsOf(s.tick(SELF, ['--kinds', 'start']).stdout), [], 'without the module: deps still open');
  assert.deepEqual(kindsOf(s.tick(WITH, ['--kinds', 'start']).stdout), [], 'refused by the module');
  assert.match(s.run(WITH, ['autonomy', '--board', s.board]).stdout, /\[W-5\][^\n]*not eligible: outside the mandate/);
  const l = lintOf(s, WITH);
  assert.deepEqual(l.filter((x) => x.rule === 31).map((x) => x.msg), ['autonomy.queue: W-5 would not start: outside the mandate (module fixture-seams)']);
  const st = JSON.parse(s.run(WITH, ['status', '--json', '--board', s.board]).stdout);
  const one = Array.isArray(st) ? st[0] : st;
  assert.equal(one.lint.warnings, l.filter((x) => x.level === 'warning').length, 'status counts the same lint warning');
  assert.ok(!lintOf(s, SELF).some((x) => x.rule === 31));
  // without any module the tick JSON of this board keeps the schema
  assert.deepEqual(tickJsonProblems(JSON.parse(s.tick(SELF, ['--json']).stdout)), []);
});
