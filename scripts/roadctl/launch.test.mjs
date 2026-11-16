// Launch description (P5.7): `roadctl routine launch`, `roadctl launch --card`, the local conductor.json, the doctor check.
// No model, no network: the executor is the fake `claude` of scripts/testkit, runs are fixtures in the run ledger or `sh` stubs under `supervise`.
// Run: node --test scripts/roadctl/launch.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAKES_SKIP, installFakes, readCalls } from '../testkit/fakes.mjs';
import { wallClock } from '../testkit/time.mjs';
import { doctorJsonProblems } from '../testkit/doctor-schema.mjs';
import { validateConductor } from './launch.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(scripts, 'roadctl.mjs');
const EXAMPLE_BOARD = path.join(scripts, '..', 'examples', 'board-example', 'board');
const DOCS = fs.readFileSync(path.join(scripts, '..', 'docs', 'roadctl.md'), 'utf8');
const ME = 'claude-code@home-wsl';
const CARD = 'W-1';
const T = '2026-11-16T10:00:00Z';

const TEMPLATE = (dir) => ({ argv: ['claude', '-p', '--model', '{model}', '--strict-mcp-config', '--mcp-config', '{mcp_config}', '--settings', '{settings}', '--max-turns', '{max_turns}', '--output-format', 'json'], mcp_config: path.join(dir, 'mcp.json'), settings: path.join(dir, 'settings.json'), max_turns: 30, env: ['HOME', 'LAUNCH_TEST_TOKEN'] });
const PROFILES = {
  worker: { agent: ME, model: 'model-a', attempt: { timeout: '30m', turns: 40 }, card: { timeout: '2h' }, strong: 'strong' },
  strong: { agent: ME, model: 'model-b', attempt: { timeout: '45m' } },
};

