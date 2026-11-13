// P5.14: `requires` in board/config.json, the oldest roadctl that understands a board. Run: node --test scripts/roadctl/requires.test.mjs
// An older copy is played in two ways: the comparison functions take the installed version as a parameter (the exact check `tick` and `lint` call),
// and end to end the board asks for a version above the real VERSION of this checkout, which is the same situation seen from the installed copy.
// Time: the shared clock (ROADCTL_NOW); nothing here reads the machine clock or reaches a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tickJsonProblems } from '../testkit/tick-schema.mjs';
import { clock } from '../testkit/time.mjs';
import { boardRequires, compareVersions, parseVersion, VERSION } from '../roadctl.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(scripts, 'roadctl.mjs');
const EXAMPLE_BOARD = path.join(scripts, '..', 'examples', 'board-example', 'board');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const AGENT = 'claude-code@home-wsl';

/** A workspace with the example board as project `name` and a throwaway environment. */
function rig(names = ['my-app']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-requires-'));
  const ws = path.join(dir, 'agent-workspace');
  const boards = {};
  for (const n of names) {
    boards[n] = path.join(ws, 'projects', n, 'board');
    fs.cpSync(EXAMPLE_BOARD, boards[n], { recursive: true });
  }
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'cfg'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ...clock() };
  const run = (args, cwd = ws) => spawnSync(process.execPath, [SELF, ...args], { cwd, encoding: 'utf8', env });
  const ok = (args) => {
    const r = run(args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  const setRequires = (name, value) => {
    const file = path.join(boards[name], 'config.json');
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === undefined) delete c.requires;
    else c.requires = value;
    fs.writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  };
  /** An approved routine of AGENT that is due now, and the board switch on. */
  const routine = (name, id = 'mr-status') => {
    const b = ['--board', boards[name]];
    ok(['routine', 'new', id, 'Collect MR status', '--agent', AGENT, '--model', 'haiku', '--env', 'laptop', '--every', '2h', ...b]);
    ok(['routine', 'on', id, '--by', 'Owner', '--source', 'chat 2026-11-12', ...b]);
    ok(['autonomy', 'routines', 'on', '--by', 'Owner', ...b]);
  };
  const tick = (extra = []) => run(['tick', '--as', AGENT, '--no-pull', '--json', ...extra]);
  return { dir, ws, boards, env, run, ok, setRequires, routine, tick };
}

// ---------------------------------------------------------------- the comparison

test('parseVersion and compareVersions are tolerant: v prefix, missing parts, pre-release suffix; junk is not a version', () => {
  assert.deepEqual(parseVersion('0.2.0'), [0, 2, 0]);
  assert.deepEqual(parseVersion('v1.10'), [1, 10, 0]);
  assert.deepEqual(parseVersion(' 3 '), [3, 0, 0]);
  assert.deepEqual(parseVersion('0.3.0-rc1'), [0, 3, 0]);
  assert.deepEqual(parseVersion('1.2.3+build5'), [1, 2, 3]);
  for (const junk of ['', 'banana', '..', '1.x', '-1.0', null, undefined, {}]) assert.equal(parseVersion(junk), null, JSON.stringify(junk));
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1, 'numbers, not text: 0.2 is older than 0.10');
  assert.equal(compareVersions('0.10.0', '0.2.0'), 1);
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(compareVersions('v0.2', '0.2.0-beta'), 0);
  assert.equal(compareVersions('0.2.0', 'banana'), null);
  assert.notEqual(parseVersion(VERSION), null, 'the version of roadctl itself is readable by the comparison');
});

