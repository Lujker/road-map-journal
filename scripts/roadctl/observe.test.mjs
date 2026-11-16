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

// ---------------------------------------------------------------- a7: the snapshot is local; the board gets a commit only when the set changes

const nowAt = (m) => clock(shift(180 + m));
const head = (r) => fs.readFileSync(r.routineFile(), 'utf8');

test('P5.6 a7: with --heartbeat an unchanged set is not a board commit; tick here is not due, digest is not OVERDUE; a change publishes; the heartbeat publishes', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const hb = ['--heartbeat', '24h'];
  const facts = { problems: [], did: 'nodes 7/7, requests open 1' };
  assert.equal(r.observe('mr-status', facts, ME, nowAt(0), hb).status, 0); // first run: always published
  const first = head(r);
  assert.match(first, /^last_run: /m);
  const runs = (s) => (s.match(/RUN ok/g) ?? []).length;
  assert.equal(runs(first), 1);
  // 2h later and 4h later: unchanged, so the routine file does not change
  const q = r.observe('mr-status', facts, ME, nowAt(120), hb);
  assert.equal(q.status, 0, q.stderr);
  assert.match(q.stdout, /kept in machine state only/);
  assert.equal(head(r), first, 'no change of the routine file');
  assert.equal(r.observe('mr-status', facts, ME, nowAt(240), hb).status, 0);
  assert.equal(head(r), first);
  // tick on this machine reads the local last_run: not due 1h after the quiet run, due after 2h
  const tick = (m) => r.run(['tick', '--as', ME, '--no-pull', '--routine', 'mr-status', '--kinds', 'run'], nowAt(m));
  assert.equal(tick(240 + 60).status, 4, 'not due: the quiet run counts');
  assert.match(tick(240 + 130).stdout, /RUN my-app\/mr-status/);
  // digest on this machine: a quiet watchdog 4h after the git last_run (every 2h, so 2x every is 4h) is not OVERDUE
  const day = r.digest(['--daily'], nowAt(240 + 30));
  assert.match(day.stdout, /my-app\/mr-status/, 'the daily overview has the routine line');
  assert.doesNotMatch(day.stdout, /ПРОСРОЧЕНА|OVERDUE/);
  assert.match(r.digest(['--daily'], nowAt(240 + 400)).stdout, /ПРОСРОЧЕНА|OVERDUE/, 'a watchdog that really stopped is still overdue');
  // a change of the confirmed set publishes
  const bad = { problems: [{ key: 'disk-full', text: '/var is full' }], did: 'nodes 6/7' };
  assert.equal(r.observe('mr-status', bad, ME, nowAt(250), hb).status, 0);
  assert.equal(runs(head(r)), 2);
  assert.match(head(r), /problem: unknown: disk-full/);
  // the same problem again: quiet
  const before = head(r);
  assert.equal(r.observe('mr-status', bad, ME, nowAt(260), hb).status, 0);
  assert.equal(head(r), before);
  // the heartbeat: the git last_run is older than 24h, so even an unchanged set is published
  assert.equal(r.observe('mr-status', bad, ME, nowAt(250 + 25 * 60), hb).status, 0);
  assert.equal(runs(head(r)), 3);
  // without --heartbeat every run is published (the safe default: another machine sees the run)
  assert.equal(r.observe('mr-status', bad, ME, nowAt(250 + 25 * 60 + 5)).status, 0);
  assert.equal(runs(head(r)), 4);
});

test('P5.6 a7: a failed run is always published and a quiet run after it publishes again; the run ledger gets the quiet run', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME);
  const hb = ['--heartbeat', '24h'];
  const facts = { problems: [], did: 'nodes 7/7' };
  assert.equal(r.observe('mr-status', facts, ME, nowAt(0), hb).status, 0);
  assert.equal(r.run(['routine', 'observe', 'mr-status', '--as', ME, ...hb], nowAt(10), 'not json').status, 1);
  assert.match(head(r), /last_result: failed/);
  // the git header says failed: an unchanged set must publish the recovery, not hide it
  assert.equal(r.observe('mr-status', facts, ME, nowAt(20), hb).status, 0);
  assert.match(head(r), /last_result: ok/);
  assert.equal(r.observe('mr-status', facts, ME, nowAt(30), hb).status, 0); // quiet now
  const ours = JSON.parse(r.run(['runs', '--json']).stdout).filter((x) => x.kind === 'routine' && x.id === 'mr-status');
  assert.equal(ours.length, 4, 'every observation is in the local run ledger, published or not');
  assert.ok(ours.every((x) => x.outcome === 'ok' || x.outcome === 'failed'));
  assert.equal(r.run(['routine', 'observe', 'mr-status', '--as', ME, '--heartbeat', 'soon'], {}, '{"problems":[]}').status, 2);
});

