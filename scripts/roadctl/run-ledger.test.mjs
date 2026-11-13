// P5.1: the run ledger end to end through the real roadctl (run-ledger.mjs, the hooks in roadctl.mjs, docs). Run: node --test scripts/roadctl/run-ledger.test.mjs
// Nothing here starts a model or reaches a network: claude is the fake of scripts/testkit/. Time: roadctl's clock is ROADCTL_NOW (the shared helper);
// real time is used only for a stale lock (run-store.test.mjs). The hostname is fixed by ROADCTL_HOST: no real host name is in a test.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { FAKES_SKIP, installFakes } from '../testkit/fakes.mjs';
import { runRecordProblems } from '../testkit/run-schema.mjs';
import { tickJsonProblems } from '../testkit/tick-schema.mjs';
import { clock, shift, T0 } from '../testkit/time.mjs';
import { buildRegistry } from './registry.mjs';
import { formatRunTrailer, parseRunTrailer, timeoutMs } from './run-ledger.mjs';
import * as store from './run-store.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(scripts, 'roadctl.mjs');
const EXAMPLE_BOARD = path.join(scripts, '..', 'examples', 'board-example', 'board');
const DOCS = fs.readFileSync(path.join(scripts, '..', 'docs', 'roadctl.md'), 'utf8');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const ME = 'claude-code@home-wsl';
const WORKER = 'codex@home-wsl';
const HOST = 'test-host';

/** A workspace with the example board as project my-app, fake executables and an environment that touches nothing outside a temp dir. */
function rig({ env: extra = {}, git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-runs-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  if (git) execFileSync('git', ['init', '-q', ws]);
  const bin = installFakes(path.join(dir, 'bin'));
  const state = path.join(dir, 'state');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: state, XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'cfg'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10', ROADCTL_HOST: HOST, FAKE_LOG: path.join(dir, 'calls.jsonl'), ...clock(T0), ...extra };
  delete env.ROADCTL_RUN_ID;
  const run = (args, over = {}) => spawnSync(process.execPath, [SELF, ...args, '--board', board], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const ok = (args, over) => {
    const r = run(args, over);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  const at = (minutes) => clock(shift(minutes));
  const tick = (args = [], over = {}) => spawnSync(process.execPath, [SELF, 'tick', '--as', ME, '--no-pull', ...args], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const routineFile = (id = 'mr-status') => path.join(board, 'routines', `${id}.md`);
  /** An approved routine of `agent` that is due, with the board switch on; `header` lines are added after `every:`. */
  const routine = (agent = ME, id = 'mr-status', header = '') => {
    ok(['routine', 'new', id, 'Collect MR status', '--agent', agent, '--model', 'haiku', '--env', 'laptop', '--every', '2h']);
    if (header) fs.writeFileSync(routineFile(id), fs.readFileSync(routineFile(id), 'utf8').replace(/^every: .*$/m, (m) => `${m}\n${header}`));
    ok(['routine', 'on', id, '--by', 'Owner', '--source', 'chat 2026-11-12']);
    ok(['autonomy', 'routines', 'on', '--by', 'Owner']);
  };
  const runs = (args = [], over) => JSON.parse(ok(['runs', '--json', ...args], over).stdout);
  const paths = store.ledgerPaths(env);
  return { dir, ws, board, bin, env, state, paths, run, ok, at, tick, routine, routineFile, runs };
}
const runIdOf = (r) => /run (\S+) begun/.exec(r.stdout)?.[1];
const logLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^- \d{4}-/.test(l));
const rawLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---------------------------------------------------------------- a1, a7, a9: begin, done, the Log line

test('P5.1 a1: begin and routine done write two linked records with one run_id; ROADCTL_RUN_ID replaces --run', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  const begin = r.ok(['run', 'begin', 'mr-status', '--as', ME]);
  const id = runIdOf(begin);
  assert.match(id, /^r-[0-9a-f]{12}$/);
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'checked 3 things'], r.at(7));
  const lines = rawLines(r.paths.runs).filter((l) => l.run_id === id);
  assert.deepEqual(lines.map((l) => l.event), ['begin', 'end'], 'two records, one run_id');
  const [run] = r.runs();
  assert.deepEqual([run.run_id, run.kind, run.project, run.id, run.agent, run.model, run.host, run.source, run.started, run.finished, run.duration_s, run.outcome, run.attempt, run.roadctl], [id, 'routine', 'my-app', 'mr-status', ME, 'haiku', HOST, 'agent', T0, shift(7), 420, 'ok', 1, rc.VERSION]);
  assert.deepEqual([run.did, run.usage], [['checked 3 things'], null]);
  // the environment carries the id: no --run on either command
  const second = r.ok(['run', 'begin', 'mr-status', '--as', ME], { ...r.at(130), ROADCTL_RUN_ID: 'sup-42' });
  assert.equal(runIdOf(second), 'sup-42');
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'escalated', 'needs a person'], { ...r.at(135), ROADCTL_RUN_ID: 'sup-42' });
  const again = r.runs().find((x) => x.run_id === 'sup-42');
  assert.deepEqual([again.outcome, again.duration_s, again.started, again.finished], ['escalated', 300, shift(130), shift(135)]);
  assert.equal(r.runs().length, 2);
  // a --run that belongs to another routine is refused, and nothing is recorded
  r.routine(ME, 'other-job');
  const other = r.ok(['run', 'begin', 'other-job', '--as', ME], r.at(140));
  const bad = r.run(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'x', '--run', runIdOf(other)], r.at(141));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /belongs to routine:my-app\/other-job, not routine:my-app\/mr-status/);
  assert.match(r.run(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'x', '--run', 'bad id!']).stderr, /--run is an id of letters/);
});

