import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { escalationAdmission, escalationFile, readEscalation, writeEscalation } from './escalation.mjs';

test('opt-in escalation journal refuses unknown, repeated and unbound attempts after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escalation-'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  const file = escalationFile(dir, dir, 'A');
  const strong = { profile: 'strong', agent: 'codex@local', model: 'strong-model' };
  const started = { version: 1, phase: 'started', strong, limit_s: 100, run_id: 'r1' };
  writeEscalation(file, started, { create: true });
  assert.throws(() => writeEscalation(file, started, { create: true }));
  assert.equal(escalationAdmission(readEscalation(file), strong), null);
  const ready = { ...started, phase: 'ready', outcome: 'escalated', group_gone: true, used_s: 40, checkpoint: { run_id: 'r1', did: 'done', next: 'continue', in_flight: 'none' } };
  writeEscalation(file, ready);
  assert.equal(escalationAdmission(readEscalation(file), strong), 60);
  for (const change of [{ group_gone: false }, { outcome: 'crashed' }, { checkpoint: { run_id: 'other' } }, { used_s: null }, { phase: 'started-strong' }]) {
    assert.equal(escalationAdmission({ ...ready, ...change }, strong), null);
  }
  assert.equal(escalationAdmission(ready, { ...strong, model: 'different' }), null);
});

test('linked worktrees use the same journal and lock identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escalation-worktree-'));
  const repo = path.join(dir, 'repo'), other = path.join(dir, 'other'); fs.mkdirSync(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@invalid' };
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo, env }).status, 0);
  git('init', '-q'); fs.mkdirSync(path.join(repo, 'board')); fs.writeFileSync(path.join(repo, 'board', 'config.json'), '{}');
  git('add', '.'); git('commit', '-qm', 'fixture'); git('worktree', 'add', '-qb', 'other', other);
  assert.equal(escalationFile(dir, path.join(repo, 'board'), 'A'), escalationFile(dir, path.join(other, 'board'), 'A'));
});
