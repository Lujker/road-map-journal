// P5.13: the run summary fields, their Log form, `roadctl digest` (immediate and daily), the notification policy and the example job.
// Run: node --test scripts/roadctl/digest.test.mjs
// Nothing here starts a model or reaches a network: claude and wsl.exe are the fakes of scripts/testkit/, git is a local bare repository.
// Time: roadctl's clock is ROADCTL_NOW from the shared helper. The host name is fixed by ROADCTL_HOST per machine; no real host name is in a test.
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
import { clock, shift, T0 } from '../testkit/time.mjs';
import * as store from './run-store.mjs';
import { collectFields, formatLogText, LIMITS, parseLogText, parseProblemArg, renderSummary } from './run-summary.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(scripts, 'roadctl.mjs');
const EXAMPLES = path.join(scripts, '..', 'examples', 'scheduler');
const EXAMPLE_BOARD = path.join(scripts, '..', 'examples', 'board-example', 'board');
const DOCS = fs.readFileSync(path.join(scripts, '..', 'docs', 'roadctl.md'), 'utf8');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const ME = 'claude-code@home-wsl';
const WORKER = 'codex@home-wsl';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const lines = (s) => s.split('\n').filter((l) => l !== '');

/** The example board (language switched to English) as project my-app, an own state directory and clock; `extra` is config.json keys. */
function rig({ config = {}, host = 'home', root } = {}) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rc-digest-'));
  const ws = path.join(dir, 'ws');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(board, 'config.json'), 'utf8')), language: 'en', ...config }));
  return machine(dir, ws, board, host);
}

