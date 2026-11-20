// P5.41 a6: roadctl lock -- COMMAND (module lock.mjs). Run: node --test scripts/roadctl/lock.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { wallClock } from '../testkit/time.mjs';
import { lockFile, spanSeconds, WAIT_EXIT } from './lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const hasFlock = spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-lock-'));
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), ROADCTL_BUILD_LOCK: path.join(dir, 'build.lock') };
  delete env.ROADCTL_LOCK_NO_FLOCK;
  const log = path.join(dir, 'order.log');
  const run = (args, over = {}) => spawnSync(process.execPath, [SELF, 'lock', ...args], { cwd: dir, encoding: 'utf8', env: { ...env, ...over } });
  const start = (args, over = {}) => {
    const child = spawn(process.execPath, [SELF, 'lock', ...args], { cwd: dir, env: { ...env, ...over }, stdio: 'ignore' });
    return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  };
  /** A command that writes START/END with its name around a pause, so an overlap shows in the log. */
  const job = (name, ms = 600) => ['--', process.execPath, '-e', `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${name}-start\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},'${name}-end\\n');},${ms});`];
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { dir, env, run, start, job, lines, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const serialized = (lines) => lines.length === 4 && lines[0].endsWith('-start') && lines[1] === lines[0].replace('start', 'end') && lines[2].endsWith('-start') && lines[3] === lines[2].replace('start', 'end');

test('P5.41 a6: spans and the lock file choice (flag, environment, board config, state directory)', () => {
  assert.equal(spanSeconds('90s'), 90);
  assert.equal(spanSeconds('30m'), 1800);
  assert.equal(spanSeconds('2h'), 7200);
  assert.equal(spanSeconds('45'), 45);
  for (const bad of ['', 'x', '-5m', '1.5h', undefined]) assert.equal(spanSeconds(bad), null, String(bad));
  const env = { XDG_STATE_HOME: '/s' };
  assert.equal(lockFile({ env }), path.join('/s', 'road-map-journal', 'build.lock'), 'default: the state directory');
  assert.equal(lockFile({ env, config: { build_lock: '/c/b.lock' } }), '/c/b.lock', 'the board config');
  assert.equal(lockFile({ env: { ...env, ROADCTL_BUILD_LOCK: '/e/b.lock' }, config: { build_lock: '/c/b.lock' } }), '/e/b.lock', 'the environment beats the config');
  assert.equal(lockFile({ env: { ...env, ROADCTL_BUILD_LOCK: '/e/b.lock' }, flags: { file: '/f/b.lock' } }), '/f/b.lock', 'the flag beats everything');
  assert.throws(() => lockFile({ env, flags: { file: 'relative.lock' } }), /absolute path/);
});

for (const mode of hasFlock ? ['flock', 'file'] : ['file']) {
  test(`P5.41 a6 (${mode}): two processes under the lock never overlap, and the code of the command comes back`, async () => {
    const r = rig();
    try {
      const over = mode === 'file' ? { ROADCTL_LOCK_NO_FLOCK: '1' } : {};
      const a = r.start(r.job('A'), over);
      await new Promise((resolve) => setTimeout(resolve, 150)); // A holds the lock before B asks
      const b = r.start(r.job('B'), over);
      assert.deepEqual(await Promise.all([a, b]), [0, 0]);
      assert.ok(serialized(r.lines()), `no overlap: ${r.lines().join(' ')}`);
      assert.equal(r.lines()[0], 'A-start', 'the first caller goes first');
      assert.equal(r.run(['--', 'sh', '-c', 'exit 7'], over).status, 7, 'the code of the command');
      assert.equal(r.run(['--', 'sh', '-c', 'echo out; echo err >&2; exit 0'], over).stdout, 'out\n', 'the output passes through');
      assert.equal(r.run(['--', 'no-such-command-xyz'], over).status !== 0, true, 'a command that cannot start fails');
    } finally { r.cleanup(); }
  });

  test(`P5.41 a6 (${mode}): a caller that cannot get the lock in --wait does not start the command, exit ${WAIT_EXIT}`, async () => {
    const r = rig();
    try {
      const over = mode === 'file' ? { ROADCTL_LOCK_NO_FLOCK: '1' } : {};
      const a = r.start(r.job('A', 2500), over);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const b = r.run(['--wait', '1s', ...r.job('B')], over);
      assert.equal(b.status, WAIT_EXIT, b.stderr);
      assert.match(b.stderr, /was not free within 1s; the command did not start/);
      assert.equal(await a, 0);
      assert.deepEqual(r.lines(), ['A-start', 'A-end'], 'B never started');
    } finally { r.cleanup(); }
  });
}

test('P5.41 a6: usage errors, the board config names the lock file, and the lock is free again after the command', () => {
  const r = rig();
  try {
    assert.equal(r.run([]).status, 2);
    assert.match(r.run([]).stderr, /usage: roadctl lock/);
    assert.equal(r.run(['--wait', 'soon', '--', 'true']).status, 2);
    assert.equal(r.run(['--file', 'rel.lock', '--', 'true']).status, 2);
    // the key build_lock of config.json (no environment variable): the lock file is created where the config says
    const board = path.join(r.dir, 'board');
    fs.mkdirSync(board);
    const named = path.join(r.dir, 'named', 'b.lock');
    fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ board_version: 1, title: 't', status_map: {}, build_lock: named }));
    const env = { ...r.env }; delete env.ROADCTL_BUILD_LOCK;
    assert.equal(spawnSync(process.execPath, [SELF, 'lock', '--board', board, '--', 'true'], { cwd: r.dir, env, encoding: 'utf8' }).status, 0);
    assert.equal(fs.existsSync(named), hasFlock, 'with flock the named file exists (the fallback keeps its own .roadctl file)');
    // free again: a second call right after does not wait
    const t0 = wallClock();
    assert.equal(r.run(['--wait', '1s', '--', 'true']).status, 0);
    assert.ok(wallClock() - t0 < 5000);
  } finally { r.cleanup(); }
});
