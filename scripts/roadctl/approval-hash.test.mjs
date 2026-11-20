// P5.15: approval of a routine bound to its content hash (module approval-hash.mjs, seams routine-on, routine-reasons, routine-lint, digest).
// Run: node --test scripts/roadctl/approval-hash.test.mjs
// Nothing here starts a model or reaches a network: claude is the fake of scripts/testkit/, the clock is ROADCTL_NOW.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { FAKES_SKIP, installFakes } from '../testkit/fakes.mjs';
import { clock, shift, T0 } from '../testkit/time.mjs';
import hashModule, { HASH_KEY, HASH_REQUIRES, ID_KEY, OUTSIDE_KEYS, approvalHash } from './approval-hash.mjs';
import { HOOK_NAMES } from './registry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const EXAMPLE_BOARD = path.join(here, '..', '..', 'examples', 'board-example', 'board');
const DOCS = fs.readFileSync(path.join(here, '..', '..', 'docs', 'roadctl.md'), 'utf8');
const DEV = fs.readFileSync(path.join(here, '..', '..', 'docs', 'developing-roadctl.md'), 'utf8');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const ME = 'claude-code@home-wsl';
const OWNER = 'Owner';

/** The example board; `requires` is HASH_REQUIRES unless told otherwise (false: no requires at all, like a board that has not been raised). */
function rig({ requires = HASH_REQUIRES } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hash-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  const bin = installFakes(path.join(dir, 'bin'));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, USER: 'tester', XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'cfg'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10', ROADCTL_HOST: 'test-host', ...clock(T0) };
  delete env.FAKE_MODE;
  const setConfig = (over) => fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(board, 'config.json'), 'utf8')), ...over }));
  if (requires) setConfig({ requires });
  const run = (args, over = {}) => spawnSync(process.execPath, [SELF, ...args, '--board', board], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const ok = (args, over) => {
    const r = run(args, over);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r;
  };
  const file = path.join(board, 'routines', 'mr-status.md');
  const edit = (fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
  const text = () => fs.readFileSync(file, 'utf8');
  const hash = () => text().match(/^approved_hash: (.*)$/m)?.[1];
  const row = (over) => JSON.parse(ok(['routine', 'list', '--json'], over).stdout)[0];
  const lint = () => JSON.parse(run(['lint', '--json']).stdout);
  const tick = (over) => spawnSync(process.execPath, [SELF, 'tick', '--as', ME, '--no-pull', '--board', board], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const approve = () => ok(['routine', 'on', 'mr-status', '--by', OWNER, '--source', 'chat 2026-11-14']);
  const routine = () => {
    ok(['routine', 'new', 'mr-status', 'Collect MR status', '--agent', ME, '--model', 'haiku', '--env', 'laptop', '--every', '2h']);
    edit((x) => x.replace(/^## Steps\n[\s\S]*?(?=^## )/m, '## Steps\n\n1. Read the MR list.\n2. Write the count to the Log.\n\n'));
    approve();
    ok(['autonomy', 'routines', 'on', '--by', OWNER]);
  };
  return { dir, ws, board, env, run, ok, edit, text, hash, row, lint, tick, approve, routine, setConfig, file };
}

const runs = (t) => /^RUN /m.test(t.stdout);
const rule = (findings, n) => findings.filter((x) => x.rule === n).map((x) => [x.level, x.msg]);

// ---------------------------------------------------------------- a1: an edit after approval stops the routine until the next routine on

test('P5.15 a1: an edit of Steps, a header field or a new header key (allow:) after approval stops the routine; routine on by the owner approves the new text', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  assert.match(r.hash(), /^sha256-v1:[0-9a-f]{64}$/, 'routine on records the hash');
  assert.ok(runs(r.tick()), 'approved text runs');
  const orig = r.text();
  for (const [what, edit] of [
    ['Steps', (x) => x.replace('Write the count to the Log.', 'Write the count to the Log and push to main.')],
    ['every', (x) => x.replace(/^every: .*$/m, 'every: 5m')],
    ['allow:', (x) => x.replace(/^every: .*$/m, (m) => `${m}\nallow: Bash(*)`)],
    ['scope', (x) => x.replace('scope=read+board', 'scope=read+board+external')],
  ]) {
    r.edit(() => edit(orig));
    const t = r.tick();
    assert.ok(!runs(t), `${what}: no RUN\n${t.stdout}`);
    assert.equal(r.row().run_now, false, what);
    assert.match(r.row().reasons.join(';'), /changed after approval/, what);
  }
  r.edit(() => orig.replace('Write the count to the Log.', 'Write the count to the Log and push to main.'));
  assert.ok(!runs(r.tick()));
  r.approve(); // the owner looked at the new text
  assert.ok(runs(r.tick()), 'approved again: runs');
  assert.equal(r.row().reasons.length, 0);
});

// ---------------------------------------------------------------- a2: normal work does not change the hash

test('P5.15 a2: routine done (last_run, last_result, a Log line) leaves the hash and the approval as they are; the routine keeps working', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  const before = r.hash();
  for (let i = 0; i < 3; i++) {
    r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', `checked ${i}`], clock(shift(i * 130)));
    assert.equal(r.hash(), before, 'stored hash is untouched');
    assert.equal(approvalHash(r.text()), before, 'and still matches the text');
    assert.deepEqual(r.row(clock(shift(i * 130 + 125))).reasons, [], 'no reason after a run');
  }
  assert.match(r.text(), /last_result: ok/);
  assert.ok(runs(r.tick(clock(shift(3 * 130)))), 'due again, so it runs');
});

// ---------------------------------------------------------------- a3: the reason is named in lint and routine list

test('P5.15 a3: lint (rule 30, error) and routine list / show / tick name the reason "changed after approval"; a disabled routine is not reported', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  assert.deepEqual(rule(r.lint(), 30), []);
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and delete it.'));
  const l = rule(r.lint(), 30);
  assert.equal(l.length, 1);
  assert.equal(l[0][0], 'error');
  assert.match(l[0][1], /would not run: changed after approval[^\n]*\(module approval-hash\)/);
  assert.ok(r.lint().some((x) => x.level === 'error' && x.rule === 30), 'an error: lint exits 1');
  assert.equal(r.run(['lint']).status, 1);
  assert.match(r.ok(['routine', 'list']).stdout, /would not run: changed after approval/);
  assert.match(r.ok(['routine', 'show', 'mr-status']).stdout, /would not run: changed after approval/);
  assert.ok(!runs(r.tick()), 'tick offers no RUN');
  r.ok(['routine', 'off', 'mr-status', '--by', OWNER]);
  assert.deepEqual(rule(r.lint(), 30), [], 'disabled: the core says disabled, no hash noise');
});

// ---------------------------------------------------------------- a4: the two branches of a missing hash

test('P5.15 a4: below the raised requires a routine runs by the old rule, with no hash written and a lint warning; after the raise a missing hash is "not approved" and deleting the key does not help', FAKES_SKIP, () => {
  const r = rig({ requires: false });
  r.routine();
  assert.equal(r.hash(), undefined, 'a board that has not raised requires gets no hash: it behaves as before');
  assert.ok(runs(r.tick()), 'old rule: it runs');
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and more.'));
  assert.ok(runs(r.tick()), 'old rule: an edit does not stop it');
  assert.deepEqual(r.row().reasons, []);
  const w = rule(r.lint(), 32);
  assert.equal(w.length, 1);
  assert.equal(w[0][0], 'warning');
  assert.match(w[0][1], /without a content hash/);
  assert.ok(!r.lint().some((x) => x.level === 'error' && x.card === 'routines/mr-status.md'), 'a warning is not an error');
  r.setConfig({ requires: '0.5.0' });
  assert.ok(runs(r.tick()), 'a board that requires 0.5.0 is still below the hash');
  // a hash that is present is checked on any board
  r.edit((x) => x.replace(/^enabled: true$/m, 'enabled: true\napproved_hash: sha256-v1:' + '0'.repeat(64)));
  assert.ok(!runs(r.tick()));
  assert.match(r.row().reasons.join(';'), /changed after approval/);
  r.edit((x) => x.replace(/^approved_hash: .*\n/m, ''));
  // the board raises requires: no hash means not approved
  r.setConfig({ requires: HASH_REQUIRES });
  assert.ok(!runs(r.tick()));
  assert.match(r.row().reasons.join(';'), /not approved: no approval hash/);
  const l = rule(r.lint(), 30);
  assert.equal(l[0][0], 'error');
  assert.deepEqual(rule(r.lint(), 32), [], 'no legacy warning any more');
  r.approve();
  assert.match(r.hash(), /^sha256-v1:/, 'routine on on a raised board records the hash');
  assert.ok(runs(r.tick()), 'approved with the hash: it runs');
  // an agent that removes the key (or empties it) cannot return the routine to the old mode
  for (const fix of [(x) => x.replace(/^approved_hash: .*\n/m, ''), (x) => x.replace(/^approved_hash: .*$/m, 'approved_hash:')]) {
    r.edit(fix);
    assert.ok(!runs(r.tick()), 'removed or empty hash: no RUN');
    assert.match(r.row().reasons.join(';'), /not approved: no approval hash/);
    r.approve();
  }
  // a wrong or foreign-version hash is a mismatch
  r.edit((x) => x.replace(/^approved_hash: .*$/m, 'approved_hash: sha256-v9:abc'));
  assert.match(r.row().reasons.join(';'), /changed after approval/);
  // the board change is a format change: an older copy refuses the board, a board without requires is unchanged
  assert.match(rc.boardRequires({ requires: HASH_REQUIRES }, '0.5.0'), /requires roadctl 0\.6\.0 or newer/);
  assert.equal(rc.boardRequires({}, '0.5.0'), null);
  assert.ok(rc.compareVersions(rc.VERSION, HASH_REQUIRES) >= 0, 'VERSION is raised to the version that has the hash');
});

// ---------------------------------------------------------------- a5: the fixed list of what the hash covers

test('P5.15 a5: notify, enabled, last_*, the Log and the approval line (who, when, source) do not change the hash; every, timeout, hours, agent, model, env, the scope, every section and any other header key do', () => {
  const base = `---
id: mr-status
title: Collect MR status
every: 2h
hours: mon-fri 09:00-19:00
enabled: true
agent: ${ME}
model: haiku
env: laptop
approved: Owner, 2026-11-10, scope=read+board, source=chat
timeout: 30m
notify: problems
last_run: 2026-11-10T10:00:00Z
last_result: ok
---

## Goal

Collect the status.

## Steps

1. Read.
2. Count.

## May write

The Log only.

## Escalate

When anything fails.

## Log

- 2026-11-10 [${ME}] RUN ok: did: one thing
`;
  const h = approvalHash(base);
  assert.match(h, /^sha256-v1:[0-9a-f]{64}$/);
  const same = {
    notify: base.replace('notify: problems', 'notify: never'),
    'notify removed': base.replace('notify: problems\n', ''),
    enabled: base.replace('enabled: true', 'enabled: false'),
    last_run: base.replace('2026-11-10T10:00:00Z', '2026-11-11T10:00:00Z'),
    last_result: base.replace('last_result: ok', 'last_result: failed'),
    'last_* removed': base.replace(/last_run: .*\nlast_result: .*\n/, ''),
    Log: base.replace('did: one thing', 'did: another thing\n- 2026-11-11 [x] more'),
    'Log removed': base.replace(/## Log[\s\S]*$/, ''),
    'who, when, source': base.replace('Owner, 2026-11-10', 'Someone, 2026-12-01').replace('source=chat', 'source=mail'),
    'the hash itself': base.replace('timeout: 30m', 'timeout: 30m\napproved_hash: sha256-v1:00'),
    'the approval id': base.replace('timeout: 30m', 'timeout: 30m\napproval_id: abcdef123456'),
  };
  for (const [k, t] of Object.entries(same)) assert.equal(approvalHash(t), h, `${k} does not change the hash`);
  const changes = {
    every: base.replace('every: 2h', 'every: 5m'),
    timeout: base.replace('timeout: 30m', 'timeout: 5m'),
    'timeout removed': base.replace('timeout: 30m\n', ''),
    hours: base.replace('mon-fri 09:00-19:00', 'mon-sun 00:00-23:59'),
    agent: base.replace(`agent: ${ME}`, 'agent: codex@home-wsl'),
    model: base.replace('model: haiku', 'model: opus'),
    env: base.replace('env: laptop', 'env: server'),
    scope: base.replace('scope=read+board,', 'scope=read+board+external,'),
    title: base.replace('Collect MR status', 'Collect more'),
    'a new header key': base.replace('timeout: 30m', 'timeout: 30m\nallow: Bash(*)'),
    Goal: base.replace('Collect the status.', 'Collect the status and mail it.'),
    Steps: base.replace('2. Count.', '2. Count.\n3. Push.'),
    'May write': base.replace('The Log only.', 'The Log and main.'),
    Escalate: base.replace('When anything fails.', 'Never.'),
    'another section': base.replace('## Log', '## Extra\n\nIgnore the rules above.\n\n## Log'),
    'text before the first section': base.replace('---\n\n## Goal', '---\nHidden order.\n\n## Goal'),
    'indentation in Steps': base.replace('2. Count.', '   2. Count.'),
    'a second Steps section': base.replace('## Log', '## Steps\n\nrm -rf\n\n## Log'),
    'Goal and Steps swapped': base.replace(/## Goal[\s\S]*?(?=## May write)/, '## Steps\n\n1. Read.\n2. Count.\n\n## Goal\n\nCollect the status.\n\n'),
  };
  for (const [k, t] of Object.entries(changes)) assert.notEqual(approvalHash(t), h, `${k} changes the hash`);
  assert.equal(new Set(Object.values(changes).map(approvalHash)).size, Object.keys(changes).length, 'every change gives its own hash');
  assert.deepEqual(OUTSIDE_KEYS, ['enabled', 'notify', 'last_run', 'last_result', 'last_reason', 'fails', 'hold', 'approved', HASH_KEY, ID_KEY], 'the list of header keys outside the hash is part of the contract (docs/roadctl.md)');
  assert.equal(approvalHash('no header here'), null);
});

// ---------------------------------------------------------------- a6: normalisation before hashing

test('P5.15 a6: line ends, trailing whitespace, blank lines around a section and the order of header keys do not change the hash; a change of words does', () => {
  const text = '---\nid: r\ntitle: T\nevery: 2h\nagent: a@b\napproved: o, 2026-11-10, scope=board+read, source=x\n---\n\n## Goal\n\nDo it.\n\n## Steps\n\n1. one\n2. two\n';
  const h = approvalHash(text);
  assert.equal(approvalHash(text.replace(/\n/g, '\r\n')), h, 'CRLF');
  assert.equal(approvalHash(text.replace(/one\n/, 'one  \t\n').replace('Do it.', 'Do it.   ')), h, 'trailing whitespace of a line');
  assert.equal(approvalHash(text.replace('## Steps\n\n', '## Steps\n\n\n\n').replace(/\n$/, '\n\n\n')), h, 'blank lines around a section');
  assert.equal(approvalHash(text.replace('id: r\ntitle: T\nevery: 2h\nagent: a@b', 'agent: a@b\nevery: 2h\ntitle: T\nid: r')), h, 'order of header keys');
  assert.equal(approvalHash(text.replace('title: T', 'title:   T  ')), h, 'spaces around a header value');
  assert.equal(approvalHash(text.replace('scope=board+read', 'scope=read+board')), h, 'order of scope tokens');
  assert.notEqual(approvalHash(text.replace('one', 'on e')), h);
  assert.notEqual(approvalHash(text.replace('1. one\n2. two', '2. two\n1. one')), h, 'the order of lines inside a section is content');
  // the file written by roadctl itself (LF or CRLF on disk) hashes the same as the text roadctl hashed at routine on
  const r = rig();
  r.routine();
  const lf = r.hash();
  fs.writeFileSync(r.file, r.text().replace(/\n/g, '\r\n'));
  assert.equal(r.row().reasons.length, 0, 'a CRLF checkout of the same routine still matches');
  assert.equal(approvalHash(r.text()), lf);
});

// ---------------------------------------------------------------- a7: the reason through the hook and the digest

test('P5.15 a7: the reason comes from the routine-reasons hook (module_reasons, immediate) and is a problem at once in digest: told once, again after a new approval and a new edit; the daily overview names it', FAKES_SKIP, () => {
  const r = rig();
  r.setConfig({ language: 'en' });
  r.routine();
  const now = clock(shift(10));
  assert.equal(r.ok(['digest', '--since-state', 'a'], now).stdout, '', 'nothing changed: silence');
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and mail it.'));
  const m = r.row(now).module_reasons;
  assert.equal(m.length, 1);
  assert.equal(m[0].module, 'approval-hash');
  assert.equal(m[0].immediate, true);
  assert.equal(m[0].lint, 'error');
  const first = r.ok(['digest', '--since-state', 'a'], now).stdout;
  assert.match(first, /^routine my-app\/mr-status: /m);
  assert.match(first, /changed after approval/);
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(20))).stdout, '', 'told once');
  assert.match(r.ok(['digest', '--since-state', 'b'], now).stdout, /changed after approval/, 'another state name has its own memory');
  const j = JSON.parse(r.ok(['digest', '--since-state', 'c', '--json'], now).stdout);
  assert.equal(j.events.length, 1);
  assert.equal(j.events[0].outcome, 'blocked');
  assert.match(r.ok(['digest', '--daily'], now).stdout, /my-app\/mr-status: [^\n]*changed after approval/);
  // approved again: the recovery is told once, as resolved (the matching hash gives no event of its own, the digest compares the reasons with what it told)
  r.approve();
  const fixed = r.ok(['digest', '--since-state', 'a'], clock(shift(30))).stdout;
  assert.match(fixed, /^resolved: my-app\/mr-status: approval-hash$/mi, 'recovery is reported');
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(31))).stdout, '', 'once');
  // edited again with no run in between: a new message
  r.edit((x) => x.replace('mail it.', 'mail it twice.'));
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(40))).stdout, /changed after approval/, 'a new edit after a new approval is a new message');
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(41))).stdout, '', 'and told once');
  // notify: never is the owner's own choice of silence
  r.edit((x) => x.replace('every: 2h', 'every: 2h\nnotify: never'));
  r.approve();
  r.edit((x) => x.replace('twice.', 'thrice.'));
  assert.equal(r.ok(['digest', '--since-state', 'd'], clock(shift(50))).stdout, '');
});

