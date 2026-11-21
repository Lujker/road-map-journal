import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardRequires } from '../roadctl.mjs';
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