test('P5.1 a7: the Log line of a run has run_id, duration and host and reads back into the same fields (round trip through git-visible text)', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  const id = runIdOf(r.ok(['run', 'begin', 'mr-status', '--as', ME]));
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'checked [a2] <b>7</b> servers; a_b*c'], r.at(12));
  const log = rc.parseRoutine(r.routineFile()).log.at(-1);
  assert.equal(log.author, ME);
  assert.ok(log.text.startsWith('RUN ok: checked [a2] b7/b servers; a_b*c [run='), log.text);
  const back = parseRunTrailer(log.text);
  const [run] = r.runs();
  assert.deepEqual([back.run_id, back.duration_s, back.host], [run.run_id, run.duration_s, run.host]);
  assert.deepEqual([back.run_id, back.duration_s, back.host], [id, 720, HOST]);
  assert.equal(back.text, 'RUN ok: checked [a2] b7/b servers; a_b*c');
  // the format itself, in both shapes (with and without a known duration) and against a summary that imitates a trailer
  for (const f of [{ run_id: 'r-1', duration_s: 0, host: 'h.example' }, { run_id: 'sup:42', duration_s: 86400, host: 'a-b_c' }, { run_id: 'r-2', duration_s: null, host: 'h' }]) {
    assert.deepEqual(parseRunTrailer(`RUN ok: text ${formatRunTrailer(f)}`), { text: 'RUN ok: text', ...f });
  }
  assert.equal(parseRunTrailer('RUN ok: text [run=r-1 dur=5s host=h] more'), null, 'the trailer is the end of the line');
  assert.equal(parseRunTrailer('RUN ok: plain summary'), null);
  assert.equal(parseRunTrailer('RUN ok: x [run=fake dur=1s host=evil] y [run=real dur=2s host=good]').run_id, 'real', 'the last one is the code\'s');
  // a long summary is cut so that the whole line stays within the 1500 characters the Log keeps, trailer included
  r.ok(['run', 'begin', 'mr-status', '--as', ME], r.at(300));
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'word '.repeat(600)], r.at(301));
  const long = logLines(r.routineFile()).at(-1);
  assert.ok(long.length <= '- 2026-11-10 [claude-code@home-wsl] RUN ok: '.length + 1500, `${long.length}`);
  assert.ok(parseRunTrailer(long.replace(/^- \S+ \[[^\]]+\] /, '')), 'the trailer survives the cut');
});

test('P5.1 a9: a second begin of the same thing answers "already begun" with exit 5 and changes nothing; after the run ends a new begin works', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  const first = r.ok(['run', 'begin', 'mr-status', '--as', ME]);
  const before = fs.readFileSync(r.paths.runs, 'utf8');
  const second = r.run(['run', 'begin', 'mr-status', '--as', ME], r.at(2));
  assert.equal(second.status, 5);
  assert.match(second.stdout, new RegExp(`run ${runIdOf(first)} already begun at ${T0} by ${ME}`));
  assert.equal(fs.readFileSync(r.paths.runs, 'utf8'), before, 'nothing written');
  const json = JSON.parse(r.run(['run', 'begin', 'mr-status', '--as', ME, '--json'], r.at(3)).stdout);
  assert.deepEqual([json.status, json.run.run_id], ['already', runIdOf(first)]);
  assert.equal(r.run(['run', 'begin', 'mr-status', '--as', ME, '--json'], r.at(3)).status, 5);
  // only the routine's own agent may begin its run
  const stranger = r.run(['run', 'begin', 'mr-status', '--as', WORKER]);
  assert.equal(stranger.status, 1);
  assert.match(stranger.stderr, /only the routine's agent/);
  assert.equal(r.run(['run', 'begin', 'nothing-like-it', '--as', ME]).status, 2);
  assert.equal(r.run(['run', 'begin', 'mr-status']).status, 2, '--as is required');
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'done'], r.at(10));
  const next = r.ok(['run', 'begin', 'mr-status', '--as', ME], r.at(130));
  assert.notEqual(runIdOf(next), runIdOf(first));
  assert.match(next.stdout, /attempt 1/);
});

// ---------------------------------------------------------------- a4: without begin, as before

