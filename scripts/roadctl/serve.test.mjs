import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireServeLock, routeSnapshot, serveLockPath } from './serve.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROADCTL = path.join(scripts, 'roadctl.mjs');
const EXAMPLE = path.join(scripts, '..', 'examples', 'board-example', 'board');

test('P5.25 a1: every RUN is separate and up to three non-RUN decisions share one supervised prompt', async () => {
  const calls = [];
  const snapshot = { prompt: 'real tick prompt', board_dirs: { one: '/boards/one', two: '/boards/two' }, items: [
    { kind: 'RUN', project: 'one', id: 'r1' }, { kind: 'TAKE', project: 'one', id: 'c1' },
    { kind: 'RUN', project: 'two', id: 'r2' }, { kind: 'ACCEPT', project: 'one', id: 'c2' },
    { kind: 'START', project: 'one', id: 'c3' }, { kind: 'STALE', project: 'one', id: 'c4' },
  ] };
  const result = await routeSnapshot(snapshot, {
    profile: { agent: 'conductor@host' }, paused: () => false,
    describeRoutine: (item, board) => ({ kind: 'routine', item, board }),
    describeService: (_profile, stdin, board) => ({ kind: 'orchestrator', stdin, board }),
    supervise: (d, board) => calls.push({ d, board }),
  });
  assert.deepEqual(calls.map((c) => c.d.kind), ['routine', 'routine', 'orchestrator']);
  assert.deepEqual(calls.slice(0, 2).map((c) => c.d.item.id), ['r1', 'r2']);
  assert.equal(calls[2].d.stdin, 'real tick prompt');
  assert.deepEqual(result.started.map((x) => x[2]), ['r1', 'r2', 'c1', 'c2', 'c3']);
});

test('P5.25 a2: the machine lock excludes a second turn and pause stops later starts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-serve-'));
  const env = { XDG_STATE_HOME: dir, ROADCTL_HOST: 'test' };
  const first = acquireServeLock(env);
  assert.ok(first);
  assert.equal(acquireServeLock(env), null);
  first.release();
  const again = acquireServeLock(env); assert.ok(again); again.release();

  let checks = 0;
  const calls = [];
  const result = await routeSnapshot({ board_dirs: { p: '/board' }, items: [{ kind: 'RUN', project: 'p', id: 'one' }, { kind: 'RUN', project: 'p', id: 'two' }, { kind: 'TAKE', project: 'p', id: 'c' }] }, {
    profile: { agent: 'a' }, paused: () => ++checks === 2,
    describeRoutine: (item) => item, describeService: () => assert.fail('orchestrator must not start'), supervise: (d) => calls.push(d.id),
  });
  assert.deepEqual(calls, ['one']);
  assert.deepEqual(result, { started: [['RUN', 'p', 'one']], paused: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P5.25 a1/a2 CLI: an idle real tick is a successful serve turn and leaves no lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-serve-cli-'));
  const workspace = path.join(dir, 'workspace');
  const board = path.join(workspace, 'projects', 'idle', 'board');
  const config = path.join(dir, 'config', 'road-map-journal');
  fs.mkdirSync(path.dirname(board), { recursive: true });
  fs.cpSync(EXAMPLE, board, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'conductor.json'), JSON.stringify({
    version: 1,
    templates: { 'orchestrator@test': { argv: [process.execPath, '-e', 'process.exit(99)'] } },
    profiles: { service: { agent: 'orchestrator@test', model: 'fake', attempt: { timeout: '1m' } } },
    service: { workspace, profile: 'service' },
  }), { mode: 0o600 });
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), ROADCTL_WORKSPACE: workspace, ROADCTL_REGISTRY: path.join(dir, 'missing-registry.json'), ROADCTL_NOW: '2026-11-26T10:00:00Z' };
  const r = spawnSync(process.execPath, [ROADCTL, 'serve', '--once', '--json'], { cwd: workspace, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(r.stdout), { started: [], paused: false });
  assert.equal(fs.existsSync(serveLockPath(env)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