/** A throwaway workspace with the example board, fakes on PATH and a local conductor.json (written with mode 0600 unless `conductor: false`). */
function rig({ conductor = true, profiles = PROFILES } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-launch-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  const cfg = path.join(board, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), requires: '0.6.0' }));
  const bin = installFakes(path.join(dir, 'bin'), { extra: { roadctl: `exec '${process.execPath}' '${SELF}' "$@"` } });
  const state = path.join(dir, 'state', 'road-map-journal');
  const confDir = path.join(dir, 'config', 'road-map-journal');
  const file = path.join(confDir, 'conductor.json');
  const log = path.join(dir, 'calls.jsonl');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'config'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: path.join(dir, 'no-registry.json'), ROADCTL_NOW: T, ROADCTL_HOST: 'testhost', FAKE_LOG: log, LAUNCH_TEST_TOKEN: 'sk-secret-value-123' };
  delete env.FAKE_MODE;
  const roadctl = (args, over = {}, input) => spawnSync(process.execPath, [SELF, ...args], { cwd: ws, encoding: 'utf8', env: { ...env, ...over }, input });
  const ok = (args, input) => {
    const r = roadctl(args, {}, input);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  const writeConductor = (c = { version: 1, templates: { 'claude-code': TEMPLATE(dir) }, profiles }, mode = 0o600) => {
    fs.mkdirSync(confDir, { recursive: true });
    fs.writeFileSync(file, typeof c === 'string' ? c : JSON.stringify(c));
    fs.chmodSync(file, mode);
  };
  if (conductor) writeConductor();
  fs.writeFileSync(path.join(dir, 'mcp.json'), '{"mcpServers":{}}');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  const routine = (id = 'mr-status', { timeout } = {}) => {
    ok(['routine', 'new', id, `Routine ${id}`, '--agent', ME, '--model', 'haiku', '--env', 'laptop', '--every', '2h', '--board', board]);
    if (timeout) { // before `routine on`: the timeout is under the approval hash
      const f = path.join(board, 'routines', `${id}.md`);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^(every:.*)$/m, `$1\ntimeout: ${timeout}`));
    }
    ok(['routine', 'on', id, '--by', 'Owner', '--source', 'chat 2026-11-16', '--board', board]);
    ok(['autonomy', 'routines', 'on', '--by', 'Owner', '--board', board]);
  };
  const launch = (id = 'mr-status', over = {}) => roadctl(['routine', 'launch', id, '--json', '--board', board], over);
  const card = (profile, over = {}) => roadctl(['launch', '--card', CARD, '--profile', profile, '--json', '--board', board], over);
  /** Fixture: a finished run of the card in the run ledger (a begin line and an end line). */
  let n = 0;
  const run = ({ model, outcome = 'failed', duration_s = 600, usage, source = 'supervisor', open = false }) => {
    const run_id = `r-fix${++n}`;
    const lines = [{ event: 'begin', run_id, kind: 'task', id: CARD, project: 'my-app', agent: ME, model, host: 'testhost', source, started: `2026-11-16T0${n}:00:00Z`, outcome: 'started', attempt: n, roadctl: '0.7.0' }];
    if (!open) lines.push({ event: 'end', run_id, finished: `2026-11-16T0${n}:30:00Z`, outcome, duration_s, reason: null, ...(usage ? { usage } : {}) });
    fs.mkdirSync(state, { recursive: true });
    fs.appendFileSync(path.join(state, 'runs.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    return run_id;
  };
  const stateFiles = () => (fs.existsSync(state) ? fs.readdirSync(state).sort().map((f) => `${f}:${fs.statSync(path.join(state, f)).size}`) : []);
  return { dir, ws, board, state, file, env, log, roadctl, ok, writeConductor, routine, launch, card, run, stateFiles, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const withRig = (opts, fn) => async () => {
  const r = rig(typeof opts === 'function' ? {} : opts);
  try { await (typeof opts === 'function' ? opts : fn)(r); } finally { r.cleanup(); }
};
const json = (r) => { assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); };
const refused = (r, re) => { assert.equal(r.status, 1, `exit ${r.status}: ${r.stderr}${r.stdout}`); assert.match(r.stderr, re); assert.equal(r.stdout, ''); };

// ---------------------------------------------------------------- a1: strict MCP, max_turns, the prompt only in stdin

test('P5.7 a1: routine launch for the fake claude gives a strict-MCP argv with the turn cap; the prompt is stdin only (the stub records argv and stdin)', FAKES_SKIP, withRig((r) => {
  r.routine();
  const d = json(r.launch());
  assert.deepEqual(d.argv, ['claude', '-p', '--model', 'haiku', '--strict-mcp-config', '--mcp-config', path.join(r.dir, 'mcp.json'), '--settings', path.join(r.dir, 'settings.json'), '--max-turns', '30', '--output-format', 'json']);
  assert.match(d.stdin, /routine done mr-status --as claude-code@home-wsl/);
  assert.ok(!d.argv.some((a) => a.includes('mr-status') || a.includes('You are')), 'no prompt text in argv');
  assert.equal(d.max_turns, 30);
  assert.equal(d.template, 'claude-code');
  assert.deepEqual(d.reasons, []);
  // a launcher runs it: the fake records exactly this argv and this stdin
  const run = spawnSync(d.argv[0], d.argv.slice(1), { input: d.stdin, encoding: 'utf8', env: r.env });
  assert.equal(run.status, 0, run.stderr);
  const [call] = readCalls(r.log, 'claude');
  assert.deepEqual(call.argv, d.argv.slice(1));
  assert.equal(call.stdin, d.stdin);
}));

test('P5.7 a1: the environment is printed by NAME only, never by value; a {prompt} placeholder or a bad env entry is refused', FAKES_SKIP, withRig((r) => {
  r.routine();
  const res = r.launch();
  assert.deepEqual(json(res).env, ['HOME', 'LAUNCH_TEST_TOKEN']);
  assert.ok(!res.stdout.includes('sk-secret-value-123') && !res.stderr.includes('sk-secret-value-123'), 'no value in the output');
  assert.throws(() => validateConductor({ templates: { x: { argv: ['claude', '{prompt}'] } } }), /prompt always goes to stdin/);
  assert.throws(() => validateConductor({ templates: { x: { argv: ['claude'], env: ['A=b'] } } }), /NAMES/);
  assert.throws(() => validateConductor({ templates: { x: { argv: ['claude', '{nope}'] } } }), /not a placeholder/);
  r.writeConductor({ templates: { 'claude-code': { argv: ['claude', '--mcp-config', '{mcp_config}'] } } });
  refused(r.launch(), /uses \{mcp_config\}, but no value/); // a placeholder without a value is not guessed
}));

// ---------------------------------------------------------------- a2: only the local file

test('P5.7 a2: a launch string in the registry is ignored with a warning; the template comes only from the local file', FAKES_SKIP, withRig({ conductor: false }, (r) => {
  r.routine();
  const registry = path.join(r.dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ version: 1, agents: { [ME]: { host: 'claude-code', roles: ['worker'], launch: 'evil-cmd --do-it "{prompt}"' } } }));
  const over = { ROADCTL_REGISTRY: registry };
  refused(r.launch('mr-status', over), /no launch template for claude-code@home-wsl|no .*conductor\.json/); // the registry alone gives nothing to run
  r.writeConductor();
  const res = r.launch('mr-status', over);
  const d = json(res);
  assert.equal(d.argv[0], 'claude');
  assert.ok(!JSON.stringify(d).includes('evil-cmd'));
  assert.match(res.stderr, /warning: the registry .* has a "launch" for claude-code@home-wsl; it is ignored/);
}));

