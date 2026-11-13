// Tests of the test kit itself (scripts/testkit/): the fake executors, the time helper and the rule that tests take time only from it.
// Run: node --test scripts/roadctl/testkit.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { FAKE_NAMES, FAKES_SKIP, installFakes, isProbe, readCalls } from '../testkit/fakes.mjs';
import { clock, ms, shift, T0, waitFor } from '../testkit/time.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-testkit-'));
  const bin = installFakes(path.join(dir, 'bin'));
  const log = path.join(dir, 'calls.jsonl');
  const run = (name, args = [], { env = {}, input = '' } = {}) => spawnSync(path.join(bin, name), args, { input, encoding: 'utf8', cwd: dir, env: { PATH: process.env.PATH, FAKE_LOG: log, ...env }, timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
  return { dir, bin, log, run, calls: (name) => readCalls(log, name) };
}

test('fakes record argv, selected environment, working directory and stdin for claude, codex, ssh, hermes and wsl.exe', FAKES_SKIP, () => {
  const r = rig();
  assert.deepEqual(FAKE_NAMES, ['claude', 'codex', 'ssh', 'hermes', 'wsl.exe']);
  for (const name of FAKE_NAMES) {
    const out = r.run(name, ['--flag', 'two words', 'quote"d'], { env: { FAKE_ENV_KEYS: 'MY_KEY', MY_KEY: 'v1', OTHER_KEY: 'hidden', ROADCTL_NOW: T0 }, input: `stdin of ${name}\nline 2` });
    assert.equal(out.status, 0, `${name}: ${out.stderr}`);
  }
  const calls = r.calls();
  assert.deepEqual(calls.map((c) => c.name), FAKE_NAMES);
  for (const c of calls) {
    assert.deepEqual(c.argv, ['--flag', 'two words', 'quote"d'], 'argv is kept exactly');
    assert.equal(c.stdin, `stdin of ${c.name}\nline 2`);
    assert.equal(c.env.MY_KEY, 'v1', 'a key named in FAKE_ENV_KEYS is recorded');
    assert.equal(c.env.ROADCTL_NOW, T0, 'ROADCTL_* is recorded');
    assert.equal(c.env.OTHER_KEY, undefined, 'other variables are not');
    assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(r.dir));
    assert.equal(c.mode, 'ok');
  }
  assert.equal(r.run('claude', ['-p', 'hi']).stdout, 'ok\n', 'claude says ok');
  assert.equal(r.run('hermes', ['cron', 'run'], { env: { FAKE_STDOUT: 'queued\n' } }).stdout, 'queued\n');
  assert.equal(r.run('ssh', ['host', 'true'], { env: { FAKE_STDIN: 'skip' } }).status, 0);
  assert.equal(r.calls('ssh').at(-1).stdin, null, 'FAKE_STDIN=skip reads nothing');
});

test('fake modes: ok, silent, crash (exit code and signal), huge and run; the mode of one fake overrides FAKE_MODE', FAKES_SKIP, () => {
  const r = rig();
  const silent = r.run('claude', ['-p', 'x'], { env: { FAKE_MODE: 'silent' } });
  assert.deepEqual([silent.status, silent.stdout, silent.stderr], [0, '', '']);
  const crash = r.run('codex', ['exec', 'x'], { env: { FAKE_MODE: 'crash' } });
  assert.deepEqual([crash.status, crash.stderr], [70, 'fake codex: crashed\n']);
  assert.equal(r.run('codex', ['exec'], { env: { FAKE_MODE: 'crash', FAKE_EXIT: '3' } }).status, 3);
  const killed = r.run('claude', ['-p'], { env: { FAKE_MODE: 'crash', FAKE_SIGNAL: 'SIGKILL' } });
  assert.deepEqual([killed.status, killed.signal], [null, 'SIGKILL']);
  const huge = r.run('hermes', [], { env: { FAKE_MODE: 'huge', FAKE_HUGE_BYTES: String(3 * 1024 * 1024) } });
  assert.equal(huge.status, 0);
  assert.ok(huge.stdout.length >= 3 * 1024 * 1024 && huge.stdout.length < 3 * 1024 * 1024 + 1024, `${huge.stdout.length} bytes`);
  assert.equal(r.run('claude', ['-p'], { env: { FAKE_MODE: 'crash', FAKE_CLAUDE_MODE: 'ok' } }).status, 0, 'FAKE_CLAUDE_MODE wins over FAKE_MODE');
  // run: the transport executes the remote command locally
  const ssh = r.run('ssh', ['somehost', 'echo', 'remote-$((1+1))'], { env: { FAKE_SSH_MODE: 'run' } });
  assert.deepEqual([ssh.status, ssh.stdout], [0, 'remote-2\n']);
  const wsl = r.run('wsl.exe', ['-e', 'bash', '-lc', 'echo via-wsl; exit 4'], { env: { FAKE_WSL_EXE_MODE: 'run' } });
  assert.deepEqual([wsl.status, wsl.stdout], [4, 'via-wsl\n']);
  // FAKE_AFTER stands for what the agent did; its exit status is the fake's
  const after = r.run('claude', ['-p', 'x'], { env: { FAKE_AFTER: 'echo did-it; exit 9' } });
  assert.deepEqual([after.status, after.stdout], [9, 'ok\ndid-it\n']);
});

