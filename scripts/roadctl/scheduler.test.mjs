// The scheduler examples (examples/scheduler/) against a real roadctl and the fake executors of scripts/testkit/ (P5.10 a1, a2, a5).
// Nothing here starts a model or reaches a network: claude, ssh and wsl.exe are fakes that record argv, environment and stdin.
// Time: roadctl's clock is ROADCTL_NOW from the shared helper; waiting for a background process uses real time (waitFor).
// Run: node --test scripts/roadctl/scheduler.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAKES_SKIP, installFakes, isProbe, readCalls } from '../testkit/fakes.mjs';
import { tickJsonProblems } from '../testkit/tick-schema.mjs';
import { clock, T0, waitFor } from '../testkit/time.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(scripts, 'roadctl.mjs');
const EXAMPLES = path.join(scripts, '..', 'examples', 'scheduler');
const EXAMPLE_BOARD = path.join(scripts, '..', 'examples', 'board-example', 'board');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json'); // a path that does not exist: no registry
const ME = 'claude-code@home-wsl';
const EXTERNAL = 'claude-code@work-notebook';
const HERMES = 'hermes@home-host';
const HAVE_TIMEOUT = spawnSync('timeout', ['--version']).status === 0;
const NEEDS = { skip: (process.platform === 'win32' && 'the fake executables are shell scripts') || (!HAVE_TIMEOUT && 'timeout(1) is not installed') };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A workspace with the example board as project my-app, a bin directory with the fakes and a roadctl wrapper, and an environment that touches nothing outside a temp dir. */
function rig({ env: extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sched-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  fs.mkdirSync(path.join(dir, 'work'));
  const q = (s) => `'${s}'`;
  const bin = installFakes(path.join(dir, 'bin'), { extra: { roadctl: `exec ${q(process.execPath)} ${q(SELF)} "$@"` } });
  const log = path.join(dir, 'calls.jsonl');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'config'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10', ...clock(T0), FAKE_LOG: log, FAKE_ENV_KEYS: 'HOME', PYTHONDONTWRITEBYTECODE: '1', ROAD_MONITOR_STATE_DIR: path.join(dir, 'monitor'), ...extra };
  delete env.FAKE_MODE;
  const roadctl = (args, over = {}) => spawnSync(process.execPath, [SELF, ...args], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const ok = (args) => {
    const r = roadctl(args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  /** A routine of `agent` that may run: created, approved by the owner, board switch on. */
  const routine = (agent, id = 'atom-status') => {
    ok(['routine', 'new', id, 'Collect MR status', '--agent', agent, '--model', 'haiku', '--env', 'laptop', '--every', '2h', '--board', board]);
    ok(['routine', 'on', id, '--by', 'Owner', '--source', 'chat 2026-11-12', '--board', board]);
    ok(['autonomy', 'routines', 'on', '--by', 'Owner', '--board', board]);
  };
  const routineText = (id = 'atom-status') => fs.readFileSync(path.join(board, 'routines', `${id}.md`), 'utf8');
  /** What the model would do when it finishes: record the run through the real roadctl (the fake claude runs this after its normal calls). */
  const finish = (agent, id = 'atom-status') => `'${bin}/roadctl' routine done ${id} --as ${agent} --result ok checked --board '${board}'`;
  return { dir, ws, board, bin, log, env, roadctl, ok, routine, routineText, finish, calls: (n) => readCalls(log, n), work: (n) => readCalls(log, n).filter((c) => !c.event && !isProbe(c)) };
}

// ---------------------------------------------------------------- tick-claude.sh: tick on exit 0, then claude with the prompt on argv

function tickClaude(r, over = {}) {
  return spawnSync('bash', [path.join(EXAMPLES, 'tick-claude.sh')], { cwd: r.ws, encoding: 'utf8', input: '', env: { ...r.env, AGENT: ME, WORKDIR: path.join(r.dir, 'work'), ROADCTL: path.join(r.bin, 'roadctl'), MODEL: 'haiku', ...over } });
}

test('tick-claude.sh: a due routine starts claude once with the tick prompt; the finished run (routine done) makes the next tick idle and starts nothing', NEEDS, () => {
  const r = rig();
  r.routine(ME);
  const a = tickClaude(r, { FAKE_AFTER: r.finish(ME) });
  assert.equal(a.status, 0, a.stderr);
  const calls = r.calls('claude').filter((c) => !c.event);
  assert.deepEqual(calls.map(isProbe), [true, false], 'the limits gate probes once (fake claude), then the run starts');
  const run = calls[1];
  assert.deepEqual(run.argv.slice(0, 5), ['-p', '--model', 'haiku', '--max-turns', '30']);
  assert.equal(run.argv.length, 6, 'the prompt is the one last argument');
  assert.match(run.argv[5], new RegExp(`^You are ${ME}, the scheduled orchestrator`));
  assert.match(run.argv[5], /^RUN my-app\/atom-status Collect MR status$/m);
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(path.join(r.dir, 'work')), 'claude starts in WORKDIR');
  assert.equal(run.env.ROADCTL_NOW, T0);
  assert.equal(run.stdin, '', 'nothing is fed to claude on stdin');
  assert.match(r.routineText(), /^last_run: 2026-11-10T10:00:00Z$/m, 'routine done (run by the fake agent) recorded the run');
  assert.match(r.routineText(), /^last_result: ok$/m);
  const b = tickClaude(r);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /tick: idle, nothing to do/);
  assert.equal(r.work('claude').length, 1, 'idle starts no claude');
});

test('tick-claude.sh: a crashing claude is the script\'s exit code, an agent that records nothing leaves the routine due, no routine means no claude, a hanging claude is stopped by timeout', NEEDS, () => {
  const r = rig();
  r.routine(ME);
  assert.equal(r.ok(['limits', '--check', ME]).status, 0); // fills the limits cache (one fake probe); the runs below use it
  const probes = r.calls('claude').length;
  const crash = tickClaude(r, { FAKE_MODE: 'crash', FAKE_EXIT: '7' });
  assert.equal(crash.status, 7, 'the exit code of claude is the exit code of the script');
  assert.equal(r.calls('claude').length, probes + 1, 'the cache served the gate: only the run called claude');
  const silent = tickClaude(r, { FAKE_MODE: 'silent' });
  assert.equal(silent.status, 0);
  assert.doesNotMatch(r.routineText(), /last_run/, 'nothing was recorded, so the routine is still due');
  assert.match(r.roadctl(['tick', '--as', ME]).stdout, /^RUN my-app\/atom-status/m);
  // the hang: stopped by timeout(1) with CLAUDE_TIMEOUT, status 124
  const hung = tickClaude(r, { FAKE_MODE: 'hang', CLAUDE_TIMEOUT: '1' });
  assert.equal(hung.status, 124, hung.stderr);
  const pid = r.work('claude').at(-1).pid;
  assert.equal(waitFor(() => !alive(pid)), true, 'the hanging claude is gone'); // real time: a process
  // no routine due: no claude at all
  r.ok(['routine', 'off', 'atom-status', '--by', 'Owner', '--board', r.board]);
  const before = r.calls('claude').length;
  assert.match(tickClaude(r).stdout, /idle/);
  assert.equal(r.calls('claude').length, before);
});

// ---------------------------------------------------------------- hermes-routines-tick.py: tick --json decides, ssh starts the external run

function hermesRoutines(r, over = {}) {
  return spawnSync('python3', [path.join(EXAMPLES, 'hermes-routines-tick.py')], { cwd: r.ws, encoding: 'utf8', env: { ...r.env, FAKE_WSL_EXE_MODE: 'run', FAKE_SSH_MODE: 'run', ...over } });
}

test('hermes-routines-tick.py: the local tick is `roadctl tick --json`; a due external routine is launched over ssh with a narrowed permission list and a timeout, and finishes with routine done', NEEDS, () => {
  const r = rig();
  r.routine(EXTERNAL);
  const done = hermesRoutines(r, { FAKE_AFTER: r.finish(EXTERNAL) });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, '', 'the Hermes agent has nothing due: the monitor prints nothing');
  assert.ok(waitFor(() => r.work('claude').length === 1, { timeoutMs: 15000 }), 'the external claude was started'); // real time: a background process
  assert.ok(waitFor(() => /last_run/.test(r.routineText()), { timeoutMs: 15000 }), 'and recorded its run');
  const wsl = r.calls('wsl.exe').map((c) => c.argv.at(-1));
  assert.ok(wsl.includes(`roadctl tick --as ${EXTERNAL} --kinds run --json`), `the external agent is asked for JSON: ${wsl}`);
  assert.ok(wsl.includes(`roadctl tick --as ${HERMES} --kinds run --prompt`), 'the Hermes monitor still shows the prompt text to Hermes');
  const ssh = r.calls('ssh');
  assert.equal(ssh.length, 1);
  assert.equal(ssh[0].argv[0], 'work-notebook');
  const run = r.work('claude')[0];
  const at = (flag) => run.argv[run.argv.indexOf(flag) + 1];
  assert.equal(at('--model'), 'haiku', 'the model comes from the JSON item');
  assert.equal(at('--max-turns'), '30');
  assert.equal(run.argv.at(-2), '--');
  assert.match(run.argv.at(-1), /^RUN my-app\/atom-status Collect MR status$/m, 'the remote roadctl built the prompt');
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(r.dir), 'claude starts in $HOME of the remote host');
  // a5: the permission list is narrowed to the roadctl subcommands the routine prompt names
  const allow = JSON.parse(at('--settings')).permissions.allow;
  assert.ok(!allow.includes('Bash(roadctl:*)'), 'not all of roadctl');
  assert.ok(allow.every((rule) => rule === 'Read' || /^Bash\(roadctl [a-z]+( [a-z-]+)?:\*\)$/.test(rule)), `every Bash rule names a subcommand: ${allow}`);
  for (const sub of ['routine done', 'limits --check', 'log', 'delegate', 'save', 'show']) assert.ok(allow.includes(`Bash(roadctl ${sub}:*)`), sub);
  for (const forbidden of ['approve', 'done', 'accept', 'return', 'claim', 'report', 'review', 'autonomy', 'routine on', 'hook']) assert.ok(!allow.some((rule) => rule.startsWith(`Bash(roadctl ${forbidden}`)), `${forbidden} is not allowed`);
  assert.match(fs.readFileSync(path.join(r.dir, '.local', 'state', 'road-map-journal', 'external-routine.log'), 'utf8'), /^== \S+ my-app\/atom-status$/m);
});