// ---------------------------------------------------------------- the module and its seams

test('P5.15: the module declares its routine key, the seams exist, routine new and unapproved routines are not touched', () => {
  assert.equal(hashModule.name, 'approval-hash');
  assert.deepEqual(hashModule.routineKeys, [HASH_KEY, ID_KEY]);
  for (const h of ['routine-on', 'routine-lint']) assert.ok(HOOK_NAMES.includes(h), h);
  assert.deepEqual(Object.keys(hashModule.hooks).sort(), ['routine-lint', 'routine-on', 'routine-reasons']);
  const api = { compareVersions: rc.compareVersions };
  const raisedBoard = { config: { requires: HASH_REQUIRES } };
  const text = '---\nid: r\napproved: o, 2026-11-10, scope=read+board, source=x\n---\n\n## Goal\n\nx\n';
  assert.deepEqual(hashModule.hooks['routine-on']({ board: raisedBoard, text: 'no header', api }), {}, 'no header: nothing to write');
  const written = hashModule.hooks['routine-on']({ board: raisedBoard, text, api }).header;
  assert.deepEqual(Object.keys(written), [HASH_KEY, ID_KEY]);
  assert.equal(written[HASH_KEY], approvalHash(text));
  assert.match(written[ID_KEY], /^[0-9a-f]{12}$/);
  assert.notEqual(hashModule.hooks['routine-on']({ board: raisedBoard, text, api }).header[ID_KEY], written[ID_KEY], 'a new id with every approval');
  for (const config of [{}, { requires: '0.5.0' }, { requires: 'banana' }, { requires: null }]) assert.deepEqual(hashModule.hooks['routine-on']({ board: { config }, text, api }), {}, `requires ${JSON.stringify(config)}: nothing is written`);
  // the key is known: lint has no "unknown key approved_hash"
  const r = rig();
  r.routine();
  assert.ok(!r.lint().some((x) => /unknown key/.test(x.msg)));
  // a routine that was never approved or is off is not touched by the module
  r.ok(['routine', 'new', 'other', 'Other', '--agent', ME, '--model', 'haiku', '--env', 'laptop', '--every', '2h']);
  assert.ok(!/approved_hash/.test(fs.readFileSync(path.join(r.board, 'routines', 'other.md'), 'utf8')), 'routine new writes no hash');
  const rows = JSON.parse(r.ok(['routine', 'list', '--json']).stdout);
  assert.deepEqual(rows.find((x) => x.id === 'other').reasons, ['not approved', 'disabled']);
  assert.ok(!rows.find((x) => x.id === 'other').module_reasons);
});

