// P5.6 first slice: `roadctl routine observe <id> --as <agent>` core (a1, a2, a6).
// Run: node --test scripts/roadctl/observe.test.mjs
// Nothing here starts a model or reaches a network: claude and wsl.exe are the fakes of scripts/testkit/. Time: ROADCTL_NOW (shared helper).
// The machine state is a temp XDG_STATE_HOME; observe keeps its snapshot (observe.state.json) next to ticks.jsonl and digest.state.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAKES_SKIP, installFakes, readCalls } from '../testkit/fakes.mjs';
import { clock, shift, T0 } from '../testkit/time.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(scripts, 'roadctl.mjs');
const EXAMPLE_BOARD = path.join(scripts, '..', 'examples', 'board-example', 'board');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const ME = 'claude-code@home-wsl';
const OTHER = 'codex@home-wsl';
const OWNER = 'Owner';

/** A workspace with the example board as project my-app, fake executables, a roadctl wrapper on PATH and an environment that touches nothing outside a temp dir. */
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-observe-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  const q = (s) => `'${s}'`;
  const bin = installFakes(path.join(dir, 'bin'), { extra: { roadctl: `exec ${q(process.execPath)} ${q(SELF)} "$@"` } });
  const state = path.join(dir, 'state');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, USER: 'tester', XDG_STATE_HOME: state, XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'cfg'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10', ROADCTL_HOST: 'test-host', FAKE_LOG: path.join(dir, 'calls.jsonl'), PYTHONDONTWRITEBYTECODE: '1', ...clock(T0) };
  delete env.FAKE_MODE;
  const sd = path.join(state, 'road-map-journal');
  const run = (args, over = {}, input = '') => spawnSync(process.execPath, [SELF, ...args, '--board', board], { cwd: ws, encoding: 'utf8', input, env: { ...env, ...over } });
  const ok = (args, over = {}, input = '') => {
    const r = run(args, over, input);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  const routine = (agent = ME, id = 'mr-status') => {
    ok(['routine', 'new', id, 'Collect MR status', '--agent', agent, '--model', 'haiku', '--env', 'laptop', '--every', '2h']);
    ok(['routine', 'on', id, '--by', OWNER, '--source', 'chat 2026-11-12']);
    ok(['autonomy', 'routines', 'on', '--by', OWNER]);
  };
  const observe = (id, facts, agent = ME, over = {}, flags = []) => run(['routine', 'observe', id, '--as', agent, ...flags], over, JSON.stringify(facts));
  const digest = (args = [], over = {}) => run(['digest', ...args], over);
  const calls = (n) => readCalls(env.FAKE_LOG, n);
  const routineFile = (id = 'mr-status') => path.join(board, 'routines', `${id}.md`);
  return { dir, ws, board, bin, env, sd, run, ok, routine, observe, digest, calls, routineFile, observeFile: path.join(sd, 'observe.state.json') };
}

// ---------------------------------------------------------------- a1: an empty set closes the run without a model

test('P5.6 a1: an empty problem set closes the run (recorded, ok) without the fake claude being called', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const before = r.calls().length;
  const res = r.observe('mr-status', { problems: [] });
  assert.equal(res.status, 0, `${res.stderr}${res.stdout}`);
  assert.match(res.stdout, /roadctl routine observe: recorded/);
  assert.equal(r.calls('claude').length, 0, 'no model, no limits probe');
  assert.equal(r.calls().length, before, 'observe starts nothing besides itself');
  assert.match(fs.readFileSync(r.routineFile(), 'utf8'), /RUN ok: did: checked \[run=r-[0-9a-f]{12} host=test-host\]/);
  const runs = JSON.parse(r.run(['runs', '--json']).stdout);
  const ours = runs.filter((x) => x.kind === 'routine' && x.id === 'mr-status');
  assert.equal(ours.length, 1);
  assert.equal(ours[0].outcome, 'ok');
  assert.deepEqual(ours[0].problems, []);
});

// ---------------------------------------------------------------- a2: one digest message per problem key

