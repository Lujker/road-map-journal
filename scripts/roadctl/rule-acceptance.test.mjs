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
  const { acceptRule } = await import('./rule-acceptance.mjs');
  const { compareVersions, appendLog } = await import('../roadctl.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-gate-'));
  fs.mkdirSync(path.join(dir, 'cards'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ requires: RULE_REQUIRES }));
  const file = path.join(dir, 'cards', 'A.md');
  const proof = { tests: { result: 'pass', command: 'node --test' }, review: { agent: 'reviewer', result: 'pass', blockers: [] } };
  const content = (p = proof, mark = 'x', evidence = '- a1: tests passed') => `---\nid: A\ntitle: Alpha\nstatus: review\n---\n\n## Acceptance\n- [${mark}] a1: works\n\n## Evidence\n${evidence}\n\n## Rule Evidence\n${JSON.stringify(p)}\n`;
  const api = { compareVersions, boardRequires: (config) => boardRequires(config, RULE_REQUIRES), appendLog };
  const cases = [
    content({ ...proof, tests: { result: 'fail', command: 'test' } }),
    content(proof, 'x', ''), content(proof, ' '),
    content({ ...proof, review: undefined }),
    content({ ...proof, review: { ...proof.review, blockers: ['defect'] } }),
  ];
  for (const input of cases) {
    fs.writeFileSync(file, input);
    const result = acceptRule(loadBoard(dir), 'A', 'orchestrator', api);
    assert.equal(result.ok, false, input);
    assert.equal(fs.readFileSync(file, 'utf8'), input, 'refusal does not write');
  }
  fs.writeFileSync(file, content());
  assert.equal(acceptRule(loadBoard(dir), 'A', 'orchestrator', api).ok, true);
  const card = loadBoard(dir).cards[0];
  assert.equal(card.header.accepted, 'rule');
  assert.equal(card.header.status, 'review');
});
