// P5.3: owner-only commands in an unattended run, the owner audit, the digest events, the bounds of the project mandate, lint of broad permission rules
// (module owner-gate.mjs, the `owner` entries of the command table, digest.mjs).
// Run: node --test scripts/roadctl/owner-gate.test.mjs
// Nothing here starts a model or reaches a network: the clock is ROADCTL_NOW, git is a local bare repository.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { helpDocsProblems } from '../testkit/helpdocs.mjs';
import { clock, T0 } from '../testkit/time.mjs';
import { MANDATE_REQUIRES } from './mandate.mjs';
import { broadRules, ownerCall } from './owner-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const SELF = path.join(here, '..', 'roadctl.mjs');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const DOCS = fs.readFileSync(path.join(ROOT, 'docs', 'roadctl.md'), 'utf8');
const OWNER = 'Owner';
const ME = 'claude-code@home-wsl';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const GITID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const PLAN = '## Plan\n- Environment: local checkout, the agent\'s own branch\n- Checks: node --test must pass\n- Allowed changes: scripts/ and docs/ only\n- Stop conditions: stop on a failing test or after two hours\n\n';
const card = (id, { status = 'ready', kind, size, goal, extra = '' } = {}) => `---\nid: ${id}\ntitle: Card ${id}\nstatus: ${status}\n${kind ? `kind: ${kind}\n` : ''}${size ? `size: ${size}\n` : ''}${goal ? `goal: ${goal}\n` : ''}${extra}as_of: 2026-11-10\n---\n\n## Goal\nDo ${id}.\n\n${PLAN}## Acceptance\n- [ ] a1: it works\n`;
const MANDATE = (level = 'L3') => `---\nmandate: 1\nlevel: ${level}\nkinds: fix, docs\nmax_size: M\nmerge: branch\nbudget: cards_per_day=2, runs_per_week=10\n---\n\n## Goals\n- G1 (priority 1): finish stage 2\n\n## Forbidden\n- pushing to main\n`;

test('checkpoint obeys L3 and L4 unattended mandate gate', () => {
  for (const level of ['L3', 'L4']) {
    const r = rig();
    try {
      fs.writeFileSync(r.mfile, MANDATE(level));
      r.put('M-3', { status: 'doing', kind: 'feature', size: 'S', goal: 'G1' });
      const run = () => spawnSync(process.execPath, [SELF, 'checkpoint', 'M-3', '--as', ME, '--board', r.board], { cwd: r.ws, encoding: 'utf8', input: JSON.stringify({ did: 'done', next: 'next', in_flight: 'none' }), env: { ...r.env, ROADCTL_UNATTENDED: '1' } });
      const before = r.cardText('M-3');
      const refused = run();
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /outside the project mandate/);
      assert.equal(r.cardText('M-3'), before);
      r.put('M-3', { status: 'doing', kind: 'feature', size: 'S', goal: 'G1', extra: 'approved: Owner, 2026-11-10, scope=implementation\n' });
      assert.equal(run().status, 0);
      assert.match(r.cardText('M-3'), /checkpoint: did: done/);
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  }
});