test('P5.7 a2: a conductor.json inside a git work tree, or writable by others, is refused', FAKES_SKIP, withRig((r) => {
  r.routine();
  r.writeConductor(undefined, 0o664);
  refused(r.launch(), /writable by group or others/);
  r.writeConductor(undefined, 0o600);
  json(r.launch());
  const repo = path.join(r.dir, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(repo, 'cfg', 'road-map-journal'), { recursive: true });
  fs.copyFileSync(r.file, path.join(repo, 'cfg', 'road-map-journal', 'conductor.json'));
  refused(r.launch('mr-status', { XDG_CONFIG_HOME: path.join(repo, 'cfg') }), /inside the git work tree/);
}));

// ---------------------------------------------------------------- a3: the timeout of the routine reaches supervise

test('P5.7 a3: the timeout in the output is the routine\'s timeout and supervise enforces that value (stub: the ledger deadline, the prompt reaches the command through --stdin)', FAKES_SKIP, withRig((r) => {
  r.routine('mr-status', { timeout: '20m' });
  const d = json(r.launch());
  assert.equal(d.timeout_s, 1200);
  assert.deepEqual(d.supervise_argv.slice(0, 7), ['supervise', '--routine', 'mr-status', '--as', ME, '--timeout', '1200s']);
  const got = path.join(r.dir, 'stdin.txt');
  const res = r.roadctl([...d.supervise_argv, 'sh', '-c', `cat > '${got}'`], {}, d.stdin);
  assert.equal(res.status, 1, res.stdout + res.stderr); // the stub reports no result: failed, which is not what is checked here
  const [run] = JSON.parse(r.roadctl(['runs', '--json', '-n', '5']).stdout);
  assert.equal((Date.parse(run.deadline) - Date.parse(run.started)) / 1000, 1200, 'supervise took the described timeout');
  assert.equal(fs.readFileSync(got, 'utf8'), d.stdin, 'the prompt arrived on stdin');
  // a routine without its own timeout: the default cap of every routine (2h)
  r.routine('plain');
  assert.equal(json(r.launch('plain')).timeout_s, 7200);
}));

test('P5.7 a3: --detach keeps the prompt: the detached supervisor inherits the stdin pipe', FAKES_SKIP, withRig(async (r) => {
  r.routine();
  const d = json(r.launch());
  const got = path.join(r.dir, 'detached-stdin.txt');
  const res = r.roadctl([...d.supervise_argv.slice(0, -1), '--detach', '--', 'sh', '-c', `cat > '${got}'`], {}, d.stdin);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const end = wallClock() + 8000; // a detached process: real time
  while (wallClock() < end && !(fs.existsSync(got) && fs.readFileSync(got, 'utf8') === d.stdin)) await new Promise((x) => setTimeout(x, 50));
  assert.equal(fs.readFileSync(got, 'utf8'), d.stdin);
}));

