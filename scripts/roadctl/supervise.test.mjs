// roadctl supervise (P5.2): lock, timeout, detach, orphan, result check, log, pause, back-off, keys, Windows refusal.
// Real processes (short sleeps, short knobs); no model, no network: the executors are `sh -c` stubs and the fakes of scripts/testkit.
// Time: roadctl's clock is ROADCTL_NOW (the shared helper); waiting for a process uses real time. A test leaves no live child behind (rig.cleanup).
// Run: node --test scripts/roadctl/supervise.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAKES_SKIP, installFakes, isProbe, readCalls } from '../testkit/fakes.mjs';
import { tickJsonProblems } from '../testkit/tick-schema.mjs';
import { clock, shift, T0, wallClock } from '../testkit/time.mjs';
import { claudeResult, createRunLog, dropStaleGuard, EXIT, finishLock, inspectLock, LOG_KEEP_MS, pruneRunLogs, removeMarkedLock, superviseRun, takeDeadLock } from './supervise.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..');
const SELF = path.join(scripts, 'roadctl.mjs');
const EXAMPLE_BOARD = path.join(scripts, '..', 'examples', 'board-example', 'board');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const EXAMPLE = path.join(scripts, '..', 'examples', 'scheduler', 'supervised-routine.sh');
const DOCS = fs.readFileSync(path.join(scripts, '..', 'docs', 'roadctl.md'), 'utf8');
const ME = 'claude-code@home-wsl';
const NEEDS = FAKES_SKIP;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = async (fn, ms = 8000) => { const end = wallClock() + ms; let v = fn(); while (!v && wallClock() < end) { await new Promise((r) => setTimeout(r, 25)); v = fn(); } return v; }; // real time: a process