/** One machine: a workspace with one board (requires 0.8.0), cards M-1 .. M-5, a throwaway environment, a runner that sets it. */
function machine(dir, ws, host = 'home') {
  const board = path.join(ws, 'projects', 'my-app', 'board');
  const state = path.join(dir, `state-${host}`);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, USER: 'tester', XDG_STATE_HOME: state, XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, `cfg-${host}`), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10', ROADCTL_HOST: host, ...GITID, ...clock(T0) };
  for (const k of ['FAKE_MODE', 'ROADCTL_UNATTENDED', 'ROADCTL_RUN_ID', 'ROADCTL_VIA']) delete env[k];
  const run = (args, over = {}) => spawnSync(process.execPath, [SELF, ...args, '--board', board], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const ok = (args, over) => {
    const r = run(args, over);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  const audit = () => {
    const f = path.join(state, 'road-map-journal', 'owner-commands.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const put = (id, opts) => fs.writeFileSync(path.join(board, 'cards', `${id}-card.md`), card(id, opts));
  const cardText = (id) => fs.readFileSync(path.join(board, 'cards', `${id}-card.md`), 'utf8');
  const mfile = path.join(board, 'mandate.md');
  const digest = (args = [], over) => ok(['digest', ...args], over).stdout;
  return { dir, ws, board, env, state, run, ok, audit, put, cardText, mfile, digest };
}

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ownergate-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.mkdirSync(path.join(board, 'cards'), { recursive: true });
  fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ board_version: 1, title: 'App', status_map: {}, requires: MANDATE_REQUIRES, language: 'en' }));
  const m = machine(dir, ws);
  m.put('M-1', { kind: 'fix', size: 'S', goal: 'G1' });
  m.put('M-2', { kind: 'docs', size: 'S', goal: 'G1' });
  m.put('M-3', { kind: 'feature', size: 'S', goal: 'G1' });
  m.put('M-4', { kind: 'fix', size: 'L', goal: 'G1' });
  m.put('M-5', { kind: 'fix', size: 'S', goal: 'G1' });
  m.ok(['routine', 'new', 'r1', 'Collect', '--agent', ME, '--model', 'haiku', '--env', 'laptop', '--every', '2h']);
  return m;
}

/** Two machines (two clones of one repository), the same as the digest tests: `home` and `laptop`. */
function pair() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ownergate-pair-'));
  const server = path.join(base, 'server.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', server);
  const a = path.join(base, 'a');
  const board = path.join(a, 'projects', 'my-app', 'board');
  fs.mkdirSync(path.join(board, 'cards'), { recursive: true });
  fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ board_version: 1, title: 'App', status_map: {}, language: 'en' }));
  const home = machine(base, a, 'home');
  home.put('M-1', { kind: 'fix', size: 'S' });
  home.put('M-2', { kind: 'fix', size: 'S' });
  git(a, 'init', '-q', '-b', 'main');
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'init');
  git(a, 'remote', 'add', 'origin', server);
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = path.join(base, 'b');
  git(base, 'clone', '-q', server, b);
  return { home, laptop: machine(base, b, 'laptop') };
}

// ---------------------------------------------------------------- a1

const OWNER_CALLS = [
  ['approve', 'M-1', '--by', OWNER, '--scope', 'implementation'],
  ['done', 'M-1', '--by', OWNER],
  ['auto', 'M-1', '--by', OWNER, '--source', 'chat'],
  ['queue', 'add', 'M-1'], ['queue', 'remove', 'M-1'], ['queue', 'move', 'M-1', '--at', '1'],
  ['pause', '--reason', 'x'], ['resume'],
  ['mandate', 'approve', '--by', OWNER],
  ['milestone', 'continue', 'M-1', '--by', OWNER], ['milestone', 'move', 'M-1', '--to', '2026-12-01', '--by', OWNER], ['milestone', 'done', 'M-1', '--hash', 'x', '--by', OWNER], ['milestone', 'return', 'M-1', '--cards', 'M-1', '--reason', 'x', '--hash', 'x', '--by', OWNER],
  ['routine', 'on', 'r1', '--by', OWNER, '--source', 'chat'], ['routine', 'off', 'r1', '--by', OWNER], ['routine', 'resume', 'r1'], ['routine', 'promote', 'r1'],
  ['autonomy', 'on', '--by', OWNER], ['autonomy', 'off'], ['autonomy', 'routines', 'on', '--by', OWNER],
  ['limits', '--confirm', 'claude', '--by', OWNER],
  ['boards', 'add', '/nonexistent'], ['boards', 'remove', 'x'],
  ['hook-install', '--git', '--apply'], ['hook-uninstall', '--git', '--apply'], ['instructions-install', '--claude', '--apply'], ['instructions-uninstall', '--claude', '--apply'], ['agents-install', '--claude', '--apply'], ['agents-uninstall', '--claude', '--apply'],
];
const READ_CALLS = [['status'], ['pause', 'status'], ['mandate', 'show'], ['queue', 'list'], ['autonomy'], ['routine', 'list'], ['hook-install', '--git'], ['boards', 'list'], ['limits', '--check', 'claude']];