test('P5.1 a4: routine done without begin works as before (same output, same Log line, same header) and still leaves a whole record', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  const done = r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'failed', 'no begin here'], r.at(5));
  assert.equal(done.stdout, 'roadctl routine done: recorded-local — recorded on the local board only (not a git repository): not yet visible to others\n');
  assert.equal(done.stderr, '');
  assert.equal(logLines(r.routineFile()).at(-1), '- 2026-11-10 [claude-code@home-wsl] RUN failed: no begin here', 'the Log line is the old one');
  assert.match(fs.readFileSync(r.routineFile(), 'utf8'), new RegExp(`^last_run: ${shift(5)}\\nlast_result: failed$`, 'm'));
  const [run] = r.runs();
  assert.deepEqual([run.outcome, run.started, run.duration_s, run.finished, run.did, run.source, run.attempt], ['failed', null, null, shift(5), ['no begin here'], 'agent', 1]);
  assert.match(run.run_id, /^r-[0-9a-f]{12}$/, 'a derived id: the same routine, last_run and attempt give the same one');
  // an explicit id (a supervisor, or ROADCTL_RUN_ID) is in the Log line even without a begin
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'with an id'], { ...r.at(10), ROADCTL_RUN_ID: 'sup-1' });
  assert.match(logLines(r.routineFile()).at(-1), /RUN ok: with an id \[run=sup-1 host=test-host\]$/, 'no duration: there was no begin');
  assert.equal(r.runs().find((x) => x.run_id === 'sup-1').duration_s, null);
  // refusals are unchanged and record nothing
  const n = rawLines(r.paths.runs).length;
  assert.match(r.run(['routine', 'done', 'mr-status', '--as', WORKER, '--result', 'ok', 'x']).stderr, /only the routine's agent/);
  assert.equal(r.run(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', '  ']).status, 1);
  assert.equal(rawLines(r.paths.runs).length, n);
});

// ---------------------------------------------------------------- a2, a10: crashed

test('P5.1 a2: a run without an end is crashed by the next tick after its deadline (the clock of roadctl, no pid), not before; a supervised run is left to its supervisor', FAKES_SKIP, () => {
  const r = rig();
  r.routine(ME, 'mr-status', 'timeout: 30m');
  const id = runIdOf(r.ok(['run', 'begin', 'mr-status', '--as', ME]));
  assert.equal(r.runs()[0].deadline, shift(30), 'the deadline comes from the timeout header');
  // two runs of other routines: one whose begin has the pid of a process that is alive right now, one under a supervisor
  const line = (o) => fs.appendFileSync(r.paths.runs, `${JSON.stringify({ event: 'begin', kind: 'routine', project: 'my-app', agent: ME, started: T0, outcome: 'started', attempt: 1, deadline: shift(30), ...o })}\n`);
  line({ run_id: 'live-pid', id: 'pid-job', source: 'agent', pid: process.pid });
  line({ run_id: 'supervised', id: 'sup-job', source: 'supervisor' });
  r.ok(['run', 'note', id, 'step one done'], r.at(5));
  r.ok(['run', 'note', id, 'step two done'], r.at(8));
  const states = (over) => Object.fromEntries(r.runs([], over).map((x) => [x.run_id, x.outcome]));
  const t29 = r.tick([], r.at(29));
  assert.equal(t29.status, 0, `${t29.stdout}${t29.stderr}`);
  assert.deepEqual(states(r.at(29)), { [id]: 'started', 'live-pid': 'started', supervised: 'started' }, 'before the deadline nothing is crashed');
  const t31 = r.tick(['--json'], r.at(31));
  assert.equal(t31.status, 0, t31.stderr);
  assert.deepEqual(states(r.at(31)), { [id]: 'crashed', 'live-pid': 'crashed', supervised: 'started' }, 'after it: crashed, whatever the pid says; the supervised run is not touched');
  const crashed = r.runs().find((x) => x.run_id === id);
  assert.deepEqual([crashed.finished, crashed.duration_s, crashed.note, crashed.source], [shift(31), 31 * 60, 'step two done', 'agent']);
  assert.match(crashed.reason, /no end by the deadline/);
  assert.equal(rawLines(r.paths.runs).filter((l) => l.event === 'crash').length, 2, 'each run is marked once');
  r.tick([], r.at(40));
  assert.equal(rawLines(r.paths.runs).filter((l) => l.event === 'crash').length, 2, 'a later tick marks nothing again');
  // the default threshold (no timeout header) is two hours
  r.routine(ME, 'default-job');
  assert.equal(JSON.parse(r.ok(['run', 'begin', 'default-job', '--as', ME, '--json'], r.at(60)).stdout).run.deadline, shift(180));
  // lint knows the key: a good value is clean, a bad one is an error
  r.ok(['sync']);
  const clean = r.run(['lint']);
  assert.equal(clean.status, 0, clean.stdout);
  fs.writeFileSync(r.routineFile(), fs.readFileSync(r.routineFile(), 'utf8').replace('timeout: 30m', 'timeout: soon'));
  const lint = JSON.parse(r.run(['lint', '--json']).stdout);
  assert.deepEqual(lint.filter((x) => /timeout/.test(x.msg)).map((x) => [x.level, x.rule]), [['error', 25]]);
  assert.deepEqual([timeoutMs('30m'), timeoutMs('2h'), timeoutMs('1d'), timeoutMs('4m'), timeoutMs('soon'), timeoutMs(undefined), timeoutMs('31d')], [1800000, 7200000, 86400000, 7200000, 7200000, 7200000, 7200000]);
});

test('P5.1 a10: claim and report of a delegated task make the run record by themselves; a checkpoint survives in the crashed record; a new claim closes the old run', FAKES_SKIP, () => {
  const r = rig();
  assert.equal(r.run(['delegate', 'W-3', '--to', WORKER, '--by', ME]).status, 0);
  const claim = r.ok(['claim', 'W-3', '--as', WORKER, '--lease', '30m'], r.at(1));
  assert.match(claim.stdout, /claimed/);
  const [t] = r.runs(['--open']);
  assert.deepEqual([t.kind, t.project, t.id, t.agent, t.outcome, t.started, t.deadline, t.host], ['task', 'my-app', 'W-3', WORKER, 'started', shift(1), shift(31), HOST], 'the deadline is the end of the lease');
  r.ok(['run', 'note', 'half the criteria', '--as', WORKER], r.at(10)); // no id: the one open run of this agent
  r.ok(['report', 'W-3', '--as', WORKER, 'changed the exporter, ran the tests'], r.at(20));
  const done = r.runs().find((x) => x.run_id === t.run_id);
  assert.deepEqual([done.outcome, done.finished, done.duration_s, done.did, done.writes, done.note], ['ok', shift(20), 19 * 60, ['changed the exporter, ran the tests'], ['card:W-3'], 'half the criteria']);
  assert.equal(r.runs(['--open']).length, 0);
  // a claim whose lease runs out: the tick marks the run crashed and keeps the checkpoint
  assert.equal(r.run(['return', 'W-3', '--as', ME, 'again']).status, 0);
  r.ok(['claim', 'W-3', '--as', WORKER, '--lease', '30m'], r.at(100));
  r.ok(['run', 'note', 'started over', '--as', WORKER], r.at(105));
  r.tick([], r.at(140));
  const lost = r.runs().filter((x) => x.outcome === 'crashed');
  assert.deepEqual(lost.map((x) => [x.id, x.note, x.finished]), [['W-3', 'started over', shift(140)]]);
  // a new claim of the card is a new run
  r.ok(['claim', 'W-3', '--as', WORKER, '--lease', '30m'], r.at(190));
  let all = r.runs().filter((x) => x.id === 'W-3');
  assert.deepEqual(all.map((x) => x.outcome), ['ok', 'crashed', 'started']);
  // the lease ran out again and nobody ticked: the next claim finds the run overdue and closes it first
  r.ok(['claim', 'W-3', '--as', WORKER, '--lease', '30m'], r.at(300));
  all = r.runs().filter((x) => x.id === 'W-3');
  assert.deepEqual(all.map((x) => x.outcome), ['ok', 'crashed', 'crashed', 'started']);
  assert.match(all[2].reason, /no end by the deadline/);
  assert.equal(all.at(-1).started, shift(300));
  // a refused claim records nothing
  const n = rawLines(r.paths.runs).length;
  assert.notEqual(r.run(['claim', 'W-3', '--as', ME], r.at(301)).status, 0);
  assert.equal(rawLines(r.paths.runs).length, n);
});

// ---------------------------------------------------------------- a3, a11: ticks.jsonl folding, rotation, skipped runs, text stability

test('P5.1 a3: ten identical blocked-reserve ticks are one line with a counter in ticks.state.json; tick --ledger keeps its format; rotation inside tick leaves one previous file', FAKES_SKIP, () => {
  const r = rig({ env: { FAKE_U5: '0.9' } });
  r.routine();
  for (let i = 0; i < 10; i++) {
    const t = r.tick([], r.at(i));
    assert.equal(t.status, 1, t.stderr + t.stdout);
  }
  assert.equal(rawLines(r.paths.ticks).length, 1);
  assert.deepEqual(rawLines(r.paths.ticks)[0], { time: T0, agent: ME, decision: 'blocked-reserve', counts: { take: 0, accept: 0, start: 0, stale: 0, run: 1 }, limits: { provider: 'claude', state: 'reserve' } }, 'the line is what the old ledger wrote');
  const st = JSON.parse(fs.readFileSync(r.paths.state, 'utf8'));
  assert.deepEqual(Object.values(st.ticks).map((x) => [x.decision, x.count, x.first, x.last]), [['blocked-reserve', 10, T0, shift(9)]]);
  assert.match(r.run(['tick', '--ledger', '-n', '5']).stdout, new RegExp(`^${T0} ${ME} blocked-reserve take=0 accept=0 start=0 stale=0 run=1 limits=claude:reserve$`, 'm'));
  // a different decision is a new line (the gate opened); idle and work are not folded: one line per tick, as before
  const open = { FAKE_U5: '0.1', XDG_CACHE_HOME: path.join(r.dir, 'cache2') };
  const w = r.tick([], { ...r.at(10), ...open });
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual(rawLines(r.paths.ticks).map((l) => l.decision), ['blocked-reserve', 'work']);
  r.tick([], { ...r.at(11), ...open });
  assert.equal(rawLines(r.paths.ticks).length, 3, 'a second identical work tick is a line again');
  assert.equal(JSON.parse(fs.readFileSync(r.paths.state, 'utf8')).ticks[`${ME}|`].count, 2, 'the state still counts the streak');
  // rotation: only inside tick, one previous generation
  const filler = `${JSON.stringify({ time: T0, agent: 'old', decision: 'idle', counts: {}, limits: null })}\n`.repeat(14000);
  fs.writeFileSync(r.paths.ticks, filler);
  assert.ok(fs.statSync(r.paths.ticks).size > store.TICKS_ROTATE_BYTES);
  assert.equal(fs.existsSync(r.paths.ticksPrev), false);
  r.tick([], { ...r.at(12), ...open });
  assert.equal(fs.readFileSync(r.paths.ticksPrev, 'utf8'), filler, 'the whole old file is the previous generation');
  assert.ok(fs.statSync(r.paths.ticks).size < 1000, 'a fresh file with the new line');
  fs.writeFileSync(r.paths.ticks, filler);
  r.tick([], { ...r.at(13), ...open });
  assert.deepEqual(fs.readdirSync(r.paths.dir).filter((f) => f.startsWith('ticks.jsonl')).sort(), ['ticks.jsonl', 'ticks.jsonl.1'], 'never more than one previous file');
  assert.equal(r.run(['tick', '--ledger', '-n', '1', '--json']).status, 0);
});

test('P5.1 a11: skipped runs with their reason are recorded (limits, busy, not-due), folded with a counter', FAKES_SKIP, () => {
  const r = rig({ env: { FAKE_U5: '0.9' } });
  r.routine();
  // limits: the reserve is reached, the RUN item is skipped
  for (let i = 0; i < 4; i++) r.tick([], r.at(i));
  assert.deepEqual(r.runs().filter((x) => x.outcome === 'skipped').map((x) => [x.reason, x.kind, x.id, x.count, x.source]), [['limits', 'routine', 'mr-status', 4, 'tick']]);
  // busy: another tick of this agent holds the lock, seen by a general job and by a routine job
  fs.writeFileSync(rc.tickLockPath(ME, r.env), '{}');
  fs.writeFileSync(rc.tickLockPath(ME, r.env, 'mr-status'), '{}');
  for (let i = 4; i < 7; i++) assert.equal(r.tick([], r.at(i)).status, 5);
  assert.equal(r.tick(['--routine', 'mr-status'], r.at(7)).status, 5);
  const busy = r.runs().filter((x) => x.outcome === 'skipped' && x.reason === 'busy');
  assert.deepEqual(busy.map((x) => [x.kind, x.id, x.count]).sort(), [['orchestrator', ME, 3], ['routine', 'mr-status', 1]]);
  // the streak ends when a tick runs again: the next busy is a new record
  fs.rmSync(rc.tickLockPath(ME, r.env));
  r.tick([], r.at(8));
  fs.writeFileSync(rc.tickLockPath(ME, r.env), '{}');
  r.tick([], r.at(9));
  assert.equal(r.runs().filter((x) => x.outcome === 'skipped' && x.reason === 'busy' && x.kind === 'orchestrator').length, 2);
  fs.rmSync(rc.tickLockPath(ME, r.env));
  // not-due: the routine ran, its tick later has nothing to do
  const n = rig();
  n.routine();
  n.ok(['run', 'begin', 'mr-status', '--as', ME]);
  n.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'fine'], n.at(3));
  for (const m of [10, 20, 30]) assert.equal(n.tick(['--routine', 'mr-status'], n.at(m)).status, 4);
  assert.deepEqual(n.runs().filter((x) => x.outcome === 'skipped').map((x) => [x.reason, x.id, x.count, x.started, x.finished]), [['not-due', 'mr-status', 3, shift(10), shift(30)]]);
  // when the routine is due again the streak ends: not-due after the next run is a new record
  assert.equal(n.tick(['--routine', 'mr-status'], n.at(125)).status, 0, 'due again: a RUN item, the not-due streak ends');
  n.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'again'], n.at(130));
  n.tick(['--routine', 'mr-status'], n.at(140));
  assert.equal(n.runs().filter((x) => x.outcome === 'skipped').length, 2);
  for (const rec of [...r.runs(), ...n.runs()]) assert.deepEqual(runRecordProblems(rec), [], JSON.stringify(rec));
});