/** One machine: a working tree with the board, a state directory of its own, a roadctl command that sets that machine's environment. */
function machine(dir, ws, board, host, bin = installFakes(path.join(dir, `bin-${host}`), { extra: { roadctl: `exec '${process.execPath}' '${SELF}' "$@"` } })) {
  const state = path.join(dir, `state-${host}`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: state, XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'cfg'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10', ROADCTL_HOST: host, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', FAKE_LOG: path.join(dir, 'calls.jsonl'), ...clock(T0) };
  delete env.ROADCTL_RUN_ID;
  const run = (args, over = {}) => spawnSync(process.execPath, [SELF, ...args, '--board', board], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const ok = (args, over) => {
    const r = run(args, over);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  const at = (minutes) => clock(shift(minutes));
  const routineFile = (id = 'atom-status') => path.join(board, 'routines', `${id}.md`);
  const routine = (id = 'atom-status', header = '', agent = ME) => {
    ok(['routine', 'new', id, 'Collect MR status', '--agent', agent, '--model', 'haiku', '--env', 'laptop', '--every', '2h']);
    if (header) fs.writeFileSync(routineFile(id), fs.readFileSync(routineFile(id), 'utf8').replace(/^every: .*$/m, (m) => `${m}\n${header}`));
    ok(['routine', 'on', id, '--by', 'Owner', '--source', 'chat 2026-11-12']);
    ok(['autonomy', 'routines', 'on', '--by', 'Owner']);
  };
  const done = (args, over) => ok(['routine', 'done', 'atom-status', '--as', ME, ...args], over);
  const digest = (args = [], over) => ok(['digest', ...args], over).stdout;
  const digestJson = (args = [], over) => JSON.parse(ok(['digest', '--json', ...args], over).stdout);
  return { dir, ws, board, bin, env, state, host, run, ok, at, routineFile, routine, done, digest, digestJson, paths: store.ledgerPaths(env) };
}

// ---------------------------------------------------------------- a1: the fields, their limits, the Log form, the round trip

test('P5.13 a1: routine done without --did refuses on a board that requires a summary; with the fields it writes a Log line that digest reads back into the same fields', FAKES_SKIP, () => {
  const r = rig({ config: { summary: 'required' } });
  r.routine();
  const no = r.run(['routine', 'done', 'atom-status', '--as', ME, '--result', 'ok', 'checked 3 things']);
  assert.equal(no.status, 1);
  assert.match(no.stderr, /needs --did/);
  assert.equal(r.run(['routine', 'done', 'atom-status', '--as', ME, '--result', 'ok', '--ask', 'x']).status, 2, 'other fields without --did and without text are a usage error');
  assert.equal(r.run(['routine', 'done', 'atom-status', '--as', ME, '--result', 'ok', '--ask', 'x', 'text']).status, 1, 'with text but no --did: refused');
  assert.doesNotMatch(fs.readFileSync(r.routineFile(), 'utf8'), /RUN ok/, 'nothing was recorded');
  r.done(['--result', 'escalated', '--did', 'checked 9 servers', '--did', 'restarted nothing', '--decision', 'left srv-3 alone', '--problem', 'permanent: disk-full: /var is full on srv-3', '--problem', 'transient: dns-timeout: one lookup failed', '--ask', 'free space or approve a bigger disk', '--not-checked', 'the backups']);
  const line = fs.readFileSync(r.routineFile(), 'utf8').split('\n').filter((l) => /^- \d{4}-.*RUN escalated/.test(l)).at(-1);
  assert.match(line, /RUN escalated: did: checked 9 servers; restarted nothing \| decision: left srv-3 alone \| problem: permanent: disk-full: \/var is full on srv-3; transient: dns-timeout: one lookup failed \| ask: free space or approve a bigger disk \| not-checked: the backups \[run=r-[0-9a-f]{12} host=home\]$/);
  assert.ok(line.length <= 1500 + '- 2026-11-10 [claude-code@home-wsl] RUN escalated: '.length, 'within the 1500 characters of the Log');
  const j = r.digestJson(['--dry-run']);
  assert.equal(j.events.length, 1);
  assert.deepEqual(j.events[0].fields, { did: ['checked 9 servers', 'restarted nothing'], decisions: ['left srv-3 alone'], problems: [{ kind: 'permanent', key: 'disk-full', text: '/var is full on srv-3' }, { kind: 'transient', key: 'dns-timeout', text: 'one lookup failed' }], needs_owner: 'free space or approve a bigger disk', not_checked: 'the backups' });
  // the local ledger got the same fields (one schema, once)
  const [run] = JSON.parse(r.ok(['runs', '--json']).stdout);
  assert.deepEqual([run.outcome, run.did, run.decisions, run.needs_owner, run.not_checked, run.problems.map((p) => p.key)], ['escalated', ['checked 9 servers', 'restarted nothing'], ['left srv-3 alone'], 'free space or approve a bigger disk', 'the backups', ['disk-full', 'dns-timeout']]);
  assert.deepEqual(runRecordProblems(run), []);
});

test('P5.13 a1: the old form keeps working on a board without the requirement (positional text only: same Log line as before); the pure functions round-trip', () => {
  const r = rig();
  r.routine();
  r.done(['--result', 'ok', 'checked 3 things']);
  const line = fs.readFileSync(r.routineFile(), 'utf8').split('\n').find((l) => /RUN ok/.test(l));
  assert.match(line, /^- 2026-11-10 \[claude-code@home-wsl\] RUN ok: checked 3 things$/, 'no trailer, no labels: exactly as before');
  assert.equal(r.digestJson(['--dry-run']).mode, 'immediate');
  // the positional text is the one did item when other fields are given without --did (not on a strict board)
  r.done(['--result', 'ok', 'checked again', '--ask', 'a question'], r.at(5));
  assert.match(fs.readFileSync(r.routineFile(), 'utf8'), /RUN ok: did: checked again \| ask: a question \[run=r-/);
  // pure: format then parse gives the same fields; values with the separators are cleaned first
  const c = collectFields({ did: ['a | b; c', 'second'], decision: 'one', problem: ['transient: k1: t1', 'unknown: k2: t2'], ask: 'q?', 'not-checked': 'n' }, '', {});
  assert.deepEqual(c.fields.did, ['a / b, c', 'second']);
  assert.deepEqual(parseLogText(formatLogText(c.fields)), { structured: true, fields: c.fields });
  assert.deepEqual(parseLogText('just words'), { structured: false, fields: { did: ['just words'], decisions: [], problems: [], needs_owner: null, not_checked: null } });
});

test('P5.13 a1: limits: too many or too long items are cut and the agent is told on stderr; a problem without a key gets one (and a warning); the longest possible line fits the Log', () => {
  const long = 'x'.repeat(300);
  const c = collectFields({ did: ['1', '2', '3', '4', long], decision: ['a', 'b', 'c', 'd'], problem: ['transient: k1: t', 'permanent: k2: t', 'unknown: k3: t', 'unknown: k4: t', 'unknown: k1: dup'], ask: [long, 'second'], 'not-checked': long }, '', {});
  assert.deepEqual(c.fields.did, ['1', '2', '3']);
  assert.equal(c.fields.decisions.length, 3);
  assert.deepEqual(c.fields.problems.map((p) => p.key), ['k1', 'k2', 'k3']);
  assert.equal(c.fields.needs_owner.length, LIMITS.ask[1]);
  assert.equal(c.fields.not_checked.length, LIMITS.notChecked[1]);
  assert.ok(c.warnings.length >= 4, c.warnings.join('\n'));
  const full = collectFields({ did: [long, long, long], decision: [long, long, long], problem: ['transient: k1: ' + long, 'permanent: k2: ' + long, 'unknown: k3: ' + long], ask: long, 'not-checked': long }, '', {});
  assert.ok(full.fields.did.every((x) => x.length === 120) && full.fields.decisions.every((x) => x.length === 160));
  const text = formatLogText(full.fields, 1400);
  assert.ok(text.length <= 1400, `${text.length}`);
  assert.equal(parseLogText(text).fields.problems.length, 3, 'the cut keeps every item and every label');
  const noKey = parseProblemArg('transient: the disk is full', () => {});
  assert.deepEqual([noKey.kind, noKey.text, /^p-[0-9a-f]{8}$/.test(noKey.key)], ['transient', 'the disk is full', true]);
  assert.equal(parseProblemArg('the disk is full', () => {}).kind, 'unknown');
  assert.equal(collectFields({}, 'x', {}).structured, false);
  assert.match(collectFields({}, 'x', { strict: true }).error, /--did/);
});

// ---------------------------------------------------------------- a2, a3, a4: digest, once, policy, keys

/** Two machines (two clones of one repository): `a` is home, `b` is the laptop. */
function pair() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-digest-pair-'));
  const server = path.join(base, 'server.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', server);
  const a = path.join(base, 'a');
  fs.mkdirSync(a);
  const bd = (w) => path.join(w, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, bd(a), { recursive: true });
  fs.writeFileSync(path.join(bd(a), 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(bd(a), 'config.json'), 'utf8')), language: 'en' }));
  git(a, 'init', '-q', '-b', 'main');
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'init');
  git(a, 'remote', 'add', 'origin', server);
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = path.join(base, 'b');
  git(base, 'clone', '-q', server, b);
  const bin = installFakes(path.join(base, 'bin'), { extra: { roadctl: `exec '${process.execPath}' '${SELF}' "$@"` } });
  return { base, server, home: machine(base, a, bd(a), 'home', bin), laptop: machine(base, b, bd(b), 'laptop', bin) };
}

