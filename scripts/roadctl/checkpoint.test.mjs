import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../roadctl.mjs', import.meta.url));
const example = fileURLToPath(new URL('../../examples/board-example/board/', import.meta.url));
const handoff = { did: 'Synthetic fixture checked', next: 'Review the diff', in_flight: 'unknown: external action; reconcile before retry' };
test('checkpoint renders handoff fields as plain text without forged separators or links', (t) => {
  const f = fixture(t);
  const r = f.run(['W-3', '--board', f.board, '--as', 'fixture-agent'], JSON.stringify({ did: 'готово | next: ложь [ссылка](https://evil.test)', next: 'проверить', in_flight: 'нет' }));
  assert.equal(r.status, 0, r.stderr);
  const text = f.files()['W-3-eksport-csv.md'];
  assert.doesNotMatch(text, /готово \| next: ложь|\[ссылка\]\(https:\/\/evil\.test\)/);
  assert.match(text, /готово.*ложь.*ссылка.*проверить.*нет/);
});
test('checkpoint preserves underscore paths and worst-case bounded input', (t) => {
  const f = fixture(t);
  const value = 'x_'.repeat(175);
  const r = f.run(['W-3', '--board', f.board, '--as', 'fixture-agent'], JSON.stringify({ did: value, next: value, in_flight: value }));
  assert.equal(r.status, 0, r.stderr);
  const text = f.files()['W-3-eksport-csv.md'];
  assert.equal(text.split('x\\_').length - 1, 525);
  assert.match(text, /in-flight: x\\_/);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const board = path.join(root, 'board');
  fs.cpSync(example, board, { recursive: true });
  const files = () => Object.fromEntries(fs.readdirSync(path.join(board, 'cards')).map((f) => [f, fs.readFileSync(path.join(board, 'cards', f), 'utf8')]));
  const run = (args, input = JSON.stringify(handoff)) => spawnSync(process.execPath, [cli, 'checkpoint', ...args], {
    cwd: root, encoding: 'utf8', input, env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), ROADCTL_DATE: '2026-11-10' },
  });
  return { root, board, files, run };
}

test('P5.43 explicit checkpoint appends only to its card with several doing cards', (t) => {
  const f = fixture(t);
  const second = path.join(f.board, 'cards', 'W-5-filtr-sklad.md');
  fs.writeFileSync(second, fs.readFileSync(second, 'utf8').replace('status: ready', 'status: doing'));
  const before = f.files();
  const r = f.run(['W-3', '--board', f.board, '--as', 'fixture-agent']);
  assert.equal(r.status, 0, r.stderr);
  const after = f.files();
  for (const name of Object.keys(before)) {
    if (!name.startsWith('W-3-')) assert.equal(after[name], before[name]);
    else {
      assert.match(after[name], /\[fixture-agent\] checkpoint: did: Synthetic fixture checked \| next: Review the diff \| in-flight: unknown:/);
      assert.match(after[name], /status: doing/);
      assert.ok(after[name].includes(before[name].split('## Log')[0]));
    }
  }
  assert.match(r.stdout, /recorded.*W-3/i);
});

