// P5.41 a5: roadctl handoff ID --to WHO --role worker|reviewer|fixer (module handoff.mjs). Run: node --test scripts/roadctl/handoff.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ECONOMY, REVIEW_RULE, ROLES } from './handoff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const EXAMPLE = path.join(here, '..', '..', 'examples', 'board-example', 'board');

const CARD = `---
id: H-1
title: Export the report to CSV
status: ready
depends_on:
as_of: 2026-11-20
---

## Goal

Export the weekly report to CSV for spreadsheets.

Second paragraph with more detail.

## Delegation
- Allowed changes: src/export/ and its tests
- Checks: node --test src/export
- Stop conditions: stop when the report format has to change
- Budget: (time or token limit, if any)
- Report format: (what the report must contain)

## Acceptance
- [ ] a1: the file is UTF-8 with BOM
- [x] a2: the separator is a semicolon
- [ ] a3: an empty report gives a header only

## Log
`;

function rig({ registry = true, reg: regObject = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-handoff-'));
  const board = path.join(root, 'board');
  fs.cpSync(EXAMPLE, board, { recursive: true });
  fs.writeFileSync(path.join(board, 'cards', 'H-1-export.md'), CARD);
  const reg = path.join(root, 'registry.json');
  if (registry) fs.writeFileSync(reg, JSON.stringify(regObject ?? { version: 1, roles: { worker: {}, reviewer: {} }, agents: { 'known-agent': { host: 'x', roles: ['worker', 'reviewer'], model: 'big-model' } } }));
  const run = (args) => spawnSync(process.execPath, [SELF, 'handoff', ...args, '--board', board], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root, ROADCTL_REGISTRY: registry ? reg : path.join(root, 'none.json'), ROADCTL_DATE: '2026-11-20' } });
  const snapshot = () => fs.readdirSync(board, { recursive: true }).sort().map((f) => { const p = path.join(board, String(f)); return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p, 'utf8').length}` : String(f); }).join('\n');
  return { root, board, run, snapshot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('P5.41 a5: a worker assignment has the goal, the open criteria, branch and worktree, the test command under the lock, the prohibitions, the report and the savings', () => {
  const r = rig();
  try {
    const before = r.snapshot();
    const h = r.run(['H-1', '--to', 'pi-developer']);
    assert.equal(h.status, 0, h.stderr);
    const t = h.stdout;
    assert.match(t, /^Assignment H-1: Export the report to CSV\nFor: pi-developer \| role: worker$/m);
    assert.match(t, /Goal:\n {2}Export the weekly report to CSV for spreadsheets\.\n {2}Second paragraph/);
    assert.match(t, /- a1: the file is UTF-8 with BOM/);
    assert.match(t, /- a3: an empty report gives a header only/);
    assert.doesNotMatch(t, /a2:/, 'a criterion that is done is not asked again');
    assert.match(t, /`roadctl worktree add H-1` makes \S+-h-1 on branch h-1-export-the-report from main/);
    assert.match(t, /`roadctl lock -- node --test src\/export`/, 'the test command comes from Checks, under the lock');
    assert.match(t, /merge into main, push, tag or publish/);
    assert.match(t, /run approve or done/);
    assert.match(t, /worktree of another card or the installed roadctl/);
    assert.match(t, /change anything outside: src\/export\/ and its tests/);
    assert.match(t, /Stop and report instead of going on: stop when the report format has to change/);
    assert.match(t, /ROADCTL_AS=pi-developer/);
    assert.match(t, /`roadctl claim H-1 --as pi-developer --workdir \S+-h-1`/, 'the claim names the worktree: the limit checkpoint binds by it');
    assert.match(t, /Without the claim and its workdir the limit checkpoint \(P5\.43\) cannot find your card/);
    assert.match(t, /roadctl report H-1 --as pi-developer "<commits \(SHA\), the test result, what is not done>"/);
    for (const l of ECONOMY) assert.ok(t.includes(l), l);
    assert.match(t, /caveman/);
    assert.match(t, /codegraph explore/);
    assert.match(t, /`rtk`/);
    assert.doesNotMatch(t, /Review rule/, 'a worker is not given the review rule');
    assert.doesNotMatch(t, /\(time or token limit/, 'template lines of the card are not copied');
    assert.equal(r.snapshot(), before, 'nothing was written');
    assert.equal(r.run(['H-1', '--to', 'pi-developer']).stdout, t, 'the same data give the same text');
  } finally { r.cleanup(); }
});

test('P5.41 a5: a reviewer gets the review rule and is read-only; a fixer gets the findings and the fix-only rule', () => {
  const r = rig();
  try {
    const rv = r.run(['H-1', '--to', 'reviewer-agent', '--role', 'reviewer']).stdout;
    for (const l of REVIEW_RULE) assert.ok(rv.includes(l), l);
    assert.match(rv, /Return the work only for: \(1\) a violated criterion of the card, \(2\) a failing test or an incompatibility, \(3\) a defect you can reproduce with a concrete scenario/);
    assert.match(rv, /At most two review rounds per card/);
    assert.match(rv, /First line of the verdict: accept \/ accept with follow-ups \/ return\./);
    assert.match(rv, /Read-only: look at branch h-1-export-the-report/);
    assert.match(rv, /Criteria to check/);
    assert.match(rv, /- a2: the separator is a semicolon/, 'a reviewer also checks completed criteria');
    assert.doesNotMatch(rv, /roadctl worktree add|roadctl claim/, 'a reviewer creates and claims nothing');
    assert.match(rv, /You do not run approve, done or accept/);
    const fx = r.run(['H-1', '--to', 'dev', '--role', 'fixer', '--note', 'a3: an empty report crashes (input: empty file -> exception)']).stdout;
    assert.match(fx, /Fix only what the review returned/);
    assert.match(fx, /Findings: a3: an empty report crashes/);
    assert.match(fx, /roadctl worktree add H-1/);
    assert.match(fx, /ROADCTL_AS=dev/);
    assert.match(fx, /roadctl claim H-1 --as dev --workdir /);
    assert.doesNotMatch(rv, /ROADCTL_AS|--workdir/, 'a reviewer claims nothing');
    assert.doesNotMatch(fx, /Review rule/);
    assert.match(r.run(['H-1', '--to', 'dev', '--role', 'fixer']).stdout, /Findings: \(not given: ask the coordinator for the review text\)/);
    assert.deepEqual(ROLES, ['worker', 'reviewer', 'fixer']);
  } finally { r.cleanup(); }
});

test('P5.41 a5: --tests beats Checks, a card without a test command says so, the registry adds the roles of a known name, --base and --json', () => {
  const r = rig();
  try {
    assert.match(r.run(['H-1', '--to', 'dev', '--tests', 'npm run check']).stdout, /`roadctl lock -- npm run check`/);
    // a card whose Checks is still the template
    fs.writeFileSync(path.join(r.board, 'cards', 'H-1-export.md'), CARD.replace('- Checks: node --test src/export', '- Checks: (commands to run and what they must show)'));
    const t = r.run(['H-1', '--to', 'dev']).stdout;
    assert.match(t, /`roadctl lock -- <test command of the project>`/);
    assert.match(t, /The card names no test command \(Checks\)/);
    assert.match(r.run(['H-1', '--to', 'known-agent']).stdout, /For: known-agent \| role: worker \| registry: roles worker, reviewer, model big-model/);
    assert.doesNotMatch(r.run(['H-1', '--to', 'stranger']).stdout, /registry:/);
    assert.match(r.run(['H-1', '--to', 'dev', '--base', 'develop']).stdout, /from develop/);
    const j = JSON.parse(r.run(['H-1', '--to', 'dev', '--role', 'reviewer', '--json']).stdout);
    assert.deepEqual([j.card, j.to, j.role], ['H-1', 'dev', 'reviewer']);
    assert.match(j.text, /^Assignment H-1/);
  } finally { r.cleanup(); }
});

test('P5.41 a5: the text names no product and no harness; usage errors and unknown cards exit 2', () => {
  const r = rig({ registry: false });
  try {
    for (const role of ROLES) assert.doesNotMatch(r.run(['H-1', '--to', 'x', '--role', role]).stdout, /openbot|hermes|mausebot|claude|codex|kimi/i, role);
    assert.equal(r.run(['H-1']).status, 2, 'no --to');
    assert.equal(r.run(['H-1', '--to', 'x', '--role', 'boss']).status, 2);
    assert.equal(r.run(['H-1', '--to', 'bad name!']).status, 2);
    assert.equal(r.run(['--to', 'x']).status, 2, 'no card');
    const u = r.run(['NOPE-1', '--to', 'x']);
    assert.equal(u.status, 2);
    assert.match(u.stderr, /no card NOPE-1/);
    assert.match(r.run(['H-1']).stderr, /usage: roadctl handoff ID --to WHO/);
  } finally { r.cleanup(); }
});

test('P5.46 a5: handoff --to a profile shows that profile\'s registry row (its executor and roles), and the executor\'s own name keeps its row', () => {
  const r = rig({ reg: { version: 1, roles: { worker: {}, reviewer: {} }, agents: { 'pi-worker@home-wsl': { host: 'pi', roles: ['worker', 'reviewer'], model: 'flash' } }, agent_profiles: { 'pi-developer': { executor: 'pi-worker@home-wsl', openbot: { name: 'pi-developer-full' } } } } });
  try {
    const h = r.run(['H-1', '--to', 'pi-developer']);
    assert.equal(h.status, 0, h.stderr);
    assert.match(h.stdout, /^For: pi-developer \| role: worker \| registry: profile pi-developer -> pi-worker@home-wsl; roles worker, reviewer, model flash, openbot pi-developer-full$/m);
    // the pair form names the same profile row
    const p = r.run(['H-1', '--to', 'openbot@home-wsl/pi-developer']);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /^For: openbot@home-wsl\/pi-developer \| role: worker \| registry: profile pi-developer -> pi-worker@home-wsl; roles worker, reviewer, model flash/m);
    // the executor by its own name: its own row, and no profile line
    const e = r.run(['H-1', '--to', 'pi-worker@home-wsl']);
    assert.equal(e.status, 0, e.stderr);
    assert.match(e.stdout, /^For: pi-worker@home-wsl \| role: worker \| registry: roles worker, reviewer, model flash$/m);
    assert.doesNotMatch(e.stdout, /registry: profile/, 'the executor row is not a profile line');
    // an unknown name in the pair form: no registry line rather than a wrong one
    const x = r.run(['H-1', '--to', 'nonsense']);
    assert.equal(x.status, 0, x.stderr);
    assert.match(x.stdout, /^For: nonsense \| role: worker$/m);
  } finally { r.cleanup(); }
});