test('P5.13 a2: a routine that ended escalated on the laptop (second clone) is told by the home digest after pull exactly once; the host is a trailer, not a guess', FAKES_SKIP, () => {
  const { home, laptop } = pair();
  home.routine();
  assert.equal(JSON.parse(home.ok(['save', '--json']).stdout).status, 'pushed');
  assert.equal(JSON.parse(laptop.ok(['pull', '--json']).stdout).status, 'pulled');
  const done = laptop.done(['--result', 'escalated', '--did', 'checked 9 servers', '--problem', 'permanent: disk-full: /var is full on srv-3', '--ask', 'free space or approve a bigger disk'], laptop.at(30));
  assert.match(done.stdout, /roadctl routine done: recorded/);
  assert.equal(home.digest([], home.at(31)), '', 'nothing before the pull: the run is only on the laptop and in git');
  assert.equal(JSON.parse(home.ok(['pull', '--json']).stdout).status, 'pulled');
  const first = home.digest([], home.at(32));
  assert.equal(lines(first).length, 4, first);
  assert.match(first, /^routine my-app\/atom-status: ESCALATED \(claude-code@home-wsl\)$/m);
  assert.match(first, /^did: checked 9 servers$/m);
  assert.match(first, /^problem: permanent disk-full: \/var is full on srv-3$/m);
  assert.match(first, /^needs from you: free space or approve a bigger disk$/m);
  assert.doesNotMatch(first, /not published/, 'the run is in git: it came from the server');
  assert.equal(home.digest([], home.at(33)), '', 'told once');
  assert.equal(home.digest([], home.at(34)), '');
  // another state name (another channel) is told on its own
  assert.equal(lines(home.digest(['--since-state', 'vk'], home.at(35))).length, 4);
  // a dry run prints without marking
  const dry = pair();
  dry.home.routine();
  dry.home.ok(['save']);
  dry.laptop.ok(['pull']);
  dry.laptop.done(['--result', 'failed', '--did', 'x'], dry.laptop.at(30));
  dry.home.ok(['pull']);
  assert.match(dry.home.digest(['--dry-run'], dry.home.at(31)), /FAILED/);
  assert.match(dry.home.digest([], dry.home.at(32)), /FAILED/, 'still unsent after the dry run');
  assert.equal(dry.home.digest([], dry.home.at(33)), '');
});

