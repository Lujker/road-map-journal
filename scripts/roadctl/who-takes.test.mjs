// P5.41 line A, compatibility tails (module who-takes.mjs and its fallback in roadctl.mjs). Run: node --test scripts/roadctl/who-takes.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, '..');
const EXAMPLE = path.join(SCRIPTS, '..', 'examples', 'board-example', 'board');
const ME = 'claude-code@home-wsl';

function rig(requires) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-who-'));
  const board = path.join(root, 'board');
  fs.cpSync(EXAMPLE, board, { recursive: true });
  const cfg = path.join(board, 'config.json');
  if (requires) fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), requires }));
  const run = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args, '--board', board], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root, ROADCTL_DATE: '2026-11-20', ROADCTL_REGISTRY: path.join(root, 'none.json'), ...env } });
  return { root, board, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('P5.41: a copy that lost roadctl/who-takes.mjs refuses a board that requires 0.14.0 (it would read a profile as a role); a board below 0.14.0 is read as before', () => {
  assert.equal(rc.boardRequires({ requires: '0.14.0' }), null, 'the whole install reads it');
  const r = rig('0.14.0');
  try {
    const copy = path.join(r.root, 'copy');
    fs.cpSync(SCRIPTS, copy, { recursive: true, filter: (src) => !src.endsWith('who-takes.mjs') && !src.endsWith('who-takes.test.mjs') });
    assert.equal(fs.existsSync(path.join(copy, 'roadctl', 'who-takes.mjs')), false);
    const t = r.run(path.join(copy, 'roadctl.mjs'), ['tick', '--as', ME, '--no-pull']);
    assert.match(t.stdout, /requires: .*board requires the module who-takes \(roadctl 0\.14\.0, scripts\/roadctl\/who-takes\.mjs\), which this copy does not have/);
    assert.doesNotMatch(t.stdout, /^(TAKE|RUN|START) /m);
    // below 0.14.0 the same partial copy still works as before (roles and agents by name)
    const old = rig('0.13.0');
    try {
      const d = old.run(path.join(copy, 'roadctl.mjs'), ['delegate', 'W-3', '--to', 'worker', '--by', ME]);
      assert.equal(d.status, 0, d.stderr + d.stdout);
      assert.match(old.run(path.join(copy, 'roadctl.mjs'), ['claim', 'W-3', '--as', ME]).stdout, /claimed/);
    } finally { old.cleanup(); }
  } finally { r.cleanup(); }
});

test('P5.41: report is not lost to a broken registry file: the name is taken as it is, like before 0.14.0', () => {
  const r = rig();
  try {
    const SELF = path.join(SCRIPTS, 'roadctl.mjs');
    const ok = (args) => { const x = r.run(SELF, args); assert.equal(x.status, 0, `${args.join(' ')}: ${x.stderr}${x.stdout}`); };
    ok(['delegate', 'W-3', '--to', 'worker', '--by', ME]);
    ok(['claim', 'W-3', '--as', 'worker-x@home-wsl']);
    const card = path.join(r.board, 'cards', 'W-3-eksport-csv.md');
    fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace('## Evidence', '## Evidence\n- a2: checked, tests pass'));
    const bad = path.join(r.root, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    const rep = r.run(SELF, ['report', 'W-3', '--as', 'worker-x@home-wsl', 'done'], { ROADCTL_REGISTRY: bad });
    assert.equal(rep.status, 0, rep.stderr + rep.stdout);
    assert.match(rep.stdout, /reported/);
    assert.match(fs.readFileSync(card, 'utf8'), /^delegate: .*state=reported/m);
  } finally { r.cleanup(); }
});