test('P5.1 a11: the text of tick does not change between two ticks without an event, and changes after crashed (attempt 2), then is stable again', FAKES_SKIP, () => {
  const s = rig({ env: { FAKE_U5: '0.1' } });
  s.routine(ME, 'mr-status', 'timeout: 30m');
  const first = s.tick([], s.at(0));
  assert.equal(first.status, 0, first.stderr);
  s.ok(['run', 'begin', 'mr-status', '--as', ME]);
  const a = s.tick([], s.at(5)).stdout;
  const b = s.tick([], s.at(20)).stdout;
  assert.equal(a, first.stdout, 'beginning a run is not an event of the text');
  assert.equal(b, a, 'no event between the ticks: the same text');
  assert.doesNotMatch(a, /attempt/);
  const prompt = (m) => s.tick(['--prompt'], s.at(m)).stdout;
  assert.equal(prompt(6), prompt(21), 'the prompt is stable too');
  const c = s.tick([], s.at(31)).stdout;
  assert.notEqual(c, b, 'crashed changes the text');
  assert.match(c, /^RUN my-app\/mr-status Collect MR status \(attempt 2\)$/m);
  assert.equal(s.tick([], s.at(45)).stdout, c, 'and it is stable again');
  assert.match(prompt(46), /^RUN my-app\/mr-status Collect MR status \(attempt 2\)$/m);
  const json = JSON.parse(s.tick(['--json'], s.at(47)).stdout);
  assert.deepEqual(tickJsonProblems(json), []);
  assert.equal(json.items[0].routine.attempt, 2);
  // a second crash is attempt 3; a finished run starts over at 1 (no attempt in the item)
  s.ok(['run', 'begin', 'mr-status', '--as', ME], s.at(50));
  assert.match(s.tick([], s.at(85)).stdout, /\(attempt 3\)$/m);
  s.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'finally'], s.at(90));
  const later = JSON.parse(s.tick(['--json'], s.at(90 + 121)).stdout);
  assert.deepEqual(tickJsonProblems(later), []);
  assert.equal(later.items[0].routine.attempt, undefined);
});