test('hermes-routines-tick.py: claude -p runs under timeout (ROAD_CLAUDE_TIMEOUT, default 30m); a hanging run is killed', NEEDS, () => {
  const src = fs.readFileSync(path.join(EXAMPLES, 'hermes-routines-tick.py'), 'utf8');
  assert.match(src, /exec timeout --kill-after=\d+s "\$6" claude -p /, 'claude -p is wrapped in timeout');
  assert.match(src, /ROAD_CLAUDE_TIMEOUT", "30m"/);
  assert.doesNotMatch(src.replace(/#.*$/gm, ''), /Bash\(roadctl:\*\)/, 'no blanket roadctl rule in the code');
  const r = rig();
  r.routine(EXTERNAL);
  r.ok(['limits', '--check', EXTERNAL]); // fills the limits cache: the hanging fake must not be asked for a probe
  hermesRoutines(r, { FAKE_CLAUDE_MODE: 'hang', ROAD_CLAUDE_TIMEOUT: '1' });
  assert.ok(waitFor(() => r.work('claude').length === 1, { timeoutMs: 15000 }), 'started');
  const pid = r.work('claude')[0].pid;
  assert.equal(waitFor(() => !alive(pid), { timeoutMs: 15000 }), true, 'killed by timeout after one second'); // real time: a process
  const bad = hermesRoutines(r, { ROAD_CLAUDE_TIMEOUT: '30 minutes' });
  assert.notEqual(bad.status, 0, 'a timeout that timeout(1) would not understand is refused up front');
  assert.match(bad.stderr, /ROAD_CLAUDE_TIMEOUT must look like/);
});

test('hermes-routines-tick.py reads JSON, not prompt text: no text parsing in the examples, a text answer or broken JSON launches nothing', NEEDS, () => {
  for (const name of fs.readdirSync(EXAMPLES)) {
    const src = fs.readFileSync(path.join(EXAMPLES, name), 'utf8');
    assert.doesNotMatch(src, /ENTRY_RE|previous run|: file |; model |re\.compile\(|re\.search\(/, `${name} does not parse the text of a tick`);
  }
  const r = rig();
  const text = 'tick claude-code@work-notebook: work\nRUN my-app/atom-status Collect MR status\nlimits: claude allowed\n  my-app/atom-status: file /b/routines/a.md; model haiku; env laptop; previous run: never\n';
  const old = hermesRoutines(r, { FAKE_WSL_EXE_MODE: 'ok', FAKE_STDOUT: text });
  assert.equal(r.calls('ssh').length, 0, 'the old text format is not parsed any more');
  assert.match(old.stderr, /not what this script expects/);
  const broken = hermesRoutines(r, { FAKE_WSL_EXE_MODE: 'ok', FAKE_STDOUT: '{"items": [{"kind": "RUN"}]}\n' });
  assert.equal(r.calls('ssh').length, 0);
  assert.match(broken.stderr, /not what this script expects/);
  const other = hermesRoutines(r, { FAKE_WSL_EXE_MODE: 'ok', FAKE_STDOUT: JSON.stringify({ agent: EXTERNAL, decision: 'work', limits: { provider: 'claude', state: 'allowed' }, items: [{ kind: 'TAKE', project: 'my-app', id: 'W-3', title: 't', delegate: {} }], sync: [] }) });
  assert.equal(other.status, 0);
  assert.equal(r.calls('ssh').length, 0, 'only RUN items launch a routine');
  // and a real tick --json of a due routine is what the example expects: the contract is checked on the real output
  r.routine(EXTERNAL);
  const j = JSON.parse(r.roadctl(['tick', '--as', EXTERNAL, '--kinds', 'run', '--json']).stdout);
  assert.deepEqual(tickJsonProblems(j), []);
  assert.deepEqual(j.items.map((i) => [i.kind, i.project, i.id, i.routine.model]), [['RUN', 'my-app', 'atom-status', 'haiku']]);
});