/** A workspace with the example board, fakes on PATH, short real-time knobs, and a way to run roadctl (sync or async) with everything in a temp dir. */
function rig({ self = SELF } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sup-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  const cfg = path.join(board, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), requires: '0.6.0' })); // the supervisor needs a board that declares the version that reads its trailer
  const bin = installFakes(path.join(dir, 'bin'), { extra: { roadctl: `exec '${process.execPath}' '${self}' "$@"` } });
  const state = path.join(dir, 'state', 'road-map-journal');
  const log = path.join(dir, 'calls.jsonl');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'config'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10', ...clock(T0), FAKE_LOG: log, FAKE_ENV_KEYS: 'HOME', ROADCTL_SUPERVISE_HEARTBEAT_MS: '100', ROADCTL_SUPERVISE_POLL_MS: '100', ROADCTL_SUPERVISE_GRACE_MS: '400' };
  delete env.FAKE_MODE;
  const children = [];
  const roadctl = (args, over = {}) => spawnSync(process.execPath, [self, ...args], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  /** Async: { child, done: Promise<{ code, signal, out, err }> }. */
  const start = (args, over = {}) => {
    const child = spawn(process.execPath, [self, ...args], { cwd: ws, env: { ...env, ...over }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    return { child, done: new Promise((res) => child.on('close', (code, signal) => res({ code, signal, out, err }))) };
  };
  const ok = (args) => {
    const r = roadctl(args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  const routine = (id = 'mr-status', agent = ME) => {
    ok(['routine', 'new', id, `Routine ${id}`, '--agent', agent, '--model', 'haiku', '--env', 'laptop', '--every', '2h', '--board', board]);
    ok(['routine', 'on', id, '--by', 'Owner', '--source', 'chat 2026-11-12', '--board', board]);
    ok(['autonomy', 'routines', 'on', '--by', 'Owner', '--board', board]);
  };
  const routineText = (id = 'mr-status') => fs.readFileSync(path.join(board, 'routines', `${id}.md`), 'utf8');
  const runs = () => JSON.parse(roadctl(['runs', '--json', '-n', '100']).stdout || '[]');
  const sup = (id, cmd, extra = []) => ['supervise', '--routine', id, '--as', ME, '--board', board, ...extra, '--', ...cmd];
  /** A command that records the pid of the `sleep` it started in `file` and waits for it. */
  const sleeper = (file, secs = 60) => ['sh', '-c', `sleep ${secs} & echo $! > '${file}'; wait`];
  const sidecars = () => (fs.existsSync(state) ? fs.readdirSync(state).filter((n) => n.endsWith('.lock.run')).map((n) => path.join(state, n)) : []);
  const cleanup = () => {
    for (const f of sidecars()) { try { process.kill(-JSON.parse(fs.readFileSync(f, 'utf8')).pgid, 'SIGKILL'); } catch { /* gone */ } }
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.pid'))) { try { process.kill(Number(fs.readFileSync(path.join(dir, f), 'utf8')), 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, ws, board, state, env, log, bin, roadctl, start, ok, routine, routineText, runs, sup, sleeper, sidecars, cleanup, calls: (n) => readCalls(log, n) };
}
const withRig = (fn) => async () => {
  const r = rig();
  try { await fn(r); } finally { r.cleanup(); }
};
const sidecarOf = (r) => JSON.parse(fs.readFileSync(r.sidecars()[0], 'utf8'));

// ---------------------------------------------------------------- units: the log and the adapter (a7, a12, a18)

test('P5.2 a12: Claude result metadata is optional and does not infer failure', () => {
  assert.deepEqual(claudeResult(JSON.stringify({ type: 'result', subtype: 'max_turns', session_id: 'abc', num_turns: 3, is_error: true, total_cost_usd: 0.12 }), 0),
    { exit_code: 0, session_id: 'abc', turns: 3, is_error: true, subtype: 'max_turns', cost_usd: 0.12 });
  assert.deepEqual(claudeResult('not json', 0), { exit_code: 0, session_id: 'unknown', turns: 'unknown', is_error: 'unknown', subtype: 'unknown', cost_usd: 'unknown' });
  assert.equal(claudeResult('', null).exit_code, 'unknown');
});

test('P5.2 a7/a18: bounded private run log, tail, footer and retention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadctl-supervise-'));
  try {
    const file = path.join(dir, 'r-test.log');
    const log = createRunLog(file, 'START time', { limit: 2048 });
    log.write('x'.repeat(10000) + 'THE END');
    assert.equal(log.close('END code=0 duration=1'), 'x'.repeat(593) + 'THE END');
    assert.ok(fs.statSync(file).size <= 2048);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(file, 'utf8'), /^START time\n[\s\S]*\nEND code=0 duration=1\n$/);
    const now = wallClock(); // the retention of a file is judged by its modification time: real time
    fs.utimesSync(file, new Date(now - LOG_KEEP_MS - 1000), new Date(now - LOG_KEEP_MS - 1000));
    fs.writeFileSync(path.join(dir, 'other.log'), 'keep');
    pruneRunLogs(dir, now);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(dir, 'other.log')), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- a1, a17: one run per key

test('P5.2 a1: a second supervise of the same routine is busy (5) and recorded as skipped: busy; another routine runs', NEEDS, withRig(async (r) => {
  r.routine('mr-a');
  r.routine('mr-b');
  const pid = path.join(r.dir, 'a.pid');
  const first = r.start(r.sup('mr-a', r.sleeper(pid)));
  assert.ok(await wait(() => r.sidecars().length === 1 && fs.existsSync(pid)), 'the first run is going');
  const second = r.roadctl(r.sup('mr-a', ['sh', '-c', 'echo ran > ran-a']));
  assert.equal(second.status, EXIT.busy, second.stderr);
  assert.match(second.stderr, /busy: routine:my-app\/mr-a is supervised by pid \d+/);
  assert.equal(fs.existsSync(path.join(r.ws, 'ran-a')), false, 'the second command did not start');
  assert.ok(r.runs().some((x) => x.outcome === 'skipped' && x.reason === 'busy' && x.id === 'mr-a'), 'skipped: busy is written, not a silent exit 0');
  const other = r.roadctl(r.sup('mr-b', ['sh', '-c', 'echo ran > ran-b']));
  assert.equal(other.status, EXIT.failed, 'it ran (and left no result)');
  assert.equal(fs.readFileSync(path.join(r.ws, 'ran-b'), 'utf8'), 'ran\n');
  process.kill(-sidecarOf(r).pgid, 'SIGKILL');
  await first.done;
}));

test('P5.2 a17: --card and --orchestrator have their own keys: two runs of one card, or of one agent\'s orchestrator, do not overlap', NEEDS, withRig(async (r) => {
  const cardId = fs.readdirSync(path.join(r.board, 'cards')).map((n) => /^id: (\S+)/m.exec(fs.readFileSync(path.join(r.board, 'cards', n), 'utf8'))?.[1]).find(Boolean);
  const card = (cmd, id = cardId) => ['supervise', '--card', id, '--as', ME, '--board', r.board, '--', ...cmd];
  const orch = (cmd, as = ME) => ['supervise', '--orchestrator', '--as', as, '--board', r.board, '--', ...cmd];
  const p1 = path.join(r.dir, 'c.pid');
  const first = r.start(card(r.sleeper(p1)));
  assert.ok(await wait(() => r.sidecars().length === 1 && fs.existsSync(p1)));
  assert.equal(r.roadctl(card(['true'])).status, EXIT.busy, 'the same card');
  const o1 = path.join(r.dir, 'o.pid');
  const second = r.start(orch(r.sleeper(o1)));
  assert.ok(await wait(() => r.sidecars().length === 2 && fs.existsSync(o1)), 'the orchestrator of the agent is another key from the card');
  assert.equal(r.roadctl(orch(['true'])).status, EXIT.busy, 'the same orchestrator');
  assert.notEqual(r.roadctl(orch(['true'], 'codex@home-wsl')).status, EXIT.busy, 'the orchestrator of another agent');
  assert.match(r.roadctl(['supervise', '--card', 'NO-SUCH', '--as', ME, '--board', r.board, '--', 'true']).stderr, /no card NO-SUCH/);
  for (const f of r.sidecars()) process.kill(-JSON.parse(fs.readFileSync(f, 'utf8')).pgid, 'SIGKILL');
  await Promise.all([first.done, second.done]);
}));

// ---------------------------------------------------------------- a2, a3: timeout and a lost result

test('P5.2 a2: a command that outlives --timeout dies with its child (TERM, then KILL), the outcome is timeout and the lock is free', NEEDS, withRig(async (r) => {
  r.routine();
  const pid = path.join(r.dir, 'sleep.pid');
  const t0 = wallClock();
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', `trap '' TERM; sleep 60 & echo $! > '${pid}'; wait`], ['--timeout', '1s']));
  assert.equal(res.status, EXIT.timeout, res.stderr);
  assert.ok(wallClock() - t0 < 8000);
  const sleepPid = Number(fs.readFileSync(pid, 'utf8'));
  assert.equal(await wait(() => !alive(sleepPid)), true, 'the grandchild is gone too');
  const run = r.runs().find((x) => x.id === 'mr-status');
  assert.equal(run.outcome, 'timeout');
  assert.equal(run.source, 'supervisor');
  assert.match(run.reason, /no result within 1s/);
  assert.deepEqual(fs.readdirSync(r.state).filter((n) => n.startsWith('supervise-')), [], 'no lock, no sidecar');
  assert.match(r.routineText(), /^last_result: failed$/m, 'the routine file got the result of the supervisor');
  assert.equal(r.roadctl(r.sup('mr-status', ['true'], ['--timeout', '1s'])).status, EXIT.notStarted, 'so it is not due again');
}));

test('P5.2 a3/a11: exit 0 without routine done is failed: no result, written to the routine file with source supervisor; the next tick offers nothing', NEEDS, withRig(async (r) => {
  r.routine();
  assert.match(r.roadctl(['tick', '--as', ME, '--routine', 'mr-status']).stdout, /^RUN my-app\/mr-status/m);
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', 'exit 0']));
  assert.equal(res.status, EXIT.failed, res.stderr);
  assert.match(res.stderr, /failed: no result \(exit 0/);
  const run = r.runs().find((x) => x.id === 'mr-status');
  assert.deepEqual([run.outcome, run.reason, run.source], ['failed', 'no result', 'supervisor']);
  assert.deepEqual(run.did, ['нет данных'], 'the example board speaks Russian');
  assert.equal(run.problems[0].key, 'no-result');
  assert.equal(run.usage.exit_code, 0);
  const text = r.routineText();
  assert.match(text, /^last_result: failed$/m);
  assert.match(text, /^last_run: 2026-11-10T10:00:00Z$/m);
  assert.match(text, /RUN failed: did: нет данных \| problem: unknown: no-result: no result \(exit 0\) \[run=r-[0-9a-f]{12} dur=0s host=\S+ src=supervisor\]/);
  assert.doesNotMatch(r.roadctl(['tick', '--as', ME, '--routine', 'mr-status']).stdout, /^RUN /m, 'last_run moved: the loop of a model on every tick is gone');
  // the command that reports itself keeps its own outcome and writes no supervisor line
  r.routine('mr-self');
  const done = `'${process.execPath}' '${SELF}' routine done mr-self --as ${ME} --result ok --board '${r.board}' "checked it"`;
  const own = r.roadctl(r.sup('mr-self', ['sh', '-c', done]));
  assert.equal(own.status, EXIT.ok, own.stderr);
  const mine = r.runs().find((x) => x.id === 'mr-self');
  assert.equal(mine.outcome, 'ok');
  assert.doesNotMatch(r.routineText('mr-self'), /src=supervisor/);
}));

test('P5.2 a14: ROADCTL_RUN_ID reaches the command (the fake claude sees it); native Windows is refused with an explanation', NEEDS, withRig(async (r) => {
  r.routine();
  r.roadctl(r.sup('mr-status', ['claude', '-p', 'hello']), { FAKE_MODE: 'ok' });
  const call = r.calls('claude').at(-1);
  assert.match(call.env.ROADCTL_RUN_ID, /^r-[0-9a-f]{12}$/);
  assert.equal(r.runs().find((x) => x.id === 'mr-status').run_id, call.env.ROADCTL_RUN_ID, 'the run of the ledger is the run the command was given');
  await assert.rejects(() => superviseRun({ flags: { routine: 'x', as: ME }, rest: ['true'], env: r.env, api: {}, out() {} }, { platform: 'win32' }), /not supported on native Windows.*WSL/);
}));

// ---------------------------------------------------------------- a4, a8, a16: a killed supervisor

test('P5.2 a4/a8: after kill -9 of the supervisor a living command means busy; a dead one means the lock is taken at once and the old run is crashed', NEEDS, withRig(async (r) => {
  r.routine();
  const pid = path.join(r.dir, 'o.pid');
  const first = r.start(r.sup('mr-status', r.sleeper(pid)));
  assert.ok(await wait(() => r.sidecars().length === 1 && fs.existsSync(pid)));
  const side = sidecarOf(r);
  const lock = path.join(r.state, fs.readdirSync(r.state).find((n) => n.endsWith('.lock')));
  const m0 = fs.statSync(lock).mtimeMs;
  assert.ok(await wait(() => fs.statSync(lock).mtimeMs > m0), 'a8: the pulse of the lock moves');
  first.child.kill('SIGKILL');
  await first.done;
  assert.equal(alive(side.pgid), true, 'the command outlived its supervisor');
  const busy = r.roadctl(r.sup('mr-status', ['true']));
  assert.equal(busy.status, EXIT.busy);
  assert.match(busy.stderr, /died but its command still runs \(process group \d+/);
  assert.doesNotMatch(r.roadctl(['tick', '--as', ME, '--routine', 'mr-status']).stdout, /^RUN /m, 'a5: tick offers nothing while the orphan command lives');
  assert.equal(r.runs().find((x) => x.id === 'mr-status' && x.outcome === 'started').source, 'supervisor');
  process.kill(-side.pgid, 'SIGKILL');
  assert.equal(await wait(() => !alive(side.pgid)), true);
  const t0 = wallClock();
  const taken = r.roadctl(r.sup('mr-status', ['true']));
  assert.ok(wallClock() - t0 < 5000, 'the dead holder is not waited for (the lock was fresh)');
  assert.equal(taken.status, EXIT.notStarted, taken.stderr);
  const old = r.runs().find((x) => x.run_id === side.run_id);
  assert.equal(old.outcome, 'crashed');
  assert.match(old.reason, /supervisor died/);
  assert.match(r.routineText(), /RUN failed: .*problem: unknown: crashed: .*src=supervisor\]/, 'the orphan\'s result is in the routine file: the next tick does not repeat the run');
  assert.deepEqual(r.sidecars(), []);
}));

test('P5.2 a16: orphans whose result cannot be written back off 10, 20, 40 minutes, then a local stop with a problem; --reset clears it', NEEDS, withRig(async (r) => {
  if (process.getuid?.() === 0) return; // a read-only file does not stop root
  r.routine();
  const file = path.join(r.board, 'routines', 'mr-status.md');
  fs.chmodSync(file, 0o444); // the supervisor cannot write the result: only the local back-off protects the next tick
  const at = (min) => ({ ROADCTL_NOW: shift(min) });
  const orphan = async (min) => {
    const pid = path.join(r.dir, `o${min}.pid`);
    const s = r.start(r.sup('mr-status', r.sleeper(pid)), at(min));
    assert.ok(await wait(() => r.sidecars().length === 1 && fs.existsSync(pid)), `a run starts at +${min} minutes`);
    const side = sidecarOf(r);
    s.child.kill('SIGKILL');
    await s.done;
    process.kill(-side.pgid, 'SIGKILL');
    assert.equal(await wait(() => !alive(side.pgid)), true);
    return r.roadctl(r.sup('mr-status', ['true']), at(min)); // finds the orphan
  };
  let res = await orphan(0);
  assert.equal(res.status, EXIT.notStarted);
  assert.match(res.stderr, /backing off until 2026-11-10T10:10:00Z/);
  assert.doesNotMatch(r.roadctl(['tick', '--as', ME, '--routine', 'mr-status'], at(5)).stdout, /^RUN /m, 'no RUN on the ticks of the back-off');
  assert.equal(r.roadctl(r.sup('mr-status', ['true']), at(5)).status, EXIT.notStarted, 'and no start');
  res = await orphan(11);
  assert.match(res.stderr, /backing off until 2026-11-10T10:31:00Z/, 'the second wait is 20 minutes');
  res = await orphan(32);
  assert.match(res.stderr, /stopped on this machine after 3 runs/);
  const crashed = r.runs().filter((x) => x.outcome === 'crashed');
  assert.equal(crashed.length, 3);
  assert.ok(crashed.at(-1).problems.some((p) => p.key === 'supervise-stop'), 'the third one is a problem to tell at once');
  assert.equal(r.roadctl(r.sup('mr-status', ['true']), at(500)).status, EXIT.notStarted, 'the stop does not end with time');
  assert.equal(r.roadctl(['supervise', '--routine', 'mr-status', '--as', ME, '--board', r.board, '--reset']).status, 0);
  fs.chmodSync(file, 0o644);
  assert.equal(r.roadctl(r.sup('mr-status', ['true']), at(500)).status, EXIT.failed, 'after --reset the routine runs again');
}));

// ---------------------------------------------------------------- a5: tick and the live run

test('P5.2 a5: tick offers no RUN while the run is live and offers it again when it is due after the run', NEEDS, withRig(async (r) => {
  r.routine();
  const tick = (over = {}) => r.roadctl(['tick', '--as', ME, '--routine', 'mr-status', '--json'], over);
  const runItems = (res) => JSON.parse(res.stdout).items.filter((i) => i.kind === 'RUN');
  assert.equal(runItems(tick()).length, 1, 'due: offered');
  const pid = path.join(r.dir, 's.pid');
  const live = r.start(r.sup('mr-status', r.sleeper(pid)));
  assert.ok(await wait(() => r.sidecars().length === 1 && fs.existsSync(pid)));
  assert.equal(runItems(tick()).length, 0, 'a supervised run is live: not offered');
  assert.match(r.roadctl(['routine', 'list', '--board', r.board]).stdout, /would not run: a supervised run is live/);
  process.kill(-sidecarOf(r).pgid, 'SIGTERM');
  const done = await live.done;
  assert.equal(done.code, EXIT.failed, done.err);
  assert.equal(runItems(tick()).length, 0, 'the run ended and recorded its result: not due yet');
  assert.equal(runItems(tick({ ROADCTL_NOW: shift(125) })).length, 1, 'two hours later it is due again');
}));

// ---------------------------------------------------------------- a6: detach

test('P5.2 a6: --detach prints run_id and returns; the run goes on without its parent and reaches an outcome', NEEDS, withRig(async (r) => {
  r.routine();
  const mark = path.join(r.dir, 'detached.txt');
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', `sleep 1; echo done > '${mark}'`], ['--detach']));
  assert.equal(res.status, 0, res.stderr);
  const id = /^run_id=(r-[0-9a-f]{12})$/m.exec(res.stdout)?.[1];
  assert.ok(id, res.stdout);
  assert.equal(fs.existsSync(mark), false, 'the parent came back before the command finished');
  assert.equal(r.roadctl(r.sup('mr-status', ['true'])).status, EXIT.busy, 'the detached run holds the lock');
  assert.ok(await wait(() => r.runs().find((x) => x.run_id === id)?.outcome === 'failed', 10000), 'it finished by itself (failed: no result)');
  assert.equal(fs.readFileSync(mark, 'utf8'), 'done\n');
  // a refusal is the parent's exit code, not a silent success
  const refused = r.roadctl(['supervise', '--routine', 'no-such', '--as', ME, '--board', r.board, '--detach', '--', 'true']);
  assert.equal(refused.status, EXIT.usage);
  assert.match(refused.stderr, /no routine no-such/);
}));

test('P5.2 a6: a detached supervisor lives in a session of its own (a hangup of the parent\'s terminal does not reach it)', NEEDS, withRig(async (r) => {
  r.routine();
  const pid = path.join(r.dir, 'h.pid');
  const p = r.start(r.sup('mr-status', r.sleeper(pid), ['--detach']));
  const res = await p.done;
  assert.equal(res.code, 0);
  assert.ok(await wait(() => fs.existsSync(pid) && r.sidecars().length === 1));
  const side = sidecarOf(r);
  assert.notEqual(side.pid, p.child.pid);
  const sid = (n) => spawnSync('ps', ['-o', 'sid=', '-p', String(n)], { encoding: 'utf8' }).stdout.trim();
  assert.notEqual(sid(side.pid), sid(process.pid), 'a session of its own');
  assert.equal(alive(side.pid), true, 'and alive after the parent is gone');
  process.kill(-side.pgid, 'SIGKILL');
  assert.ok(await wait(() => r.runs().find((x) => x.run_id === side.run_id)?.outcome === 'failed'));
}));

// ---------------------------------------------------------------- a7: the log

test('P5.2 a7/a12/a18: huge output does not grow the log past its limit; the ledger gets a tail of at most 600 characters; the log is private with a header and a footer; the claude adapter', NEEDS, withRig(async (r) => {
  r.routine();
  const res = r.roadctl(r.sup('mr-status', ['claude', '-p', 'x']), { FAKE_MODE: 'huge', FAKE_HUGE_BYTES: String(3 * 1024 * 1024) });
  assert.equal(res.status, EXIT.failed, res.stderr);
  const logs = fs.readdirSync(path.join(r.state, 'run-logs'));
  assert.equal(logs.length, 1);
  const file = path.join(r.state, 'run-logs', logs[0]);
  assert.ok(fs.statSync(file).size <= 1024 * 1024, `${fs.statSync(file).size} bytes`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(r.state, 'run-logs')).mode & 0o777, 0o700);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^START 2026-11-10T10:00:00Z run=r-[0-9a-f]{12} key=routine:my-app\/mr-status timeout=7200s cmd=claude -p x\n/);
  assert.match(text, /\nEND 2026-11-10T10:00:00Z exit 0 duration=\d+s\n$/);
  const run = r.runs().find((x) => x.id === 'mr-status');
  assert.ok(run.usage.tail.length <= 600 && run.usage.tail.length > 100, `tail ${run.usage.tail.length}`);
  // the adapter: `--output-format json` fills the claude fields from the last JSON line; no data is `unknown`, and a run without a result still gets a summary of the supervisor
  const json = JSON.stringify({ type: 'result', subtype: 'max_turns', session_id: 's-1', num_turns: 30, is_error: true, total_cost_usd: 0.5 });
  r.routine('mr-json');
  r.roadctl(r.sup('mr-json', ['claude', '-p', 'x', '--output-format', 'json']), { FAKE_STDOUT: `${json}\n` });
  const adapted = r.runs().find((x) => x.id === 'mr-json');
  assert.deepEqual(adapted.usage.claude, { exit_code: 0, session_id: 's-1', turns: 30, is_error: true, subtype: 'max_turns', cost_usd: 0.5 });
  assert.deepEqual([adapted.outcome, adapted.source], ['failed', 'supervisor']);
  r.routine('mr-nodata');
  r.roadctl(r.sup('mr-nodata', ['claude', '-p', 'x', '--output-format=json']), { FAKE_STDOUT: 'plain text\n' });
  assert.equal(r.runs().find((x) => x.id === 'mr-nodata').usage.claude.session_id, 'unknown');
  // a log older than 30 days goes at the next run
  const old = path.join(r.state, 'run-logs', 'r-old000000000.log');
  fs.writeFileSync(old, 'x');
  const past = new Date(wallClock() - LOG_KEEP_MS - 5000);
  fs.utimesSync(old, past, past);
  r.roadctl(r.sup('mr-nodata', ['true']), clock('2027-01-10T00:00:00Z')); // the clock of roadctl is ahead of the file's modification time by more than 30 days
  assert.equal(fs.existsSync(old), false);
}));

// ---------------------------------------------------------------- a9, a10: signals and pause

test('P5.2 a9: TERM to the supervisor passes TERM to the group, the outcome is aborted and the lock is released', NEEDS, withRig(async (r) => {
  r.routine();
  const got = path.join(r.dir, 'got-term');
  const pid = path.join(r.dir, 't.pid');
  const s = r.start(r.sup('mr-status', ['sh', '-c', `trap 'echo term > ${got}; exit 0' TERM; sleep 60 & echo $! > '${pid}'; wait`]));
  assert.ok(await wait(() => r.sidecars().length === 1 && fs.existsSync(pid)));
  await new Promise((x) => setTimeout(x, 200)); // the trap is installed once the pid file exists
  s.child.kill('SIGTERM');
  const res = await s.done;
  assert.equal(res.code, EXIT.aborted, res.err);
  assert.equal(fs.readFileSync(got, 'utf8'), 'term\n', 'the command got TERM');
  assert.equal(r.runs().find((x) => x.id === 'mr-status').outcome, 'aborted');
  assert.deepEqual(fs.readdirSync(r.state).filter((n) => n.startsWith('supervise-')), []);
  assert.equal(await wait(() => !alive(Number(fs.readFileSync(pid, 'utf8')))), true);
}));

test('P5.2 a10: a paused machine starts nothing (6); pause --now stops a run that is going; a plain pause does not', NEEDS, withRig(async (r) => {
  r.routine();
  r.ok(['pause', '--reason', 'testing']);
  const blocked = r.roadctl(r.sup('mr-status', ['sh', '-c', 'echo ran > ran']));
  assert.equal(blocked.status, EXIT.paused);
  assert.match(blocked.stderr, /paused: PAUSED/);
  assert.equal(fs.existsSync(path.join(r.ws, 'ran')), false);
  r.ok(['resume']);
  const pid = path.join(r.dir, 'p.pid');
  const s = r.start(r.sup('mr-status', r.sleeper(pid)));
  assert.ok(await wait(() => r.sidecars().length === 1 && fs.existsSync(pid)));
  r.ok(['pause', '--reason', 'plain']);
  await new Promise((x) => setTimeout(x, 400));
  assert.equal(alive(Number(fs.readFileSync(pid, 'utf8'))), true, 'a plain pause leaves the run alone');
  const now = r.roadctl(['pause', '--now', '--reason', 'stop all']);
  assert.match(now.stdout, /Runs held by roadctl supervise on this machine are stopped/);
  const res = await s.done;
  assert.equal(res.code, EXIT.aborted, res.err);
  const run = r.runs().find((x) => x.id === 'mr-status');
  assert.equal(run.outcome, 'aborted');
  assert.match(run.reason, /pause --now/);
}));

// ---------------------------------------------------------------- a15: the decision may change between tick and supervise

test('P5.2 a15: a routine switched off (or a board that requires a newer roadctl) between tick and supervise does not start', NEEDS, withRig(async (r) => {
  r.routine();
  const item = r.roadctl(['tick', '--as', ME, '--routine', 'mr-status', '--json']);
  assert.equal(JSON.parse(item.stdout).items.filter((i) => i.kind === 'RUN').length, 1);
  r.ok(['routine', 'off', 'mr-status', '--by', 'Owner', '--board', r.board]);
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', 'echo ran > ran']));
  assert.equal(res.status, EXIT.notStarted);
  assert.match(res.stderr, /would not run now: disabled/);
  assert.equal(fs.existsSync(path.join(r.ws, 'ran')), false);
  r.ok(['routine', 'on', 'mr-status', '--by', 'Owner', '--source', 'chat', '--board', r.board]);
  const cfg = path.join(r.board, 'config.json');
  const json = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  fs.writeFileSync(cfg, JSON.stringify({ ...json, requires: '9.0.0' }));
  const needs = r.roadctl(r.sup('mr-status', ['true']));
  assert.equal(needs.status, EXIT.notStarted);
  assert.match(needs.stderr, /requires roadctl 9\.0\.0/);
  fs.writeFileSync(cfg, JSON.stringify(json));
  assert.equal(r.roadctl(r.sup('mr-status', ['true'])).status, EXIT.failed, 'allowed and due again: it runs');
}));

// ---------------------------------------------------------------- a11: the scheduler example

test('P5.2 a11: the scheduler example runs the model under supervise: no routine done is recorded as failed and the next tick is idle; a reporting model is ok', NEEDS, withRig(async (r) => {
  r.routine();
  const job = (over = {}) => spawnSync('bash', [EXAMPLE], { cwd: r.ws, encoding: 'utf8', input: '', env: { ...r.env, AGENT: ME, ROUTINE: 'mr-status', PROJECT: 'my-app', WORKDIR: r.dir, ROADCTL: path.join(r.bin, 'roadctl'), ...over } });
  const work = () => r.calls('claude').filter((c) => !c.event && !isProbe(c));
  const a = job();
  assert.equal(a.status, EXIT.failed, a.stderr + a.stdout);
  assert.equal(work().length, 1, 'the model started once');
  assert.deepEqual(work()[0].argv.slice(0, 5), ['-p', '--model', 'haiku', '--max-turns', '30']);
  assert.match(work()[0].argv.at(-1), /^You are claude-code@home-wsl, the scheduled orchestrator/);
  assert.match(a.stderr, /failed: no result/);
  assert.match(r.routineText(), /^last_result: failed$/m);
  assert.match(r.routineText(), /src=supervisor\]/);
  const b = job();
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /tick: idle, nothing to do/, 'the next tick says something else: nothing is due, the model is not started again');
  assert.equal(work().length, 1);
  const finish = `'${r.bin}/roadctl' routine done mr-status --as ${ME} --result ok checked --board '${r.board}'`;
  const c = job({ ROADCTL_NOW: shift(180), FAKE_AFTER: finish });
  assert.equal(c.status, 0, c.stderr + c.stdout);
  assert.equal(work().length, 2);
  assert.match(r.routineText(), /^last_result: ok$/m);
  assert.equal(r.runs().filter((x) => x.id === 'mr-status' && x.outcome === 'ok').length, 1);
}));

