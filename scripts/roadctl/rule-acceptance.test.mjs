import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { autonomyRows, boardRequires, loadBoard, brief, briefJson, statusSummary, formatStatus } from '../roadctl.mjs';
import { CLOSE_REVIEWED_REQUIRES, RULE_REQUIRES, ruleContent } from './rule-acceptance.mjs';
import { approvalHash } from './approval-hash.mjs';

function approvedMandate(board, level = 'L3') {
  const raw = `---\nmandate: 1\nlevel: ${level}\nkinds: fix\nmax_size: M\nbudget: cards_per_day=2, runs_per_week=5\n---\n`;
  fs.writeFileSync(path.join(board, 'mandate.md'), raw.replace('\n---\n', `\napproved: Owner, 2026-11-20\napproved_hash: ${approvalHash(raw)}\n---\n`));
  return approvalHash(raw);
}

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
  const source = fileURLToPath(new URL('../', import.meta.url));
  const oldScripts = path.join(dir, 'scripts');
  fs.cpSync(source, oldScripts, { recursive: true });
  const bin = path.join(oldScripts, 'roadctl.mjs');
  fs.writeFileSync(bin, fs.readFileSync(bin, 'utf8').replace("export const VERSION = '0.16.0';", "export const VERSION = '0.14.0';"));
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
  const { acceptRule, ruleSnapshot, ruleDependencySatisfied } = await import('./rule-acceptance.mjs');
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
  const api = { compareVersions, boardRequires: (config) => boardRequires(config, RULE_REQUIRES), appendLog, scopesOf: (s) => String(s ?? '').match(/scope=([^,]+)/)?.[1].split('+') ?? [], approvalBasis: () => ({ ok: false }), delegationInfo: () => ({ delegate: null }), loadRegistry: () => ({ providers: { test: { models: { 'model-a': ['alias-a'], 'model-b': [] } } } }) };
  fs.writeFileSync(file, content());
  assert.match(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo).reasons[0], /mandate/);
  fs.writeFileSync(file, content().replace('status: review', 'status: review\napproved: Owner, 2026-11-01, scope=implementation'));
  assert.match(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo).reasons[0], /mandate/, 'legacy boards remain L3/L4-only');
  approvedMandate(dir, 'L2');
  assert.match(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo).reasons[0], /mandate/);
  approvedMandate(dir);
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
  assert.equal(ruleDependencySatisfied(loadBoard(dir), card, api), true);
  assert.equal(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo, { recheck: true }).ok, false, 'current acceptance is not repeated');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- a1: tests passed', '- a1: rechecked'));
  assert.equal(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo, { recheck: true }).ok, false, 'old test and review are stale');
  const updated = ruleSnapshot(loadBoard(dir), 'A', repo);
  Object.assign(proof.tests, updated); Object.assign(proof.review, updated);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(## Rule Evidence\n)[^\n]+/, (_, h) => h + JSON.stringify(proof)));
  assert.equal(acceptRule(loadBoard(dir), 'A', 'orchestrator', api, repo, { recheck: true }).ok, true);
  assert.notEqual(loadBoard(dir).cards[0].header.rule_id, card.header.rule_id);
});

test('P5.35 a10: aliases and effort cannot disguise same model; unknowns and self-review fail', async () => {
  const { canonicalModel } = await import('./rule-acceptance.mjs');
  const registry = { providers: { one: { models: { 'model-a': ['alias-a'], 'model-b': ['alias-b'] } } } };
  assert.equal(canonicalModel('alias-a[high]', registry), canonicalModel('one/model-a:low', registry));
  assert.notEqual(canonicalModel('model-a', registry), canonicalModel('model-b', registry));
  assert.equal(canonicalModel('unknown', registry), null);
  assert.equal(canonicalModel('alias-a', { providers: { one: { models: { 'model-a': ['alias-a'], 'model-b': ['alias-a'] } } } }), null);
});

