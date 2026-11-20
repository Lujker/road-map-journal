// P5.41 a6: roadctl worktree add|list|prune ID (module worktree.mjs). Run: node --test scripts/roadctl/worktree.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { branchFor, dirFor, idSlug } from './worktree.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const EXAMPLE = path.join(here, '..', '..', 'examples', 'board-example', 'board');

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-wt-'));
  const repo = fs.realpathSync(fs.mkdirSync(path.join(root, 'proj'), { recursive: true }) ?? path.join(root, 'proj'));
  const g = (cwd, ...a) => { try { return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { throw new Error(`git ${a.join(' ')}: ${e.stderr}${e.stdout}`); } };
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'init');
  const board = path.join(root, 'board');
  fs.cpSync(EXAMPLE, board, { recursive: true });
  const run = (args, cwd = repo) => spawnSync(process.execPath, [SELF, 'worktree', ...args, '--board', board], { cwd, encoding: 'utf8', env: { ...process.env, HOME: root, ROADCTL_DATE: '2026-11-10' } });
  return { root, repo, board, g, run, wt: (id) => dirFor(repo, id), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('P5.41 a6: the names follow the card id and the title; a title with no ASCII word gives work', () => {
  assert.equal(idSlug('P5.41'), 'p5.41');
  assert.equal(branchFor('P5.41', 'Handoff, lock and worktree for agents'), 'p5.41-handoff-lock-and');
  assert.equal(branchFor('W-3', 'Экспорт CSV'), 'w-3-csv');
  assert.equal(branchFor('W-3', 'Экспорт'), 'w-3-work');
  assert.equal(dirFor('/x/proj', 'W-3'), '/x/proj-w-3');
});

test('P5.41 a6: add makes the branch and the worktree of a card, a second add shows it, an unknown card or a non-repository is refused', () => {
  const r = rig();
  try {
    const a = r.run(['add', 'W-3']);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, new RegExp(`${r.wt('W-3').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(branch w-3-[a-z0-9-]+ from main\\)`));
    assert.ok(fs.existsSync(path.join(r.wt('W-3'), 'a.txt')), 'a real checkout of main');
    assert.match(r.g(r.repo, 'branch', '--list', 'w-3-*'), /w-3-/);
    const again = r.run(['add', 'W-3']);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /W-3: already /);
    assert.equal(r.g(r.repo, 'worktree', 'list').split('\n').length, 2, 'nothing was added the second time');
    assert.equal(r.run(['add', 'NOPE-1']).status, 2);
    assert.match(r.run(['add', 'NOPE-1']).stderr, /no card NOPE-1/);
    assert.equal(r.run(['add', 'W-3'], r.root).status, 2, 'the project root is not a repository');
    assert.equal(r.run(['bogus', 'W-3']).status, 2);
    assert.equal(r.run(['add']).status, 2);
    // an existing directory or branch is refused, not overwritten
    fs.mkdirSync(r.wt('W-5'));
    assert.equal(r.run(['add', 'W-5']).status, 1);
    assert.equal(r.run(['add', 'W-4', '--branch', r.g(r.repo, 'branch', '--list', 'w-3-*').replace(/^[* +]+/, '')]).status, 1, 'the branch name is taken');
  } finally { r.cleanup(); }
});

test('P5.41 a6: list shows clean/dirty and merged/unmerged per card and only the cards worktrees when an id is given', () => {
  const r = rig();
  try {
    assert.match(r.run(['list']).stdout, /no worktrees besides the main one/);
    assert.equal(r.run(['add', 'W-3']).status, 0);
    assert.equal(r.run(['add', 'W-4']).status, 0);
    let l = r.run(['list']).stdout.trim().split('\n');
    assert.equal(l.length, 2);
    for (const line of l) assert.match(line, /\| clean \| merged into main$/);
    fs.writeFileSync(path.join(r.wt('W-3'), 'new.txt'), 'x\n');
    r.g(r.wt('W-4'), 'commit', '-q', '--allow-empty', '-m', 'work');
    l = r.run(['list']).stdout.trim().split('\n');
    assert.ok(l.some((x) => x.startsWith('w-3-') && /\| dirty \| merged/.test(x)), l.join('\n'));
    assert.ok(l.some((x) => x.startsWith('w-4-') && /\| clean \| unmerged into main$/.test(x)), l.join('\n'));
    assert.equal(r.run(['list', 'W-3']).stdout.trim().split('\n').length, 1);
    assert.match(r.run(['list', 'W-9']).stdout, /W-9: no worktree/);
  } finally { r.cleanup(); }
});

test('P5.41 a6: prune removes the worktree and branch of a clean merged card; a dirty or unmerged one only with --force; other cards and the main work tree stay', () => {
  const r = rig();
  try {
    assert.equal(r.run(['add', 'W-3']).status, 0);
    assert.equal(r.run(['add', 'W-4']).status, 0);
    // clean and merged: removed, with the branch
    const p = r.run(['prune', 'W-3']);
    assert.equal(p.status, 0, p.stderr + p.stdout);
    assert.match(p.stdout, /W-3: removed .* and branch w-3-/);
    assert.equal(fs.existsSync(r.wt('W-3')), false);
    assert.equal(r.g(r.repo, 'branch', '--list', 'w-3-*'), '');
    assert.ok(fs.existsSync(r.wt('W-4')), 'the other card is untouched');
    assert.ok(fs.existsSync(path.join(r.repo, 'a.txt')), 'the main work tree is untouched');
    // dirty: refused, nothing removed
    fs.writeFileSync(path.join(r.wt('W-4'), 'wip.txt'), 'x\n');
    let d = r.run(['prune', 'W-4']);
    assert.equal(d.status, 1);
    assert.match(d.stdout, /refused: .*: uncommitted changes \(use --force/);
    assert.ok(fs.existsSync(r.wt('W-4')));
    // committed but not merged: refused too
    r.g(r.wt('W-4'), 'add', '-A');
    r.g(r.wt('W-4'), 'commit', '-q', '-m', 'work');
    d = r.run(['prune', 'W-4']);
    assert.equal(d.status, 1);
    assert.match(d.stdout, /refused: w-4-.*: not merged into main/);
    assert.ok(fs.existsSync(r.wt('W-4')));
    // merged into main: now it goes without --force
    r.g(r.repo, 'merge', '-q', '--no-edit', r.g(r.repo, 'branch', '--list', 'w-4-*').replace(/^[* +]+/, ''));
    assert.equal(r.run(['prune', 'W-4']).status, 0);
    assert.equal(fs.existsSync(r.wt('W-4')), false);
    // --force removes a dirty, unmerged one
    assert.equal(r.run(['add', 'W-5']).status, 0);
    fs.writeFileSync(path.join(r.wt('W-5'), 'w5.txt'), 'x\n');
    r.g(r.wt('W-5'), 'add', '-A');
    r.g(r.wt('W-5'), 'commit', '-q', '-m', 'unmerged');
    fs.writeFileSync(path.join(r.wt('W-5'), 'more.txt'), 'x\n');
    const f = r.run(['prune', 'W-5', '--force']);
    assert.equal(f.status, 0, f.stderr + f.stdout);
    assert.equal(fs.existsSync(r.wt('W-5')), false);
    assert.equal(r.g(r.repo, 'branch', '--list', 'w-5-*'), '');
    assert.match(r.run(['prune', 'W-5']).stdout, /no worktree; nothing to do/);
  } finally { r.cleanup(); }
});