// ---------------------------------------------------------------- a10: a watchdog with model none gets RUN without the limits gate

test('P5.6 a10: a routine with model none and a script agent: tick --as <script> --routine ID gives RUN, not blocked-unknown; a model routine still depends on limits', FAKES_SKIP, () => {
  const r = rig();
  const SCRIPT_AGENT = 'cron:watchdog@home-wsl';
  r.ok(['routine', 'new', 'wd', 'Watch servers', '--agent', SCRIPT_AGENT, '--model', 'none', '--env', 'laptop', '--every', '30m']);
  r.ok(['routine', 'on', 'wd', '--by', OWNER, '--source', 'chat 2026-11-12']);
  r.ok(['autonomy', 'routines', 'on', '--by', OWNER]);
  const before = r.calls().length;
  const t = r.run(['tick', '--as', SCRIPT_AGENT, '--no-pull', '--routine', 'wd']);
  assert.equal(t.status, 0, `${t.stderr}${t.stdout}`);
  assert.match(t.stdout, /^tick cron:watchdog@home-wsl: work$/m);
  assert.match(t.stdout, /^RUN my-app\/wd /m);
  assert.equal(r.calls().length, before, 'no limits probe, no model');
  // the same script with a model routine is still gated: its provider is unknown here
  r.ok(['routine', 'new', 'wd2', 'With a model', '--agent', SCRIPT_AGENT, '--model', 'haiku', '--env', 'laptop', '--every', '30m']);
  r.ok(['routine', 'on', 'wd2', '--by', OWNER, '--source', 'chat 2026-11-12']);
  assert.equal(r.run(['tick', '--as', SCRIPT_AGENT, '--no-pull', '--routine', 'wd2']).status, 3);
});

// ---------------------------------------------------------------- a9: the shipped example watchdog (examples/routines + examples/scheduler) on fixture data

const PY = spawnSync('python3', ['--version']).status === 0;
const EXAMPLES = path.join(scripts, '..', 'examples');

test('P5.6 a9: the example watchdog routine lints in a board, is switched off, and the example script on fixture facts gives problems by status and last movement, numbers in did', { skip: !PY && 'python3 missing' }, () => {
  const r = rig();
  fs.mkdirSync(path.join(r.board, 'routines'), { recursive: true });
  fs.copyFileSync(path.join(EXAMPLES, 'routines', 'watchdog.md'), path.join(r.board, 'routines', 'server-watchdog.md'));
  r.ok(['sync']);
  const lint = r.run(['lint']);
  assert.equal(lint.status, 0, `${lint.stderr}${lint.stdout}`);
  assert.match(fs.readFileSync(path.join(r.board, 'routines', 'server-watchdog.md'), 'utf8'), /^enabled: false$/m);
  assert.match(fs.readFileSync(path.join(r.board, 'routines', 'server-watchdog.md'), 'utf8'), /EXAMPLE, not a real routine/);
  const facts = {
    now: '2026-11-16T10:00:00Z',
    nodes: [...Array.from({ length: 6 }, (_, i) => ({ name: `srv-${i + 1}`, up: true })), { name: 'srv-7', up: false }],
    requests: [
      { id: 'R-1', status: 'waiting_customer', created: '2026-11-01T09:00:00Z', updated: '2026-11-16T09:00:00Z' }, // old, but moved an hour ago: fine
      { id: 'R-2', status: 'open', created: '2026-11-16T08:00:00Z', updated: '2026-11-16T08:00:00Z' }, // young, 2h in open (limit 8h): fine
      { id: 'R-3', status: 'open', created: '2026-11-16T09:00:00Z', updated: '2026-11-15T22:00:00Z' }, // 12h without movement: a problem
      { id: 'R-4', status: 'closed', created: '2026-10-01T09:00:00Z', updated: '2026-10-02T09:00:00Z' }, // closed: never a problem
    ],
  };
  const file = path.join(r.dir, 'facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const py = spawnSync('python3', [path.join(EXAMPLES, 'scheduler', 'watchdog-example.py'), '--facts', file, '--print'], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const out = JSON.parse(py.stdout);
  assert.deepEqual(out.problems.map((p) => p.key), ['node-down-srv-7', 'request-stale-R-3']);
  assert.equal(out.did, 'nodes 6/7, requests open 3');
  // the output is exactly what observe reads: it records the run with the numbers
  r.ok(['routine', 'new', 'wd-fixture', 'fixture', '--agent', ME, '--model', 'none', '--env', 'laptop', '--every', '30m']);
  assert.equal(r.observe('wd-fixture', out).status, 0);
  assert.match(fs.readFileSync(r.routineFile('wd-fixture'), 'utf8'), /did: nodes 6\/7, requests open 3 \| problem: unknown: node-down-srv-7/);
});