test('P5.3 a1: every owner call is refused with exit 1 in an unattended run (ROADCTL_UNATTENDED, ROADCTL_RUN_ID); reads are not; without the mode the gate says nothing; the list is the `owner` entries', () => {
  const r = rig();
  const owners = Object.entries(rc.ALL_COMMANDS).filter(([, c]) => c.owner).map(([n]) => n).sort();
  assert.deepEqual(owners, ['agents-install', 'agents-uninstall', 'answer', 'approve', 'auto', 'autonomy', 'boards', 'done', 'hook-install', 'hook-uninstall', 'inbox', 'instructions-install', 'instructions-uninstall', 'limits', 'mandate', 'milestone', 'pause', 'queue', 'resume', 'routine', 'undo']);
  // every call of the table is an owner call by the entries, every read call is not
  const parse = (a) => ({ args: a.filter((x, i) => !x.startsWith('--') && !(i && a[i - 1].startsWith('--') && !['--git', '--claude', '--apply'].includes(a[i - 1]))), flags: Object.fromEntries(a.filter((x) => x.startsWith('--')).map((x) => [x.slice(2), true])) });
  for (const a of OWNER_CALLS) { const { args, flags } = parse(a); assert.ok(ownerCall(args[0], rc.ALL_COMMANDS[args[0]], args, flags), a.join(' ')); }
  for (const a of READ_CALLS) { const { args, flags } = parse(a); assert.equal(ownerCall(args[0], rc.ALL_COMMANDS[args[0]], args, flags), null, a.join(' ')); }
  for (const over of [{ ROADCTL_UNATTENDED: '1' }, { ROADCTL_RUN_ID: 'run-1' }]) {
    for (const a of OWNER_CALLS) {
      const x = r.run(a, over);
      assert.equal(x.status, 1, `${a.join(' ')}: ${x.stderr}`);
      assert.match(x.stderr, new RegExp(`^roadctl ${a[0]}: refused: an unattended run .* never runs ${a[0]}`), a.join(' '));
    }
  }
  assert.equal(r.audit().length, OWNER_CALLS.length * 2, 'every refusal is on the audit');
  assert.doesNotMatch(r.cardText('M-1'), /^approved:/m, 'nothing was changed');
  for (const a of READ_CALLS) assert.ok(!/unattended run/.test(r.run(a, { ROADCTL_UNATTENDED: '1' }).stderr), `${a.join(' ')} is not refused`);
  assert.equal(r.run(['status'], { ROADCTL_UNATTENDED: '0' }).status, 0);
  assert.equal(r.run(['approve', 'M-1', '--by', OWNER, '--scope', 'implementation', '--help'], { ROADCTL_UNATTENDED: '1' }).status, 0, 'help is not refused');
  // the same calls without the mode work as before
  const before = r.audit().length;
  r.ok(['approve', 'M-1', '--by', OWNER, '--scope', 'implementation']);
  assert.match(r.cardText('M-1'), /^approved: Owner, 2026-11-10, scope=implementation$/m);
  r.ok(['autonomy', 'on', '--by', OWNER]);
  r.ok(['queue', 'add', 'M-1']);
  r.ok(['routine', 'on', 'r1', '--by', OWNER, '--source', 'chat']);
  assert.equal(r.audit().length - before, 4);
  for (const a of OWNER_CALLS) assert.doesNotMatch(r.run(a).stderr, /unattended run/, a.join(' '));
  // the docs name the same commands (help = docs also runs in helpdocs.test.mjs)
  assert.deepEqual(helpDocsProblems(rc.ALL_COMMANDS, { overview: spawnSync(process.execPath, [SELF, 'help'], { encoding: 'utf8' }).stdout, docs: DOCS }), []);
});

// ---------------------------------------------------------------- a2