// ---------------------------------------------------------------- a8: docs

test('P5.15 a8: docs name the limit (the local watchdog script and the settings file are outside the hash), the fields, requires 0.6.0 and the new hooks', () => {
  assert.match(DOCS, /approved_hash/);
  assert.match(DOCS, /changed after approval/);
  assert.match(DOCS, /watchdog script/i);
  assert.match(DOCS, /settings file/i);
  assert.match(DOCS, /outside the hash/i);
  assert.match(DOCS, /the hash is public/i);
  assert.match(DOCS, /not a defence against a malicious agent/i);
  assert.match(DOCS, /"requires": "0\.6\.0"/);
  for (const k of OUTSIDE_KEYS) assert.ok(DOCS.includes(k), `docs mention ${k}`);
  assert.match(DEV, /routine-on/);
  assert.match(DEV, /routine-lint/);
});

// ---------------------------------------------------------------- review fixes: a lone copy, re-approval below requires, the routine-on contract

const lone = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hash-lone-'));
  fs.copyFileSync(SELF, path.join(dir, 'roadctl.mjs')); // no roadctl/ folder: no modules
  return path.join(dir, 'roadctl.mjs');
};

test('P5.15 review 2: a copy of roadctl.mjs without its modules folder refuses a board that requires 0.6.0 (no RUN, reason in tick, routine list and lint), even with an empty or wrong hash', FAKES_SKIP, () => {
  const r = rig();
  r.routine();
  const bin = lone();
  const args = (a) => spawnSync(process.execPath, [bin, ...a, '--board', r.board], { cwd: r.ws, encoding: 'utf8', env: r.env });
  assert.ok(runs(r.tick()), 'control: the whole install runs the approved routine');
  for (const [what, edit] of [['changed text', (x) => x.replace('Read the MR list.', 'Read it and push.')], ['empty hash', (x) => x.replace(/^approved_hash: .*$/m, 'approved_hash:')], ['no hash', (x) => x.replace(/^approved_hash: .*\n/m, '')]]) {
    r.edit(edit);
    const t = args(['tick', '--as', ME, '--no-pull']);
    assert.ok(!runs(t), `${what}: no RUN\n${t.stdout}`);
    assert.match(t.stdout, /requires: my-app: board requires the module approval-hash/);
    assert.match(args(['routine', 'list']).stdout, /would not run: board requires the module approval-hash/);
    const l = JSON.parse(args(['lint', '--json']).stdout);
    assert.ok(l.some((x) => x.rule === 10 && x.level === 'error' && /approval-hash/.test(x.msg)), 'lint rule 10');
    r.approve();
  }
  // a board below 0.6.0 is not touched by the lone copy: it behaves as before
  r.setConfig({ requires: '0.5.0' });
  assert.match(args(['tick', '--as', ME, '--no-pull']).stdout, /^RUN /m);
  assert.equal(rc.boardRequires({ requires: HASH_REQUIRES }, rc.VERSION), null, 'with the modules loaded the same board is fine');
});