test('P5.52: opt-in closes an existing current direct approval, preserves owner-only review, and records one close event', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-cli-'));
  const source = fileURLToPath(new URL('..', import.meta.url));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.copyFileSync(path.join(source, 'roadctl.mjs'), path.join(binDir, 'roadctl.mjs'));
  fs.cpSync(path.join(source, 'roadctl'), path.join(binDir, 'roadctl'), { recursive: true, filter: (f) => !f.endsWith('.test.mjs') });
  const bin = path.join(binDir, 'roadctl.mjs');
  const board = path.join(dir, 'board');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(board, 'cards'), { recursive: true });
  fs.mkdirSync(repo);
  const config = path.join(board, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ board_version: 1, requires: CLOSE_REVIEWED_REQUIRES }));
  const mandateHash = approvedMandate(board);
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), ROADCTL_REGISTRY: path.join(dir, 'registry.json'), GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  for (const args of [['init', '-q'], ['commit', '--allow-empty', '-qm', 'initial']]) assert.equal(spawnSync('git', args, { cwd: repo, env }).status, 0);
  fs.writeFileSync(env.ROADCTL_REGISTRY, JSON.stringify({ providers: { provider: { models: { alpha: [], beta: [] } } } }));
  const card = path.join(board, 'cards', 'A.md');
  const text = '---\nid: A\ntitle: Alpha\nstatus: review\nas_of: 2026-11-21\napproved: Owner, 2026-11-21, scope=implementation\nowner_acceptance: required\n---\n\n## Acceptance\n- [x] a1: works\n\n## Evidence\n- a1: verified\n';
  fs.writeFileSync(card, text);
  const run = (extra = []) => spawnSync(process.execPath, [bin, 'accept', 'A', '--rule', '--as', 'orchestrator', '--repo', repo, '--board', board, ...extra], { cwd: dir, env, encoding: 'utf8' });
  const snap = run(['--snapshot']);
  assert.equal(snap.status, 0, snap.stderr);
  const basis = JSON.parse(snap.stdout);
  const proof = { tests: { result: 'pass', command: 'node --test', ...basis }, worker: { agent: 'worker', model: 'alpha', run: 'one', source: 'run log' }, review: { agent: 'reviewer', model: 'beta', run: 'two', source: 'run log', result: 'pass', blockers: [], ...basis } };
  fs.writeFileSync(card, `${text}\n## Rule Evidence\n${JSON.stringify(proof)}\n`);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadBoard(board).cards[0].header.status, 'review', 'old behavior stays review');
  fs.writeFileSync(config, JSON.stringify({ board_version: 1, requires: CLOSE_REVIEWED_REQUIRES, close_reviewed: true }));
  assert.match(run().stderr, /only the owner may close/);
  const withoutOwner = fs.readFileSync(card, 'utf8').replace(/^owner_acceptance: required\n/m, '').replace(/^---\n/, '---\ndelegate: to=worker host=any criteria=all by=agent accept=owner state=reported at=2026-11-21T00:00:00Z\n');
  fs.writeFileSync(card, withoutOwner);
  const fresh = JSON.parse(run(['--snapshot']).stdout);
  Object.assign(proof.tests, fresh); Object.assign(proof.review, fresh);
  fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace(/(## Rule Evidence\n)[^\n]+/, (_, h) => h + JSON.stringify(proof)));
  assert.match(run().stderr, /only the owner may close/, 'live accept=owner delegation also blocks');
  fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace('accept=owner', 'accept=by'));
  assert.match(run(['--recheck']).stderr, /finish the delegation/);
  fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace(/^delegate:.*\n/m, ''));
  const close = run();
  assert.equal(close.status, 0, close.stderr);
  const closed = loadBoard(board).cards[0];
  assert.equal(closed.header.status, 'done');
  assert.equal(closed.header.accepted, 'rule');
  assert.match(closed.log.at(-1).text, new RegExp(`^CLOSED after review: reviewer=reviewer revision=${fresh.revision}$`));
  assert.equal(closed.log.at(-1).author, 'orchestrator');
  const closedCount = () => loadBoard(board).cards[0].log.filter((l) => l.text.startsWith('CLOSED after review:')).length;
  assert.equal(closedCount(), 1);
  fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace('accepted: rule', 'accepted: Owner, 2026-11-22').replace('- a1: verified', '- a1: reverified'));
  const stale = JSON.parse(run(['--snapshot']).stdout);
  Object.assign(proof.tests, stale); Object.assign(proof.review, stale);
  fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace(/(## Rule Evidence\n)[^\n]+/, (_, h) => h + JSON.stringify(proof)));
  assert.equal(run(['--recheck']).status, 0, 'stale done may be rechecked');
  const rechecked = loadBoard(board).cards[0];
  assert.equal(rechecked.header.accepted, 'Owner, 2026-11-22', 'owner identity is preserved');
  assert.equal(closedCount(), 1, 'recheck writes no second CLOSED');
  assert.match(rechecked.log.at(-1).text, /^RECHECKED rule acceptance$/);
  const once = fs.readFileSync(card, 'utf8');
  assert.equal(run(['--recheck']).status, 1, 'current done refuses');
  assert.equal(fs.readFileSync(card, 'utf8'), once, 'repeat writes nothing');

  const bad = path.join(board, 'cards', 'B.md');
  fs.writeFileSync(bad, '---\nid: B\ntitle: Bad scope\nstatus: review\napproved: Owner, 2026-11-21, scope=analysis+implementationish\n---\n\n## Acceptance\n- [x] a1: works\n\n## Evidence\n- a1: yes\n');
  const runId = (id, extra = []) => spawnSync(process.execPath, [bin, 'accept', id, '--rule', '--as', 'orchestrator', '--repo', repo, '--board', board, ...extra], { cwd: dir, env, encoding: 'utf8' });
  assert.match(runId('B').stderr, /scope=implementation approval/);
  fs.writeFileSync(bad, fs.readFileSync(bad, 'utf8').replace('analysis+implementationish', 'analysis+implementation'));
  assert.match(runId('B').stderr, /missing or invalid Rule Evidence/, 'the shared scope parser accepts the exact implementation scope');

  const admitted = path.join(board, 'cards', 'M.md');
  const admittedText = `---\nid: M\ntitle: Mandated\nstatus: review\nkind: fix\nsize: S\nby_mandate: ${mandateHash}\n---\n\n## Acceptance\n- [x] a1: works\n\n## Evidence\n- a1: yes\n`;
  fs.writeFileSync(admitted, admittedText);
  const admittedBasis = JSON.parse(runId('M', ['--snapshot']).stdout);
  const admittedProof = { tests: { result: 'pass', command: 'node --test', ...admittedBasis }, worker: proof.worker, review: { ...proof.review, ...admittedBasis } };
  fs.writeFileSync(admitted, `${admittedText}\n## Rule Evidence\n${JSON.stringify(admittedProof)}\n`);
  fs.writeFileSync(admitted, fs.readFileSync(admitted, 'utf8').replace('kind: fix', 'kind: research'));
  assert.match(runId('M').stderr, /outside the current mandate|current by_mandate admission/, 'admission is rechecked after the snapshot');
  fs.writeFileSync(admitted, fs.readFileSync(admitted, 'utf8').replace('kind: research', 'kind: fix'));
  assert.equal(runId('M').status, 0, 'current by_mandate admission closes on opt-in');
  assert.equal(loadBoard(board).cards.find((c) => c.header.id === 'M').header.status, 'done');

  fs.writeFileSync(config, JSON.stringify({ board_version: 1, requires: CLOSE_REVIEWED_REQUIRES, close_reviewed: true, autonomy: { enabled: true, agents: [], queue: ['N'] } }));
  fs.writeFileSync(path.join(board, 'cards', 'N.md'), '---\nid: N\ntitle: Dependent\nstatus: ready\ndepends_on: M\napproved: Owner, 2026-11-21, scope=implementation+auto\n---\n');
  const dependentEligible = () => autonomyRows(loadBoard(board)).find((x) => x.id === 'N').eligible;
  assert.equal(dependentEligible(), true, 'closed mandate result initially satisfies its dependent');
  const mandateFile = path.join(board, 'mandate.md'), mandateRaw = fs.readFileSync(mandateFile, 'utf8');
  fs.writeFileSync(mandateFile, mandateRaw.replace('kinds: fix', 'kinds: research'));
  assert.equal(dependentEligible(), false, 'changed mandate invalidates the dependent');
  fs.writeFileSync(mandateFile, mandateRaw);
  const closedRaw = fs.readFileSync(admitted, 'utf8');
  for (const [from, to, label] of [['kind: fix', 'kind: research', 'kind'], ['size: S', 'size: L', 'size'], ['size: S', 'size: S\ngoal: G9', 'goal']]) {
    fs.writeFileSync(admitted, closedRaw.replace(from, to));
    assert.equal(dependentEligible(), false, `changed ${label} invalidates the dependent`);
  }
  fs.writeFileSync(admitted, closedRaw);
  assert.equal(dependentEligible(), true, 'restoring admission restores the current dependency');

  fs.writeFileSync(bad, fs.readFileSync(bad, 'utf8').replace('status: review', 'status: review\nby_mandate: stale'));
  assert.match(runId('B').stderr, /by_mandate is stale/, 'stale mandate marker wins over explicit approval');
});