// ---------------------------------------------------------------- a4: no template, no launch

test('P5.7 a4: no template for the agent: refusal with a hint, exit 1, nothing runs and nothing is written', FAKES_SKIP, withRig({ conductor: false }, (r) => {
  r.routine();
  const before = r.stateFiles();
  refused(r.launch(), /no .*conductor\.json.*nothing starts without a local template/);
  r.writeConductor({ version: 1, templates: { codex: TEMPLATE(r.dir) } });
  refused(r.launch(), /no launch template for claude-code@home-wsl: .* has no templates\.claude-code@home-wsl or templates\.claude-code/);
  assert.equal(readCalls(r.log, 'claude').length, 0, 'no agent was started');
  assert.deepEqual(r.stateFiles(), before, 'the description writes nothing');
  r.writeConductor('{ not json');
  const bad = r.launch();
  assert.equal(bad.status, 2, 'an invalid file is a configuration error, not a refusal');
  assert.match(bad.stderr, /conductor\.json/);
}));

// ---------------------------------------------------------------- a5: doctor

const checksOf = (r, extra = [], over = {}) => {
  const res = r.roadctl(['doctor', '--json', ...extra], over);
  const d = JSON.parse(res.stdout);
  assert.deepEqual(doctorJsonProblems(d), []);
  return d.checks.filter((c) => c.id.startsWith('launch-template'));
};

test('P5.7 a5: doctor checks the local launch file and its permissions: absent, fine, unsafe, invalid, in git, a missing file it names', FAKES_SKIP, withRig({ conductor: false }, (r) => {
  assert.deepEqual(checksOf(r).map((c) => c.status), ['skip']);
  r.writeConductor();
  const ok = checksOf(r, ['--agent', ME]);
  assert.deepEqual(ok.map((c) => [c.id, c.status]), [['launch-templates', 'ok'], ['launch-template', 'ok']]);
  const noTemplate = checksOf(r, ['--agent', 'codex@home-wsl']);
  assert.deepEqual(noTemplate.map((c) => [c.id, c.status]), [['launch-templates', 'ok'], ['launch-template', 'warn']]);
  r.writeConductor(undefined, 0o666);
  const unsafe = checksOf(r);
  assert.equal(unsafe[0].status, 'fail');
  assert.match(unsafe[0].detail, /writable by group or others/);
  assert.match(unsafe[0].hint, /chmod go-w/);
  r.writeConductor('{ "templates": 3 }');
  assert.equal(checksOf(r)[0].status, 'fail');
  r.writeConductor({ version: 1, templates: { 'claude-code': { ...TEMPLATE(r.dir), mcp_config: path.join(r.dir, 'gone.json') } } });
  const gone = checksOf(r)[0];
  assert.equal(gone.status, 'warn');
  assert.match(gone.detail, /do not exist/);
  const repo = path.join(r.dir, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(repo, 'cfg', 'road-map-journal'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'cfg', 'road-map-journal', 'conductor.json'), JSON.stringify({ templates: {} }), { mode: 0o600 });
  assert.equal(checksOf(r, [], { XDG_CONFIG_HOME: path.join(repo, 'cfg') })[0].status, 'fail');
}));

// ---------------------------------------------------------------- a6: docs

test('P5.7 a6: the docs describe the local file, the rule that roadctl does not run a command from git, and the Hermes tool set', () => {
  const section = DOCS.slice(DOCS.indexOf('## Launch description'), DOCS.indexOf('## What was tested'));
  assert.ok(section.length > 1000);
  assert.match(section, /conductor\.json/);
  assert.match(section, /`roadctl` does not run a command taken from git/);
  assert.match(section, /\*\*Hermes\.\*\*[^\n]*Hermes job itself/);
  assert.match(section, /--strict-mcp-config/);
  assert.match(section, /deferred P5\.20/); // a8: current limits and reserves vs the deferred money cap
});

// ---------------------------------------------------------------- a7: profiles, the remainder of the second attempt

