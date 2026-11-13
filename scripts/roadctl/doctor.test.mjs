// P5.9: `roadctl doctor`, `roadctl --version` and installed.json. Run: node --test scripts/roadctl/doctor.test.mjs
// Everything runs in a throwaway HOME with fake executables (scripts/testkit); the clock is ROADCTL_NOW from the shared test clock, git commits get
// fixed dates, and nothing reaches a network (the only "remote" is a local bare repository). A real machine's files are never read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncRoadctl } from '../update-installed.mjs';
import * as rc from '../roadctl.mjs';
import { doctorJsonProblems } from '../testkit/doctor-schema.mjs';
import { FAKES_SKIP, installFakes, readCalls } from '../testkit/fakes.mjs';
import { T0, clock, shift } from '../testkit/time.mjs';
import { pathProblem, which, wslenvNames } from './doctor-checks.mjs';
import { redact, runChecks } from './doctor.mjs';
import { INSTALLED_JSON, fingerprint, readInstalledJson, writeInstalledJson } from './fingerprint.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(scripts, 'roadctl.mjs');
const EXAMPLE_BOARD = path.join(scripts, '..', 'examples', 'board-example', 'board');
const AGENT = 'claude-code@home-wsl';
const GIT_DIR = path.dirname(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git');

const gitIn = (cwd, args, env = {}) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: T0, GIT_COMMITTER_DATE: T0, ...env } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Hash of every file under `root` (path, size, mtime, content): a snapshot to prove that nothing changed. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[`${path.relative(root, p)}/`] = fs.statSync(p).mtimeMs;
        walk(p);
      } else if (e.isFile()) out[path.relative(root, p)] = [fs.statSync(p).size, fs.statSync(p).mtimeMs, crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')];
    }
  };
  walk(root);
  return out;
}

/**
 * A throwaway machine: HOME, XDG dirs, a workspace with the example board as project my-app (a git repository with a local bare origin), a registry
 * with AGENT, a bin directory with the fakes first on PATH. `ok(extraEnv)` etc. run doctor in it.
 */