test('P5.13 a3: ok is silent under notify: problems, shown in --daily; notify: always tells every run; notify: never tells nothing at once', FAKES_SKIP, () => {
  const r = rig();
  r.routine('atom-status');
  r.done(['--result', 'ok', '--did', 'checked 3 things'], r.at(5));
  assert.equal(r.digest([], r.at(6)), '', 'an ok run of a routine on the default policy is not news');
  const daily = r.digest(['--daily'], r.at(7));
  assert.match(daily, /^roadctl daily overview 2026-11-10$/m);
  assert.match(daily, /^my-app\/atom-status: ok 2m ago - checked 3 things$/m);
  r.routine('chatty', 'notify: always');
  r.done(['--result', 'ok', '--did', 'looked'], r.at(8));
  ok2(r, 'chatty', ['--result', 'ok', '--did', 'looked at it'], r.at(9));
  const always = r.digest([], r.at(10));
  assert.match(always, /^routine my-app\/chatty: ok/m);
  assert.match(always, /^did: looked at it$/m);
  r.routine('quiet', 'notify: never');
  ok2(r, 'quiet', ['--result', 'failed', '--did', 'broke'], r.at(11));
  assert.equal(r.digest([], r.at(12)), '', 'never: silent even for a failure');
  assert.match(r.digest(['--daily'], r.at(13)), /^my-app\/quiet: FAILED/m, 'but the daily overview shows it');
  // lint knows the key and its values
  const f = r.routineFile('quiet');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('notify: never', 'notify: sometimes'));
  assert.match(r.run(['lint', '--json']).stdout, /notify must be problems, always or never/);
});
const ok2 = (m, id, args, over) => m.ok(['routine', 'done', id, '--as', ME, ...args], over);

test('P5.13 a4: the same problem key in two runs is one message; a problem that went away is one line; a new key is a new message', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  const P = ['--problem', 'transient: dns-timeout: lookup of srv-3 failed'];
  r.done(['--result', 'ok', '--did', 'checked', ...P], r.at(5));
  const one = r.digest([], r.at(6));
  assert.match(one, /dns-timeout/);
  r.done(['--result', 'ok', '--did', 'checked again', ...P], r.at(130));
  assert.equal(r.digest([], r.at(131)), '', 'the same key: nothing new');
  r.done(['--result', 'ok', '--did', 'checked a third time'], r.at(260));
  assert.deepEqual(lines(r.digest([], r.at(261))), ['resolved: my-app/atom-status: dns-timeout'], 'gone: one line');
  assert.equal(r.digest([], r.at(262)), '');
  r.done(['--result', 'ok', '--did', 'checked', ...P], r.at(390));
  assert.match(r.digest([], r.at(391)), /dns-timeout/, 'it came back: told again');
  // an escalation is a problem too (key: the outcome); the next ok resolves it
  r.done(['--result', 'escalated', '--did', 'stuck'], r.at(520));
  assert.match(r.digest([], r.at(521)), /ESCALATED/);
  r.done(['--result', 'escalated', '--did', 'stuck again'], r.at(650));
  assert.equal(r.digest([], r.at(651)), '', 'still escalated, already told');
  // the same question twice is one message
  const Q = ['--ask', 'approve the bigger disk?'];
  r.done(['--result', 'ok', '--did', 'waiting', ...Q], r.at(780));
  const q = r.digest([], r.at(781));
  assert.match(q, /needs from you: approve the bigger disk\?/);
  assert.match(q, /resolved: my-app\/atom-status: escalated/);
  r.done(['--result', 'ok', '--did', 'still waiting', ...Q], r.at(910));
  assert.equal(r.digest([], r.at(911)), '');
});

test('P5.13: the first digest of a state name tells only the last two days; older lines and a line of 30 days ago are never told; a board that needs a newer roadctl is one requires: line', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  r.done(['--result', 'failed', '--did', 'old failure'], { ...clock('2026-11-01T10:00:00Z'), ROADCTL_DATE: '2026-11-01' });
  assert.equal(r.digest([], clock('2026-11-10T10:00:00Z')), '', 'nine days old: marked seen without a word');
  r.done(['--result', 'failed', '--did', 'recent failure'], r.at(5));
  assert.match(r.digest([], r.at(6)), /FAILED/);
  const cfg = path.join(r.board, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), requires: '99.0.0' }));
  const text = r.digest([], r.at(7));
  assert.equal(lines(text).length, 1);
  assert.equal(text.trimEnd(), `requires: my-app: board requires roadctl 99.0.0 or newer; this is ${rc.VERSION}`);
  assert.equal(r.digest([], r.at(8)), '', 'told once');
  assert.match(r.digest(['--daily'], r.at(9)), /^requires: my-app: board requires roadctl 99\.0\.0/m);
});

// ---------------------------------------------------------------- a5: overdue

