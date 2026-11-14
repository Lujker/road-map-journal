// Tests of the state directory and the shared lock helper (state.mjs, P5.28 a6 and a7), and of the lone-copy fallback in roadctl.mjs.
// Run: node --test scripts/roadctl/state.test.mjs
// Real time is used on purpose (a lock is about real processes): `wallClock` and `sleepSync` of the test kit make that visible.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as rc from '../roadctl.mjs';
import { sleepSync, wallClock } from '../testkit/time.mjs';
import { digestStateFile } from './digest.mjs';
import { ledgerPaths, stateDir as storeStateDir, withLedgerLock } from './run-store.mjs';
import { LOCK_STALE_MS, acquireLock, lockAgeMs, stateDir, xdgDir } from './state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const STATE_URL = pathToFileURL(path.join(here, 'state.mjs')).href;
const TIME_URL = pathToFileURL(path.join(here, '..', 'testkit', 'time.mjs')).href;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const age = (file, ms) => {
  const t = new Date(wallClock() - ms);
  fs.utimesSync(file, t, t);
};

test('P5.28 a7: one state directory: the core, the ledger store, the digest and the helper give the same path for the same environment', () => {
  const sd = tmp('rcs-state-');
  for (const env of [{ XDG_STATE_HOME: sd }, { XDG_STATE_HOME: `  ${sd}  ` }, { XDG_STATE_HOME: '' }, {}]) {
    const dir = stateDir(env);
    assert.equal(storeStateDir(env), dir);
    assert.equal(ledgerPaths(env).dir, dir);
    assert.equal(path.dirname(rc.tickLedgerPath(env)), dir);
    assert.equal(path.dirname(rc.tickLockPath('claude-code@host', env)), dir);
    assert.equal(path.dirname(digestStateFile(env)), dir);
    assert.equal(path.basename(dir), 'road-map-journal');
  }
  assert.equal(stateDir({ XDG_STATE_HOME: sd }), path.join(sd, 'road-map-journal'));
  assert.equal(stateDir({}), path.join(os.homedir(), '.local', 'state', 'road-map-journal'), 'the default is the XDG one');
  assert.equal(xdgDir({ XDG_CACHE_HOME: '/x' }, 'XDG_CACHE_HOME', ['.cache']), '/x');
  assert.equal(path.dirname(path.dirname(rc.limitsCachePath({ XDG_CACHE_HOME: sd }))), sd, 'the core still uses the same XDG rule for its cache');
});

test('P5.28 a6: acquireLock: exclusive, released by its owner only, kept lifetimes, a legacy lock file of any content counts as held', () => {
  assert.deepEqual(LOCK_STALE_MS, { tick: 600000, ledger: 30000, digest: 60000 }, 'the lifetimes of the three old locks');
  const dir = tmp('rcs-lock-');
  const f = path.join(dir, 'x.lock');
  const a = acquireLock(f, { staleMs: 60000 });
  assert.equal(a.ok, true);
  assert.equal(acquireLock(f, { staleMs: 60000 }).ok, false, 'held');
  assert.ok(lockAgeMs(f) < 5000);
  a.release();
  assert.equal(fs.existsSync(f), false);
  // someone else's file is not removed by a release of a stale handle
  const b = acquireLock(f, { staleMs: 60000 });
  fs.writeFileSync(f, JSON.stringify({ token: 'other' }));
  b.release();
  assert.equal(fs.existsSync(f), true, 'not ours any more: left alone');
  for (const text of ['{}', '1', '']) {
    fs.writeFileSync(f, text);
    assert.equal(acquireLock(f, { staleMs: 60000 }).ok, false, `content ${JSON.stringify(text)} is held`);
  }
  age(f, 61000);
  const c = acquireLock(f, { staleMs: 60000 });
  assert.equal(c.ok, true, 'stale: taken over');
  assert.equal(fs.existsSync(`${f}.takeover`), false, 'the takeover guard is gone');
  c.release();
  // waiting: a short wait gives up, a lock released meanwhile is taken
  const d = acquireLock(f, { staleMs: 60000 });
  const t0 = wallClock();
  assert.deepEqual(acquireLock(f, { staleMs: 60000, waitMs: 80 }), { ok: false, reason: 'held' });
  assert.ok(wallClock() - t0 >= 70);
  d.release();
  // heartbeat keeps a long-lived lock from going stale
  const e = acquireLock(f, { staleMs: 1000 });
  age(f, 5000);
  assert.equal(e.heartbeat(), true);
  assert.ok(lockAgeMs(f) < 1000);
  assert.equal(acquireLock(f, { staleMs: 1000 }).ok, false, 'a beating lock is not taken over');
  e.release();
  // an unusable directory: lenient mode goes on without a lock, strict mode reports it
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, '');
  const bad = path.join(blocker, 'x.lock');
  assert.deepEqual([acquireLock(bad, { staleMs: 1000 }).ok, acquireLock(bad, { staleMs: 1000 }).held], [true, false]);
  assert.equal(acquireLock(bad, { staleMs: 1000, strict: true }).ok, false);
  assert.throws(() => acquireLock(f, {}), /staleMs/);
});