// ---------------------------------------------------------------- a5, a6, a8: schema, unreachable state, privacy

test('P5.1 a5: `runs --json` is an array of records that fit the schema described in docs/roadctl.md (usage null, summary fields); the checker rejects a broken record', FAKES_SKIP, () => {
  const r = rig({ env: { FAKE_U5: '0.9' } });
  r.routine();
  r.tick([], r.at(0)); // skipped: limits
  r.ok(['run', 'begin', 'mr-status', '--as', ME], r.at(1));
  r.ok(['run', 'note', 'looking', '--as', ME], r.at(2));
  assert.equal(r.runs(['--open']).length, 1);
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'escalated', 'a long summary that stays one line'], r.at(3));
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'failed', 'second, without begin'], r.at(4));
  const all = r.runs();
  assert.ok(all.length >= 3);
  for (const rec of all) {
    assert.deepEqual(runRecordProblems(rec), [], JSON.stringify(rec));
    assert.deepEqual(Object.keys(rec), store.RUN_FIELDS, 'every field, in the documented order');
    assert.equal(rec.usage, null);
    for (const f of ['did', 'decisions', 'problems', 'writes']) assert.ok(Array.isArray(rec[f]), f);
  }
  const text = r.ok(['runs'], r.at(5)).stdout;
  assert.match(text, /escalated routine my-app\/mr-status claude-code@home-wsl run=r-[0-9a-f]+ dur=120s/);
  assert.match(text, /skipped:limits routine my-app\/mr-status/);
  assert.equal(r.ok(['runs', '--as', WORKER]).stdout, 'no runs recorded\n');
  assert.equal(r.ok(['runs', '--open']).stdout, 'no open runs\n');
  assert.equal(r.ok(['runs', '-n', '1']).stdout.trimEnd().split('\n').length, 1);
  assert.equal(r.run(['runs', '-n', '0']).status, 2);
  // the checker proves it can fail
  const good = all[0];
  const bad = (patch) => runRecordProblems({ ...good, ...patch });
  assert.ok(bad({ extra: 1 }).some((p) => /unknown key extra/.test(p)));
  assert.ok(bad({ usage: { input: 1 } }).some((p) => /run.usage/.test(p)));
  assert.ok(bad({ outcome: 'done' }).some((p) => /run.outcome/.test(p)));
  assert.ok(bad({ did: 'text' }).some((p) => /run.did/.test(p)));
  assert.ok(bad({ problems: [{ kind: 'bad', key: 'k', text: 't' }] }).some((p) => /run.problems/.test(p)));
  assert.ok(runRecordProblems({ ...good, outcome: 'skipped', reason: 'tired' }).some((p) => /skipped needs a reason/.test(p)));
  const { host, ...noHost } = good;
  assert.ok(runRecordProblems(noHost).some((p) => /missing host/.test(p)));
  // the docs name every field and the reserved usage
  for (const f of store.RUN_FIELDS) assert.ok(DOCS.includes(`\`${f}\``), `docs/roadctl.md describes ${f}`);
  assert.match(DOCS, /`usage`[^\n]*`null`/);
});