test('P5.13 a5: a routine that has not run for twice its every inside its hours is OVERDUE in --daily; outside its hours it is not', FAKES_SKIP, () => {
  const r = rig();
  r.routine('atom-status', 'hours: daily 00:00-24:00 tz=UTC'); // every 2h
  r.done(['--result', 'ok', '--did', 'checked'], clock('2026-11-10T10:00:00Z'));
  assert.doesNotMatch(r.digest(['--daily'], clock('2026-11-10T13:00:00Z')), /OVERDUE/, '3h of 2h: late, not yet overdue');
  assert.match(r.digest(['--daily'], clock('2026-11-10T14:30:00Z')), /^my-app\/atom-status: OVERDUE, last run 5h ago \(every 2h\)$/m);
  const outside = rig();
  outside.routine('atom-status', 'hours: daily 08:00-12:00 tz=UTC');
  outside.done(['--result', 'ok', '--did', 'checked'], clock('2026-11-10T10:00:00Z'));
  const d = outside.digest(['--daily'], clock('2026-11-11T03:00:00Z')); // 17h later, outside the window
  assert.doesNotMatch(d, /OVERDUE/);
  assert.match(d, /^my-app\/atom-status: ok 17h ago/m);
  assert.match(outside.digest(['--daily'], clock('2026-11-11T09:00:00Z')), /OVERDUE/, 'inside the window again, still not run: overdue');
  // a switched-off routine has no line; a board switch that is off is one line
  outside.ok(['routine', 'off', 'atom-status', '--by', 'Owner']);
  assert.doesNotMatch(outside.digest(['--daily'], clock('2026-11-11T09:00:00Z')), /atom-status/);
  // never run: its own words, not overdue
  const fresh = rig();
  fresh.routine();
  assert.match(fresh.digest(['--daily']), /^my-app\/atom-status: never run$/m);
});

// ---------------------------------------------------------------- a6: the local ledger

test('P5.13 a6: crashed and skipped: busy from the local ledger reach the digest of this machine (crashed at once, the skip streak in the daily overview and under notify: always)', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  r.routine('chatty', 'notify: always');
  r.ok(['run', 'begin', 'atom-status', '--as', ME]);
  r.ok(['run', 'begin', 'chatty', '--as', ME]);
  for (let i = 0; i < 3; i++) store.recordSkip(r.env, { kind: 'routine', project: 'my-app', id: 'chatty', agent: ME, reason: 'busy', now: Date.parse(shift(60 + i)), version: rc.VERSION });
  const tick = spawnSync(process.execPath, [SELF, 'tick', '--as', ME, '--no-pull'], { cwd: r.ws, encoding: 'utf8', env: { ...r.env, ...r.at(200) } }); // past the deadline: both runs are marked crashed
  assert.ok([0, 4].includes(tick.status), tick.stderr);
  const now = r.digest([], r.at(201));
  assert.match(now, /^routine my-app\/atom-status: CRASHED \(claude-code@home-wsl, 200m\)$/m);
  assert.match(now, /^routine my-app\/chatty: CRASHED \(/m, 'crashed under always too');
  assert.match(now, /^routine my-app\/chatty: skipped busy x3$/m, 'a skip streak is news only under notify: always');
  assert.doesNotMatch(now, /atom-status: skipped/);
  const daily = r.digest(['--daily'], r.at(202));
  assert.match(daily, /^this machine, last 24h: crashed 2, skipped busy 3$/m);
  // another machine's ledger is not read: the laptop's digest has none of it
  const other = machine(r.dir, r.ws, r.board, 'laptop', r.bin);
  assert.doesNotMatch(other.digest(['--daily'], other.at(202)), /this machine/);
  assert.doesNotMatch(other.digest([], other.at(203)), /CRASHED/);
});

// ---------------------------------------------------------------- a7: the orchestrator and the delegated task