test('P5.7 a7: a profile gives the attempt and card limits, model and tools; the second attempt gets only the measurable remainder, with no reset (fixtures)', FAKES_SKIP, withRig((r) => {
  const first = json(r.card('worker'));
  assert.deepEqual([first.attempt, first.model, first.timeout_s, first.max_turns], [1, 'model-a', 1800, 40]);
  assert.deepEqual(first.card, { limit_s: 7200, used_s: 0, remaining_s: 7200, limit_turns: null });
  assert.deepEqual(first.escalation, { to: 'strong', offered: true, reason: 'the strong profile is permitted and the card has a time limit' });
  assert.deepEqual(first.supervise_argv.slice(0, 9), ['supervise', '--card', CARD, '--as', ME, '--model', 'model-a', '--timeout', '1800s']);
  const id1 = r.run({ model: 'model-a', outcome: 'failed', duration_s: 1500, source: 'agent' }); // the command reported its own failure: a known outcome
  const second = json(r.card('strong'));
  assert.deepEqual([second.attempt, second.model, second.timeout_s, second.max_turns], [2, 'model-b', 2700, 30]);
  assert.deepEqual(second.card, { limit_s: 7200, used_s: 1500, remaining_s: 5700, limit_turns: null });
  assert.deepEqual(second.previous, [{ run_id: id1, model: 'model-a', outcome: 'failed', duration_s: 1500 }]);
  assert.equal(second.escalation, null);
  // the cap of the attempt is cut to what is left of the card: nothing is issued again
  r.run({ model: 'model-b', outcome: 'escalated', duration_s: 4500, source: 'agent' });
  const third = json(r.card('strong'));
  assert.deepEqual([third.card.used_s, third.card.remaining_s, third.timeout_s], [6000, 1200, 1200]);
}));

test('P5.7 a7: a card turn limit caps the first attempt; turns are not measured, so it refuses a second one', FAKES_SKIP, withRig({ profiles: { ...PROFILES, worker: { ...PROFILES.worker, card: { timeout: '2h', turns: 25 } } } }, (r) => {
  const first = json(r.card('worker'));
  assert.deepEqual([first.card.limit_turns, first.max_turns], [25, 25]); // the smaller of the attempt (40) and the card (25) limit
  r.run({ model: 'model-a', outcome: 'failed', duration_s: 600, source: 'agent' });
  refused(r.card('strong'), /turns used by the earlier attempts are not measured/);
}));

// ---------------------------------------------------------------- a8: no limits, no escalation

test('P5.7 a8: without limits or a measurable remainder no escalation is offered; the current limits are told apart from the deferred money cap', FAKES_SKIP, withRig({ profiles: { worker: { agent: ME, model: 'model-a', attempt: { timeout: '30m' }, strong: 'strong' }, strong: { agent: ME, model: 'model-b', attempt: { timeout: '45m' } }, plain: { agent: ME, model: 'model-a', attempt: { timeout: '30m' } } } }, (r) => {
  const first = json(r.card('worker'));
  assert.deepEqual(first.escalation, { to: 'strong', offered: false, reason: 'no card time limit is set, so no automatic escalation' });
  assert.equal(first.timeout_s, 1800);
  assert.equal(json(r.card('plain')).escalation.reason, 'no strong profile is permitted');
  r.run({ model: 'model-a', outcome: 'failed', duration_s: 600, source: 'agent' });
  // the profile with the strong target but no card limit: refused, not guessed
  refused(r.card('strong'), /no card time limit is set for profile worker: automatic escalation is not offered/);
}));

test('P5.7 a8: a second attempt must come from the strong profile the first attempt\'s own profile permits', FAKES_SKIP, withRig((r) => {
  r.run({ model: 'some-other-model', outcome: 'failed', duration_s: 100, source: 'agent' });
  refused(r.card('strong'), /no profile with the model of the first attempt \(some-other-model\) permits strong/);
  refused(r.card('worker'), /no profile with the model of the first attempt/); // worker is not anybody's strong profile
}));

