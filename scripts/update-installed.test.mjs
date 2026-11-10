import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decide, folderHash, nodeOk } from './update-installed.mjs';

test('nodeOk enforces the skills CLI minimum', () => {
  assert.equal(nodeOk('20.17.0'), false);
  assert.equal(nodeOk('22.19.9'), false);
  assert.equal(nodeOk('22.20.0'), true);
  assert.equal(nodeOk('26.12.1'), true);
});

test('folderHash ignores CRLF and detects edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmj-test-'));
  try {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    for (const d of [a, b]) fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    fs.writeFileSync(path.join(a, 'SKILL.md'), 'one\ntwo\n');
    fs.writeFileSync(path.join(a, 'references', 'x.md'), 'x\n');
    fs.writeFileSync(path.join(b, 'SKILL.md'), 'one\r\ntwo\r\n');
    fs.writeFileSync(path.join(b, 'references', 'x.md'), 'x\r\n');
    assert.equal(folderHash(a), folderHash(b));
    fs.appendFileSync(path.join(b, 'SKILL.md'), 'local\n');
    assert.notEqual(folderHash(a), folderHash(b));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('decide covers the update states', () => {
  const lock = { skillFolderHash: 'old' };
  assert.equal(decide({ canonicalExists: false }).state, 'NOT_INSTALLED');
  assert.equal(decide({ canonicalExists: true, lockEntry: null, installedHash: 'old', upstreamHash: 'new' }).state, 'UNTRACKED');
  assert.equal(decide({ canonicalExists: true, lockEntry: lock, installedHash: 'new', upstreamHash: 'new' }).state, 'UP_TO_DATE');
  assert.equal(decide({ canonicalExists: true, lockEntry: lock, installedHash: 'old', upstreamHash: 'new' }).state, 'OUTDATED');
  assert.equal(decide({ canonicalExists: true, lockEntry: lock, installedHash: 'edited', upstreamHash: 'new' }).state, 'LOCALLY_MODIFIED');
});
