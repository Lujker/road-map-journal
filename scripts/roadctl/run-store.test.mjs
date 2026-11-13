// P5.1: the storage of the run ledger (run-store.mjs): lines, folding, locking, rotation, the state file. Run: node --test scripts/roadctl/run-store.test.mjs
// Time: the shared clock (a time is always passed in); real time only where a lock ages by the mtime of its file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { clock, ms, shift, T0, wallClock } from '../testkit/time.mjs';
import * as store from './run-store.mjs';

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-store.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-runstore-'));
/** An environment whose state directory is empty and outside any git work tree. */
const envOf = () => {
  const dir = tmp();
  return { HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), ...clock() };
};
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('fitLine: a line never exceeds 4096 bytes (Cyrillic is two bytes a character), the longest text is cut first, the input is untouched', () => {
  const rec = { event: 'end', run_id: 'r-1', outcome: 'ok', did: ['а'.repeat(2500), 'б'.repeat(2500)], note: 'в'.repeat(3000), problems: [{ kind: 'transient', key: 'k', text: 'ж'.repeat(3000) }] };
  const before = structuredClone(rec);
  const line = store.fitLine(rec);
  assert.ok(Buffer.byteLength(line) <= store.MAX_LINE, `${Buffer.byteLength(line)} bytes`);
  assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1, 'one line');
  const back = JSON.parse(line);
  assert.deepEqual([back.event, back.run_id, back.outcome], ['end', 'r-1', 'ok'], 'the identity fields survive');
  assert.deepEqual(rec, before);
  const small = { event: 'note', run_id: 'r-2', note: 'short' };
  assert.deepEqual(JSON.parse(store.fitLine(small)), small, 'a small line is not changed');
  // the worst case: nothing but huge text; still one valid line within the limit
  const huge = store.fitLine({ event: 'end', run_id: 'r-3', note: 'x'.repeat(100000), did: Array.from({ length: 500 }, () => 'y'.repeat(100)) });
  assert.ok(Buffer.byteLength(huge) <= store.MAX_LINE);
  assert.equal(JSON.parse(huge).run_id, 'r-3');
});

test('two processes append at the same time: every line is whole and none is lost (a3)', async () => {
  const env = envOf();
  const file = store.ledgerPaths(env).runs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const worker = (tag) => new Promise((resolve, reject) => {
    const code = `import * as s from ${JSON.stringify(`file://${STORE}`)}; for (let i = 0; i < 300; i++) s.appendLine(${JSON.stringify(file)}, { event: 'note', run_id: 'r-${tag}-' + i, note: ${JSON.stringify(tag)}.repeat(900) });`;
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' });
    c.on('error', reject);
    c.on('close', (status) => (status === 0 ? resolve() : reject(new Error(`worker ${tag} exited ${status}`))));
  });
  await Promise.all([worker('a'), worker('b')]);
  const all = lines(file);
  assert.equal(all.length, 600);
  const parsed = all.map((l) => JSON.parse(l)); // a torn line would throw here
  assert.equal(new Set(parsed.map((p) => p.run_id)).size, 600);
  assert.ok(all.every((l) => Buffer.byteLength(l) + 1 <= store.MAX_LINE));
});

test('readJsonl tolerates a missing file, broken and half-written lines and lines that are not objects', () => {
  const dir = tmp();
  assert.deepEqual(store.readJsonl(path.join(dir, 'none.jsonl')), []);
  const f = path.join(dir, 'x.jsonl');
  fs.writeFileSync(f, '{"a":1}\nnot json\n[1,2]\n"str"\n{"b":2}\n{"c":');
  assert.deepEqual(store.readJsonl(f), [{ a: 1 }, { b: 2 }]);
});