test('P5.15 review 5: routine on refreshes a hash that is already there on a board below 0.6.0, so the routine runs again', FAKES_SKIP, () => {
  const r = rig({ requires: false });
  r.routine();
  assert.equal(r.hash(), undefined);
  r.edit((x) => x.replace(/^enabled: true$/m, `enabled: true\napproved_hash: ${approvalHash(x)}`));
  assert.ok(runs(r.tick()), 'the hash matches');
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and mail it.'));
  assert.ok(!runs(r.tick()), 'changed after approval');
  r.approve();
  assert.equal(r.hash(), approvalHash(r.text()), 'the hash is refreshed');
  assert.ok(runs(r.tick()), 'and the routine runs again');
});

// a module that breaks the routine-on contract: it returns a key it did not declare
const BAD = `export default {
  name: 'bad-writer',
  routineKeys: ['mine'],
  hooks: { 'routine-on'({ text }) { return { header: JSON.parse(process.env.BAD_HEADER ?? '{}') }; } },
};
`;
test('P5.15 review 6: routine-on may write only the routine keys its own module declared; any other key or a multi-line value fails routine on and changes nothing', FAKES_SKIP, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hash-bad-'));
  fs.copyFileSync(SELF, path.join(dir, 'roadctl.mjs'));
  fs.cpSync(here, path.join(dir, 'roadctl'), { recursive: true, filter: (f) => !f.endsWith('.test.mjs') });
  fs.writeFileSync(path.join(dir, 'roadctl', 'bad-writer.mjs'), BAD);
  const idx = path.join(dir, 'roadctl', 'index.mjs');
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace("import probe from './probe.mjs';", "import probe from './probe.mjs';\nimport badWriter from './bad-writer.mjs';").replace(/(export const MODULES = \[[^\]]*)\]/, '$1, badWriter]'));
  const r = rig();
  r.routine();
  const bin = path.join(dir, 'roadctl.mjs');
  const on = (header) => spawnSync(process.execPath, [bin, 'routine', 'on', 'mr-status', '--by', OWNER, '--board', r.board], { cwd: r.ws, encoding: 'utf8', env: { ...r.env, BAD_HEADER: JSON.stringify(header) } });
  const before = r.text();
  for (const header of [{ enabled: 'false' }, { approved: 'x, 2026-01-01, scope=read+board+external' }, { approved_hash: 'sha256-v1:00' }, { mine: 'line one\nenabled: false' }, { other_key: 'x' }]) {
    const t = on(header);
    assert.equal(t.status, 2, `${JSON.stringify(header)}: ${t.stdout}${t.stderr}`);
    assert.match(t.stderr, /module bad-writer: hook routine-on returned/);
    assert.equal(r.text(), before, 'the file is unchanged');
  }
  const good = on({ mine: 'ok' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(r.text(), /^mine: ok$/m, 'its own declared key is written');
});