test('P5.13 a7: run done of the duty orchestrator and report of a delegated task give a summary of the same shape as routine done; the orchestrator\'s is local, the report goes to the card', FAKES_SKIP, () => {
  const r = rig();
  const f = ['--did', 'took W-3', '--did', 'accepted W-2', '--decision', 'W-4 waits', '--problem', 'permanent: lease: W-5 lease expired twice', '--ask', 'decide the scope of W-6', '--not-checked', 'W-7'];
  const orch = r.ok(['run', 'done', '--as', ME, '--result', 'escalated', ...f], r.at(10));
  const o = lines(orch.stdout);
  assert.ok(o.length <= 6 && o.length === 6, orch.stdout);
  assert.equal(o[0], `orchestrator ${ME}: ESCALATED`);
  assert.equal(o[1], 'did: took W-3; accepted W-2');
  assert.deepEqual(o.slice(2), ['decided: W-4 waits', 'problem: permanent lease: W-5 lease expired twice', 'needs from you: decide the scope of W-6', 'not checked: W-7']);
  const [run] = JSON.parse(r.ok(['runs', '--json']).stdout);
  assert.deepEqual([run.kind, run.id, run.project, run.outcome, run.did, run.needs_owner, run.writes], ['orchestrator', ME, null, 'escalated', ['took W-3', 'accepted W-2'], 'decide the scope of W-6', ['orchestrator']]);
  assert.deepEqual(runRecordProblems(run), []);
  assert.match(r.run(['run', 'done', '--as', ME, '--result', 'ok']).stderr, /--did/, 'run done needs --did');
  assert.equal(r.run(['run', 'done', '--as', ME, '--result', 'weird', '--did', 'x']).status, 2);
  // the digest of this machine tells it (the ledger is the only place an orchestrator run lives)
  const news = r.digest([], r.at(11));
  assert.match(news, new RegExp(`^orchestrator ${ME}: ESCALATED`, 'm'));
  assert.equal(r.digest([], r.at(12)), '');
  // report
  assert.equal(r.run(['delegate', 'W-3', '--to', WORKER, '--by', ME]).status, 0);
  r.ok(['claim', 'W-3', '--as', WORKER, '--lease', '30m'], r.at(20));
  const rep = r.ok(['report', 'W-3', '--as', WORKER, '--did', 'changed the exporter', '--did', 'ran the tests', '--problem', 'transient: flaky: one test flaked', '--ask', 'ok to merge?'], r.at(25));
  const p = lines(rep.stdout);
  assert.match(p[0], /^roadctl report: reported/);
  assert.deepEqual(p.slice(1), [`task my-app/W-3: ok (${WORKER}, 5m)`, 'did: changed the exporter; ran the tests', 'problem: transient flaky: one test flaked', 'needs from you: ok to merge? [not published: waits for roadctl save]']);
  const card = fs.readFileSync(path.join(r.board, 'cards', fs.readdirSync(path.join(r.board, 'cards')).find((x) => x.startsWith('W-3'))), 'utf8');
  assert.match(card, /REPORT: did: changed the exporter; ran the tests \| problem: transient: flaky: one test flaked \| ask: ok to merge\? \[run=r-[0-9a-f]{12} dur=300s host=home\]/);
  const [t] = JSON.parse(r.ok(['runs', '--json']).stdout).filter((x) => x.kind === 'task');
  assert.deepEqual([t.outcome, t.did, t.needs_owner, t.duration_s, t.writes], ['ok', ['changed the exporter', 'ran the tests'], 'ok to merge?', 300, ['card:W-3']]);
  // the report is news (a problem and a question); a plain old-form report is not
  const told = r.digest([], r.at(26));
  assert.match(told, /^task my-app\/W-3: ok/m);
  assert.match(told, /flaky/);
  assert.equal(r.digest([], r.at(27)), '');
});

// ---------------------------------------------------------------- a8: the owner's commands

test('P5.13 a8: the daily overview has a line about the owner\'s commands of the last 24 hours (the audit file is written by P5.3; this reads it)', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  assert.doesNotMatch(r.digest(['--daily']), /owner commands/, 'no audit file, no line');
  fs.mkdirSync(path.dirname(r.paths.dir + '/x'), { recursive: true });
  const rows = [
    { time: shift(-30), command: 'approve', target: 'P5.1', by: 'claude-code@home-wsl', outcome: 'ok' },
    { time: shift(-20), command: 'routine on', target: 'atom-status', by: 'hermes@home-host', outcome: 'refused' },
    { time: shift(-60 * 30), command: 'done', target: 'P5.0', by: 'someone', outcome: 'ok' }, // a day and a half ago: not in the period
    { time: 'not a time', command: 'x' },
  ];
  fs.writeFileSync(path.join(r.paths.dir, 'owner-commands.jsonl'), `${rows.map((x) => JSON.stringify(x)).join('\n')}\nbroken line\n`);
  const d = r.digest(['--daily']);
  assert.match(d, /^owner commands, last 24h: 2 \(approve P5\.1 by claude-code@home-wsl; routine on atom-status by hermes@home-host refused\)$/m);
});

test('P5.13 + P5.5: the daily overview names an active pause of this machine (one line), nothing for no pause or an expired one', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  assert.doesNotMatch(r.digest(['--daily']), /PAUSED/);
  fs.mkdirSync(r.paths.dir, { recursive: true });
  fs.writeFileSync(path.join(r.paths.dir, 'pause.json'), JSON.stringify({ since: '2026-11-10T08:00:00Z', by: 'owner', reason: 'travelling', until: '2099-01-01T00:00:00Z' }));
  assert.match(r.digest(['--daily']), /^PAUSED since 2026-11-10T08:00:00Z by owner until 2099-01-01T00:00:00Z: travelling$/m);
  fs.writeFileSync(path.join(r.paths.dir, 'pause.json'), JSON.stringify({ since: '2026-11-10T08:00:00Z', reason: 'old', until: '2026-11-10T09:00:00Z' }));
  assert.doesNotMatch(r.digest(['--daily']), /PAUSED/, 'an expired pause is no pause');
});