test('P5.28 a6: the ledger lock still waits, gives up and takes over a stale lock of a dead process through the shared helper', () => {
  const env = { XDG_STATE_HOME: tmp('rcs-ledger-') };
  const { lock } = ledgerPaths(env);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '1');
  assert.equal(withLedgerLock(env, () => 'never', { timeoutMs: 40 }).locked, false);
  age(lock, 31000); // the real lifetime: 30 seconds
  const r = withLedgerLock(env, () => 'ran', { timeoutMs: 200 });
  assert.deepEqual([r.locked, r.value, fs.existsSync(lock)], [true, 'ran', false]);
});

const CHILD = `import fs from 'node:fs';
const { acquireLock } = await import(process.env.STATE_URL);
const { wallClock } = await import(process.env.TIME_URL);
const [file, startAt, out] = process.argv.slice(2);
while (wallClock() < Number(startAt)) { /* all processes leave the gate together */ }
const l = acquireLock(file, { staleMs: 1000 });
fs.writeFileSync(out, l.ok ? 'won' : 'lost');
if (l.ok) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); l.release(); }
`;

test('P5.28 a6: race: several processes take over the same stale lock at once and exactly one wins (a removed fresh lock would let two win)', async () => {
  const dir = tmp('rcs-race-');
  const script = path.join(dir, 'child.mjs');
  fs.writeFileSync(script, CHILD);
  for (let round = 0; round < 4; round++) {
    const lock = path.join(dir, `r${round}.lock`);
    fs.writeFileSync(lock, '{}');
    age(lock, 60000);
    const startAt = wallClock() + 400;
    const procs = [0, 1, 2].map((n) => {
      const out = path.join(dir, `r${round}.${n}.out`);
      return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [script, lock, String(startAt), out], { env: { ...process.env, STATE_URL, TIME_URL }, stdio: 'ignore' });
        c.on('error', reject);
        c.on('close', () => resolve(fs.readFileSync(out, 'utf8')));
      });
    });
    const results = await Promise.all(procs);
    assert.equal(results.filter((x) => x === 'won').length, 1, `round ${round}: ${results.join(',')}`);
    assert.equal(fs.existsSync(lock), false, 'released by the winner');
    assert.equal(fs.existsSync(`${lock}.takeover`), false);
  }
});

// ---------------------------------------------------------------- the lone-copy fallback of roadctl.mjs

const lone = () => {
  const dir = tmp('rcs-lone-');
  fs.copyFileSync(SELF, path.join(dir, 'roadctl.mjs'));
  return path.join(dir, 'roadctl.mjs');
};