test('foldRuns: begin, notes and end make one record; the first real end wins, a real end replaces a crashed mark, a crash does not replace an end', () => {
  const base = { run_id: 'r-1', kind: 'routine', id: 'x', project: 'p' };
  const rec = (l) => store.foldRuns(l).get('r-1');
  assert.equal(rec([{ ...base, event: 'begin', outcome: 'started' }, { event: 'note', run_id: 'r-1', note: 'one' }, { event: 'note', run_id: 'r-1', note: 'two' }]).note, 'two', 'the last checkpoint');
  const ended = rec([{ ...base, event: 'begin', outcome: 'started' }, { event: 'end', run_id: 'r-1', outcome: 'ok', finished: 'F1' }, { event: 'end', run_id: 'r-1', outcome: 'failed', finished: 'F2' }]);
  assert.deepEqual([ended.outcome, ended.finished], ['ok', 'F1'], 'the first end wins');
  const crashedThenDone = rec([{ ...base, event: 'begin', outcome: 'started' }, { event: 'crash', run_id: 'r-1', outcome: 'crashed', finished: 'C' }, { event: 'end', run_id: 'r-1', outcome: 'ok', finished: 'E' }]);
  assert.deepEqual([crashedThenDone.outcome, crashedThenDone.finished], ['ok', 'E'], 'the agent did finish: the mark is replaced');
  const doneThenCrash = rec([{ ...base, event: 'begin', outcome: 'started' }, { event: 'end', run_id: 'r-1', outcome: 'ok', finished: 'E' }, { event: 'crash', run_id: 'r-1', outcome: 'crashed', finished: 'C' }]);
  assert.equal(doneThenCrash.outcome, 'ok');
  const twice = rec([{ ...base, event: 'begin', outcome: 'started', started: 'S1' }, { ...base, event: 'begin', outcome: 'started', started: 'S2' }]);
  assert.equal(twice.started, 'S1', 'a repeated begin line (after a rotation, say) changes nothing');
  assert.equal(store.foldRuns([{ event: 'note', run_id: 'r-9', note: 'orphan' }]).size, 1, 'folded');
  assert.equal(store.foldRuns([{ event: 'note', run_id: 'r-9', note: 'orphan' }]).get('r-9').kind, undefined);
  assert.equal(store.foldRuns([{ event: 'note', note: 'no id' }]).size, 0, 'a line without run_id is ignored');
});

test('run ids are derived: the same routine, previous last_run and attempt give the same id, any other input another', () => {
  const k = 'routine:p/x';
  assert.equal(store.runIdFor(k, '2026-11-10T09:00:00Z', 1), store.runIdFor(k, '2026-11-10T09:00:00Z', 1));
  assert.notEqual(store.runIdFor(k, '2026-11-10T09:00:00Z', 1), store.runIdFor(k, '2026-11-10T09:00:00Z', 2));
  assert.notEqual(store.runIdFor(k, '2026-11-10T09:00:00Z', 1), store.runIdFor(k, '2026-11-10T09:30:00Z', 1));
  assert.notEqual(store.runIdFor(k, null, 1), store.runIdFor('routine:p/y', null, 1));
  assert.match(store.runIdFor(k, null, 1), /^r-[0-9a-f]{12}$/);
});

test('beginRun: idempotent per key, an overdue run is marked crashed and the next attempt gets a new id; attempts count bad runs since the anchor only', () => {
  const env = envOf();
  const p = { kind: 'routine', project: 'p', id: 'x', agent: 'a@h', anchor: '2026-11-10T09:00:00Z', deadlineMs: ms(shift(60)), now: ms(), version: '0.3.0' };
  const a = store.beginRun(env, p);
  assert.equal(a.status, 'begun');
  assert.equal(a.run.attempt, 1);
  assert.equal(store.beginRun(env, { ...p, now: ms(shift(10)) }).status, 'already');
  assert.equal(store.beginRun(env, { ...p, now: ms(shift(10)) }).run.run_id, a.run.run_id);
  const b = store.beginRun(env, { ...p, now: ms(shift(90)), deadlineMs: ms(shift(150)) }); // the first is overdue now
  assert.equal(b.status, 'begun');
  assert.equal(b.run.attempt, 2);
  assert.notEqual(b.run.run_id, a.run.run_id);
  assert.equal(store.readRuns(env).get(a.run.run_id).outcome, 'crashed');
  // the anchor moved (the routine finished a run): earlier bad runs no longer count
  assert.equal(store.badAttempts(store.readRuns(env), 'routine:p/x', '2026-11-10T09:00:00Z'), 1);
  assert.equal(store.badAttempts(store.readRuns(env), 'routine:p/x', shift(120)), 0);
  // an explicit run id that exists is "already"
  assert.equal(store.beginRun(env, { ...p, kind: 'task', runId: b.run.run_id }).status, 'already');
  // supersede (a new claim): the open run of the key is closed as crashed at once
  const t1 = store.beginRun(env, { kind: 'task', project: 'p', id: 'T-1', agent: 'a@h', now: ms(), deadlineMs: ms(shift(120)) });
  const t2 = store.beginRun(env, { kind: 'task', project: 'p', id: 'T-1', agent: 'b@h', now: ms(shift(5)), deadlineMs: ms(shift(125)), supersede: true });
  assert.deepEqual([t2.status, store.readRuns(env).get(t1.run.run_id).outcome, store.readRuns(env).get(t1.run.run_id).reason], ['begun', 'crashed', 'superseded by a new claim']);
});