// ---------------------------------------------------------------- review fixes: hooks, the takeover race, signals, adoption, state, faults, tick, cards, requires, the example

const FIXTURE = `import fs from 'node:fs';
export default { name: 'fixture-refuse', hooks: { 'routine-done-before'(ctx) {
  if (ctx.env.FIXTURE_LOG) fs.appendFileSync(ctx.env.FIXTURE_LOG, JSON.stringify({ id: ctx.id, source: ctx.source ?? null, run: ctx.env.ROADCTL_RUN_ID ?? null, flags: ctx.flags }) + '\\n');
  if (ctx.env.FIXTURE_SLOW) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ctx.env.FIXTURE_SLOW));
  return ctx.env.FIXTURE_REFUSE ? { refuse: ctx.env.FIXTURE_REFUSE } : {};
} } };
`;
/** A throwaway copy of roadctl with a module that observes, delays or refuses `routine done` (what P5.15 does with the approval hash). */
function installFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sup-bin-'));
  fs.copyFileSync(SELF, path.join(dir, 'roadctl.mjs'));
  fs.cpSync(here, path.join(dir, 'roadctl'), { recursive: true, filter: (x) => !x.endsWith('.test.mjs') });
  fs.writeFileSync(path.join(dir, 'roadctl', 'fixture-refuse.mjs'), FIXTURE);
  const f = path.join(dir, 'roadctl', 'index.mjs');
  const index = fs.readFileSync(f, 'utf8').replace("import probe from './probe.mjs';", "import probe from './probe.mjs';\nimport fixtureRefuse from './fixture-refuse.mjs';");
  fs.writeFileSync(f, index.replace(/(export const MODULES = \[[^\]]*)\]/, '$1, fixtureRefuse]'));
  return { dir, bin: path.join(dir, 'roadctl.mjs') };
}