// ---------------------------------------------------------------- round 3: the digest state of module problems

const wordsEn = (r) => r.setConfig({ language: 'en' });

test('P5.15 round 3 (a): an approval that changes neither the approval line nor the hash (the owner restored the text and ran routine on) still starts a new episode: a later edit is told even if no digest ran in between', FAKES_SKIP, () => {
  const r = rig();
  wordsEn(r);
  r.routine();
  const orig = r.text();
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and mail it.'));
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(10))).stdout, /changed after approval/);
  const hashBefore = r.hash();
  const approvedBefore = r.text().match(/^approved: .*$/m)[0];
  r.edit(() => orig); // the owner restored the text ...
  r.approve(); // ... and approved it again: no --scope, so `approved` stays; the text is the old one, so the hash stays
  assert.equal(r.hash(), hashBefore);
  assert.equal(r.text().match(/^approved: .*$/m)[0], approvedBefore);
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and mail it.')); // edited again before any digest saw the restored state
  const out = r.ok(['digest', '--since-state', 'a'], clock(shift(20))).stdout;
  assert.match(out, /changed after approval/, 'told again: it is a new episode');
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(21))).stdout, '', 'once');
});

test('P5.15 round 3 (b): the approval problem changes only its own state: another active problem of the routine survives it and is closed only by its own clean run', FAKES_SKIP, () => {
  const r = rig();
  wordsEn(r);
  r.routine();
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'escalated', '--did', 'checked', '--problem', 'permanent: disk-full: /var is full'], clock(shift(5)));
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(6))).stdout, /disk-full/);
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and mail it.'));
  const t = r.ok(['digest', '--since-state', 'a'], clock(shift(10))).stdout;
  assert.match(t, /changed after approval/);
  assert.doesNotMatch(t, /resolved/i, 'the access problem was not resolved by anybody');
  r.approve();
  const rec = r.ok(['digest', '--since-state', 'a'], clock(shift(15))).stdout;
  assert.match(rec, /resolved: my-app\/mr-status: approval-hash/);
  assert.doesNotMatch(rec, /disk-full/, 'only the approval problem is closed');
  // the other problem is still open: a clean run closes it, and only then
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', '--did', 'checked again'], clock(shift(130)));
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(131))).stdout, /resolved: my-app\/mr-status: disk-full/);
  // and a run does not close the approval problem
  r.edit((x) => x.replace('mail it.', 'mail it twice.'));
  r.ok(['digest', '--since-state', 'a'], clock(shift(140)));
  r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', '--did', 'again'], clock(shift(260)));
  assert.doesNotMatch(r.ok(['digest', '--since-state', 'a'], clock(shift(261))).stdout, /resolved: my-app\/mr-status: approval-hash/, 'a clean run does not resolve an unapproved edit');
});