test('reconcileCrashed: only the time threshold counts, a live pid does not save a run, a supervised run is left to its supervisor, and it is idempotent', () => {
  const env = envOf();
  const p = store.ledgerPaths(env);
  fs.mkdirSync(p.dir, { recursive: true });
  const begin = (run_id, extra = {}) => store.appendLine(p.runs, { event: 'begin', run_id, kind: 'routine', id: run_id, project: 'p', agent: 'a@h', source: 'agent', started: T0, outcome: 'started', attempt: 1, deadline: shift(60), ...extra });
  begin('r-plain');
  begin('r-live-pid', { pid: process.pid }); // this process is alive; nobody asks
  begin('r-supervised', { source: 'supervisor' });
  begin('r-not-yet', { deadline: shift(300) });
  store.noteRun(env, 'r-plain', 'step 3 of 5', ms(shift(10)));
  assert.deepEqual(store.reconcileCrashed(env, ms(shift(59))), [], 'before the deadline: nothing');
  const marked = store.reconcileCrashed(env, ms(shift(61))).map((r) => r.run_id).sort();
  assert.deepEqual(marked, ['r-live-pid', 'r-plain']);
  assert.deepEqual(store.reconcileCrashed(env, ms(shift(90))), [], 'idempotent: already marked');
  const runs = store.readRuns(env);
  assert.deepEqual(['r-plain', 'r-live-pid', 'r-supervised', 'r-not-yet'].map((id) => runs.get(id).outcome), ['crashed', 'crashed', 'started', 'started']);
  assert.equal(runs.get('r-plain').note, 'step 3 of 5', 'the last checkpoint stays in the crashed record');
  assert.equal(runs.get('r-plain').duration_s, 61 * 60);
  assert.equal(lines(p.runs).filter((l) => l.includes('"crash"')).length, 2, 'one crash line per run');
});

test('recordTick: ten identical decisions are one line with a counter in ticks.state.json; a different one is a new line; the line format is the old one', () => {
  const env = envOf();
  const p = store.ledgerPaths(env);
  const entry = (time, over = {}) => ({ time, agent: 'a@h', decision: 'blocked-reserve', counts: { take: 0, accept: 0, start: 0, stale: 0, run: 1 }, limits: { provider: 'claude', state: 'reserve' }, ...over });
  for (let i = 0; i < 10; i++) assert.equal(store.recordTick(env, entry(shift(i))), true);
  assert.equal(lines(p.ticks).length, 1);
  assert.deepEqual(JSON.parse(lines(p.ticks)[0]), entry(T0), 'exactly the line the old ledger wrote');
  const st = JSON.parse(fs.readFileSync(p.state, 'utf8'));
  const cur = Object.values(st.ticks)[0];
  assert.deepEqual([cur.decision, cur.count, cur.first, cur.last], ['blocked-reserve', 10, T0, shift(9)]);
  assert.equal(store.recordTick(env, entry(shift(10), { decision: 'work', limits: { provider: 'claude', state: 'allowed' } })), true);
  assert.equal(store.recordTick(env, entry(shift(11), { agent: 'b@h' })), true, 'another agent has its own streak');
  assert.equal(lines(p.ticks).length, 3);
  assert.equal(store.recordTick(env, entry(shift(12), { agent: 'b@h' })), true);
  assert.equal(lines(p.ticks).length, 3, 'the streak of b@h goes on');
  assert.equal(store.recordTick(env, entry(shift(13), { filter: { routine: 'x' } })), true, 'a filter is its own streak');
  assert.equal(lines(p.ticks).length, 4);
  // idle and work are never folded: one line per tick as before, the state counts the streak
  for (let i = 0; i < 3; i++) store.recordTick(env, entry(shift(30 + i), { agent: 'c@h', decision: 'idle' }));
  assert.equal(lines(p.ticks).filter((l) => l.includes('c@h')).length, 3);
  assert.equal(JSON.parse(fs.readFileSync(p.state, 'utf8')).ticks['c@h|'].count, 3);
  // a broken state file is only a lost counter: the next line is written
  fs.writeFileSync(p.state, '{broken');
  assert.equal(store.recordTick(env, entry(shift(20))), true);
  assert.equal(lines(p.ticks).length, 8);
  // a ticks.jsonl that was removed is not mistaken for "same as the last line"
  fs.rmSync(p.ticks);
  assert.equal(store.recordTick(env, entry(shift(21))), true);
  assert.equal(lines(p.ticks).length, 1);
});