test('P5.3 a2: lint reports each broad permission rule in a routine file, and nothing for narrow rules or plain prose', () => {
  const r = rig();
  const routine = path.join(r.board, 'routines', 'r1.md');
  const clean = fs.readFileSync(routine, 'utf8');
  const lint = () => JSON.parse(r.run(['lint', '--json']).stdout).filter((x) => x.rule === 33 && x.card === 'routines/r1.md');
  assert.deepEqual(lint(), []);
  const narrow = `${clean}\nsettings: {"permissions":{"allow":["Read","Bash(roadctl show:*)","Bash(git status:*)","Edit(/tmp/work/**)","mcp__srv__tool"]}}\nA Bash tool and a git push are described here, and the Write step too.\n`;
  fs.writeFileSync(routine, narrow);
  assert.deepEqual(lint(), []);
  const cases = [
    ['Bash(roadctl:*)', 'error', /Bash\(roadctl:\*\)/],
    ['Bash(git:*)', 'warning', /Bash\(git:\*\)/],
    ['mcp__atom-services', 'error', /mcp__atom-services/],
    ['mcp__claude_ai_Context7__*', 'error', /mcp__claude_ai_Context7__\*/],
    ['"Bash"', 'error', /"Bash"/],
    ['"Write"', 'warning', /"Write"/],
    ['"Edit"', 'warning', /"Edit"/],
  ];
  for (const [rule, level, re] of cases) {
    fs.writeFileSync(routine, `${clean}\nsettings: ["Read", ${rule.startsWith('"') ? rule : `"${rule}"`}]\n`);
    const f = lint();
    assert.equal(f.length, 1, `${rule}: ${JSON.stringify(f)}`);
    assert.equal(f[0].level, level, rule);
    assert.match(f[0].msg, re);
  }
  fs.writeFileSync(routine, `${clean}\n"Bash(roadctl:*)" "Bash(git:*)" "mcp__srv" "Bash" "Write"\n`);
  assert.equal(lint().length, 5, 'one finding per rule');
  assert.equal(r.run(['lint']).status, 1, 'an error rule fails lint');
  assert.deepEqual(broadRules('Bash(roadctl show:*) Edit(/a/**)'), []);
  assert.equal(broadRules('Bash(roadctl *)').length, 1);
});

// ---------------------------------------------------------------- a3, a7

test('P5.3 a3 a7: every owner call leaves one audit line (who, what, target, outcome, via, run_id, unattended) and shows in the daily overview; a usage error writes none; digest reads extra fields', () => {
  const r = rig();
  r.ok(['approve', 'M-1', '--by', OWNER, '--scope', 'implementation']);
  r.ok(['approve', 'M-2', '--by', OWNER, '--scope', 'implementation'], { ROADCTL_VIA: 'telegram' });
  assert.equal(r.run(['approve', 'M-1']).status, 2, 'a usage error');
  assert.equal(r.run(['done', 'M-2', '--by', OWNER]).status, 1, 'refused by the command itself (no evidence)');
  r.run(['approve', 'M-3', '--by', 'agent', '--scope', 'implementation'], { ROADCTL_RUN_ID: 'r-123' });
  r.ok(['pause', '--reason', 'testing']);
  r.ok(['resume']);
  const rows = r.audit();
  assert.deepEqual(rows.map((x) => [x.command, x.target, x.by, x.outcome]), [['approve', 'M-1', OWNER, 'ok'], ['approve', 'M-2', OWNER, 'ok'], ['done', 'M-2', OWNER, 'refused'], ['approve', 'M-3', 'agent', 'refused'], ['pause', 'my-app', '', 'ok'], ['resume', 'my-app', '', 'ok']]);
  assert.deepEqual(rows.map((x) => [x.via, x.run_id, x.unattended]), [['direct', null, false], ['telegram', null, false], ['direct', null, false], ['direct', 'r-123', true], ['direct', null, false], ['direct', null, false]]);
  assert.ok(rows.every((x) => Number.isFinite(Date.parse(x.time))));
  assert.match(rows[3].reason, /unattended run/);
  // the reader tolerates fields it does not know and lines that are not objects of the format
  const f = path.join(r.state, 'road-map-journal', 'owner-commands.jsonl');
  fs.appendFileSync(f, `${JSON.stringify({ time: '2026-11-10T08:00:00Z', command: 'approve', target: 'M-8', by: 'x', outcome: 'ok', via: 'direct', run_id: null, unattended: false, something_new: [1, 2] })}\nnot json\n`);
  const daily = r.digest(['--daily']);
  assert.match(daily, /^owner commands, last 24h: 7 \(/m, daily);
  assert.match(daily, /approve M-1 by Owner/);
});

// ---------------------------------------------------------------- a4

test('P5.3 a4: docs, help and the skill say the gate is an agreement, not a sandbox, and that a refusal is exit code 1', () => {
  const help = spawnSync(process.execPath, [SELF, 'help', 'unattended'], { encoding: 'utf8' }).stdout;
  assert.match(help, /exit 1/);
  assert.match(help, /agreement, not a sandbox/);
  const one = spawnSync(process.execPath, [SELF, 'help', 'approve'], { encoding: 'utf8' }).stdout;
  assert.match(one, /Owner only: run it only on the owner's explicit words/);
  assert.match(one, /refused with exit 1/);
  assert.match(spawnSync(process.execPath, [SELF, 'help', 'routine'], { encoding: 'utf8' }).stdout, /Owner only \(on, off, resume, promote\)/);
  const sec = DOCS.slice(DOCS.indexOf('## Unattended mode and the owner audit'), DOCS.indexOf('## Recurring routines'));
  assert.match(sec, /exit code 1/);
  assert.match(sec, /agreement, not a sandbox/);
  assert.match(sec, /A prefix rule is not "read only"/);
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'road-map-journal', 'references', 'autonomy.md'), 'utf8');
  assert.match(skill, /agreement, not a sandbox/);
  assert.match(skill, /exit code 1/);
  assert.match(skill, /not "read only"/);
});