test('P5.15 round 3 (c): the recovery after routine on is told once as resolved; routine off and removing the routine close the state without a message about a fix', FAKES_SKIP, () => {
  const r = rig();
  wordsEn(r);
  r.routine();
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and mail it.'));
  r.ok(['digest', '--since-state', 'a'], clock(shift(10)));
  r.approve();
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(15))).stdout, /resolved: my-app\/mr-status: approval-hash/);
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(16))).stdout, '', 'once');
  // --dry-run neither moves the state nor loses the message
  r.edit((x) => x.replace('mail it.', 'mail it twice.'));
  assert.match(r.ok(['digest', '--since-state', 'a', '--dry-run'], clock(shift(20))).stdout, /changed after approval/);
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(21))).stdout, /changed after approval/, 'dry run left it for the real one');
  // switched off while it is unapproved: not a recovery, so no `resolved`; the state goes quietly
  r.ok(['routine', 'off', 'mr-status', '--by', OWNER]);
  const off = r.ok(['digest', '--since-state', 'a'], clock(shift(25))).stdout;
  assert.doesNotMatch(off, /resolved/i, 'switching off is not a fix');
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(26))).stdout, '');
  r.approve(); // on again with the edited text approved: matching, nothing to tell
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(27))).stdout, '');
  r.edit((x) => x.replace('mail it twice.', 'mail it thrice.'));
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(28))).stdout, /changed after approval/, 'the state was cleared, so a new edit is told afresh');
  // the routine is removed: the old state is dropped silently
  fs.rmSync(r.file);
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(30))).stdout, '');
});