test('P5.6 a2: the same problem key in two observations gives one digest message; the snapshot is local machine state', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const facts = { problems: [{ key: 'disk-full', text: '/var is full on srv-3' }], did: 'nodes 7/7, requests open 1' };
  assert.equal(r.observe('mr-status', facts).status, 0);
  assert.equal(r.observe('mr-status', { ...facts, did: 'nodes 7/7, requests open 1 (again)' }).status, 0);
  const dry = r.digest(['--dry-run']);
  assert.equal(dry.status, 0, `${dry.stderr}${dry.stdout}`);
  assert.equal((dry.stdout.match(/disk-full/g) ?? []).length, 1, 'the problem is told once, not once per observation');
  const first = r.digest([]);
  assert.match(first.stdout, /disk-full/);
  assert.equal(r.digest([]).stdout.trim(), '', 'the next digest has nothing new');
  // the snapshot lives in the machine state directory, like ticks.jsonl and digest.state.json
  assert.ok(fs.existsSync(r.observeFile), 'observe.state.json is in the state directory');
  const snap = JSON.parse(fs.readFileSync(r.observeFile, 'utf8'));
  assert.equal(snap.v, 1);
  assert.deepEqual(Object.keys(snap.routines), ['my-app/mr-status']);
  assert.deepEqual(snap.routines['my-app/mr-status'].problems['disk-full'], { key: 'disk-full', text: '/var is full on srv-3', since: T0, streak: 2, gone: 0 });
});

test('P5.6 a2: a changed key is a new message, and dedupe is by key (a changed text alone is still the same problem)', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  assert.equal(r.observe('mr-status', { problems: [{ key: 'disk-full', text: 'first text' }], did: 'nodes 7/7' }).status, 0);
  assert.equal(r.observe('mr-status', { problems: [{ key: 'disk-full', text: 'different text' }], did: 'nodes 7/7' }).status, 0);
  assert.equal(r.observe('mr-status', { problems: [{ key: 'dns-timeout', text: 'lookup failed' }], did: 'nodes 7/7' }).status, 0);
  const d = r.digest(['--dry-run']);
  assert.equal(d.status, 0, `${d.stderr}${d.stdout}`);
  assert.equal((d.stdout.match(/disk-full/g) ?? []).length, 1, 'the changed text is not a new message');
  assert.match(d.stdout, /dns-timeout/, 'a new key is a new message');
});

// ---------------------------------------------------------------- a3/a4: hysteresis (--confirm-after N)

test('P5.6 a3: a problem is reported as resolved only after N observations in a row without it', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const facts = { problems: [{ key: 'disk-full', text: '/var is full on srv-3' }], did: 'nodes 7/7' };
  const flags = ['--confirm-after', '2'];
  const at = (m) => clock(shift(180 + m)); // after noon: the day fallback (noon) stays before every last_run, so the Log order is preserved
  assert.equal(r.observe('mr-status', facts, ME, at(0), flags).status, 0);
  assert.equal(r.observe('mr-status', facts, ME, at(1), flags).status, 0); // confirmed now
  const first = r.digest([]);
  assert.equal(first.status, 0, `${first.stderr}${first.stdout}`);
  assert.match(first.stdout, /disk-full/, 'the confirmed problem is told');
  assert.doesNotMatch(first.stdout, /снято/, 'nothing is resolved yet');
  // one observation without it: still published, so nothing is resolved yet
  assert.equal(r.observe('mr-status', { problems: [], did: 'nodes 7/7' }, ME, at(2), flags).status, 0);
  assert.equal(r.digest([]).stdout.trim(), '', 'not gone after one absence');
  // the second absence confirms it is gone: one resolved line, told once
  assert.equal(r.observe('mr-status', { problems: [], did: 'nodes 7/7' }, ME, at(3), flags).status, 0);
  const third = r.digest([]);
  assert.equal(third.status, 0, `${third.stderr}${third.stdout}`);
  assert.match(third.stdout, /снято: my-app\/mr-status: disk-full/);
  assert.equal(r.digest([]).stdout.trim(), '', 'the resolved line is told once');
});

