import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installFakes, isProbe, readCalls } from '../testkit/fakes.mjs';
import { clock, shift, T0 } from '../testkit/time.mjs';
import * as serve from './serve.mjs?p525';

const { acquireServeLock, routeSnapshot, serveLockPath, servicePrompt } = serve;

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROADCTL = path.join(scripts, 'roadctl.mjs');
const EXAMPLE = path.join(scripts, '..', 'examples', 'board-example', 'board');

test('P5.25 a1: every RUN is separate and up to three non-RUN decisions share one supervised prompt', async () => {
  const calls = [];
  const snapshot = { prompt: 'real tick prompt', boardDirs: { one: '/boards/one', two: '/boards/two' }, items: [
    { kind: 'RUN', project: 'one', id: 'r1' }, { kind: 'TAKE', project: 'one', id: 'c1' },
    { kind: 'RUN', project: 'two', id: 'r2' }, { kind: 'ACCEPT', project: 'two', id: 'c2' },
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
  assert.match(servicePrompt(calls[2].d.stdin, 'conductor@host'), /roadctl run done --as conductor@host --result ok\|escalated\|failed/);
  assert.deepEqual(result.started.map((x) => x[2]), ['r1', 'r2', 'c1', 'c2', 'c3']);
});

test('P5.25 a2 CLI: a project symlink cannot escape the service clone before tick', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-serve-symlink-'));
  const workspace = path.join(dir, 'service');
  const outside = path.join(dir, 'owner-project');
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'board'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'board', 'config.json'), '{}');
  fs.symlinkSync(outside, path.join(workspace, 'projects', 'escaped'));
  const config = path.join(dir, 'config', 'road-map-journal');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'conductor.json'), JSON.stringify({ templates: { 'orchestrator@test': { argv: [process.execPath, '-e', ''] } }, profiles: { service: { agent: 'orchestrator@test', model: 'fake', attempt: { timeout: '1m' } } }, service: { workspace, profile: 'service' } }), { mode: 0o600 });
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_STATE_HOME: path.join(dir, 'state'), ROADCTL_WORKSPACE: workspace, ROADCTL_REGISTRY: path.join(dir, 'missing.json') };
  const r = spawnSync(process.execPath, [ROADCTL, 'serve', '--once'], { cwd: workspace, env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /project escaped escapes service\.workspace/);
  fs.rmSync(dir, { recursive: true, force: true });
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
  const result = await routeSnapshot({ boardDirs: { p: '/board' }, items: [{ kind: 'RUN', project: 'p', id: 'one' }, { kind: 'RUN', project: 'p', id: 'two' }, { kind: 'TAKE', project: 'p', id: 'c' }] }, {
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

test('P5.25 a3 CLI: cached reserve skips the provider past normal TTL and probes after its reset', { skip: process.platform === 'win32' && 'fake executables are shell scripts' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-serve-reserve-'));
  const workspace = path.join(dir, 'workspace');
  const board = path.join(workspace, 'projects', 'queued', 'board');
  const config = path.join(dir, 'config', 'road-map-journal');
  const cache = path.join(dir, 'cache', 'road-map-journal');
  const log = path.join(dir, 'calls.jsonl');
  const agent = 'codex@test';
  fs.mkdirSync(path.dirname(board), { recursive: true });
  fs.cpSync(EXAMPLE, board, { recursive: true });
  const boardConfig = path.join(board, 'config.json');
  fs.writeFileSync(boardConfig, JSON.stringify({ ...JSON.parse(fs.readFileSync(boardConfig, 'utf8')), requires: '0.6.0' }));
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'conductor.json'), JSON.stringify({
    version: 1,
    templates: { codex: { argv: [process.execPath, '-e', ''] } },
    profiles: { service: { agent, model: 'fake', attempt: { timeout: '1m' } } },
    service: { workspace, profile: 'service' },
  }), { mode: 0o600 });
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ version: 1, roles: {}, agents: { [agent]: { host: 'codex', roles: ['worker'] } } }));
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'limits.json'), JSON.stringify({ version: 1, providers: { codex: {
    provider: 'codex', kind: 'subscription', state: 'known', measured_at: T0, source: 'synthetic',
    windows: [{ name: 'five_hour', used_percent: 95, resets_at: shift(120) }, { name: 'seven_day', used_percent: 20, resets_at: shift(1440) }],
    reserve: { five_hour: 10, seven_day: 10 }, closed_until: shift(120),
  } } }));
  const bin = installFakes(path.join(dir, 'bin'));
  const env = { ...process.env, ...clock(shift(30)), HOME: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), ROADCTL_WORKSPACE: workspace, ROADCTL_REGISTRY: registry, FAKE_LOG: log, FAKE_5H: '20' };
  const setup = (args) => spawnSync(process.execPath, [ROADCTL, ...args, '--board', board], { cwd: workspace, env, encoding: 'utf8' });
  assert.equal(setup(['routine', 'new', 'due', 'Due', '--agent', agent, '--model', 'fake', '--env', 'test', '--every', '30m']).status, 0);
  assert.equal(setup(['routine', 'on', 'due', '--by', 'Owner', '--source', 'test']).status, 0);
  assert.equal(setup(['autonomy', 'routines', 'on', '--by', 'Owner']).status, 0);
  const run = (at) => spawnSync(process.execPath, [ROADCTL, 'serve', '--once', '--json'], { cwd: workspace, env: { ...env, ...clock(at) }, encoding: 'utf8' });
  try {
    const before = run(shift(30));
    assert.equal(before.status, 1, before.stderr + before.stdout);
    assert.equal(run(shift(90)).status, 1, 'closed_until outlives the normal ten-minute cache TTL');
    assert.equal(readCalls(log).filter(isProbe).length, 0, 'no provider call before reset');
    const after = run(shift(121));
    assert.equal(readCalls(log).filter(isProbe).length, 1, 'the first turn after reset rechecks the provider once');
    assert.equal(after.status, 1);
    assert.match(after.stderr, /supervise: .* failed: no result/, 'the allowed fresh reading reaches the supervisor');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P5.25 a5: TAKE checks the remote path before starting; local needs no ssh', async () => {
  const { environmentGate, accessOf } = await import('./environment.mjs');
  const reg = { agents: { 'a@home': { machine: 'home' } }, environments: { remote: { machine: 'work', placement: 'remote-access', access: [{ from: 'home', ssh: 'work-host' }] }, local: { machine: 'home', placement: 'remote-access' } } };
  const api = { loadRegistry: () => reg };
  const board = { cards: [{ header: { id: 'c', env: 'remote' } }] };
  const calls = [];
  const gate = (status) => environmentGate(api, {}, board, { kind: 'task', id: 'c' }, 'a@home', { spawn: (cmd, argv) => { calls.push([cmd, argv]); return { status }; } });
  const snapshot = { prompt: 'work', boardDirs: { p: '/board' }, items: [{ kind: 'TAKE', project: 'p', id: 'c' }] };
  let started = 0;
  const options = { profile: {}, paused: () => false, describeService: () => ({}), supervise: () => { started++; }, checkDecision: () => gate(1) };
  await assert.rejects(routeSnapshot(snapshot, options), /unreachable/);
  assert.equal(started, 0);
  options.checkDecision = () => gate(0);
  await routeSnapshot(snapshot, options);
  assert.equal(started, 1);
  assert.deepEqual(calls[0], ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', 'work-host', 'true']]);
  assert.equal(accessOf(reg, 'a@home', 'remote').ssh, 'work-host');
  board.cards[0].header.env = 'local';
  const before = calls.length;
  assert.equal(gate(0), null);
  assert.equal(calls.length, before);
});