test('P5.28: a lone roadctl.mjs (no roadctl/ folder) still holds the tick lock: a second concurrent tick is busy (exit 5), a stale lock is taken over, and the paths are those of the full copy', () => {
  const bin = lone();
  const sd = tmp('rcs-lone-state-');
  const env = { ...process.env, XDG_STATE_HOME: sd, ROADCTL_DATE: '2026-11-10', ROADCTL_REGISTRY: path.join(sd, 'none.json') };
  const board = tmp('rcs-lone-proj-');
  fs.mkdirSync(path.join(board, 'board', 'cards'), { recursive: true });
  fs.writeFileSync(path.join(board, 'board', 'config.json'), '{"board_version":1}\n');
  const tick = (b) => spawnSync(process.execPath, [b, 'tick', '--as', 'worker', '--no-pull'], { cwd: board, encoding: 'utf8', env });
  const lock = rc.tickLockPath('worker', env);
  const first = tick(bin);
  assert.deepEqual([first.status, first.stdout], [4, 'tick worker: idle\n']);
  assert.equal(fs.existsSync(lock), false, 'released');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, token: 'x' })); // another tick is running
  const busy = tick(bin);
  assert.deepEqual([busy.status, busy.stdout], [5, 'tick worker: busy\n']);
  assert.equal(fs.existsSync(lock), true, 'the running tick keeps its lock');
  age(lock, 11 * 60 * 1000); // stale after 10 minutes
  assert.equal(tick(bin).status, 4);
  assert.equal(fs.existsSync(lock), false);
  // the same environment gives the full copy the same lock file, so the two copies exclude each other
  fs.writeFileSync(lock, '{}');
  assert.equal(tick(SELF).status, 5);
  assert.equal(path.dirname(lock), stateDir(env));
  sleepSync(1);
});

test('P5.2 B: a lock appears with its whole content (linked into place) and leaves no temporary file; a held lock is not replaced; a stale one is taken over complete', () => {
  const dir = tmp('rcs-atomic-');
  try {
    const file = path.join(dir, 'a.lock');
    const body = JSON.stringify({ pid: process.pid, token: 'x'.repeat(200) });
    const a = acquireLock(file, { staleMs: 60000, content: body });
    assert.equal(a.held, true);
    assert.equal(fs.readFileSync(file, 'utf8'), body, 'complete content at once');
    assert.deepEqual(fs.readdirSync(dir), ['a.lock'], 'no temporary file is left');
    const b = acquireLock(file, { staleMs: 60000, content: 'other', strict: true });
    assert.deepEqual([b.ok, b.reason], [false, 'held']);
    assert.equal(fs.readFileSync(file, 'utf8'), body, 'the held lock is untouched');
    assert.deepEqual(fs.readdirSync(dir), ['a.lock'], 'a refused create leaves no temporary file either');
    age(file, 120000);
    const c = acquireLock(file, { staleMs: 60000, content: 'third' });
    assert.equal(c.held, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'third');
    assert.deepEqual(fs.readdirSync(dir), ['a.lock']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P5.2 r3-4/r4-1: when the link cannot be made (not EEXIST) a strict caller gets no lock and no file; a non-strict caller (tick) still gets a real lock by the exclusive create', () => {
  const dir = tmp('rcs-nolink-');
  try {
    const file = path.join(dir, 'b.lock');
    const noLink = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
    const strict = acquireLock(file, { staleMs: 60000, content: 'x', strict: true, link: noLink });
    assert.deepEqual([strict.ok, strict.reason], [false, 'EPERM']);
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing was created, not even a temporary file');
    const first = acquireLock(file, { staleMs: 60000, content: 'x', link: noLink });
    assert.equal(first.held, true, 'the non-strict form holds a real lock');
    assert.equal(fs.readFileSync(file, 'utf8'), 'x');
    const second = acquireLock(file, { staleMs: 60000, content: 'y', link: noLink });
    assert.deepEqual([second.ok, second.reason], [false, 'held'], 'and a second non-strict taker is told it is held');
    assert.deepEqual(fs.readdirSync(dir), ['b.lock'], 'no temporary file is left');
    first.release();
    // under the takeover of a stale lock the strict form is not replaced by a non-atomic create either
    fs.writeFileSync(file, 'old');
    age(file, 120000);
    const stale = acquireLock(file, { staleMs: 60000, content: 'new', strict: true, link: noLink });
    assert.deepEqual([stale.ok, stale.reason], [false, 'EPERM']);
    assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp') || n.endsWith('.takeover')), 'no temporary file or guard is left');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