test('P5.7 a8: a used-up card limit and an unmeasurable duration refuse the second attempt', FAKES_SKIP, withRig((r) => {
  r.run({ model: 'model-a', outcome: 'failed', duration_s: 7300, source: 'agent' });
  refused(r.card('strong'), /card limit is used up/);
  fs.rmSync(path.join(r.state, 'runs.jsonl'));
  r.run({ model: 'model-a', outcome: 'failed', duration_s: null, source: 'agent' });
  refused(r.card('strong'), /time used by the earlier attempts cannot be measured/);
}));

// ---------------------------------------------------------------- a9: two attempts of one card

test('P5.7 a9: a live first run or an unknown outcome blocks the second attempt (fixtures); a known outcome does not', FAKES_SKIP, withRig((r) => {
  const live = r.run({ model: 'model-a', open: true });
  refused(r.card('strong'), new RegExp(`${live}: started\\)`));
  refused(r.card('worker'), /live or its outcome is unknown/); // the same card is not described again over a live run
  fs.rmSync(path.join(r.state, 'runs.jsonl'));
  for (const outcome of ['crashed', 'timeout', 'aborted']) {
    r.run({ model: 'model-a', outcome, duration_s: 100 });
    refused(r.card('strong'), /outcome is unknown/);
    fs.rmSync(path.join(r.state, 'runs.jsonl'));
  }
  r.run({ model: 'model-a', outcome: 'failed', duration_s: 100, usage: { exit_code: 0, tail: '' } }); // the supervisor wrote it: the command reported nothing
  refused(r.card('strong'), /outcome is unknown/);
  fs.rmSync(path.join(r.state, 'runs.jsonl'));
  r.run({ model: 'model-a', outcome: 'escalated', duration_s: 100, source: 'agent' });
  assert.equal(json(r.card('strong')).attempt, 2);
}));

test('P5.7 a9: two attempts keep one card budget and the models they really ran under; a real supervised run that reports nothing blocks the next (supervise --model)', FAKES_SKIP, withRig((r) => {
  const a1 = json(r.card('worker'));
  const res = r.roadctl([...a1.supervise_argv, 'sh', '-c', 'exit 0']);
  assert.equal(res.status, 1, res.stdout + res.stderr); // no result reported: failed, outcome unknown
  const [run] = JSON.parse(r.roadctl(['runs', '--json', '-n', '5']).stdout);
  assert.deepEqual([run.kind, run.model], ['task', 'model-a'], 'the actual model is in the ledger');
  refused(r.card('strong'), /outcome is unknown/);
  // two earlier attempts: their durations add up in the one card budget, and both models are listed with the new one
  fs.rmSync(path.join(r.state, 'runs.jsonl'));
  r.run({ model: 'model-a', outcome: 'failed', duration_s: 1000, source: 'agent' });
  r.run({ model: 'model-b', outcome: 'failed', duration_s: 500, source: 'agent' });
  const third = json(r.card('strong'));
  assert.deepEqual([third.attempt, third.card.used_s, third.card.remaining_s], [3, 1500, 5700]);
  assert.deepEqual(third.models, ['model-a', 'model-b', 'model-b']);
}));

test('P5.7 a9: the description decides nothing and writes nothing: no escalation policy lives here', FAKES_SKIP, withRig((r) => {
  r.run({ model: 'model-a', outcome: 'failed', duration_s: 100, source: 'agent' });
  const before = r.stateFiles();
  json(r.card('strong'));
  json(r.card('strong'));
  assert.deepEqual(r.stateFiles(), before);
  const source = fs.readFileSync(path.join(scripts, 'roadctl', 'launch.mjs'), 'utf8');
  assert.ok(!/appendLine|writeFileSync\(.*runs|beginRun|recordSkip/.test(source), 'launch.mjs has no ledger write');
  assert.match(DOCS, /Whether and when to escalate is the conductor's policy \(P5\.25, P5\.21\), not decided here/);
}));

test('P5.7: launch is read only in the help, has complete help and the usage error names both forms', () => {
  const h = spawnSync(process.execPath, [SELF, 'help', 'launch'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /roadctl routine launch ID/);
  const bad = spawnSync(process.execPath, [SELF, 'launch'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /roadctl launch --routine ID.*--card ID --profile NAME/);
});