test('P5.1 a6: a state directory that cannot be used does not break routine done, claim, report, tick or the run commands', FAKES_SKIP, () => {
  const good = rig();
  const bad = rig();
  fs.writeFileSync(path.join(bad.dir, 'a-file'), 'x');
  const broken = { XDG_STATE_HOME: path.join(bad.dir, 'a-file', 'state') }; // a path below a regular file: it can never be created
  for (const x of [good, bad]) x.routine();
  const same = (args, over = {}) => {
    const g = good.run(args, over);
    const b = bad.run(args, { ...over, ...broken });
    assert.deepEqual([b.status, b.stdout, b.stderr], [g.status, g.stdout, g.stderr], args.join(' '));
    return b;
  };
  same(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'works without a ledger']);
  assert.match(logLines(bad.routineFile()).at(-1), /RUN ok: works without a ledger \[run=r-[0-9a-f]+ host=test-host\]$|RUN ok: works without a ledger$/);
  for (const x of [good, bad]) assert.equal(x.run(['delegate', 'W-3', '--to', WORKER, '--by', ME]).status, 0);
  same(['claim', 'W-3', '--as', WORKER]);
  same(['report', 'W-3', '--as', WORKER, 'text']);
  const t = bad.tick([], broken);
  assert.equal(t.status, good.tick([]).status);
  assert.equal(t.stdout, good.tick([]).stdout);
  assert.equal(bad.tick([], { ...broken, XDG_STATE_HOME: path.join(bad.dir, 'a-file', 'x', 'y') }).status, t.status);
  // the run commands say so and let the work go on
  const begin = bad.run(['run', 'begin', 'mr-status', '--as', ME], broken);
  assert.equal(begin.status, 0);
  assert.match(begin.stderr, /warning: .*cannot be created.*not recorded/);
  assert.equal(bad.run(['run', 'note', 'x', '--as', ME], broken).status, 0);
  assert.equal(bad.run(['runs'], broken).stdout, 'no runs recorded\n');
  assert.equal(fs.existsSync(path.join(bad.dir, 'a-file', 'state')), false);
});

