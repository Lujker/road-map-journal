import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../roadctl.mjs', import.meta.url));
const example = fileURLToPath(new URL('../../examples/board-example/board/', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-questions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const board = path.join(root, 'board');
  fs.cpSync(example, board, { recursive: true });
  const cfg = path.join(board, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), requires: '0.13.0' }));
  const card = path.join(board, 'cards', 'W-3-eksport-csv.md');
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), ROADCTL_NOW: '2026-11-20T10:00:00.000Z' };
  const run = (args, data, extra = {}) => spawnSync(process.execPath, [cli, ...args, '--board', board], { cwd: root, encoding: 'utf8', input: data === undefined ? undefined : JSON.stringify(data), env: { ...env, ...extra } });
  return { root, board, card, run, read: () => fs.readFileSync(card, 'utf8') };
}
const q = (id, reason = 'irreversible') => ({ question: { id, kind: 'confirm', prompt: 'Proceed?', reason, ...(reason === 'reversible' ? { recommended: true } : {}) }, undo_until: '2026-11-21T10:00:00.000Z' });

test('P5.24 a1/a4/a9: ask and answer persist a card question, log and owner audit; repeat is refused', (t) => {
  const f = fixture(t);
  let r = f.run(['ask', 'W-3', '--as', 'worker'], q('q1')); assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /status: blocked/);
  r = f.run(['answer', 'W-3', 'q1', '--by', 'Owner'], { answer: true }, { ROADCTL_UNATTENDED: '1' }); assert.equal(r.status, 1);
  assert.match(f.read(), /"state":"waiting"/);
  r = f.run(['answer', 'W-3', 'q1', '--by', 'Owner'], { answer: true }); assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /status: doing/); assert.match(f.read(), /ANSWER q1: true/);
  assert.equal(f.run(['answer', 'W-3', 'q1', '--by', 'Owner'], { answer: true }).status, 7);
  const audit = fs.readFileSync(path.join(f.root, 'state', 'road-map-journal', 'owner-commands.jsonl'), 'utf8');
  assert.match(audit, /"command":"answer".*"outcome":"ok"/);
  assert.match(audit, /"command":"answer".*"outcome":"refused"/);
});

test('P5.24 a5/a11: reversible decisions appear in inbox, undo is owner-only and rejects expiry', (t) => {
  const f = fixture(t);
  let r = f.run(['ask', 'W-3', '--as', 'worker'], q('q2', 'reversible')); assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /status: doing/);
  const inbox = JSON.parse(f.run(['inbox', '--json']).stdout);
  assert.equal(inbox.items.find((x) => x.target === 'W-3').type, 'decision');
  assert.equal(f.run(['undo', 'W-3', 'q2', '--by', 'Owner'], { comment: 'reconsider' }, { ROADCTL_UNATTENDED: '1' }).status, 1);
  assert.equal(f.run(['undo', 'W-3', 'q2', '--by', 'Owner'], { comment: 'late' }, { ROADCTL_NOW: '2026-11-21T10:00:00.000Z' }).status, 8);
  r = f.run(['undo', 'W-3', 'q2', '--by', 'Owner'], { comment: 'reconsider' }); assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /UNDO q2:.*reconsider/);
});