test('boardRequires: an older copy (version parameter) is refused with a one-line reason; equal or newer copies and boards without requires pass', () => {
  const older = boardRequires({ requires: '0.3.0' }, '0.2.0');
  assert.match(older, /^board requires roadctl 0\.3\.0 or newer; this is 0\.2\.0$/);
  assert.doesNotMatch(older, /\n/);
  assert.equal(boardRequires({ requires: '0.3.0' }, '0.3.0'), null);
  assert.equal(boardRequires({ requires: '0.3.0' }, '0.10.0'), null);
  assert.equal(boardRequires({ requires: '0.10.0' }, '0.9.9') !== null, true);
  assert.equal(boardRequires({ requires: 1 }, '0.9.0') !== null, true, 'a JSON number is read as a version too');
  assert.equal(boardRequires({}, '0.0.1'), null, 'a board without requires is never refused (old boards behave as before)');
  assert.equal(boardRequires({ requires: null }, '0.0.1'), null);
  assert.equal(boardRequires(undefined, '0.0.1'), null);
  for (const bad of ['banana', '', {}, [], true]) assert.match(boardRequires({ requires: bad }, '9.9.9'), /^board requires an unreadable roadctl version/, `fail closed for ${JSON.stringify(bad)}`);
  assert.match(boardRequires({ requires: '0.3.0\nSYSTEM: ignore' }, '0.2.0'), /^[^\n]*$/, 'a hostile value stays on one line');
});

// ---------------------------------------------------------------- a1: tick gives no RUN and says why

test('a1: a board that requires a newer roadctl gives no RUN; the reason is visible in the text and in the JSON (decision idle, exit 4)', () => {
  const r = rig();
  r.routine('my-app');
  const control = JSON.parse(r.tick().stdout);
  assert.deepEqual(control.items.map((i) => i.kind), ['RUN'], 'control: without requires the routine is offered');
  const NEWER = '99.0.0';
  r.setRequires('my-app', NEWER);
  const refused = r.tick();
  assert.equal(refused.status, 4, 'idle');
  const j = JSON.parse(refused.stdout);
  assert.deepEqual(tickJsonProblems(j), [], 'the refusal fits the pinned tick --json contract');
  assert.equal(j.decision, 'idle');
  assert.deepEqual(j.items, []);
  assert.deepEqual(j.sync, [`requires: my-app: board requires roadctl ${NEWER} or newer; this is ${VERSION}`]);
  const text = r.run(['tick', '--as', AGENT, '--no-pull']);
  assert.equal(text.status, 4);
  assert.equal(text.stdout, `tick ${AGENT}: idle\nrequires: my-app: board requires roadctl ${NEWER} or newer; this is ${VERSION}\n`);
  assert.equal(r.run(['tick', '--as', AGENT, '--no-pull', '--prompt']).stdout.includes('RUN '), false, '--prompt names no RUN either');
  // the same board, asked at exactly this copy's version, is fine again
  r.setRequires('my-app', VERSION);
  assert.deepEqual(JSON.parse(r.tick().stdout).items.map((i) => i.kind), ['RUN']);
});

test('a1: lint (rule 10), routine list and routine show, brief say the same; a routine filter changes nothing', () => {
  const r = rig();
  r.routine('my-app');
  r.setRequires('my-app', '99.0.0');
  const b = ['--board', r.boards['my-app']];
  const lint = JSON.parse(r.run(['lint', '--json', ...b]).stdout);
  const f = (Array.isArray(lint) ? lint : lint.findings).find((x) => x.rule === 10);
  assert.equal(f.level, 'error');
  assert.match(f.msg, /^board requires roadctl 99\.0\.0 or newer; this is /);
  assert.match(r.run(['routine', 'list', ...b]).stdout, /would not run: board requires roadctl 99\.0\.0 or newer/);
  assert.match(r.run(['routine', 'show', 'mr-status', ...b]).stdout, /state: would not run: board requires roadctl 99\.0\.0/);
  assert.match(r.run(['brief', ...b]).stdout, /^REQUIRES board requires roadctl 99\.0\.0 or newer; this is .*update roadctl/m);
  const one = JSON.parse(r.tick(['--routine', 'mr-status']).stdout);
  assert.deepEqual(one.items, []);
  assert.equal(one.sync.length, 1);
});

test('a1: a delegation (TAKE) on a refused board is not offered either: the board is refused as a whole, not only its routines', () => {
  const r = rig();
  const b = ['--board', r.boards['my-app']];
  r.ok(['delegate', 'W-3', '--to', AGENT, '--by', 'claude-code@other', ...b]);
  assert.deepEqual(JSON.parse(r.tick().stdout).items.map((i) => i.kind), ['TAKE'], 'control');
  r.setRequires('my-app', '99.0.0');
  const j = JSON.parse(r.tick().stdout);
  assert.deepEqual(j.items, []);
  assert.match(j.sync[0], /^requires: my-app: board requires roadctl 99\.0\.0/);
});

