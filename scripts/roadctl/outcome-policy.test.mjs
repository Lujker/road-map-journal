// P5.4: the hold reason comes from the module outcome-policy (hook routine-reasons); a copy without the modules folder refuses a board that requires 0.12.0.
// Run: node --test scripts/roadctl/outcome-policy.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { FAKES_SKIP } from '../testkit/fakes.mjs';
import outcome, { OUTCOME_MODULE_REQUIRES } from './outcome-policy.mjs';
import { MODULES } from './index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const EXAMPLE = path.join(here, '..', '..', 'examples', 'board-example', 'board');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const ME = 'claude-code@home-wsl';

test('P5.4: the module answers only for a held routine, with the reason, lint level and immediate mark', () => {
  assert.equal(outcome.name, 'outcome-policy');
  assert.ok(MODULES.includes(outcome));
  assert.equal(OUTCOME_MODULE_REQUIRES, rc.OUTCOME_REQUIRES);
  const hook = outcome.hooks['routine-reasons'];
  assert.deepEqual(hook({ routine: { header: { id: 'a' } } }), {});
  assert.deepEqual(hook({ routine: { header: { id: 'a', hold: '  ' } } }), {});
  assert.deepEqual(hook({ routine: { header: { id: 'a', hold: 'aborted' } } }), { reasons: ['held: aborted (roadctl routine resume a)'], lint: 'warning', immediate: true });
});

test('P5.4: a copy of roadctl.mjs without its modules folder refuses a board that requires 0.12.0 (the hold would otherwise be ignored)', FAKES_SKIP, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-outcome-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE, board, { recursive: true });
  const cfg = path.join(board, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), requires: '0.12.0' }));
  const lone = path.join(dir, 'lone', 'roadctl.mjs');
  fs.mkdirSync(path.dirname(lone));
  fs.copyFileSync(SELF, lone); // no roadctl/ folder: no modules
  const env = { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_DATE: '2026-11-10' };
  const run = (bin, args) => spawnSync(process.execPath, [bin, ...args, '--board', board], { cwd: ws, encoding: 'utf8', env });
  assert.match(run(lone, ['tick', '--as', ME, '--no-pull']).stdout, /requires: my-app: board requires the module \w[\w-]* \(roadctl 0\.\d+\.0, scripts\/roadctl\/\), which this copy does not have/);
  assert.match(fs.readFileSync(SELF, 'utf8'), /\['0\.12\.0', 'outcome-policy'\]/, 'the list of modules that a board of 0.12.0 needs names this one (the first missing module is the one reported)');
  assert.equal(rc.boardRequires({ requires: '0.12.0' }), null, 'with the modules loaded the board is fine');
  assert.doesNotMatch(run(SELF, ['tick', '--as', ME, '--no-pull']).stdout, /requires: my-app/, 'the whole install reads the board');
});
