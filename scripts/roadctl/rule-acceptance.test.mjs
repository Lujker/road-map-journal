import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardRequires, loadBoard, brief, briefJson, statusSummary, formatStatus } from '../roadctl.mjs';
import { RULE_REQUIRES } from './rule-acceptance.mjs';

test('P5.35 a8: older copies refuse boards that use rule acceptance', () => {
  const board = { requires: RULE_REQUIRES };
  assert.match(boardRequires(board, '0.14.0'), /requires roadctl 0\.15\.0/);
  assert.equal(boardRequires(board, RULE_REQUIRES), null);
});

test('P5.35 a8: an old copy offers no work on a rule-acceptance board', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-old-'));
  const board = path.join(dir, 'board');
  fs.mkdirSync(path.join(board, 'cards'), { recursive: true });
  fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ board_version: 1, requires: RULE_REQUIRES, autonomy: { enabled: true, agents: [], queue: ['B'] } }));
  fs.writeFileSync(path.join(board, 'cards', 'A.md'), '---\nid: A\ntitle: A\nstatus: review\naccepted: rule\n---\n');
  fs.writeFileSync(path.join(board, 'cards', 'B.md'), '---\nid: B\ntitle: B\nstatus: ready\ndepends_on: A\napproved: Owner, 2026-11-01, scope=implementation+auto\n---\n');
  const bin = fileURLToPath(new URL('../roadctl.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [bin, 'tick', '--as', 'agent', '--no-pull', '--json', '--board', board], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state') } });
  assert.equal(r.status, 4, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result.items, []);
  assert.match(result.sync.join(' '), /requires roadctl 0\.15\.0/);
});

test('P5.35 a3: rule acceptance stays in review and is visible in status and brief', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-status-'));
  fs.mkdirSync(path.join(dir, 'cards'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.writeFileSync(path.join(dir, 'cards', 'A.md'), '---\nid: A\ntitle: Alpha\nstatus: review\naccepted: rule\n---\n');
  fs.writeFileSync(path.join(dir, 'cards', 'B.md'), '---\nid: B\ntitle: Beta\nstatus: done\naccepted: Owner, 2026-11-01\n---\n');
  const board = loadBoard(dir);
  const summary = statusSummary('p', board);
  assert.equal(summary.counts.review, 1);
  assert.equal(summary.counts.done, 1);
  assert.equal(summary.review[0].accepted, 'rule');
  assert.equal(briefJson(board).review[0].accepted, 'rule');
  assert.match(formatStatus([summary]), /REVIEW \[A\].*accepted by rule/);
  assert.match(brief(board), /REVIEW \[A\].*accepted by rule/);
  const bin = fileURLToPath(new URL('../roadctl.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [bin, 'done', 'A', '--by', 'Owner', '--board', dir], { encoding: 'utf8', env: { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), ROADCTL_UNATTENDED: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unattended run/);
  assert.equal(loadBoard(dir).cards.find((c) => c.header.id === 'A').header.status, 'review');
});

test('P5.35 a1: rule acceptance requires green tests, every criterion and an unblocked review', async () => {
  const { acceptRule, ruleSnapshot } = await import('./rule-acceptance.mjs');
  const { compareVersions, appendLog } = await import('../roadctl.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-gate-'));
  fs.mkdirSync(path.join(dir, 'cards'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ requires: RULE_REQUIRES }));
  const file = path.join(dir, 'cards', 'A.md');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'code'), 'initial');
  git('add', 'code');
  git('commit', '-qm', 'initial');
  const proof = { tests: { result: 'pass', command: 'node --test' }, worker: { agent: 'worker', model: 'model-a', run: 'r1', source: 'run log' }, review: { agent: 'reviewer', model: 'model-b', run: 'r2', source: 'run log', result: 'pass', blockers: [] } };
  const content = (p = proof, mark = 'x', evidence = '- a1: tests passed') => `---\nid: A\ntitle: Alpha\nstatus: review\n---\n\n## Acceptance\n- [${mark}] a1: works\n\n## Evidence\n${evidence}\n\n## Rule Evidence\n${JSON.stringify(p)}\n`;
  const api = { compareVersions, boardRequires: (config) => boardRequires(config, RULE_REQUIRES), appendLog, loadRegistry: () => ({ providers: { test: { models: { 'model-a': ['alias-a'], 'model-b': [] } } } }) };
  fs.writeFileSync(file, content());
  const snapshot = ruleSnapshot(loadBoard(dir), 'A', repo);
  Object.assign(proof.tests, snapshot);
  Object.assign(proof.review, snapshot);
  const cases = [
    content({ ...proof, tests: { result: 'fail', command: 'test' } }),
    content(proof, 'x', ''), content(proof, ' '),
    content({ ...proof, review: undefined }),
    content({ ...proof, review: { ...proof.review, blockers: ['defect'] } }),
    content({ ...proof, review: { ...proof.review, model: 'alias-a[high]' } }),
    content({ ...proof, review: { ...proof.review, model: 'unknown' } }),
    content({ ...proof, review: { ...proof.review, agent: 'worker' } }),
    content({ ...proof, review: { ...proof.review, run: 'r1' } }),
    content({ ...proof, review: { ...proof.review, basis: 'sha256:wrong' } }),
  ];
  for (const input of cases) {
    fs.writeFileSync(file, input);
    const result = acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo);
    assert.equal(result.ok, false, input);
    assert.equal(fs.readFileSync(file, 'utf8'), input, 'refusal does not write');
  }
  fs.writeFileSync(file, content(proof, 'x', '- a1: different evidence'));
  assert.equal(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo).ok, false, 'changed evidence');
  fs.writeFileSync(file, content().replace('a1: works', 'a1: changed'));
  assert.equal(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo).ok, false, 'changed criterion');
  fs.writeFileSync(file, content().replace('status: review', 'status: review\napproved: Owner, 2026-11-01, scope=implementation'));
  assert.equal(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo).ok, false, 'changed approval');
  fs.writeFileSync(path.join(repo, 'code'), 'changed');
  git('add', 'code');
  git('commit', '-qm', 'changed');
  fs.writeFileSync(file, content());
  assert.equal(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo).ok, false, 'changed revision');
  Object.assign(proof.tests, ruleSnapshot(loadBoard(dir), 'A', repo));
  Object.assign(proof.review, ruleSnapshot(loadBoard(dir), 'A', repo));
  fs.writeFileSync(file, content());
  assert.equal(acceptRule(loadBoard(dir), 'A', 'script:bot', api, repo).ok, false, 'a script cannot accept');
  assert.equal(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo).ok, true);
  const card = loadBoard(dir).cards[0];
  assert.equal(card.header.accepted, 'rule');
  assert.equal(card.header.status, 'review');
});