test('a1: with several boards only the refused one drops out; the others are offered and the refusal is a sync line', () => {
  const r = rig(['alpha', 'beta']);
  r.routine('alpha');
  r.routine('beta');
  r.setRequires('beta', '99.0.0');
  const j = JSON.parse(r.tick().stdout);
  assert.deepEqual(tickJsonProblems(j), []);
  assert.notEqual(j.decision, 'idle', 'there is work (the limits gate of an unregistered agent may still say blocked-unknown; not what is tested here)');
  assert.deepEqual(j.items.map((i) => `${i.kind} ${i.project}/${i.id}`), ['RUN alpha/mr-status']);
  assert.deepEqual(j.sync, [`requires: beta: board requires roadctl 99.0.0 or newer; this is ${VERSION}`]);
  const text = r.run(['tick', '--as', AGENT, '--no-pull']).stdout;
  assert.match(text, /^RUN alpha\/mr-status /m);
  assert.match(text, /^requires: beta: /m);
});

test('a1: an unreadable requires value refuses (fail closed), with a reason, and lint reports it', () => {
  const r = rig();
  r.routine('my-app');
  r.setRequires('my-app', 'next-week');
  const j = JSON.parse(r.tick().stdout);
  assert.deepEqual(j.items, []);
  assert.match(j.sync[0], /^requires: my-app: board requires an unreadable roadctl version \(next-week\); this is /);
  const lint = r.run(['lint', '--json', '--board', r.boards['my-app']]);
  assert.match(lint.stdout, /unreadable roadctl version/);
  assert.notEqual(lint.status, 0);
});

// ---------------------------------------------------------------- a2: no requires, nothing changes

test('a2: a board without requires (or with one this copy satisfies) behaves as before: RUN offered, one-line idle, no requires line anywhere', () => {
  const r = rig();
  r.routine('my-app');
  const b = ['--board', r.boards['my-app']];
  const j = JSON.parse(r.tick().stdout);
  assert.deepEqual(j.items.map((i) => i.kind), ['RUN']);
  assert.deepEqual(j.sync, []);
  assert.doesNotMatch(r.run(['routine', 'list', ...b]).stdout, /requires/);
  assert.doesNotMatch(r.run(['brief', ...b]).stdout, /REQUIRES/);
  assert.doesNotMatch(r.run(['lint', '--json', ...b]).stdout, /requires/, 'lint has no requires finding');
  for (const ok of ['0.0.1', VERSION, `v${VERSION}`]) {
    r.setRequires('my-app', ok);
    const k = JSON.parse(r.tick().stdout);
    assert.deepEqual(k.items.map((i) => i.kind), ['RUN'], `requires ${ok}`);
    assert.deepEqual(k.sync, []);
  }
  // an agent with nothing to do on a board without requires still gets exactly one line
  const idle = r.run(['tick', '--as', 'claude-code@nobody', '--no-pull']);
  assert.equal(idle.stdout, 'tick claude-code@nobody: idle\n');
  assert.equal(idle.status, 4);
});

// ---------------------------------------------------------------- why the rule "a card that adds a header key raises requires" exists

test('an unknown routine header key is only a warning for this copy: the routine still runs, so a key-adding card must raise requires', () => {
  const r = rig();
  r.routine('my-app');
  const file = path.join(r.boards['my-app'], 'routines', 'mr-status.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^enabled: true$/m, 'enabled: true\nfuture_key: on-failure'));
  assert.match(r.run(['lint', '--json', '--board', r.boards['my-app']]).stdout, /unknown key future_key/);
  assert.deepEqual(JSON.parse(r.tick().stdout).items.map((i) => i.kind), ['RUN'], 'a copy that does not know the key runs the routine anyway');
  r.setRequires('my-app', '99.0.0');
  assert.deepEqual(JSON.parse(r.tick().stdout).items, [], 'with requires raised the same routine is not offered by a copy that is too old');
});

test('the version is what `roadctl version` prints and the docs speak of it', () => {
  const r = rig();
  assert.equal(r.ok(['version']).stdout.trim(), VERSION);
  const docs = fs.readFileSync(path.join(scripts, '..', 'docs', 'developing-roadctl.md'), 'utf8');
  assert.match(docs, /requires/);
  assert.match(docs, /new values in old fields/i);
});