test('P5.1 a8: runs.jsonl is never inside a git work tree (by default it is under the home directory, next to ticks.jsonl); a state directory inside a repository is refused and the commands go on', FAKES_SKIP, () => {
  const r = rig({ git: true }); // the workspace itself is a git repository
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-home-'));
  const env = { XDG_STATE_HOME: '', HOME: home }; // the default location
  const def = r.ok(['routine', 'new', 'mr-status', 'T', '--agent', ME, '--model', 'haiku', '--env', 'e', '--every', '2h'], env);
  assert.equal(def.status, 0);
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'x'], env);
  const where = path.join(home, '.local', 'state', 'road-map-journal', 'runs.jsonl');
  assert.equal(fs.existsSync(where), true);
  assert.equal(store.gitWorkTreeOf(path.dirname(where), env), null, 'the ledger is not in a work tree');
  assert.equal(store.gitWorkTreeOf(path.join(r.ws, 'projects'), env) !== null, true, 'while the workspace is one (the checker sees it)');
  assert.ok(!where.startsWith(r.ws), 'not in the workspace');
  // a state directory configured inside a repository: nothing is written there, the work is done
  const inside = path.join(r.ws, 'state-in-repo');
  const run = r.run(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', 'y'], { XDG_STATE_HOME: inside });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(path.join(inside, 'road-map-journal', 'runs.jsonl')), false);
  const note = r.run(['run', 'begin', 'mr-status', '--as', ME], { XDG_STATE_HOME: inside });
  assert.equal(note.status, 0);
  assert.match(note.stderr, /inside a git work tree/);
  // the docs say what the file holds and where it must not be
  assert.match(DOCS, /runs\.jsonl[^\n]*(text of|summar)/i);
  assert.match(DOCS, /never[^\n]*(inside|in) a git work tree/i);
});

// ---------------------------------------------------------------- P5.14: the format change is raised and documented