test('P5.2 review 1: a result the supervisor writes passes the hooks of `routine done` (with the run and its source); a refusing hook means nothing is written and the record says so', NEEDS, withRig(async (r) => {
  const fx = installFixture();
  try {
    const q = rig({ self: fx.bin });
    try {
      q.routine();
      const hooklog = path.join(q.dir, 'hook.jsonl');
      const ok = q.roadctl(q.sup('mr-status', ['sh', '-c', 'exit 0']), { FIXTURE_LOG: hooklog });
      assert.equal(ok.status, EXIT.failed, ok.stderr);
      const seen = fs.readFileSync(hooklog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(seen.length, 1, 'the hook was called once');
      assert.equal(seen[0].source, 'supervisor');
      assert.match(seen[0].run, /^r-[0-9a-f]{12}$/);
      assert.deepEqual(seen[0].flags.did, ['нет данных']);
      assert.match(q.routineText(), /src=supervisor\]/);
      assert.equal(q.runs().filter((x) => x.id === 'mr-status').length, 1, 'one run in the ledger: the hook of the ledger did not add a second end');
      // a refusing hook: no write to the routine file; the ledger run says why; the key backs off
      q.routine('mr-no');
      const before = q.routineText('mr-no');
      const refused = q.roadctl(q.sup('mr-no', ['sh', '-c', 'exit 0']), { FIXTURE_REFUSE: 'approval hash differs' });
      assert.equal(refused.status, EXIT.failed);
      assert.match(refused.stderr, /routine file: refused/);
      assert.equal(q.routineText('mr-no'), before, 'nothing was written to the routine file');
      const run = q.runs().find((x) => x.id === 'mr-no');
      assert.equal(run.outcome, 'failed');
      assert.match(run.reason, /routine file was not written \(refused: approval hash differs\)/);
      assert.match(q.roadctl(q.sup('mr-no', ['true'])).stderr, /backing off until/);
    } finally { q.cleanup(); }
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
}));

test('P5.2 review 2: taking the lock of a dead supervisor is decided under the takeover guard: a lock that changed hands is never removed', NEEDS, withRig(async (r) => {
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.mkdirSync(r.state, { recursive: true });
  const file = path.join(r.state, 'supervise-test.lock');
  const old = JSON.stringify({ pid: Number(dead), token: 'old', key: 'k' });
  fs.writeFileSync(file, old);
  assert.equal(inspectLock(file).state, 'orphan-dead');
  const seen = inspectLock(file).raw;
  // the first taker wins; the second one still holds the OLD observation and must not touch the new lock
  const mine = JSON.stringify({ pid: process.pid, token: 'first', key: 'k' });
  const first = takeDeadLock(file, seen, mine);
  assert.ok(first, 'the first taker has it');
  const before = fs.statSync(file).mtimeMs;
  const second = takeDeadLock(file, seen, JSON.stringify({ pid: process.pid, token: 'second', key: 'k' }));
  assert.equal(second, null, 'the second taker, with the stale observation, gets nothing');
  assert.equal(fs.readFileSync(file, 'utf8'), mine, 'and the lock of the first one is untouched');
  assert.equal(fs.statSync(file).mtimeMs, before, 'its pulse is not moved by the second taker either');
  assert.equal(fs.existsSync(`${file}.takeover`), false, 'the guard is released');
  first.release();
  // a guard held by someone else means: look again, do not take
  fs.writeFileSync(file, old);
  fs.writeFileSync(`${file}.takeover`, String(process.pid)); // a live owner
  assert.equal(takeDeadLock(file, old, mine), null);
  assert.equal(fs.readFileSync(file, 'utf8'), old);
  fs.rmSync(`${file}.takeover`);
  // and through the CLI: four supervisors at once over one dead lock start the command exactly once
  r.routine();
  const lock = path.join(r.state, 'supervise-routine.my-app.mr-status.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(dead), token: 't', key: 'routine:my-app/mr-status' }));
  const runs = [1, 2, 3, 4].map((n) => r.start(r.sup('mr-status', ['sh', '-c', `echo ${n} >> '${path.join(r.dir, 'started.txt')}'; sleep 1`])));
  const codes = (await Promise.all(runs.map((x) => x.done))).map((x) => x.code).sort();
  assert.equal(fs.readFileSync(path.join(r.dir, 'started.txt'), 'utf8').trim().split('\n').length, 1, `exactly one command ran (exit codes ${codes})`);
}));

test('P5.2 review 3: the delayed KILL is cancelled when the group is gone and never sent to a group that is confirmed finished', NEEDS, withRig(async (r) => {
  const fx = installFixture();
  try {
    const q = rig({ self: fx.bin });
    try {
      q.routine();
      const siglog = path.join(q.dir, 'signals.txt');
      // the command ends at TERM; the result is then written slowly (longer than the grace): a pending KILL timer would fire during that
      const res = q.roadctl(q.sup('mr-status', ['sh', '-c', "trap 'exit 0' TERM; sleep 30 & wait"], ['--timeout', '1s']), { ROADCTL_SUPERVISE_SIGLOG: siglog, FIXTURE_SLOW: '900' });
      assert.equal(res.status, EXIT.timeout, res.stderr);
      const sent = fs.readFileSync(siglog, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
      assert.deepEqual(sent, ['SIGTERM'], `only TERM went to the group: ${sent}`);
    } finally { q.cleanup(); }
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
}));

test('P5.2 review 4: an open run begun by `run begin` (or a claim) is not taken over: busy, the command does not start', NEEDS, withRig(async (r) => {
  r.routine();
  r.ok(['run', 'begin', 'mr-status', '--as', ME, '--board', r.board]);
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', 'echo ran > ran']));
  assert.equal(res.status, EXIT.busy, res.stderr);
  assert.match(res.stderr, /already has an open run \(r-[0-9a-f]{12}, begun by agent\)/);
  assert.equal(fs.existsSync(path.join(r.ws, 'ran')), false);
  assert.equal(r.runs().filter((x) => x.id === 'mr-status' && x.outcome === 'started').length, 1, 'the agent\'s run is still the only open one');
}));

test('P5.2 review 5/D: an unreadable state file is never rewritten by a running command\'s end (fail closed until --reset); a stop that cannot be saved keeps the lock with a marker that nobody takes until --reset', NEEDS, withRig(async (r) => {
  r.routine();
  fs.mkdirSync(r.state, { recursive: true });
  const stateFile = path.join(r.state, 'supervise.state.json');
  fs.writeFileSync(stateFile, '{not json');
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', 'echo ran > ran']));
  assert.equal(res.status, EXIT.notStarted);
  assert.match(res.stderr, /supervise\.state\.json cannot be read, so nothing starts/);
  assert.equal(fs.existsSync(path.join(r.ws, 'ran')), false);
  assert.match(r.roadctl(['routine', 'list', '--board', r.board]).stdout, /supervise\.state\.json cannot be read/);
  assert.equal(r.roadctl(['supervise', '--routine', 'mr-status', '--as', ME, '--board', r.board, '--reset']).status, 0, '--reset rewrites it');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{}\n');
  // D(a): the state becomes unreadable DURING a run that then ends on its own: its end must not replace the file (it may hold stops of other keys)
  r.routine('mr-two');
  const done = r.roadctl(r.sup('mr-two', ['sh', '-c', `echo '{broken' > '${stateFile}'`]));
  assert.equal(done.status, EXIT.failed, done.stderr);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{broken\n', 'the unreadable file was left alone');
  assert.equal(r.roadctl(['supervise', '--routine', 'mr-two', '--as', ME, '--board', r.board, '--reset']).status, 0);
  if (process.getuid?.() === 0) return;
  // D(b): the result cannot be written (read-only file) and, during the run, the state file becomes a directory: the back-off cannot be saved
  r.routine('mr-lost');
  fs.rmSync(stateFile, { force: true });
  fs.chmodSync(path.join(r.board, 'routines', 'mr-lost.md'), 0o444);
  const lost = r.roadctl(r.sup('mr-lost', ['sh', '-c', `mkdir '${stateFile}'`]));
  assert.equal(lost.status, EXIT.failed, lost.stderr);
  assert.match(lost.stderr, /WARNING: .*back-off could not be saved/);
  const lockFile = path.join(r.state, 'supervise-routine.my-app.mr-lost.lock');
  assert.match(JSON.parse(fs.readFileSync(lockFile, 'utf8')).stop_unsaved, /back-off could not be saved/, 'the lock stays, with the marker');
  assert.equal(inspectLock(lockFile).state, 'stop-unsaved');
  fs.chmodSync(path.join(r.board, 'routines', 'mr-lost.md'), 0o644);
  fs.rmSync(stateFile, { recursive: true });
  const again = r.roadctl(r.sup('mr-lost', ['sh', '-c', 'echo ran > ran-lost']));
  assert.equal(again.status, EXIT.notStarted, 'even when the state file is fine again, the marked lock is not taken');
  assert.match(again.stderr, /the stop of routine:my-app\/mr-lost could not be saved/);
  assert.equal(fs.existsSync(path.join(r.ws, 'ran-lost')), false);
  assert.match(r.roadctl(['routine', 'list', '--board', r.board]).stdout, /a stop could not be saved/);
  assert.equal(r.roadctl(['supervise', '--routine', 'mr-lost', '--as', ME, '--board', r.board, '--reset']).status, 0);
  assert.equal(fs.existsSync(lockFile), false, '--reset removes the marked lock');
  assert.equal(r.roadctl(r.sup('mr-lost', ['true'])).status, EXIT.failed, 'and the routine can run again');
}));

test('P5.2 review 6: an error after the spawn kills the command\'s group (a group never stays without a supervisor)', NEEDS, withRig(async (r) => {
  r.routine();
  const pid = path.join(r.dir, 'f.pid');
  const res = r.roadctl(r.sup('mr-status', r.sleeper(pid)), { ROADCTL_SUPERVISE_FAULT: 'after-spawn' });
  assert.equal(res.status, EXIT.failed, res.stderr);
  assert.match(res.stderr, /supervisor error: injected fault after the spawn/);
  assert.deepEqual(r.sidecars(), []);
  if (fs.existsSync(pid)) assert.equal(await wait(() => !alive(Number(fs.readFileSync(pid, 'utf8')))), true, 'the sleep is gone');
  assert.equal(r.runs().find((x) => x.id === 'mr-status').outcome, 'failed');
}));

test('P5.2 review 7/A: tick only reads: after a dead supervisor it marks the RUN item (recover), changes no file, no ledger record and no lock; supervise then recovers', NEEDS, withRig(async (r) => {
  r.routine();
  const pid = path.join(r.dir, 'k.pid');
  const s = r.start(r.sup('mr-status', r.sleeper(pid)));
  assert.ok(await wait(() => r.sidecars().length === 1 && fs.existsSync(pid)));
  const side = sidecarOf(r);
  s.child.kill('SIGKILL');
  await s.done;
  process.kill(-side.pgid, 'SIGKILL');
  assert.equal(await wait(() => !alive(side.pgid)), true);
  const snapshot = () => ({ routine: r.routineText(), runs: fs.readFileSync(path.join(r.state, 'runs.jsonl'), 'utf8'), locks: fs.readdirSync(r.state).filter((n) => n.startsWith('supervise-')).sort() });
  const before = snapshot();
  const text = r.roadctl(['tick', '--as', ME, '--routine', 'mr-status']);
  assert.match(text.stdout, new RegExp(`^RUN my-app/mr-status Routine mr-status \\(recover: supervised run ${side.run_id} died\\)$`, 'm'), 'the text of tick changed');
  const json = r.roadctl(['tick', '--as', ME, '--routine', 'mr-status', '--json']);
  const j = JSON.parse(json.stdout);
  assert.equal(j.items[0].routine.recover, `supervised run ${side.run_id} died`);
  assert.deepEqual(tickJsonProblems(j), [], 'the contract of tick --json knows the field');
  const after = snapshot();
  assert.equal(after.routine, before.routine, 'no board file written');
  assert.equal(after.locks.join(), before.locks.join(), 'the dead lock is still there');
  assert.equal(after.runs.replace(/"event":"skip[^\n]*\n/g, ''), before.runs.replace(/"event":"skip[^\n]*\n/g, ''), 'no run record changed (tick may only add its own skipped records)');
  assert.equal(r.runs().find((x) => x.run_id === side.run_id).outcome, 'started');
  // the board no longer declares the version: supervise recovers nothing and writes nothing
  const cfg = path.join(r.board, 'config.json');
  const json0 = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  fs.writeFileSync(cfg, JSON.stringify({ ...json0, requires: undefined }));
  const refused = r.roadctl(r.sup('mr-status', ['true']));
  assert.equal(refused.status, EXIT.notStarted);
  assert.equal(snapshot().routine, before.routine);
  assert.equal(r.runs().find((x) => x.run_id === side.run_id).outcome, 'started');
  fs.writeFileSync(cfg, JSON.stringify(json0));
  // supervise does the recovery: the old run is crashed, the result is in the routine file, the next tick offers nothing
  assert.equal(r.roadctl(r.sup('mr-status', ['true'])).status, EXIT.notStarted);
  assert.equal(r.runs().find((x) => x.run_id === side.run_id).outcome, 'crashed');
  assert.match(r.routineText(), /RUN failed: .*crashed.*src=supervisor\]/);
  assert.equal(JSON.parse(r.roadctl(['tick', '--as', ME, '--routine', 'mr-status', '--json']).stdout).items.filter((i) => i.kind === 'RUN').length, 0);
}));

test('P5.2 B: a lock file that exists but has no readable content is busy, never taken for a dead owner (until it is stale by age)', NEEDS, withRig(async (r) => {
  r.routine();
  fs.mkdirSync(r.state, { recursive: true });
  const lock = path.join(r.state, 'supervise-routine.my-app.mr-status.lock');
  fs.writeFileSync(lock, '');
  assert.equal(inspectLock(lock).state, 'live');
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', 'echo ran > ran']));
  assert.equal(res.status, EXIT.busy, res.stderr);
  assert.match(res.stderr, /a process whose lock cannot be read yet/);
  assert.equal(fs.existsSync(path.join(r.ws, 'ran')), false);
  assert.equal(fs.readFileSync(lock, 'utf8'), '', 'the lock was not touched');
  assert.equal(takeDeadLock(lock, '', '{"pid":1}'), null, 'and takeDeadLock does not take it either');
  const old = new Date(wallClock() - 20 * 60e3);
  fs.utimesSync(lock, old, old);
  assert.equal(r.roadctl(r.sup('mr-status', ['sh', '-c', 'exit 0'])).status, EXIT.failed, 'an empty lock older than the stale time is nobody\'s: the run goes');
}));

test('P5.2 C: ROADCTL_RUN_SOURCE in the environment changes nothing: routine done writes the ordinary trailer and closes its run', NEEDS, withRig(async (r) => {
  r.routine();
  r.ok(['run', 'begin', 'mr-status', '--as', ME, '--board', r.board]);
  const done = r.roadctl(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'checked', '--board', r.board], { ROADCTL_RUN_SOURCE: 'supervisor' });
  assert.equal(done.status, 0, done.stderr);
  assert.doesNotMatch(r.routineText(), /src=supervisor/);
  assert.match(r.routineText(), /\[run=r-[0-9a-f]{12} dur=\d+s host=\S+\]/);
  assert.equal(r.runs().find((x) => x.id === 'mr-status').outcome, 'ok', 'the run is closed by the ordinary hook');
}));

test('P5.2 E: an unreadable supervise.state.json blocks only the routines of boards that require 0.6.0; other boards are not touched', NEEDS, withRig(async (r) => {
  r.routine();
  fs.mkdirSync(r.state, { recursive: true });
  fs.writeFileSync(path.join(r.state, 'supervise.state.json'), '{bad');
  const cfg = path.join(r.board, 'config.json');
  const json = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.match(r.roadctl(['routine', 'list', '--board', r.board]).stdout, /would not run: supervise\.state\.json cannot be read/);
  fs.writeFileSync(cfg, JSON.stringify({ ...json, requires: undefined }));
  const list = r.roadctl(['routine', 'list', '--board', r.board]).stdout;
  assert.doesNotMatch(list, /supervise\.state/, 'a board that cannot be supervised does not see the supervisor\'s state');
  assert.match(list, /would run now/);
  assert.equal(JSON.parse(r.roadctl(['tick', '--as', ME, '--routine', 'mr-status', '--json']).stdout).items.filter((i) => i.kind === 'RUN').length, 1, 'tick still offers it');
}));

test('P5.2 review 8: a card whose run ended without a result (failed, timeout, or a dead supervisor) is not run again until --reset', NEEDS, withRig(async (r) => {
  const cardId = fs.readdirSync(path.join(r.board, 'cards')).map((n) => /^id: (\S+)/m.exec(fs.readFileSync(path.join(r.board, 'cards', n), 'utf8'))?.[1]).find(Boolean);
  const card = (cmd, extra = []) => ['supervise', '--card', cardId, '--as', ME, '--board', r.board, ...extra, '--', ...cmd];
  assert.equal(r.roadctl(card(['sh', '-c', 'echo ran >> ran.txt'])).status, EXIT.failed, 'no result');
  const second = r.roadctl(card(['sh', '-c', 'echo ran >> ran.txt']));
  assert.equal(second.status, EXIT.notStarted, second.stderr);
  assert.match(second.stderr, /stopped on this machine because the last run of the card ended failed without a result/);
  assert.equal(fs.readFileSync(path.join(r.ws, 'ran.txt'), 'utf8'), 'ran\n', 'the command did not run twice');
  assert.equal(r.roadctl(['supervise', '--card', cardId, '--as', ME, '--board', r.board, '--reset']).status, 0);
  assert.equal(r.roadctl(card(['sleep', '30'], ['--timeout', '1s'])).status, EXIT.timeout);
  assert.equal(r.roadctl(card(['true'])).status, EXIT.notStarted, 'a timeout blocks it too');
  // a run that reports itself is a known outcome: no stop
  r.roadctl(['supervise', '--card', cardId, '--as', ME, '--board', r.board, '--reset']);
  const orch = (cmd) => ['supervise', '--orchestrator', '--as', ME, '--board', r.board, '--', ...cmd];
  assert.equal(r.roadctl(orch(['true'])).status, EXIT.failed);
  assert.equal(r.roadctl(orch(['true'])).status, EXIT.failed, 'the orchestrator is not blocked by one lost result (only a routine or a card is)');
}));

test('P5.2 review 9: a routine of a board that does not declare requires >= 0.6.0 is refused before anything starts; a board without supervise is unchanged', NEEDS, withRig(async (r) => {
  r.routine();
  const cfg = path.join(r.board, 'config.json');
  const json = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  for (const requires of [undefined, '0.5.0', 'x.y']) {
    fs.writeFileSync(cfg, JSON.stringify({ ...json, requires }));
    const before = r.routineText();
    const res = r.roadctl(r.sup('mr-status', ['sh', '-c', 'echo ran > ran']));
    assert.equal(res.status, EXIT.notStarted, `${requires}: ${res.stderr}`);
    assert.match(res.stderr, /does not declare "requires": "0\.6\.0"/);
    assert.equal(fs.existsSync(path.join(r.ws, 'ran')), false);
    assert.equal(r.routineText(), before);
  }
  assert.deepEqual(r.runs().filter((x) => x.source === 'supervisor'), [], 'no run was begun');
  fs.writeFileSync(cfg, JSON.stringify({ ...json, requires: '0.6.0' }));
  assert.equal(r.roadctl(r.sup('mr-status', ['sh', '-c', 'exit 0'])).status, EXIT.failed, 'the declared version is enough');
  // the old commands do not need it: routine done without a supervisor works on a board without requires
  fs.writeFileSync(cfg, JSON.stringify({ ...json, requires: undefined }));
  r.routine('mr-plain');
  assert.equal(r.roadctl(['routine', 'done', 'mr-plain', '--as', ME, '--result', 'ok', 'checked', '--board', r.board]).status, 0);
  assert.doesNotMatch(r.routineText('mr-plain'), /src=supervisor/);
}));

test('P5.2 review 10: the example does not leave a prompt file behind and runs tick in WORKDIR', NEEDS, withRig(async (r) => {
  r.routine();
  const tmp = path.join(r.dir, 'tmp');
  fs.mkdirSync(tmp);
  const wd = path.join(r.dir, 'workdir');
  fs.mkdirSync(wd);
  const wrapper = path.join(r.dir, 'rc-wrapper');
  fs.writeFileSync(wrapper, `#!/bin/sh\npwd >> '${path.join(r.dir, 'cwds.txt')}'\nexec '${process.execPath}' '${SELF}' "$@"\n`, { mode: 0o755 });
  const res = spawnSync('bash', [EXAMPLE], { cwd: r.ws, encoding: 'utf8', input: '', env: { ...r.env, TMPDIR: tmp, AGENT: ME, ROUTINE: 'mr-status', PROJECT: 'my-app', WORKDIR: wd, ROADCTL: wrapper } });
  assert.equal(res.status, EXIT.failed, res.stderr + res.stdout);
  assert.deepEqual(fs.readdirSync(tmp), [], 'no temporary file is left');
  const cwds = fs.readFileSync(path.join(r.dir, 'cwds.txt'), 'utf8').trim().split('\n').map((p) => fs.realpathSync(p));
  assert.deepEqual(cwds, [fs.realpathSync(wd), fs.realpathSync(wd)], 'tick and supervise both ran in WORKDIR');
}));

// ---------------------------------------------------------------- round 3: --reset under the guard, requires before every write, ownership at the end, no non-atomic lock

test('P5.2 r3-1: --reset removes a marked lock only if it still is the very one it saw (under the guard); a lock that changed hands stays', NEEDS, withRig(async (r) => {
  fs.mkdirSync(r.state, { recursive: true });
  const file = path.join(r.state, 'supervise-reset.lock');
  const marked = JSON.stringify({ pid: Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout), token: 'old', key: 'k', stop_unsaved: 'x' });
  fs.writeFileSync(file, marked);
  assert.equal(inspectLock(file).state, 'stop-unsaved');
  const seen = inspectLock(file).raw;
  // between the look and the removal a new supervisor took the key
  const live = JSON.stringify({ pid: process.pid, token: 'new', key: 'k' });
  fs.writeFileSync(file, live);
  assert.equal(removeMarkedLock(file, seen), false);
  assert.equal(fs.readFileSync(file, 'utf8'), live, 'the new owner\'s lock is untouched');
  assert.equal(fs.existsSync(`${file}.takeover`), false, 'the guard is released');
  fs.writeFileSync(file, marked);
  assert.equal(removeMarkedLock(file, seen), true, 'the very marker that was seen is removed');
  assert.equal(fs.existsSync(file), false);
  // a guard held by someone else: nothing is removed
  fs.writeFileSync(file, marked);
  fs.writeFileSync(`${file}.takeover`, String(process.pid));
  assert.equal(removeMarkedLock(file, seen), false);
  assert.equal(fs.readFileSync(file, 'utf8'), marked);
}));

test('P5.2 r3-2: the board\'s requires is checked right before the write of a result: removed during the command, nothing is written, the record says why and the lock is kept marked', NEEDS, withRig(async (r) => {
  r.routine();
  const cfg = path.join(r.board, 'config.json');
  const json = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const before = r.routineText();
  const strip = `'${process.execPath}' -e "const f=process.argv[1];const j=JSON.parse(require('fs').readFileSync(f,'utf8'));delete j.requires;require('fs').writeFileSync(f,JSON.stringify(j))" '${cfg}'`;
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', strip]));
  assert.equal(res.status, EXIT.failed, res.stderr);
  assert.match(res.stderr, /WARNING: the board no longer declares requires 0\.6\.0/);
  assert.equal(r.routineText(), before, 'the routine file is unchanged');
  const run = r.runs().find((x) => x.id === 'mr-status');
  assert.equal(run.outcome, 'failed');
  assert.match(run.reason, /routine file was not written \(unsupported: the board does not declare "requires": "0\.6\.0"/);
  const lock = path.join(r.state, 'supervise-routine.my-app.mr-status.lock');
  assert.equal(inspectLock(lock).state, 'stop-unsaved', 'fail closed: the key stays stopped');
  fs.writeFileSync(cfg, JSON.stringify(json));
  assert.equal(r.roadctl(r.sup('mr-status', ['true'])).status, EXIT.notStarted);
  assert.equal(r.roadctl(['supervise', '--routine', 'mr-status', '--as', ME, '--board', r.board, '--reset']).status, 0);
  assert.equal(r.roadctl(r.sup('mr-status', ['sh', '-c', 'exit 0'])).status, EXIT.failed, 'after --reset it runs and records as usual');
}));

test('P5.2 r3-3: at the end of a run the lock and the sidecar are touched only while the lock is still ours', NEEDS, withRig(async (r) => {
  r.routine();
  const lock = path.join(r.state, 'supervise-routine.my-app.mr-status.lock');
  const foreign = JSON.stringify({ pid: 1, token: 'foreign', key: 'routine:my-app/mr-status' });
  const swap = `sleep 0.4; printf '%s' '${foreign}' > '${lock}'; printf foreign-sidecar > '${lock}.run'`;
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', swap]));
  assert.notEqual(res.status, EXIT.ok);
  assert.match(res.stderr, /WARNING: the lock of the key changed hands before the end of the run/);
  assert.equal(fs.readFileSync(lock, 'utf8'), foreign, 'the other lock is intact');
  assert.equal(fs.readFileSync(`${lock}.run`, 'utf8'), 'foreign-sidecar', 'and its sidecar');
  // the marker path too: a stop that cannot be published over a lock that is not ours
  const mine = JSON.stringify({ pid: process.pid, token: 'mine', key: 'k' });
  assert.equal(finishLock(lock, mine, 'cannot save'), 'lost');
  assert.equal(fs.readFileSync(lock, 'utf8'), foreign);
  fs.writeFileSync(lock, mine);
  assert.equal(finishLock(lock, mine, 'cannot save'), 'ok');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).stop_unsaved, 'cannot save', 'ours: marked');
  assert.equal(fs.existsSync(`${lock}.takeover`), false);
}));

test('P5.2 r4-2: a board that requires a NEWER roadctl than this copy is not written either (requires 9.0.0 during the command)', NEEDS, withRig(async (r) => {
  r.routine();
  const cfg = path.join(r.board, 'config.json');
  const before = r.routineText();
  const bump = `'${process.execPath}' -e "const f=process.argv[1];const j=JSON.parse(require('fs').readFileSync(f,'utf8'));j.requires='9.0.0';require('fs').writeFileSync(f,JSON.stringify(j))" '${cfg}'`;
  const res = r.roadctl(r.sup('mr-status', ['sh', '-c', bump]));
  assert.equal(res.status, EXIT.failed, res.stderr);
  assert.equal(r.routineText(), before, 'the routine file is unchanged');
  assert.match(r.runs().find((x) => x.id === 'mr-status').reason, /routine file was not written \(unsupported: board requires roadctl 9\.0\.0 or newer/);
  assert.equal(inspectLock(path.join(r.state, 'supervise-routine.my-app.mr-status.lock')).state, 'stop-unsaved');
}));

test('P5.2 r4-3: a takeover guard of a LIVE process is never removed for its age; one of a dead process or older than the lock may be is', NEEDS, withRig(async (r) => {
  fs.mkdirSync(r.state, { recursive: true });
  const file = path.join(r.state, 'supervise-guard.lock');
  const guard = `${file}.takeover`;
  const marked = JSON.stringify({ pid: 999999999, token: 't', key: 'k', stop_unsaved: 'x' });
  fs.writeFileSync(file, marked);
  fs.writeFileSync(guard, String(process.pid));
  const old = new Date(wallClock() - 60e3); // much older than 5 seconds, but its owner (this process) is alive
  fs.utimesSync(guard, old, old);
  assert.equal(removeMarkedLock(file, marked), false, 'the guard is busy: nothing is removed');
  assert.equal(fs.existsSync(guard), true, 'and the live owner\'s guard stays');
  assert.equal(fs.readFileSync(file, 'utf8'), marked);
  // the guard of a dead process is cleared and the next look can take it
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(guard, dead);
  dropStaleGuard(guard);
  assert.equal(fs.existsSync(guard), false);
  assert.equal(removeMarkedLock(file, marked), true);
  // a live owner's guard older than the lock stale time (10 minutes) is also given up
  fs.writeFileSync(guard, String(process.pid));
  const ancient = new Date(wallClock() - 11 * 60e3);
  fs.utimesSync(guard, ancient, ancient);
  dropStaleGuard(guard);
  assert.equal(fs.existsSync(guard), false);
}));

// ---------------------------------------------------------------- usage, format, docs

test('P5.2: usage errors, the routine must belong to --as, a command that cannot start, flags after -- stay the command\'s', NEEDS, withRig(async (r) => {
  r.routine();
  for (const args of [['supervise'], ['supervise', '--routine', 'mr-status', '--as', ME], ['supervise', '--routine', 'mr-status', '--card', 'X', '--as', ME, '--', 'true'], ['supervise', '--routine', 'mr-status', '--as', ME, '--board', r.board, '--timeout', 'soon', '--', 'true']]) {
    const res = r.roadctl(args);
    assert.equal(res.status, EXIT.usage, args.join(' '));
    assert.match(res.stderr, /usage: roadctl supervise/);
  }
  assert.match(r.roadctl(['supervise', '--routine', 'mr-status', '--as', 'codex@home-wsl', '--board', r.board, '--', 'true']).stderr, /belongs to claude-code@home-wsl/);
  const missing = r.roadctl(r.sup('mr-status', ['no-such-command-here']));
  assert.equal(missing.status, EXIT.failed);
  assert.match(missing.stderr, /cannot start: ENOENT/);
  assert.equal(r.runs().find((x) => x.id === 'mr-status').outcome, 'failed');
  r.routine('mr-args');
  r.roadctl(r.sup('mr-args', ['claude', '--as', 'someone', '--routine', 'other', '--model', 'haiku']));
  assert.deepEqual(r.calls('claude').at(-1).argv, ['--as', 'someone', '--routine', 'other', '--model', 'haiku']);
}));

test('P5.2 a18: the Log line trailer of the supervisor reads back (src=supervisor), VERSION and the docs say what changed, the exit codes are in the docs', async () => {
  const rc = await import('../roadctl.mjs');
  const { formatRunTrailer, parseRunTrailer } = await import('./run-ledger.mjs');
  const t = formatRunTrailer({ run_id: 'r-abc', duration_s: 3, host: 'h', src: 'supervisor' });
  assert.equal(t, '[run=r-abc dur=3s host=h src=supervisor]');
  assert.deepEqual(parseRunTrailer(`RUN failed: x ${t}`), { text: 'RUN failed: x', run_id: 'r-abc', duration_s: 3, host: 'h', src: 'supervisor' });
  assert.deepEqual(parseRunTrailer('RUN ok: x [run=r-abc dur=3s host=h]'), { text: 'RUN ok: x', run_id: 'r-abc', duration_s: 3, host: 'h' }, 'the old form is unchanged');
  assert.ok(rc.compareVersions(rc.VERSION, '0.6.0') >= 0, 'VERSION raised for the new trailer');
  assert.match(rc.boardRequires({ requires: '0.6.0' }, '0.5.0'), /requires roadctl 0\.6\.0 or newer/, 'a 0.5 copy refuses a board that asks for 0.6');
  assert.match(DOCS, /\*\*Format change \(roadctl 0\.6\.0\)\.\*\*/);
  assert.match(DOCS, /src=supervisor/);
  for (const [code, word] of [[0, 'ok'], [1, 'failed'], [2, 'usage'], [4, 'not started'], [5, 'busy'], [6, 'paused'], [7, 'timeout'], [8, 'aborted']]) {
    assert.match(DOCS, new RegExp(`\\| ${code} \\|[^\\n]*${word}`, 'i'), `exit code ${code} is described`);
  }
});