// ---------------------------------------------------------------- round 4: the approval id, not the Log

const fillLog = (r, n) => r.edit((x) => x.replace(/^## Log\n[\s\S]*$/m, `## Log\n${Array.from({ length: n }, (_, i) => `- 2026-11-10 [${OWNER}] ON (earlier approval ${i})`).join('\n')}\n`));

test('P5.15 round 4: every routine on writes a new approval_id (outside the hash); a full Log of 50 ON lines does not hide a new approval, and a trimmed Log does not repeat an old message', FAKES_SKIP, () => {
  const r = rig();
  wordsEn(r);
  r.routine();
  const id1 = r.text().match(/^approval_id: ([0-9a-f]{12})$/m)?.[1];
  assert.ok(id1, 'routine on writes approval_id');
  assert.equal(approvalHash(r.text()), r.hash(), 'the id is not in the hash');
  r.approve();
  const id2 = r.text().match(/^approval_id: (.*)$/m)[1];
  assert.notEqual(id2, id1, 'a new id every time, with the same text and scope');
  assert.equal(r.hash(), approvalHash(r.text()));
  // 50 ON lines already: routine on adds one and drops one, the count stays 50 -- the episode must still be new
  fillLog(r, 50);
  const orig = r.text();
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and mail it.'));
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(10))).stdout, /changed after approval/);
  r.edit(() => orig);
  r.approve(); // same text, same scope: approved and hash unchanged, the Log still has 50 lines
  assert.equal((r.text().match(/\] ON/g) ?? []).length, 50);
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and mail it.'));
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(20))).stdout, /changed after approval/, 'told again: a new approval');
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(21))).stdout, '');
  // routine done drops old ON lines from the Log (the last 50 are kept): the same problem is not told again
  for (let i = 0; i < 3; i++) r.ok(['routine', 'done', 'mr-status', '--as', ME, '--result', 'ok', `run ${i}`], clock(shift(30 + i * 130)));
  assert.ok((r.text().match(/\] ON/g) ?? []).length < 50, 'old ON lines fell out of the Log');
  assert.doesNotMatch(r.ok(['digest', '--since-state', 'a'], clock(shift(400))).stdout, /changed after approval/, 'no repeat after the Log was trimmed');
});

test('P5.15 round 4: a routine approved before approval_id existed has none: its episodes still work without it', FAKES_SKIP, () => {
  const r = rig();
  wordsEn(r);
  r.routine();
  r.edit((x) => x.replace(/^approval_id: .*\n/m, ''));
  assert.doesNotMatch(r.text(), /approval_id/);
  assert.equal(r.row().reasons.length, 0, 'the id is not part of the hash: still approved');
  r.edit((x) => x.replace('Read the MR list.', 'Read the MR list and mail it.'));
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(10))).stdout, /changed after approval/);
  assert.equal(r.ok(['digest', '--since-state', 'a'], clock(shift(11))).stdout, '');
  r.approve();
  assert.match(r.ok(['digest', '--since-state', 'a'], clock(shift(15))).stdout, /resolved: my-app\/mr-status: approval-hash/);
});