test('P5.43 invalid input and ambiguous or unavailable targets never write or echo payloads', (t) => {
  const f = fixture(t);
  const base = ['W-3', '--board', f.board, '--as', 'fixture-agent'];
  const before = f.files();
  const cases = [
    [base, ''], [base, '{RAW-SECRET'], [base, 'null'], [base, '[]'],
    [base, JSON.stringify({ ...handoff, did: ' ' })],
    [base, JSON.stringify({ ...handoff, next: 'x'.repeat(351) })],
    [base, JSON.stringify({ ...handoff, in_flight: 'line\nbreak' })],
    [base, JSON.stringify({ ...handoff, error: 'RAW-SECRET' })],
    [base, 'RAW-SECRET'.repeat(1000)],
    [['W-3', '--as', 'fixture-agent'], JSON.stringify(handoff)],
    [['W-3', '--board', f.board], JSON.stringify(handoff)],
    [['--board', f.board, '--as', 'fixture-agent'], JSON.stringify(handoff)],
    [['W-99', '--board', f.board, '--as', 'fixture-agent'], JSON.stringify(handoff)],
    [['../W-3', '--board', f.board, '--as', 'fixture-agent'], JSON.stringify(handoff)],
    [['W-2', '--board', f.board, '--as', 'fixture-agent'], JSON.stringify(handoff)],
    [['W-3', '--board', f.board, '--project', 'other', '--as', 'fixture-agent'], JSON.stringify(handoff)],
    [['W-3', '--board', path.join(f.root, 'absent'), '--as', 'fixture-agent'], JSON.stringify(handoff)],
  ];
  for (const [args, input] of cases) {
    const r = f.run(args, input);
    assert.equal(r.status, 2, `${args}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /RAW-SECRET/);
    assert.deepEqual(f.files(), before);
  }
  fs.copyFileSync(path.join(f.board, 'cards', 'W-3-eksport-csv.md'), path.join(f.board, 'cards', 'duplicate.md'));
  const duplicated = f.files();
  assert.equal(f.run(base).status, 2);
  assert.deepEqual(f.files(), duplicated);
});

test('P5.43 refuses non-doing states and malformed card headers', (t) => {
  const f = fixture(t);
  const file = path.join(f.board, 'cards', 'W-3-eksport-csv.md');
  const original = fs.readFileSync(file, 'utf8');
  const variants = ['idea', 'ready', 'review', 'blocked', 'done', 'parked', 'dropped', 'nonsense'].map((s) => original.replace('status: doing', `status: ${s}`));
  variants.push(original.replace('status: doing', 'status: doing\nstatus: doing'));
  for (const variant of variants) {
    fs.writeFileSync(file, variant);
    const before = f.files();
    const r = f.run(['W-3', '--board', f.board, '--as', 'fixture-agent']);
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(f.files(), before);
  }
});

test('P5.43 preserves CRLF and bounded handoff text without truncating it', (t) => {
  const f = fixture(t);
  const file = path.join(f.board, 'cards', 'W-3-eksport-csv.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  const value = 'я'.repeat(350);
  const r = f.run(['W-3', '--board', f.board, '--as', 'fixture-agent'], JSON.stringify({ did: value, next: value, in_flight: value }));
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(`in-flight: ${value}`));
  assert.ok(!/[^\r]\n/.test(text));
});

test('P5.43 write errors fail rather than claim a saved checkpoint', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const f = fixture(t);
  const file = path.join(f.board, 'cards', 'W-3-eksport-csv.md');
  fs.chmodSync(file, 0o444);
  t.after(() => { if (fs.existsSync(file)) fs.chmodSync(file, 0o644); });
  const before = f.files();
  const r = f.run(['W-3', '--board', f.board, '--as', 'fixture-agent']);
  assert.equal(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stdout, /recorded/);
  assert.deepEqual(f.files(), before);
});

test('P5.43 obeys mapped doing and refuses unsupported or damaged boards without exposing data', (t) => {
  const f = fixture(t);
  const file = path.join(f.board, 'cards', 'W-3-eksport-csv.md');
  const config = path.join(f.board, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: doing', 'status: active'));
  fs.writeFileSync(config, JSON.stringify({ ...cfg, status_map: { active: 'doing' } }));
  const args = ['W-3', '--board', f.board, '--as', 'fixture-agent'];
  assert.equal(f.run(args).status, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /status: active/);
  const before = f.files();
  for (const content of [JSON.stringify({ ...cfg, status_map: { active: 'doing' }, requires: '999.0.0' }), '{RAW-SECRET']) {
    fs.writeFileSync(config, content);
    const r = f.run(args);
    assert.equal(r.status, 2, r.stderr);
    assert.doesNotMatch(r.stderr, /RAW-SECRET/);
    assert.deepEqual(f.files(), before);
  }
});