test('P5.35 a10: aliases and effort cannot disguise same model; unknowns and self-review fail', async () => {
  const { canonicalModel } = await import('./rule-acceptance.mjs');
  const registry = { providers: { one: { models: { 'model-a': ['alias-a'], 'model-b': ['alias-b'] } } } };
  assert.equal(canonicalModel('alias-a[high]', registry), canonicalModel('one/model-a:low', registry));
  assert.notEqual(canonicalModel('model-a', registry), canonicalModel('model-b', registry));
  assert.equal(canonicalModel('unknown', registry), null);
  assert.equal(canonicalModel('alias-a', { providers: { one: { models: { 'model-a': ['alias-a'], 'model-b': ['alias-a'] } } } }), null);
});

test('P5.35: CLI accepts a current independent review on a future 0.15 copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-cli-'));
  const source = fileURLToPath(new URL('..', import.meta.url));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.copyFileSync(path.join(source, 'roadctl.mjs'), path.join(binDir, 'roadctl.mjs'));
  fs.cpSync(path.join(source, 'roadctl'), path.join(binDir, 'roadctl'), { recursive: true, filter: (f) => !f.endsWith('.test.mjs') });
  const bin = path.join(binDir, 'roadctl.mjs');
  fs.writeFileSync(bin, fs.readFileSync(bin, 'utf8').replace("export const VERSION = '0.14.0'", "export const VERSION = '0.15.0'"));
  const board = path.join(dir, 'board');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(board, 'cards'), { recursive: true });
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ board_version: 1, requires: RULE_REQUIRES }));
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), ROADCTL_REGISTRY: path.join(dir, 'registry.json'), GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  for (const args of [['init', '-q'], ['commit', '--allow-empty', '-qm', 'initial']]) assert.equal(spawnSync('git', args, { cwd: repo, env }).status, 0);
  fs.writeFileSync(env.ROADCTL_REGISTRY, JSON.stringify({ providers: { provider: { models: { alpha: [], beta: [] } } } }));
  const card = path.join(board, 'cards', 'A.md');
  const text = '---\nid: A\ntitle: Alpha\nstatus: review\nas_of: 2026-11-21\n---\n\n## Acceptance\n- [x] a1: works\n\n## Evidence\n- a1: verified\n';
  fs.writeFileSync(card, text);
  const run = (extra = []) => spawnSync(process.execPath, [bin, 'accept', 'A', '--rule', '--as', 'orchestrator', '--repo', repo, '--board', board, ...extra], { cwd: dir, env, encoding: 'utf8' });
  const snap = run(['--snapshot']);
  assert.equal(snap.status, 0, snap.stderr);
  const basis = JSON.parse(snap.stdout);
  const proof = { tests: { result: 'pass', command: 'node --test', ...basis }, worker: { agent: 'worker', model: 'alpha', run: 'one', source: 'run log' }, review: { agent: 'reviewer', model: 'beta', run: 'two', source: 'run log', result: 'pass', blockers: [], ...basis } };
  fs.writeFileSync(card, `${text}\n## Rule Evidence\n${JSON.stringify(proof)}\n`);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadBoard(board).cards[0].header.accepted, 'rule');
});