test('P5.52: legacy hashes stay byte-compatible; owner-only delegation remains owner-only after withdrawal', async () => {
  const rc = await import('../roadctl.mjs');
  const crypto = await import('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-owner-'));
  fs.mkdirSync(path.join(dir, 'cards'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ requires: CLOSE_REVIEWED_REQUIRES, close_reviewed: true, autonomy: { enabled: true, agents: [], queue: ['B'] } }));
  const file = path.join(dir, 'cards', 'A.md');
  fs.writeFileSync(file, '---\nid: A\ntitle: A\nstatus: ready\napproved: Owner, 2026-11-21, scope=implementation\n---\n\n## Acceptance\n- [x] a1: works\n\n## Evidence\n- a1: yes\n');
  const legacy = loadBoard(dir).cards[0];
  const expected = crypto.default.createHash('sha256').update(JSON.stringify({ criteria: legacy.criteria, evidence: legacy.sections.Evidence.trim(), proof: '', approved: legacy.header.approved, by_mandate: '', depends_on: '' })).digest('hex');
  assert.equal(ruleContent(legacy), expected);
  fs.writeFileSync(path.join(dir, 'cards', 'D.md'), '---\nid: D\ntitle: Done\nstatus: done\naccepted: Owner, 2026-11-20\n---\n');
  fs.writeFileSync(path.join(dir, 'cards', 'B.md'), '---\nid: B\ntitle: B\nstatus: ready\ndepends_on: D\napproved: Owner, 2026-11-21, scope=implementation+auto\n---\n');
  assert.equal(rc.autonomyRows(loadBoard(dir)).find((x) => x.id === 'B').eligible, true, 'ordinary owner-done dependency needs no mandate');
  assert.equal(rc.delegateCard(loadBoard(dir), 'A', { to: 'worker', by: 'agent', accept: 'owner', registry: null }).ok, true);
  assert.equal(loadBoard(dir).cards[0].header.owner_acceptance, 'required');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^delegate:.*\n/m, ''));
  assert.equal(loadBoard(dir).cards[0].header.owner_acceptance, 'required', 'withdrawal cannot erase the owner-only decision');
});