function rig({ git = true, registry = true, extraFakes = {}, fakeNames, env: extraEnv = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-doctor-'));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  const bin = installFakes(path.join(root, 'bin'), { ...(fakeNames ? { names: fakeNames } : {}), extra: extraFakes });
  const regFile = path.join(root, 'registry.json');
  if (registry) fs.writeFileSync(regFile, JSON.stringify({ version: 1, agents: { [AGENT]: { host: 'claude-code', machine: 'home-wsl', roles: ['orchestrator', 'worker'] } } }));
  const origin = path.join(root, 'origin.git');
  if (git) {
    gitIn(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    gitIn(ws, ['init', '-q', '-b', 'main']);
    gitIn(ws, ['add', '-A']);
    gitIn(ws, ['commit', '-q', '-m', 'board']);
    gitIn(ws, ['remote', 'add', 'origin', origin]);
    gitIn(ws, ['push', '-q', '-u', 'origin', 'main']);
  }
  const env = {
    PATH: `${bin}${path.delimiter}${GIT_DIR}`, HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'cfg'),
    ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: regFile, FAKE_LOG: path.join(root, 'calls.jsonl'), ...clock(shift(60)), ...extraEnv,
  };
  const run = (args, { cwd = ws, env: e = {}, script = SELF } = {}) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...env, ...e }, timeout: 60000 });
  const json = (args, opts) => {
    const r = run([...args, '--json'], opts);
    assert.ok([0, 1].includes(r.status), `${args.join(' ')}: exit ${r.status}: ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(doctorJsonProblems(j), [], 'the JSON follows the documented schema');
    return { r, j, by: (id, subject = null) => j.checks.find((c) => c.id === id && (subject === null || c.subject === subject)), all: (id) => j.checks.filter((c) => c.id === id) };
  };
  const install = () => syncRoadctl(home, SELF);
  const installedFile = (...p) => path.join(home, '.local', 'share', 'road-map-journal', ...p);
  const calls = (name) => readCalls(env.FAKE_LOG, name);
  return { root, home, ws, board, bin, regFile, origin, env, run, json, install, installedFile, calls };
}

// ---------------------------------------------------------------- a1: read only

test('a1: doctor changes nothing: a snapshot of the whole machine (boards, repositories, installed copy, state) is identical before and after, with --online and ssh', FAKES_SKIP, () => {
  const sshStub = 'while [ "$1" = "-o" ]; do shift 2; done; [ "$1" = "--" ] && shift; shift; exec sh -c "$*"';
  const r = rig({ extraFakes: { ssh: sshStub, 'wsl.exe': 'exec sh -c "$4"' }, env: { WSL_DISTRO_NAME: 'test', ROADCTL_RUN_ID: 'r1' } });
  r.install();
  fs.writeFileSync(path.join(r.board, 'cards', 'untracked-note.md'), 'x\n'); // pending work in the board: doctor must not commit or stage it
  const before = snapshot(r.root);
  for (const args of [['doctor'], ['doctor', '--agent', AGENT, '--json'], ['doctor', '--online', '--host', 'work-host', '--agent', AGENT]]) {
    const out = r.run(args);
    assert.ok([0, 1].includes(out.status), `${args.join(' ')}: ${out.stderr}`);
  }
  assert.deepEqual(snapshot(r.root), before);
  assert.equal(fs.existsSync(r.env.XDG_STATE_HOME), false, 'the state directory is not created');
});

// ---------------------------------------------------------------- a2: a missing executor fails with a hint; a path with the wrong letter case gets a message

test('a2: --agent with no command of its host in PATH is a failure with a hint (exit 1); with the command it passes', FAKES_SKIP, () => {
  const bare = rig({ fakeNames: [] }); // no claude on PATH
  const a = bare.json(['doctor', '--agent', AGENT]);
  assert.equal(a.r.status, 1);
  assert.equal(a.j.ok, false);
  const ex = a.by('executor', AGENT);
  assert.equal(ex.status, 'fail');
  assert.match(ex.detail, /claude was not found in PATH \(host claude-code\)/);
  assert.match(ex.hint, /install claude, or add its directory to PATH for non-interactive shells/);
  const text = bare.run(['doctor', '--agent', AGENT]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /Failures \(1\):/);
  assert.match(text.stdout, /FAIL executor \[claude-code@home-wsl\]: claude was not found in PATH/);
  assert.match(text.stdout, /hint: install claude/);
  const good = rig();
  const b = good.json(['doctor', '--agent', AGENT]);
  assert.equal(b.r.status, 0, b.r.stdout);
  assert.equal(b.by('executor', AGENT).status, 'ok');
  assert.equal(b.by('agent', AGENT).status, 'ok');
  // an agent the registry does not know: a warning, the host is guessed from the name
  assert.equal(good.json(['doctor', '--agent', 'codex@elsewhere']).by('agent', 'codex@elsewhere').status, 'warn');
  // without --agent no executor is required
  const none = bare.json(['doctor']);
  assert.equal(none.r.status, 0);
  assert.equal(none.by('executors').status, 'skip');
});

test('a2: a boards-list entry with the wrong letter case is reported with both spellings; a missing one is reported as missing', () => {
  const r = rig({ git: false });
  const wrongCase = path.join(r.root, 'Elsewhere', 'Proj', 'board');
  fs.mkdirSync(path.join(r.root, 'elsewhere', 'Proj', 'board'), { recursive: true });
  fs.writeFileSync(path.join(r.root, 'elsewhere', 'Proj', 'board', 'config.json'), '{}');
  fs.mkdirSync(path.join(r.env.XDG_CONFIG_HOME, 'road-map-journal'), { recursive: true });
  fs.writeFileSync(path.join(r.env.XDG_CONFIG_HOME, 'road-map-journal', 'boards'), `${wrongCase}\n${path.join(r.root, 'gone', 'board')}\n`);
  const d = r.json(['doctor']);
  const paths = d.by('paths');
  assert.equal(paths.status, 'warn');
  assert.match(paths.detail, /wrong letter case/);
  assert.ok(paths.detail.includes(path.join(r.root, 'Elsewhere', 'Proj', 'board', 'config.json')), 'the spelling that was written');
  assert.ok(paths.detail.includes(path.join(r.root, 'elsewhere', 'Proj', 'board', 'config.json')), 'the spelling on disk');
  assert.match(paths.detail, /gone\/board\/config\.json does not exist/);
  assert.equal(d.r.status, 0, 'a warning is not a failure');
  assert.deepEqual([pathProblem(path.join(r.root, 'ELSEWHERE')), pathProblem(path.join(r.root, 'nothing', 'here'))], [{ kind: 'case', actual: path.join(r.root, 'elsewhere') }, { kind: 'missing' }]);
  assert.equal(pathProblem(r.root), null);
});

// ---------------------------------------------------------------- a3: a sha mismatch is a warning; a board that requires a newer copy is a failure

test('a3: an installed copy that differs from its record is a warning, not a failure; installed.json names what changed', FAKES_SKIP, () => {
  const r = rig();
  r.install();
  const clean = r.json(['doctor']);
  assert.equal(clean.by('installed-copy').status, 'ok');
  assert.equal(clean.by('installed-modules').status, 'ok');
  assert.equal(clean.by('installed-current').status, 'ok', 'identical to this checkout');
  fs.appendFileSync(r.installedFile('roadctl', 'probe.mjs'), '// edited by hand\n');
  const d = r.json(['doctor']);
  assert.equal(d.by('installed-copy').status, 'warn');
  assert.match(d.by('installed-copy').detail, /files differ from what was installed/);
  assert.match(d.by('installed-copy').detail, /changed: roadctl\/probe\.mjs/);
  assert.equal(d.by('installed-current').status, 'warn');
  assert.equal(d.j.summary.fail, 0);
  assert.equal(d.r.status, 0, 'a checksum mismatch alone never fails doctor');
  // no installed.json at all (installed by hand or by an old update-installed.mjs)
  fs.rmSync(r.installedFile(INSTALLED_JSON));
  assert.match(r.json(['doctor']).by('installed-copy').detail, /no installed\.json/);
  // no installed copy at all
  const bare = rig();
  assert.equal(bare.json(['doctor']).by('installed-copy').status, 'warn');
  assert.equal(bare.json(['doctor']).by('installed-modules'), undefined);
});

test('a3: an installed copy older than 0.2.0 is a warning (it cannot see "requires"), and a board that asks for more than it has is a failure of that copy', FAKES_SKIP, () => {
  const r = rig();
  r.install();
  const file = r.installedFile('roadctl.mjs');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^export const VERSION = '[^']+'/m, "export const VERSION = '0.1.0'"));
  const d = r.json(['doctor']);
  assert.equal(d.by('installed-copy').status, 'warn');
  assert.match(d.by('installed-copy').detail, /version 0\.1\.0 is older than 0\.2\.0 and cannot see "requires"/);
  assert.match(d.by('installed-copy').hint, /update-installed\.mjs --roadctl --apply/);
  assert.match(d.by('installed-current').detail, /the installed one is older/);
  assert.equal(d.r.status, 0);
  // the board asks for 0.2.0: this checkout has it, the installed copy does not
  const cfgFile = path.join(r.board, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, requires: '0.2.0' }));
  const e = r.json(['doctor']);
  assert.equal(e.by('board-requires', 'my-app').status, 'ok');
  const old = e.by('board-requires-installed', 'my-app');
  assert.equal(old.status, 'fail');
  assert.match(old.detail, /installed copy \(0\.1\.0\) is too old: board requires roadctl 0\.2\.0 or newer; this is 0\.1\.0/);
  assert.match(old.hint, /board requires a newer copy/);
  assert.equal(e.r.status, 1);
});

test('a3: a board that requires a newer roadctl than this copy is a failure (the same refusal tick makes); an unreadable value too', () => {
  const r = rig({ git: false });
  const cfgFile = path.join(r.board, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, requires: '9.9.0' }));
  const d = r.json(['doctor']);
  const b = d.by('board-requires', 'my-app');
  assert.equal(b.status, 'fail');
  assert.match(b.detail, new RegExp(`board requires roadctl 9\\.9\\.0 or newer; this is ${rc.VERSION.replace(/\./g, '\\.')}`));
  assert.match(b.hint, /update roadctl/);
  assert.equal(d.r.status, 1);
  assert.equal(r.run(['tick', '--as', AGENT, '--no-pull']).stdout.includes('requires'), true, 'tick refuses the same board');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, requires: 'soon' }));
  assert.match(r.json(['doctor']).by('board-requires', 'my-app').detail, /unreadable roadctl version/);
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, requires: rc.VERSION }));
  assert.equal(r.json(['doctor']).by('board-requires', 'my-app').status, 'ok', 'a board that asks for exactly this version is fine');
});

test('the modules folder: an installed roadctl.mjs without roadctl/ is a failure; a missing recorded file too', FAKES_SKIP, () => {
  const r = rig();
  r.install();
  fs.renameSync(r.installedFile('roadctl', 'probe.mjs'), r.installedFile('probe.moved'));
  const lost = r.json(['doctor']).by('installed-modules');
  assert.equal(lost.status, 'fail');
  assert.match(lost.detail, /files recorded at install are missing: roadctl\/probe\.mjs/);
  fs.renameSync(r.installedFile('probe.moved'), r.installedFile('roadctl', 'probe.mjs'));
  fs.rmSync(r.installedFile('roadctl'), { recursive: true });
  const d = r.json(['doctor']);
  assert.equal(d.by('installed-modules').status, 'fail');
  assert.match(d.by('installed-modules').detail, /no roadctl\/ modules folder/);
  assert.equal(d.r.status, 1);
});

// ---------------------------------------------------------------- a4: the schema, and no secret in the output

test('a4: --json follows the documented schema; the strict checker catches a wrong shape', () => {
  const r = rig({ git: false });
  const d = r.json(['doctor', '--agent', AGENT]);
  assert.equal(d.j.schema, 1);
  assert.equal(d.j.roadctl.version, rc.VERSION);
  assert.equal(d.j.roadctl.sha, fingerprint(scripts).short);
  assert.equal(d.j.agent, AGENT);
  assert.equal(d.j.online, false);
  assert.ok(d.j.checks.length > 15);
  assert.equal(d.j.summary.ok + d.j.summary.warn + d.j.summary.fail + d.j.summary.skip, d.j.checks.length);
  const good = d.j;
  assert.deepEqual(doctorJsonProblems(good), []);
  assert.match(doctorJsonProblems({ ...good, extra: 1 }).join(), /unknown key extra/);
  assert.match(doctorJsonProblems({ ...good, checks: [{ ...good.checks[0], status: 'maybe' }] }).join(), /bad status maybe/);
  assert.match(doctorJsonProblems({ ...good, ok: !good.ok }).join(), /ok must be true exactly when/);
  assert.match(doctorJsonProblems({ ...good, checks: [{ id: 'x', subject: null, status: 'fail', detail: 'd', hint: null }], summary: { ok: 0, warn: 0, fail: 1, skip: 0 }, ok: false }).join(), /a failure needs a hint/);
  assert.match(doctorJsonProblems({ ...good, checks: [{ ...good.checks[0], detail: '' }] }).join(), /detail must be a non-empty string/);
});

test('a4: a token from the environment never appears in the output, in text or in JSON; ROADCTL_* variables are named, never shown', () => {
  const token = 'tok-9f8e7d6c5b4a';
  const secretValue = 'hunter2hunter2';
  const r = rig({ git: false, env: { GITHUB_TOKEN: token, MY_API_KEY: 'key-value-0123456789', ROADCTL_PRIVATE_NOTE: secretValue, ROADCTL_REGISTRY: undefined } });
  // a path that embeds the token reaches the output through the paths check; it must be redacted there
  const tokenPath = path.join(r.root, token, 'registry.json');
  for (const args of [['doctor'], ['doctor', '--json'], ['doctor', '--agent', AGENT]]) {
    const out = r.run(args, { env: { ROADCTL_REGISTRY: tokenPath, ROADCTL_WORKSPACE: path.join(r.root, token) } });
    const all = `${out.stdout}${out.stderr}`;
    assert.ok(!all.includes(token), `${args.join(' ')}: the token is not printed`);
    assert.ok(!all.includes('key-value-0123456789'));
    assert.ok(!all.includes(secretValue), 'the value of a ROADCTL_* variable is not printed');
    assert.ok(all.includes('[redacted]'), 'the redaction happened');
    assert.ok(all.includes('ROADCTL_PRIVATE_NOTE'), 'the variable is named');
  }
  assert.equal(redact('a tok-123456 b', { SOME_TOKEN: 'tok-123456', OTHER: 'tok-123456' }), 'a [redacted] b');
  assert.equal(redact('abc', { SOME_TOKEN: 'abc' }), 'abc', 'a value shorter than 4 characters is left alone');
  assert.equal(redact('x', { PATH: 'x/y/z' }), 'x', 'only secret-looking names count');
});

// ---------------------------------------------------------------- a5: two state directories, WSLENV and ssh for ROADCTL_*, clock skew

test('a5: two state directories (WSL and native Windows) are a warning naming both; one is fine', () => {
  const win = (r) => path.join(r.root, 'winhome');
  const r = rig({ git: false, env: { WSL_DISTRO_NAME: 'Test' } });
  fs.mkdirSync(path.join(win(r), '.local', 'state', 'road-map-journal'), { recursive: true });
  const both = r.json(['doctor'], { env: { ROADCTL_WINDOWS_HOME: win(r) } }).by('state-dirs');
  assert.equal(both.status, 'warn');
  assert.ok(both.detail.includes(path.join(win(r), '.local', 'state', 'road-map-journal')), 'the Windows directory is named');
  assert.match(both.detail, /two state directories/);
  assert.match(both.detail, /not shared/);
  fs.rmSync(path.join(win(r), '.local'), { recursive: true });
  assert.equal(r.json(['doctor'], { env: { ROADCTL_WINDOWS_HOME: win(r) } }).by('state-dirs').status, 'ok');
  // not WSL: the check does not apply and says so
  const plain = rig({ git: false });
  assert.match(plain.json(['doctor']).by('state-dirs').detail, /applies to WSL and Windows/);
  // a Hermes monitor state directory is mentioned
  fs.mkdirSync(path.join(plain.home, '.road-map-journal'));
  assert.match(plain.json(['doctor']).by('state-dirs').detail, /Hermes monitor state directory/);
});

test('a5: the state directory: not writable is a warning that names the lost lock; a missing one that can be created is fine', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const r = rig({ git: false });
  assert.match(r.json(['doctor']).by('state-dir').detail, /does not exist yet/);
  const dir = path.join(r.env.XDG_STATE_HOME, 'road-map-journal');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tick-x.lock'), '');
  assert.match(r.json(['doctor']).by('state-dir').detail, /lock file\(s\): tick-x\.lock/);
  fs.chmodSync(dir, 0o555);
  try {
    const d = r.json(['doctor']).by('state-dir');
    assert.equal(d.status, 'warn');
    assert.match(d.detail, /not writable: tick would run WITHOUT its lock/);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test('a5: ROADCTL_* variables against WSLENV: unlisted ones are named in a warning, listed ones pass; the value is never shown', () => {
  const r = rig({ git: false, env: { WSL_DISTRO_NAME: 'Test', ROADCTL_RUN_ID: 'run-secret-value', ROADCTL_FLAG_X: 'v' } });
  const bad = r.json(['doctor'], { env: { WSLENV: 'OTHER/u' } }).by('wsl-env');
  assert.equal(bad.status, 'warn');
  assert.match(bad.detail, /set here but not in WSLENV: .*ROADCTL_FLAG_X.*ROADCTL_RUN_ID/);
  assert.ok(!JSON.stringify(bad).includes('run-secret-value'));
  assert.match(bad.hint, /add them to WSLENV/);
  const good = r.json(['doctor'], { env: { WSLENV: 'ROADCTL_RUN_ID/u:ROADCTL_FLAG_X:ROADCTL_NOW:ROADCTL_REGISTRY/p:ROADCTL_WORKSPACE/p:OTHER/p' } }).by('wsl-env');
  assert.equal(good.status, 'ok');
  assert.deepEqual(wslenvNames('A/p:B:C/u:/l::D'), ['A', 'B', 'C', 'D']);
  // outside WSL and Windows, without WSLENV: not applicable
  const plain = rig({ git: false, env: { ROADCTL_RUN_ID: 'x' } });
  assert.equal(plain.json(['doctor']).by('wsl-env').status, 'skip');
});

test('a5: the wsl.exe probe: a transport that passes a WSLENV-listed variable is ok, one that drops it is a warning, none on PATH is skipped', FAKES_SKIP, () => {
  const passes = rig({ git: false, extraFakes: { 'wsl.exe': 'exec sh -c "$4"' }, env: { WSL_DISTRO_NAME: 'Test' } });
  assert.equal(passes.json(['doctor']).by('wsl-probe').status, 'ok');
  assert.equal(passes.calls('wsl.exe').length, 0, 'the stub above is not the recording fake');
  const drops = rig({ git: false, extraFakes: { 'wsl.exe': 'exec env -i /bin/sh -c "$4"' }, env: { WSL_DISTRO_NAME: 'Test' } });
  const w = drops.json(['doctor']).by('wsl-probe');
  assert.equal(w.status, 'warn');
  assert.match(w.detail, /did NOT reach/);
  const crashes = rig({ git: false, fakeNames: ['wsl.exe'], env: { WSL_DISTRO_NAME: 'Test', FAKE_WSL_EXE_MODE: 'crash' } });
  assert.match(crashes.json(['doctor']).by('wsl-probe').detail, /could not run a command \(exit 70\)/);
  const recording = rig({ git: false, fakeNames: ['wsl.exe'], env: { WSL_DISTRO_NAME: 'Test', FAKE_WSL_EXE_MODE: 'run' } });
  assert.equal(recording.json(['doctor']).by('wsl-probe').status, 'ok');
  const call = recording.calls('wsl.exe')[0];
  assert.deepEqual(call.argv.slice(0, 3), ['-e', 'sh', '-c']);
  assert.equal(call.env.ROADCTL_DOCTOR_PROBE, 'probe-ok');
  assert.match(call.env.WSLENV ?? 'ROADCTL_DOCTOR_PROBE', /ROADCTL_DOCTOR_PROBE/);
  const none = rig({ git: false, fakeNames: [], env: { WSL_DISTRO_NAME: 'Test' } });
  assert.equal(none.json(['doctor']).by('wsl-probe').status, 'skip');
});

test('a5: the ssh check is opt-in (--online --host): without it ssh is never started; with it a server that passes the variable is ok, one that drops it is a warning, an unreachable one is a warning', FAKES_SKIP, () => {
  const strip = 'while [ "$1" = "-o" ]; do shift 2; done; [ "$1" = "--" ] && shift; shift; exec env -i /bin/sh -c "$*"';
  const keep = 'while [ "$1" = "-o" ]; do shift 2; done; [ "$1" = "--" ] && shift; shift; exec sh -c "$*"';
  const r = rig({ git: false, extraFakes: { ssh: keep } });
  const off = r.json(['doctor']).by('ssh-env');
  assert.equal(off.status, 'skip');
  assert.match(off.detail, /--online --host HOST/);
  const refused = r.run(['doctor', '--host', 'work-host']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--host contacts HOST over ssh: add --online/);
  assert.equal(r.json(['doctor', '--online', '--host', 'work-host']).by('ssh-env').status, 'ok');
  const dropped = rig({ git: false, extraFakes: { ssh: strip } }).json(['doctor', '--online', '--host', 'work-host']).by('ssh-env');
  assert.equal(dropped.status, 'warn');
  assert.equal(dropped.subject, 'work-host');
  assert.match(dropped.hint, /set them in the remote command itself/);
  const down = rig({ git: false, extraFakes: { ssh: 'exit 255' } }).json(['doctor', '--online', '--host', 'work-host']).by('ssh-env');
  assert.equal(down.status, 'warn');
  assert.match(down.detail, /could not reach work-host/);
  const recording = rig({ git: false, fakeNames: ['ssh'], env: { FAKE_SSH_MODE: 'silent' } });
  recording.json(['doctor', '--online', '--host', 'work-host']);
  const call = recording.calls('ssh')[0];
  assert.deepEqual(call.argv, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'SendEnv=ROADCTL_DOCTOR_PROBE', '--', 'work-host', 'echo "$ROADCTL_DOCTOR_PROBE"']);
  assert.equal(call.env.ROADCTL_DOCTOR_PROBE, 'probe-ok');
  for (const bad of ['-oProxyCommand=x', 'a b', '']) assert.equal(r.run(['doctor', '--online', '--host', bad]).status, 2, `host ${JSON.stringify(bad)} is refused`);
});

test('a5: clock skew: a clock behind the newest fetched commit of origin is a warning with the size of the gap; a clock past it is fine; ROADCTL_NOW is flagged', () => {
  const r = rig();
  const future = shift(120); // the commit of origin was made two hours after the clock below
  gitIn(r.ws, ['commit', '-q', '--allow-empty', '-m', 'later'], { GIT_COMMITTER_DATE: future, GIT_AUTHOR_DATE: future });
  gitIn(r.ws, ['push', '-q']);
  const behind = r.json(['doctor'], { env: clock(shift(0)) });
  assert.equal(behind.by('clock').status, 'warn');
  assert.match(behind.by('clock').detail, /ROADCTL_NOW is at least 120 minute\(s\) behind the newest commit of origin \(my-app\)/);
  assert.match(behind.by('clock').hint, /unset ROADCTL_NOW/);
  assert.equal(behind.by('env').status, 'warn', 'ROADCTL_NOW is a test knob and doctor says so');
  assert.match(behind.by('env').hint, /ROADCTL_NOW replaces the clock/);
  assert.equal(behind.r.status, 0, 'skew is a warning');
  assert.equal(r.json(['doctor'], { env: clock(shift(125)) }).by('clock').status, 'ok');
  assert.equal(r.json(['doctor'], { env: clock(shift(121)) }).by('clock').status, 'ok', 'inside the five-minute tolerance, ahead of the commit');
  assert.equal(r.json(['doctor'], { env: clock(shift(118)) }).by('clock').status, 'ok', 'two minutes behind is inside the tolerance');
  assert.equal(r.json(['doctor'], { env: clock(shift(110)) }).by('clock').status, 'warn');
  // no repository with a fetched upstream: not checked
  assert.equal(rig({ git: false }).json(['doctor']).by('clock').status, 'skip');
});

// ---------------------------------------------------------------- boards: git write access, uncommitted work, origin, routines, registry

test('boards: uncommitted and unpushed work is a warning; a clean board is ok; --online asks origin and says so, a missing origin is a warning', () => {
  const r = rig();
  const d0 = r.json(['doctor']);
  assert.equal(d0.by('board-sync', 'my-app').status, 'ok');
  assert.equal(d0.by('board-git', 'my-app').status, 'ok');
  assert.equal(d0.by('origin-reachable'), undefined, 'offline: origin is not asked');
  fs.writeFileSync(path.join(r.board, 'cards', 'extra.md'), 'x\n');
  gitIn(r.ws, ['add', '-A']);
  gitIn(r.ws, ['commit', '-q', '-m', 'local']);
  fs.writeFileSync(path.join(r.board, 'cards', 'extra2.md'), 'y\n');
  const d1 = r.json(['doctor']);
  assert.equal(d1.by('board-sync', 'my-app').status, 'warn');
  assert.match(d1.by('board-sync', 'my-app').detail, /1 uncommitted change\(s\); 1 commit\(s\) not pushed/);
  assert.equal(d1.r.status, 0);
  assert.equal(r.json(['doctor', '--online']).by('origin-reachable', 'my-app').status, 'ok');
  gitIn(r.ws, ['remote', 'set-url', 'origin', path.join(r.root, 'no-such-origin.git')]);
  const down = r.json(['doctor', '--online']).by('origin-reachable', 'my-app');
  assert.equal(down.status, 'warn');
  assert.equal(r.json(['doctor']).by('origin-reachable'), undefined);
  assert.match(r.run(['doctor']).stdout, /offline: no network and no limits are used/);
  assert.match(r.run(['doctor', '--online']).stdout, /online checks are on \(--online\)/);
});

test('boards: a repository the user cannot write to is a failure; a stale index.lock is a warning', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const r = rig();
  const gitDir = path.join(r.ws, '.git');
  fs.writeFileSync(path.join(gitDir, 'index.lock'), '');
  assert.match(r.json(['doctor']).by('board-git', 'my-app').detail, /index\.lock exists/);
  fs.rmSync(path.join(gitDir, 'index.lock'));
  fs.chmodSync(gitDir, 0o555);
  try {
    const d = r.json(['doctor']);
    assert.equal(d.by('board-git', 'my-app').status, 'fail');
    assert.match(d.by('board-git', 'my-app').detail, /is not writable by this user: roadctl save and pull cannot commit/);
    assert.equal(d.r.status, 1);
  } finally {
    fs.chmodSync(gitDir, 0o755);
  }
});

test('registry: an unreadable registry is a failure; an agent whose provider is unknown too; a missing registry is skipped', () => {
  const r = rig({ git: false });
  fs.writeFileSync(r.regFile, '{ not json');
  const bad = r.json(['doctor']);
  assert.equal(bad.by('registry').status, 'fail');
  assert.match(bad.by('registry').detail, /is not valid JSON/);
  assert.equal(bad.r.status, 1);
  fs.writeFileSync(r.regFile, JSON.stringify({ agents: { [AGENT]: { host: 'claude-code', provider: 'nowhere' } } }));
  assert.match(r.json(['doctor']).by('registry').detail, new RegExp(`${AGENT} names provider nowhere`));
  fs.rmSync(r.regFile);
  assert.equal(r.json(['doctor']).by('registry').status, 'skip');
});

test('routines: an enabled routine that cannot run, or that names an agent missing from the registry, is a warning; consistent ones are ok', () => {
  const r = rig({ git: false });
  const cli = (args) => {
    const o = r.run(args);
    assert.equal(o.status, 0, `${args.join(' ')}: ${o.stderr}${o.stdout}`);
  };
  cli(['routine', 'new', 'status', 'Collect status', '--agent', AGENT, '--model', 'haiku', '--env', 'laptop', '--every', '2h', '--board', r.board]);
  cli(['routine', 'on', 'status', '--by', 'Owner', '--source', 'chat', '--board', r.board]);
  cli(['autonomy', 'routines', 'on', '--by', 'Owner', '--board', r.board]);
  assert.equal(r.json(['doctor', '--agent', AGENT]).by('routines', 'my-app').status, 'ok');
  assert.match(r.json(['doctor', '--agent', AGENT]).by('routines', 'my-app').detail, /1 routine\(s\), 1 enabled, 1 for claude-code@home-wsl/);
  cli(['routine', 'new', 'ghost', 'Ghost', '--agent', 'codex@nowhere', '--model', 'm', '--env', 'e', '--every', '1d', '--board', r.board]);
  cli(['routine', 'on', 'ghost', '--by', 'Owner', '--source', 'chat', '--board', r.board]);
  const d = r.json(['doctor']).by('routines', 'my-app');
  assert.equal(d.status, 'warn');
  assert.match(d.detail, /ghost: agent codex@nowhere is not in the registry/);
  cli(['autonomy', 'routines', 'off', '--by', 'Owner', '--board', r.board]);
  assert.match(r.json(['doctor']).by('routines', 'my-app').detail, /enabled but the board switch is off/);
});

test('usage: --agent needs a valid name; unknown agents and hosts are named; a failing check becomes a warning, not a crash', () => {
  const r = rig({ git: false });
  assert.equal(r.run(['doctor', '--agent']).status, 2);
  assert.equal(r.run(['doctor', '--agent', 'bad name']).status, 2);
  assert.match(r.run(['doctor', '--agent']).stderr, /usage: --agent NAME/);
  // a helper missing from api makes one check throw; the runner reports it and goes on
  const api = { VERSION: rc.VERSION, compareVersions: rc.compareVersions, nowMs: rc.nowMs, knownBoards: () => [], findBoard: () => null, userBoardsFile: rc.userBoardsFile, registryPath: rc.registryPath, loadRegistry: () => null, providerTable: rc.providerTable, hostOfAgent: rc.hostOfAgent, splitCommand: rc.splitCommand, limitsCachePath: rc.limitsCachePath /* tickLedgerPath is missing */ };
  const ctx = { env: r.env, home: r.home, platform: process.platform, cwd: r.root, flags: {}, agent: null, online: false, host: null, api, runDir: scripts, nodeVersion: process.version, spawn: spawnSync };
  const result = runChecks(ctx);
  const crashed = result.checks.find((c) => c.id === 'state');
  assert.equal(crashed.status, 'warn');
  assert.match(crashed.detail, /the check could not run: /);
  assert.ok(result.checks.some((c) => c.id === 'version' && c.status === 'ok'), 'the other checks ran');
});

test('which: finds an executable file on PATH, ignores directories and non-executable files', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-which-'));
  fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'plain'), 'x', { mode: 0o644 });
  fs.mkdirSync(path.join(dir, 'folder'));
  assert.equal(which('tool', { PATH: dir }, 'linux'), path.join(dir, 'tool'));
  assert.equal(which('plain', { PATH: dir }, 'linux'), null);
  assert.equal(which('folder', { PATH: dir }, 'linux'), null);
  assert.equal(which('tool', { PATH: '' }, 'linux'), null);
});

// ---------------------------------------------------------------- a6: roadctl --version and installed.json

test('a6: roadctl --version prints the version and the sha of the copy; `roadctl version` is unchanged', () => {
  const r = rig({ git: false });
  const v = r.run(['--version']);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, `roadctl ${rc.VERSION} sha:${fingerprint(scripts).short}\n`);
  assert.match(v.stdout, /^roadctl \d+\.\d+\.\d+ sha:[0-9a-f]{12}\n$/);
  assert.equal(r.run(['version']).stdout, `${rc.VERSION}\n`);
  // an installed copy reports its own sha, the same number doctor shows
  r.install();
  const installed = r.run(['--version'], { script: r.installedFile('roadctl.mjs') });
  assert.equal(installed.stdout, v.stdout, 'same code, same line');
  fs.appendFileSync(r.installedFile('roadctl', 'probe.mjs'), '// edit\n');
  assert.notEqual(r.run(['--version'], { script: r.installedFile('roadctl.mjs') }).stdout, v.stdout, 'an edited file changes the sha');
  // a lone roadctl.mjs without its modules folder (no fingerprint.mjs) still answers, with the version alone
  const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-lone-'));
  fs.copyFileSync(SELF, path.join(lone, 'roadctl.mjs'));
  assert.equal(r.run(['--version'], { script: path.join(lone, 'roadctl.mjs') }).stdout, `roadctl ${rc.VERSION}\n`);
});

test('a6: the sha ignores CRLF and test files, depends on every file and on the file names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-fp-'));
  const make = (d, files) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), text);
    }
    return fingerprint(d);
  };
  const a = make(path.join(dir, 'a'), { 'roadctl.mjs': "export const VERSION = '1.2.3';\n", 'roadctl/m.mjs': 'one\n' });
  assert.equal(a.version, '1.2.3');
  assert.deepEqual(Object.keys(a.files), ['roadctl.mjs', 'roadctl/m.mjs']);
  assert.equal(make(path.join(dir, 'b'), { 'roadctl.mjs': "export const VERSION = '1.2.3';\r\n", 'roadctl/m.mjs': 'one\r\n', 'roadctl/m.test.mjs': 'tests are not part of a copy' }).sha, a.sha);
  assert.notEqual(make(path.join(dir, 'c'), { 'roadctl.mjs': "export const VERSION = '1.2.3';\n", 'roadctl/m.mjs': 'two\n' }).sha, a.sha);
  assert.notEqual(make(path.join(dir, 'd'), { 'roadctl.mjs': "export const VERSION = '1.2.3';\n", 'roadctl/n.mjs': 'one\n' }).sha, a.sha, 'a renamed module is another copy');
  assert.equal(fingerprint(path.join(dir, 'nothing')).sha, null);
  assert.equal(a.short, a.sha.slice(0, 12));
});

test('a6: update-installed --roadctl writes installed.json (version, sha, files) and leaves it alone when nothing changed; a dry run writes nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-installed-'));
  const dry = syncRoadctl(home, SELF, false);
  assert.match(dry.action, /would install/);
  assert.equal(fs.existsSync(path.join(home, '.local')), false);
  const first = syncRoadctl(home, SELF);
  assert.equal(first.installedJson, 'write');
  const dir = path.dirname(first.dest);
  const rec = readInstalledJson(dir);
  const fp = fingerprint(dir);
  assert.deepEqual(Object.keys(rec).sort(), ['files', 'installed_at', 'schema', 'sha', 'version']);
  assert.deepEqual([rec.schema, rec.version, rec.sha, rec.files], [1, rc.VERSION, fp.sha, fp.files]);
  assert.equal(fp.sha, fingerprint(scripts).sha, 'the installed copy is the same code as the source');
  assert.ok(rec.files['roadctl/doctor.mjs'] && rec.files['roadctl/fingerprint.mjs'], 'the doctor files are part of the copy');
  assert.match(rec.installed_at, /^\d{4}-\d\d-\d\dT/);
  const before = fs.readFileSync(path.join(dir, INSTALLED_JSON), 'utf8');
  const again = syncRoadctl(home, SELF);
  assert.equal(again.action, 'unchanged');
  assert.equal(again.installedJson, 'unchanged');
  assert.equal(fs.readFileSync(path.join(dir, INSTALLED_JSON), 'utf8'), before, 'installed_at is kept when nothing changed');
  assert.equal(writeInstalledJson(path.join(home, 'nothing'), 'x'), null);
  // a changed file is a new record
  fs.appendFileSync(path.join(dir, 'roadctl', 'probe.mjs'), '// edit\n');
  assert.equal(writeInstalledJson(dir, '2026-01-01T00:00:00Z'), 'write');
  assert.equal(readInstalledJson(dir).installed_at, '2026-01-01T00:00:00Z');
});

test('the text report: failures, warnings, passed and not-checked are listed apart, with the exit code in the last line', FAKES_SKIP, () => {
  const r = rig({ fakeNames: [] });
  const out = r.run(['doctor', '--agent', AGENT]);
  const lines = out.stdout.split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.match(lines[0], new RegExp(`^roadctl doctor: roadctl ${rc.VERSION.replace(/\./g, '\\.')} \\(sha [0-9a-f]{12}\\), ${process.platform}, node ${process.version.replace(/\./g, '\\.')}, agent ${AGENT}$`));
  assert.ok(at(/^Failures \(\d+\):$/) < at(/^Warnings \(\d+\):$/) && at(/^Warnings \(\d+\):$/) < at(/^Passed \(\d+\):$/) && at(/^Passed \(\d+\):$/) < at(/^Not checked \(\d+\):$/));
  assert.match(lines.filter(Boolean).at(-1), /^result: 1 failure\(s\), \d+ warning\(s\), \d+ ok, \d+ not checked; exit 1$/);
  assert.equal(out.status, 1);
});

test('help and docs: doctor is in the overview, has complete help, and docs/roadctl.md names every id the checks produce', () => {
  const help = spawnSync(process.execPath, [SELF, 'help', 'doctor'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const part of ['Usage:', 'Examples:', 'Changes:', 'Exit codes:', '--agent NAME', '--online', '--host HOST', '--json']) assert.ok(help.stdout.includes(part), part);
  assert.match(help.stdout, /0 no failure \(warnings may be present\); 1 at least one failure; 2 usage error/);
  const docs = fs.readFileSync(path.join(scripts, '..', 'docs', 'roadctl.md'), 'utf8');
  const r = rig({ extraFakes: { ssh: 'exit 0', 'wsl.exe': 'exec sh -c "$4"' }, env: { WSL_DISTRO_NAME: 'Test' } });
  const ids = new Set(r.json(['doctor', '--agent', AGENT, '--online', '--host', 'h']).j.checks.map((c) => c.id));
  for (const id of ['board-load', 'board-requires-installed', 'launch', 'limits-command']) ids.add(id); // reachable only with a broken board or a configured launch command
  for (const id of ids) assert.ok(docs.includes(`\`${id}\``), `docs/roadctl.md names the check ${id}`);
  const schema = fs.readFileSync(path.join(scripts, 'testkit', 'doctor-schema.mjs'), 'utf8');
  assert.ok(docs.includes('scripts/testkit/doctor-schema.mjs') && schema.includes('doctorJsonProblems'));
});