test('P5.1 format change (P5.14): VERSION is 0.3.0, a board that requires it is refused by 0.2.x and used by this copy, a board without requires is unchanged; tick --json knows `attempt`', FAKES_SKIP, () => {
  assert.ok(rc.compareVersions(rc.VERSION, '0.3.0') >= 0, 'the P5.1 format needs roadctl 0.3.0 or newer');
  assert.match(rc.boardRequires({ requires: '0.3.0' }, '0.2.0'), /requires roadctl 0\.3\.0 or newer; this is 0\.2\.0/);
  assert.equal(rc.boardRequires({ requires: '0.3.0' }, rc.VERSION), null);
  assert.equal(rc.boardRequires({}, '0.2.0'), null, 'a board without requires is never refused');
  const r = rig();
  r.routine(ME, 'mr-status', 'timeout: 45m');
  const cfg = path.join(r.board, 'config.json');
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(JSON.parse(r.tick(['--json']).stdout).items[0].kind, 'RUN', 'without requires the board is used as before');
  fs.writeFileSync(cfg, JSON.stringify({ ...c, requires: '99.0.0' }));
  const refused = JSON.parse(r.tick(['--json']).stdout);
  assert.deepEqual([refused.decision, refused.items.length], ['idle', 0], 'a copy that is too old offers nothing from a board that asks for more');
  fs.writeFileSync(cfg, JSON.stringify({ ...c, requires: rc.VERSION }));
  assert.equal(JSON.parse(r.tick(['--json']).stdout).items[0].kind, 'RUN', 'this copy meets the requirement');
  assert.deepEqual(tickJsonProblems({ agent: ME, decision: 'work', limits: { provider: 'claude', state: 'allowed' }, sync: [], items: [{ kind: 'RUN', project: 'p', id: 'x', title: 't', routine: { agent: ME, model: 'm', env: 'e', every: '2h', file: 'f', last_run: null, attempt: 2 } }] }), []);
  assert.ok(tickJsonProblems({ agent: ME, decision: 'work', limits: { provider: 'claude', state: 'allowed' }, sync: [], items: [{ kind: 'RUN', project: 'p', id: 'x', title: 't', routine: { agent: ME, model: 'm', env: 'e', every: '2h', file: 'f', last_run: null, attempt: 1 } }] }).length > 0, 'attempt 1 is never printed');
  // old values stay: a new detail is a new key, not a new value of last_result
  assert.deepEqual(rc.ROUTINE_RESULTS, ['ok', 'escalated', 'failed']);
  assert.match(fs.readFileSync(path.join(scripts, '..', 'CHANGELOG.md'), 'utf8'), /0\.3\.0[^\n]*(requires|timeout)/);
});

// ---------------------------------------------------------------- the seam

test('registry hooks: only known names, each module gets the value of its own before-call, a failing hook is a warning and gives no value', () => {
  const opts = { builtin: {}, groups: ['Look'], knownKeys: new Set() };
  assert.throws(() => buildRegistry([{ name: 'x', hooks: { 'nope-hook'() {} } }], opts), /unknown hook "nope-hook"/);
  assert.throws(() => buildRegistry([{ name: 'x', hooks: { 'claim-after': 'no' } }], opts), /hook claim-after must be a function/);
  const seen = [];
  const reg = buildRegistry([
    { name: 'a', hooks: { 'routine-done-before': () => ({ text: 'A' }), 'routine-done-after': (c) => seen.push(['a', c.prior, c.done]) } },
    { name: 'b', hooks: { 'routine-done-before': () => { throw new Error('boom\nline two'); }, 'routine-done-after': (c) => seen.push(['b', c.prior]) } },
    { name: 'c', hooks: { 'routine-done-before': () => ({ refuse: 'no' }) } },
  ], opts);
  let err = '';
  const before = reg.callHook('routine-done-before', { x: 1 }, { err: (s) => { err += s; } });
  assert.deepEqual(before, [{ module: 'a', value: { text: 'A' } }, { module: 'c', value: { refuse: 'no' } }]);
  assert.equal(err, 'roadctl: warning: module b: hook routine-done-before failed: boom line two\n');
  reg.callHook('routine-done-after', { done: 'D' }, undefined, before);
  assert.deepEqual(seen, [['a', { text: 'A' }, 'D'], ['b', undefined]]);
  assert.deepEqual(buildRegistry([], opts).callHook('tick-ledger', {}), [], 'no hooks: nothing');
});

test('docs: the run ledger commands, the files, the timeout key, the folding and the reading rules are described where a user looks', () => {
  for (const w of ['roadctl runs', 'roadctl run begin', 'roadctl run note', 'ROADCTL_RUN_ID', 'ticks.state.json', 'runs.jsonl', '`timeout`', 'requires', '0.3.0', 'already begun', 'crashed', 'blocked-reserve']) assert.ok(DOCS.includes(w), `docs/roadctl.md mentions ${w}`);
  const dev = fs.readFileSync(path.join(scripts, '..', 'docs', 'developing-roadctl.md'), 'utf8');
  for (const w of ['tick-before', 'tick-ledger', 'routine-done-before', 'claim-after', 'report-after']) assert.ok(dev.includes(w), `docs/developing-roadctl.md names the hook ${w}`);
  const overview = spawnSync(process.execPath, [SELF, 'help'], { encoding: 'utf8', env: { ...process.env, ROADCTL_DATE: '2026-11-10' } }).stdout;
  assert.doesNotMatch(overview, /^ {2}runs? +\[/m, '`run` and `runs` are hidden (the overview has a line budget)');
  for (const c of ['run', 'runs']) assert.match(spawnSync(process.execPath, [SELF, 'help', c], { encoding: 'utf8' }).stdout, new RegExp(`^roadctl ${c} \\[`));
  assert.ok(overview.trimEnd().split('\n').length <= 70);
});
