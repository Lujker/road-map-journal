// "help = docs" (P5.10 a3): every command and every flag that `roadctl help` knows is described in docs/roadctl.md.
// It extends the module test "help and docs" of registry.test.mjs (module commands only) to all commands and to flags, and proves that it can fail.
// Run: node --test scripts/roadctl/helpdocs.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { helpDocsProblems } from '../testkit/helpdocs.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = fs.readFileSync(path.join(scripts, '..', 'docs', 'roadctl.md'), 'utf8');
const help = spawnSync(process.execPath, [path.join(scripts, 'roadctl.mjs'), 'help'], { encoding: 'utf8', env: { ...process.env, ROADCTL_DATE: '2026-11-10' } });
const overview = help.stdout;

const spec = (extra = {}) => ({ group: 'Look', effect: 'read', summary: 's', purpose: 'p', usage: ['roadctl x'], flags: [], examples: ['roadctl x'], changes: 'Nothing.', exits: '0', run: () => 0, ...extra });

test('help and docs agree: every visible command is in the overview and in docs/roadctl.md, every flag of every command is in docs/roadctl.md', () => {
  assert.equal(help.status, 0, help.stderr);
  assert.ok(Object.keys(rc.ALL_COMMANDS).length > 30, 'the whole command table is checked');
  assert.deepEqual(helpDocsProblems(rc.ALL_COMMANDS, { overview, docs }), []);
});

test('help and docs: a command added without a description fails the check (in-memory table, nothing registered)', () => {
  const table = { ...rc.ALL_COMMANDS, 'new-cmd': spec({ summary: 'a new command', usage: ['roadctl new-cmd'], examples: ['roadctl new-cmd'] }) };
  const problems = helpDocsProblems(table, { overview, docs });
  assert.deepEqual(problems, ['new-cmd: not in the overview (roadctl help)', 'new-cmd: not described in docs/roadctl.md (no "roadctl new-cmd")']);
  // described in both places: the same table passes
  const described = helpDocsProblems(table, { overview: `${overview}\n  new-cmd  [read]  a new command`, docs: `${docs}\nroadctl new-cmd   does a thing\n` });
  assert.deepEqual(described, []);
  // hidden commands are exempt from the overview and the docs
  assert.deepEqual(helpDocsProblems({ ...rc.ALL_COMMANDS, 'internal-cmd': spec({ hidden: true }) }, { overview, docs }), []);
});

test('help and docs: a flag that docs/roadctl.md does not mention, and an empty help field, fail the check', () => {
  const flag = '--zz-not-documented';
  const table = { ...rc.ALL_COMMANDS, status: { ...rc.ALL_COMMANDS.status, flags: [...rc.ALL_COMMANDS.status.flags, [`${flag} N`, 'a flag nobody described']] } };
  assert.deepEqual(helpDocsProblems(table, { overview, docs }), [`status: flag ${flag} is not in docs/roadctl.md`]);
  assert.deepEqual(helpDocsProblems({ ...rc.ALL_COMMANDS, tick: { ...rc.ALL_COMMANDS.tick, purpose: ' ', examples: [] } }, { overview, docs }), ['tick: help field purpose is empty', 'tick: help field examples is empty']);
  // a command that disappears from the overview text (the table and the help disagree)
  assert.match(helpDocsProblems(rc.ALL_COMMANDS, { overview: overview.replace(/^ {2}tick .*$/m, ''), docs }).join('\n'), /tick: not in the overview/);
});