test('P5.35 a12: real milestone return invalidates active and accepted dependency chains until fresh review', async () => {
  const { acceptRule, ruleSnapshot } = await import('./rule-acceptance.mjs');
  const rc = await import('../roadctl.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-chain-'));
  const board = path.join(dir, 'board'), repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(board, 'cards'), { recursive: true }); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ board_version: 1, requires: RULE_REQUIRES, autonomy: { enabled: true, agents: [], queue: ['C'] } }));
  approvedMandate(board);
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), ROADCTL_REGISTRY: path.join(dir, 'registry.json'), ROADCTL_NOW: '2026-11-20T10:00:00.000Z', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const registry = { providers: { test: { kind: 'api', models: { alpha: [], beta: [] } } } };
  fs.writeFileSync(env.ROADCTL_REGISTRY, JSON.stringify(registry));
  for (const args of [['init', '-q'], ['commit', '--allow-empty', '-qm', 'initial']]) assert.equal(spawnSync('git', args, { cwd: repo, env }).status, 0);
  const api = { compareVersions: rc.compareVersions, boardRequires: rc.boardRequires, appendLog: rc.appendLog, scopesOf: (s) => String(s ?? '').match(/scope=([^,]+)/)?.[1].split('+') ?? [], approvalBasis: () => ({ ok: false }), delegationInfo: () => ({ delegate: null }), loadRegistry: () => registry };
  const file = (id) => path.join(board, 'cards', `${id}.md`);
  const write = (id, status, dependency = '') => fs.writeFileSync(file(id), `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\n${dependency ? `depends_on: ${dependency}\n` : ''}${id === 'C' ? 'approved: Owner, 2026-11-20, scope=implementation+auto\n' : ''}---\n\n## Acceptance\n- [x] a1: works\n\n## Evidence\n- a1: tests passed\n`);
  const proof = (id) => {
    const snapshot = ruleSnapshot(rc.loadBoard(board), id, repo);
    const p = { tests: { result: 'pass', command: 'node --test', ...snapshot }, worker: { agent: 'worker', model: 'alpha', run: 'one', source: 'run log' }, review: { agent: 'reviewer', model: 'beta', run: 'two', source: 'run log', result: 'pass', blockers: [], ...snapshot } };
    let raw = fs.readFileSync(file(id), 'utf8');
    raw = /^## Rule Evidence$/m.test(raw) ? raw.replace(/(^## Rule Evidence\n)[^\n]+/m, (_, h) => h + JSON.stringify(p)) : `${raw}\n## Rule Evidence\n${JSON.stringify(p)}\n`;
    fs.writeFileSync(file(id), raw);
  };
  const accept = (id, recheck = false) => acceptRule(rc.loadBoard(board), id, 'orchestrator', api, repo, { recheck });
  const runnable = () => rc.autonomyRows(rc.loadBoard(board)).some((x) => x.id === 'C' && x.eligible);
  const cli = fileURLToPath(new URL('../roadctl.mjs', import.meta.url));
  const run = (args) => spawnSync(process.execPath, [cli, ...args, '--board', board], { cwd: dir, env, encoding: 'utf8' });
  const returned = () => {
    const inbox = JSON.parse(run(['inbox', '--json']).stdout), milestone = inbox.items.find((x) => x.target === 'M');
    const result = run(['milestone', 'return', 'M', '--cards', 'A', '--reason', 'rework', '--hash', milestone.hash, '--by', 'Owner']);
    assert.equal(result.status, 0, result.stderr);
  };
  const rereviewA = () => {
    fs.writeFileSync(file('A'), fs.readFileSync(file('A'), 'utf8').replace('status: doing', 'status: review'));
    proof('A'); assert.equal(accept('A').ok, true);
  };
  write('A', 'review'); proof('A'); assert.equal(accept('A').ok, true);
  write('B', 'doing', 'A'); proof('B'); write('C', 'ready', 'B');
  fs.mkdirSync(path.join(board, 'milestones')); fs.writeFileSync(path.join(board, 'milestones', 'M.md'), '---\nid: M\ncards: A\n---\n');
  returned();
  assert.match(fs.readFileSync(file('B'), 'utf8'), /status: doing/, 'active B is not rolled back');
  rereviewA();
  fs.writeFileSync(file('B'), fs.readFileSync(file('B'), 'utf8').replace('status: doing', 'status: review'));
  assert.equal(accept('B').ok, false, 'active B cannot accept with the old basis');
  proof('B'); assert.equal(accept('B').ok, true); assert.equal(runnable(), true);
  returned(); assert.equal(runnable(), false);
  rereviewA(); assert.equal(runnable(), false, 'new A acceptance does not revive B');
  for (const args of [['status'], ['brief'], ['inbox'], ['digest', '--daily']]) {
    const view = run(args); assert.match(view.stdout, /STALE RULE.*B|B: rule acceptance is stale/i, args.join(' '));
  }
  assert.equal(accept('B', true).ok, false, 'old B evidence does not recheck');
  proof('B'); assert.equal(accept('B', true).ok, true); assert.equal(runnable(), true);
});