// ---------------------------------------------------------------- a5, a8

test('P5.3 a5: a refusal in an unattended run is a "problem at once" event of the digest, told once; an owner call of the owner is not', () => {
  const r = rig();
  r.ok(['approve', 'M-1', '--by', OWNER, '--scope', 'implementation']);
  assert.equal(r.digest([], clock(T0)), '', 'an owner command of the owner is no problem');
  assert.equal(r.run(['approve', 'M-2', '--by', 'claude-code@home-wsl', '--scope', 'implementation'], { ROADCTL_RUN_ID: 'r-77' }).status, 1);
  const first = r.digest();
  assert.match(first, /^owner command approve M-2 by claude-code@home-wsl: refused in an unattended run, run r-77$/m, first);
  assert.equal(r.digest(), '', 'told once');
  const json = JSON.parse(r.digest(['--json', '--dry-run']));
  assert.deepEqual(json.events, []);
  assert.equal(r.run(['autonomy', 'on', '--by', 'agent'], { ROADCTL_UNATTENDED: '1' }).status, 1);
  assert.match(JSON.parse(r.digest(['--json'])).events[0].fields.problems[0].text, /owner command autonomy on my-app by agent: refused/);
});

test('P5.3 a8: with the local bridge setting an owner command that did not come through the bridge is a digest event; without the setting, or via the bridge, none', () => {
  const r = rig();
  r.ok(['approve', 'M-1', '--by', OWNER, '--scope', 'implementation']);
  assert.equal(r.digest(), '', 'no setting: no event');
  const cfg = path.join(r.env.XDG_CONFIG_HOME, 'road-map-journal');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'owner-gate.json'), JSON.stringify({ bridge: 'telegram' }));
  r.ok(['approve', 'M-2', '--by', OWNER, '--scope', 'implementation'], { ROADCTL_VIA: 'telegram' });
  const text = r.digest();
  assert.match(text, /^owner command approve M-1 by Owner: not through the bridge telegram \(via direct\)$/m, text);
  assert.doesNotMatch(text, /M-2/, 'the bridge is the right way');
  assert.equal(r.digest(), '');
  fs.writeFileSync(path.join(cfg, 'owner-gate.json'), '{ broken');
  r.ok(['approve', 'M-3', '--by', OWNER, '--scope', 'implementation']);
  assert.equal(r.digest(), '', 'an unreadable setting is no setting');
});

// ---------------------------------------------------------------- a6