// ---------------------------------------------------------------- a9: the example job

function job(r, args = [], over = {}) {
  return spawnSync('python3', [path.join(EXAMPLES, 'hermes-digest.py'), ...args], { cwd: r.ws, encoding: 'utf8', env: { ...r.env, FAKE_WSL_EXE_MODE: 'run', PYTHONDONTWRITEBYTECODE: '1', ...over } });
}

test('P5.13 a9: the example no_agent job prints exactly the digest (silence when there is nothing), at most 6 lines per run, no raw tail of a failure; roadctl help for run summaries is plain text', FAKES_SKIP, () => {
  const r = rig({ config: {} });
  r.routine();
  // the stub transport (fake wsl.exe) runs roadctl locally; nothing is told while all is well
  const quiet = job(r);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');
  r.done(['--result', 'escalated', '--did', 'checked 9 servers', '--decision', 'left it', '--problem', 'permanent: disk-full: /var is full', '--ask', 'free space?', '--not-checked', 'backups'], r.at(5));
  const news = job(r, [], r.at(6));
  assert.equal(news.status, 0, news.stderr);
  assert.ok(lines(news.stdout).length <= 6, news.stdout);
  assert.match(news.stdout, /^routine my-app\/atom-status: ESCALATED/m);
  assert.doesNotMatch(news.stdout, /[*_`#]|<|>/, 'plain text: no markdown, no tags');
  assert.equal(job(r, [], r.at(7)).stdout, '', 'told once');
  const wsl = readCalls(r.env.FAKE_LOG).map((c) => c.argv.at(-1));
  assert.ok(wsl.includes('roadctl digest --all --since-state telegram'), wsl.join('\n'));
  // the daily job asks for the overview
  const daily = job(r, ['--daily'], r.at(8));
  assert.match(daily.stdout, /^my-app\/atom-status: ESCALATED 3m ago/m);
  assert.ok(readCalls(r.env.FAKE_LOG).some((c) => c.argv.at(-1) === 'roadctl digest --all --daily'));
  // a failing roadctl: one short line, not its stderr or its output
  const crash = job(r, [], { FAKE_WSL_EXE_MODE: 'crash', FAKE_EXIT: '9' });
  assert.equal(crash.stdout, 'roadctl digest did not run (exit 9); see the machine\n');
  assert.doesNotMatch(crash.stdout, /fake wsl/, 'the stderr of the failed command is not forwarded');
  // a runaway output is cut at a line boundary, with no tail
  const huge = job(r, [], { FAKE_WSL_EXE_MODE: 'ok', FAKE_STDOUT: `${'a line of text that is long enough to count\n'.repeat(200)}` });
  assert.ok(huge.stdout.length <= 3500 + 10, `${huge.stdout.length}`);
  assert.match(huge.stdout, /\(cut\)\n$/);
  // the example says the delivery limit out loud, and never parses text
  assert.match(fs.readFileSync(path.join(EXAMPLES, 'hermes-digest.py'), 'utf8'), /delivery that fails then loses that message/);
});
const readCalls = (log) => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.name === 'wsl.exe' && !c.event);

// ---------------------------------------------------------------- a10: recorded-local, and the known limit in the docs

test('P5.13 a10: a run that is only recorded locally says so in the summary and in the digest ("not published: waits for roadctl save"); the docs name the delivery limit', FAKES_SKIP, () => {
  const r = rig(); // not a git repository: recorded-local
  r.routine();
  const out = r.done(['--result', 'ok', '--did', 'checked', '--ask', 'a question'], r.at(5)).stdout;
  assert.match(out, /roadctl routine done: recorded-local/);
  assert.match(out, /^needs from you: a question \[not published: waits for roadctl save\]$/m);
  // with git, committed but not pushed (offline): the run is only on this machine; the summary and the digest say so
  const p = pair();
  p.home.routine();
  p.home.ok(['save']);
  p.laptop.ok(['pull']);
  git(p.laptop.ws, 'remote', 'set-url', 'origin', path.join(p.base, 'gone.git'));
  const off = p.laptop.done(['--result', 'escalated', '--did', 'checked', '--ask', 'a question'], p.laptop.at(30));
  assert.match(off.stdout, /recorded-local/);
  assert.match(off.stdout, /\[not published: waits for roadctl save\]$/m);
  const told = p.laptop.digest([], p.laptop.at(31));
  assert.match(told, /ESCALATED/);
  assert.match(told, /needs from you: a question \[not published: waits for roadctl save\]$/m);
  // the delivery limit is documented where the owner looks
  assert.match(DOCS, /delivery that fails after roadctl printed the text loses that message/);
  assert.match(DOCS, /the daily overview is the safety net/);
});

// ---------------------------------------------------------------- the rest: language, plain text, help, docs, format change

test('P5.13: headings follow the language of the board (ru here), the text of the agent is shown as written; no emoji or markup', () => {
  const ev = { kind: 'routine', project: 'my-app', id: 'atom-status', outcome: 'escalated', agent: ME, duration_s: 12, fields: { did: ['проверил 9 серверов'], decisions: [], problems: [{ kind: 'permanent', key: 'disk', text: 'диск полон' }], needs_owner: 'освободить место?', not_checked: null } };
  const ru = renderSummary(ev, 'ru');
  assert.deepEqual(ru, [`рутина my-app/atom-status: ЭСКАЛАЦИЯ (${ME}, 12с)`, 'сделано: проверил 9 серверов', 'проблема: permanent disk: диск полон', 'нужно от вас: освободить место?']);
  assert.equal(renderSummary(ev, 'en')[0], `routine my-app/atom-status: ESCALATED (${ME}, 12s)`);
  assert.equal(renderSummary(ev, undefined)[3], 'needs from you: освободить место?');
  assert.ok(renderSummary({ ...ev, fields: { ...ev.fields, decisions: ['d'], not_checked: 'n' } }, 'en').length <= 6);
});

test('P5.13: the digest of a board in Russian is in Russian, the daily overview too', FAKES_SKIP, () => {
  const r = rig({ config: { language: 'ru' } });
  r.routine();
  r.done(['--result', 'failed', '--did', 'проверил'], r.at(5));
  assert.match(r.digest([], r.at(6)), /^рутина my-app\/atom-status: СБОЙ/m);
  assert.match(r.digest(['--daily'], r.at(7)), /^суточная сводка roadctl 2026-11-10$/m);
});

test('P5.13: usage and the state name are checked; the digest never writes the board and nothing but ticks.jsonl-neighbours in the state directory', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  assert.equal(r.run(['digest', 'extra']).status, 2);
  assert.equal(r.run(['digest', '--since-state', 'bad name!']).status, 2);
  assert.equal(r.run(['digest', '--since-state']).status, 2, 'a state name needs a value');
  assert.match(r.run(['help', 'digest']).stdout, /--since-state NAME/);
  const before = fs.readFileSync(r.routineFile(), 'utf8');
  r.done(['--result', 'failed', '--did', 'x'], r.at(5));
  const mid = fs.readFileSync(r.routineFile(), 'utf8');
  r.digest([], r.at(6));
  r.digest(['--daily'], r.at(6));
  assert.equal(fs.readFileSync(r.routineFile(), 'utf8'), mid, 'digest changes no board file');
  assert.notEqual(before, mid);
  assert.deepEqual(fs.readdirSync(r.paths.dir).filter((f) => !f.startsWith('runs.jsonl') && !f.startsWith('ticks')).sort(), ['digest.state.json'], 'only the delivery state is new (and no lock is left)');
  // the state is never inside a git work tree is not needed: it holds keys and times only, but a broken file is started over
  fs.writeFileSync(path.join(r.paths.dir, 'digest.state.json'), '{not json');
  assert.doesNotThrow(() => r.digest([], r.at(7)));
});

test('P5.13 format change (P5.14): VERSION 0.5.0 (notify, the summary form of the Log line, summary in config.json), CHANGELOG and the docs say what an older copy does; the old forms are unchanged', () => {
  assert.ok(rc.compareVersions(rc.VERSION, '0.5.0') >= 0);
  assert.match(fs.readFileSync(path.join(scripts, '..', 'CHANGELOG.md'), 'utf8'), /0\.5\.0[^\n]*(digest|notify)/);
  assert.match(DOCS, /roadctl 0\.5\.0/);
  assert.match(DOCS, /"requires": "0\.5\.0"/);
  // old values stay
  assert.deepEqual(rc.ROUTINE_RESULTS, ['ok', 'escalated', 'failed']);
  // a board that requires 0.5.0 is refused by 0.4.x
  assert.match(rc.boardRequires({ requires: '0.5.0' }, '0.4.0'), /requires roadctl 0\.5\.0 or newer; this is 0\.4\.0/);
  assert.equal(rc.boardRequires({ requires: '0.5.0' }, rc.VERSION), null);
});