test('rotation: one previous generation, replaced by the next rotation; only when asked (inside tick)', () => {
  const env = envOf();
  const p = store.ledgerPaths(env);
  fs.mkdirSync(p.dir, { recursive: true });
  const filler = `${JSON.stringify({ time: T0, agent: 'old', decision: 'idle' })}\n`.repeat(40);
  fs.writeFileSync(p.ticks, filler);
  const entry = (time, over = {}) => ({ time, agent: 'a@h', decision: 'idle', counts: { take: 0, accept: 0, start: 0, stale: 0 }, limits: { provider: 'claude', state: 'not-checked' }, ...over });
  assert.equal(store.recordTick(env, entry(shift(1)), { rotate: false, maxBytes: 100 }), true);
  assert.equal(fs.existsSync(p.ticksPrev), false, 'no rotation unless asked');
  assert.equal(store.recordTick(env, entry(shift(2), { decision: 'work' }), { rotate: true, maxBytes: 100 }), true);
  assert.equal(fs.existsSync(p.ticksPrev), true);
  assert.equal(lines(p.ticksPrev).length, 41, 'the whole old file moved');
  assert.deepEqual(lines(p.ticks).map((l) => JSON.parse(l).decision), ['work'], 'a fresh file with the new line');
  // second rotation: still one previous generation
  fs.appendFileSync(p.ticks, filler);
  store.recordTick(env, entry(shift(3), { decision: 'idle' }), { rotate: true, maxBytes: 100 });
  assert.deepEqual(fs.readdirSync(p.dir).filter((f) => f.startsWith('ticks.jsonl')).sort(), ['ticks.jsonl', 'ticks.jsonl.1']);
  assert.equal(lines(p.ticksPrev).length, 41, 'the previous generation is the one just rotated');
});

test('skipped runs are folded: a streak is one record with a counter, a new reason or the end of the streak closes it', () => {
  const env = envOf();
  const s = (reason, minutes) => store.recordSkip(env, { kind: 'routine', project: 'p', id: 'x', agent: 'a@h', reason, now: ms(shift(minutes)), version: '0.3.0' });
  for (let i = 0; i < 5; i++) assert.equal(s('busy', i), true);
  let runs = [...store.readRuns(env).values()];
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].outcome, runs[0].reason, runs[0].count, runs[0].finished, runs[0].started], ['skipped', 'busy', 5, shift(4), T0], 'the live counter comes from the state file');
  assert.equal(s('limits', 6), true);
  assert.equal(store.clearSkips(env, (k, st) => st.reason === 'limits'), true);
  runs = [...store.readRuns(env).values()].sort((a, b) => (a.reason < b.reason ? -1 : 1));
  assert.deepEqual(runs.map((r) => [r.reason, r.count]), [['busy', 5], ['limits', 1]]);
  assert.equal(lines(store.ledgerPaths(env).runs).filter((l) => l.includes('"skips"')).length, 1, 'the closed streak of 5 left its counter in the file');
  assert.equal(store.clearSkips(env, () => true), true);
  assert.deepEqual(store.readState(env).skips, {});
});

test('the ledger lock: a lock of a dead process is taken over after it grew stale, a held one makes the caller give up instead of failing', () => {
  const env = envOf();
  const p = store.ledgerPaths(env);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.lock, '1');
  const r1 = store.withLedgerLock(env, () => 'never', { timeoutMs: 60, staleMs: 60000 });
  assert.equal(r1.locked, false, 'held by someone: gave up');
  const old = new Date(wallClock() - 120000); // real time: the age of a lock is about real processes
  fs.utimesSync(p.lock, old, old);
  const r2 = store.withLedgerLock(env, () => 'ran', { timeoutMs: 500, staleMs: 60000 });
  assert.deepEqual([r2.locked, r2.value], [true, 'ran']);
  assert.equal(fs.existsSync(p.lock), false, 'released');
  assert.throws(() => store.withLedgerLock(env, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(p.lock), false, 'released after an error too');
});

test('usable: a state directory inside a git work tree is refused (the ledger holds summaries), one that cannot be created is refused, a normal one is fine', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true });
  assert.equal(store.usable({ HOME: dir, XDG_STATE_HOME: path.join(dir, 'repo', 'state') }).ok, false);
  assert.match(store.usable({ HOME: dir, XDG_STATE_HOME: path.join(dir, 'repo', 'state') }).reason, /git work tree/);
  assert.equal(fs.existsSync(path.join(dir, 'repo', 'state')), false, 'nothing was created there');
  fs.writeFileSync(path.join(dir, 'file'), 'x');
  assert.equal(store.usable({ HOME: dir, XDG_STATE_HOME: path.join(dir, 'file', 'state') }).ok, false);
  assert.equal(store.usable({ HOME: dir, XDG_STATE_HOME: path.join(dir, 'state') }).ok, true);
  // the whole home directory being a repository is not counted: nothing could avoid that
  fs.mkdirSync(path.join(dir, '.git'));
  assert.equal(store.usable({ HOME: dir, XDG_STATE_HOME: path.join(dir, 'state2') }).ok, true);
  // the default path (no XDG_STATE_HOME) is under the home directory
  assert.equal(store.ledgerPaths({ HOME: dir }).runs, path.join(os.homedir(), '.local', 'state', 'road-map-journal', 'runs.jsonl'));
});