test('P5.3 a6: the daily line of owner commands is built from git (another machine) plus the local refusals (two clones)', () => {
  const { home, laptop } = pair();
  home.ok(['approve', 'M-1', '--by', OWNER, '--scope', 'implementation']);
  assert.equal(JSON.parse(home.ok(['save', '--json']).stdout).status, 'pushed');
  assert.equal(laptop.run(['approve', 'M-2', '--by', 'agent', '--scope', 'implementation'], { ROADCTL_UNATTENDED: '1' }).status, 1);
  assert.equal(JSON.parse(laptop.ok(['pull', '--json']).stdout).status, 'pulled');
  assert.equal(laptop.audit().length, 1, 'the laptop never saw the home audit');
  const daily = laptop.digest(['--daily']);
  assert.match(daily, /^owner commands, last 24h: 2 \(approve M-2 by agent refused; approve M-1 by Owner\)$/m, daily);
  // the home machine has its own audit line for the same command: counted once
  assert.match(home.digest(['--daily']), /^owner commands, last 24h: 1 \(approve M-1 by Owner\)$/m);
});

// ---------------------------------------------------------------- a9

test('P5.3 a9: unattended, card commands outside the mandate (kind, size, budget, level, an edited mandate, mandate approve) are refused with an audit line and a digest event; without a mandate nothing changes', () => {
  const r = rig();
  const un = { ROADCTL_UNATTENDED: '1' };
  const plain = r.run(['delegate', 'M-3', '--to', 'worker', '--by', ME], un); // no mandate file
  assert.equal(plain.stderr, 'refused: the card has no approved record; the owner approves before work is delegated\n', 'without a mandate: the old text, no gate');
  assert.equal(r.audit().length, 0);
  fs.writeFileSync(r.mfile, MANDATE('L3'));
  const hash = JSON.parse(r.ok(['mandate', 'show', '--json']).stdout).hash;
  assert.equal(r.run(['mandate', 'approve', '--by', OWNER, '--hash', hash], un).status, 1, 'mandate approve unattended');
  r.ok(['mandate', 'approve', '--by', OWNER, '--hash', hash]);
  const refused = (args, re) => {
    const x = r.run(args, un);
    assert.equal(x.status, 1, `${args.join(' ')}: ${x.stderr}`);
    assert.match(x.stderr, re, args.join(' '));
    const last = r.audit().at(-1);
    assert.deepEqual([last.command, last.target, last.outcome, last.unattended], [args[0], args[1], 'refused', true]);
    assert.match(last.reason, re);
  };
  refused(['delegate', 'M-3', '--to', 'worker', '--by', ME], /outside the project mandate: kind feature is outside the mandate/);
  refused(['delegate', 'M-4', '--to', 'worker', '--by', ME], /size L is above max_size M/);
  refused(['review', 'M-3'], /kind feature is outside the mandate/);
  refused(['claim', 'M-3', '--as', ME], /outside the project mandate/);
  // inside the limits it works; the budget of two cards a day is used by the third
  r.ok(['delegate', 'M-1', '--to', 'worker', '--by', ME], un);
  r.ok(['delegate', 'M-2', '--to', 'worker', '--by', ME], un);
  refused(['delegate', 'M-5', '--to', 'worker', '--by', ME], /the budget of 2 card\(s\) a day is used/);
  // a card taken by the mandate keeps working; a card approved by hand is not the mandate's business
  r.ok(['claim', 'M-1', '--as', 'worker', '--no-pull'], un);
  r.ok(['approve', 'M-3', '--by', OWNER, '--scope', 'implementation']);
  assert.ok(!/outside the project mandate/.test(r.run(['review', 'M-3'], un).stderr));
  // the mandate edited after approval: the taken card is outside it until the owner approves again
  fs.writeFileSync(r.mfile, fs.readFileSync(r.mfile, 'utf8').replace('kinds: fix, docs', 'kinds: fix, docs, tests'));
  refused(['review', 'M-1'], /the mandate changed after approval|by_mandate is not the hash/);
  // the owner at the keyboard is not checked
  assert.ok(!/outside the project mandate/.test(r.run(['review', 'M-1']).stderr));
  // level L2: the mandate takes nothing and the gate says nothing
  fs.writeFileSync(r.mfile, MANDATE('L2'));
  assert.ok(!/outside the project mandate/.test(r.run(['delegate', 'M-4', '--to', 'worker', '--by', ME], un).stderr));
  // every refusal is a digest event at once
  const text = r.digest();
  assert.match(text, /owner command mandate approve .*refused in an unattended run/);
  assert.match(text, /owner command delegate M-3 .*refused in an unattended run.*outside the project mandate: kind feature/);
  assert.match(text, /owner command review M-1/);
});