test('fake hang: logs first, then never answers until killed or FAKE_HANG_MS passes', FAKES_SKIP, async () => {
  const r = rig();
  const child = spawn(path.join(r.bin, 'claude'), ['-p', 'x'], { cwd: r.dir, env: { PATH: process.env.PATH, FAKE_LOG: r.log, FAKE_MODE: 'hang' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.ok(waitFor(() => r.calls('claude').length === 1), 'the call is logged before it hangs'); // real time: a child process
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, 'still running');
  child.kill('SIGTERM');
  const end = await closed;
  assert.notEqual(end.code, 0);
  const brief = r.run('claude', ['-p'], { env: { FAKE_MODE: 'hang', FAKE_HANG_MS: '200' } });
  assert.equal(brief.status, 0, 'FAKE_HANG_MS ends the hang');
});

test('fake probes: claude stream-json and codex app-server answer the limits probe of roadctl and are told apart from a start of work', FAKES_SKIP, () => {
  const r = rig();
  const probe = r.run('claude', ['-p', 'Reply with: ok', '--output-format', 'stream-json', '--verbose'], { env: { FAKE_U5: '0.42' } });
  assert.match(probe.stdout, /"type":"rate_limit_event"/);
  assert.equal(JSON.parse(probe.stdout.split('\n')[1]).rate_limit_info.unifiedWindows.five_hour.utilization, 0.42);
  const rpc = ['{"jsonrpc":"2.0","id":1,"method":"initialize"}', '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read"}'].join('\n');
  const codex = r.run('codex', ['app-server'], { input: `${rpc}\n`, env: { FAKE_5H: '33' } });
  assert.equal(JSON.parse(codex.stdout.trim().split('\n')[1]).result.rateLimits.primary.usedPercent, 33);
  r.run('claude', ['-p', 'do the routine']);
  assert.deepEqual(r.calls().filter((c) => !c.event).map(isProbe), [true, true, false]);
  assert.equal(r.calls('codex').filter((c) => c.event === 'rpc').length, 2, 'the JSON-RPC lines are recorded one by one');
});

test('time helper: roadctl sees only the clock it is given; shift and ms are plain arithmetic on ISO strings', () => {
  assert.deepEqual(clock(), { ROADCTL_NOW: T0 });
  assert.deepEqual(clock('2026-11-11T00:00:00Z'), { ROADCTL_NOW: '2026-11-11T00:00:00Z' });
  assert.equal(shift(90), '2026-11-10T11:30:00Z');
  assert.equal(shift(-10, '2026-11-11T00:05:00Z'), '2026-11-10T23:55:00Z');
  assert.equal(ms(T0), Date.parse(T0));
  const old = process.env.ROADCTL_NOW;
  process.env.ROADCTL_NOW = clock('2031-01-02T03:04:05Z').ROADCTL_NOW;
  try {
    assert.equal(rc.nowMs(), ms('2031-01-02T03:04:05Z'), 'roadctl takes its "now" from ROADCTL_NOW');
    assert.equal(rc.isoAt(), '2031-01-02T03:04:05Z');
  } finally {
    if (old === undefined) delete process.env.ROADCTL_NOW;
    else process.env.ROADCTL_NOW = old;
  }
});

// ---------------------------------------------------------------- criterion a6: tests take time only from the common helper

test('no test file reads the clock of the machine (the ambient clock calls live only in scripts/testkit/time.mjs)', () => {
  const tests = [path.join(scripts, 'roadctl.test.mjs'), path.join(scripts, 'update-installed.test.mjs'), ...fs.readdirSync(here).filter((n) => n.endsWith('.test.mjs')).map((n) => path.join(here, n))];
  const ambient = /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bperformance\.now\s*\(|\bprocess\.hrtime\b/;
  const offenders = [];
  for (const file of tests) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
      if (ambient.test(line)) offenders.push(`${path.relative(scripts, file)}:${n + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'take the time from scripts/testkit/time.mjs (clock/shift/ms for roadctl, wallClock/waitFor for real processes)');
  // the rule can fail: a line that reads the clock is recognised
  const D = 'Date';
  assert.ok(ambient.test(`const t = ${D}.now();`) && ambient.test(`x = new ${D}()`) && !ambient.test(`new ${D}(ms(T0))`), 'the pattern recognises a clock read and lets a date built from a given value through');
});