test('P5.6 a4: a problem shorter than N observations in a row is never published', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const facts = { problems: [{ key: 'disk-full', text: '/var is full on srv-3' }], did: 'nodes 7/7' };
  const flags = ['--confirm-after', '2'];
  assert.equal(r.observe('mr-status', facts, ME, {}, flags).status, 0);
  assert.equal(r.observe('mr-status', { problems: [], did: 'nodes 7/7' }, ME, {}, flags).status, 0);
  const dry = r.digest(['--dry-run']);
  assert.equal(dry.status, 0, `${dry.stderr}${dry.stdout}`);
  assert.equal(dry.stdout.trim(), '', 'a one-off problem is never reported');
  assert.doesNotMatch(dry.stdout, /disk-full/);
});

// ---------------------------------------------------------------- a5: bad input is a recorded failed run

test('P5.6 a5: stdin that is not JSON records a failed run with a transient observe-input problem and exits 1', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const res = r.run(['routine', 'observe', 'mr-status', '--as', ME], {}, 'not json');
  assert.equal(res.status, 1);
  const file = fs.readFileSync(r.routineFile(), 'utf8');
  assert.match(file, /RUN failed: did: observe input \| problem: transient: observe-input: stdin is not JSON/);
  assert.match(file, /last_result: failed/);
  assert.ok(!fs.existsSync(r.observeFile), 'bad input does not touch the snapshot');
  assert.equal(r.calls('claude').length, 0, 'no model');
});

test('P5.6 a5: stdin JSON of the wrong shape or with a bad problem key is a failed run, not a refusal', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const wrong = r.run(['routine', 'observe', 'mr-status', '--as', ME], {}, JSON.stringify({ problems: 'nope' }));
  assert.equal(wrong.status, 1);
  assert.match(fs.readFileSync(r.routineFile(), 'utf8'), /problem: transient: observe-input: stdin JSON must be an object with a problems array/);
  const bad = r.run(['routine', 'observe', 'mr-status', '--as', ME], {}, JSON.stringify({ problems: [{ key: 'not a key', text: 'x' }] }));
  assert.equal(bad.status, 1);
  const file = fs.readFileSync(r.routineFile(), 'utf8');
  assert.match(file, /problem: transient: observe-input: bad problem key not a key/);
  assert.doesNotMatch(file, /RUN ok/);
  assert.equal(r.calls('claude').length, 0, 'no model');
});

// ---------------------------------------------------------------- a6: only the routine's agent

test('P5.6 a6: observe from an agent that is not the routine\'s agent is refused (non-zero, clear message, nothing written, no model)', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const res = r.observe('mr-status', { problems: [] }, OTHER);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /only the routine's agent \(claude-code@home-wsl\) may observe, not codex@home-wsl/);
  assert.doesNotMatch(fs.readFileSync(r.routineFile(), 'utf8'), /RUN ok/, 'no run was recorded on the board');
  assert.ok(!fs.existsSync(r.observeFile), 'no snapshot was written');
  assert.equal(r.calls('claude').length, 0, 'no model, no probe');
});

test('P5.6: more than three problems are not dropped: two are told, the rest is one stable `more` message; the snapshot keeps all and their first-seen time', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const problems = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: `p-${k}`, text: `problem ${k}` }));
  assert.equal(r.observe('mr-status', { problems, did: 'nodes 5/7' }).status, 0);
  const d = r.digest(['--dry-run']);
  assert.match(d.stdout, /p-a/);
  assert.match(d.stdout, /3 more problems: p-c, p-d, p-e/);
  assert.equal(r.observe('mr-status', { problems, did: 'nodes 5/7' }).status, 0);
  const snap = JSON.parse(fs.readFileSync(r.observeFile, 'utf8')).routines['my-app/mr-status'].problems;
  assert.deepEqual(Object.keys(snap), ['p-a', 'p-b', 'p-c', 'p-d', 'p-e']);
  assert.equal(snap['p-e'].since, T0, 'a problem keeps the time it was first seen');
});
