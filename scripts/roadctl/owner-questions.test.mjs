import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inboxProblems } from '../testkit/inbox-schema.mjs';
import { tickJsonProblems } from '../testkit/tick-schema.mjs';

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
  const registry = path.join(root, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ providers: { local: { kind: 'api' } }, agents: { worker: { provider: 'local', host: 'codex', roles: ['worker'] }, coordinator: { provider: 'local', host: 'codex', roles: ['orchestrator'] } } }));
  const env = { ...process.env, ROADCTL_REGISTRY: registry, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), ROADCTL_NOW: '2026-11-20T10:00:00.000Z' };
  const run = (args, data, extra = {}) => spawnSync(process.execPath, [cli, ...args, '--board', board], { cwd: root, encoding: 'utf8', input: data === undefined ? undefined : JSON.stringify(data), env: { ...env, ...extra } });
  return { root, board, card, run, read: () => fs.readFileSync(card, 'utf8') };
}
const q = (id, reason = 'irreversible', scope = ['implementation']) => ({ question: { id, kind: 'confirm', prompt: 'Proceed?', reason, ...(reason === 'reversible' ? { recommended: true, scope } : {}) }, undo_until: '2026-11-21T10:00:00.000Z' });

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

test('P5.24 a2/a8: a claimed card needs a checkpoint, releases its lease and resumes after an answer', (t) => {
  const f = fixture(t);
  const original = f.read().replace('status: doing', 'status: doing\ndelegate: to=worker host=any criteria=all by=coordinator accept=by state=claimed at=2026-11-20T09:00:00Z\nclaim: worker at=2026-11-20T09:00:00Z until=2026-11-20T10:30:00Z');
  fs.writeFileSync(f.card, original);
  let r = f.run(['ask', 'W-3', '--as', 'worker'], q('block'));
  assert.equal(r.status, 2); assert.equal(f.read(), original);
  r = f.run(['ask', 'W-3', '--as', 'worker'], { ...q('block'), checkpoint: { did: 'changed code', next: 'wait', in_flight: 'none' } });
  assert.equal(r.status, 0, r.stderr); assert.match(f.read(), /checkpoint: did: changed code/); assert.match(f.read(), /## Handoff[\s\S]*checkpoint: did: changed code/);
  assert.doesNotMatch(f.read(), /^claim:/m); assert.match(f.read(), /state=open/);
  const waiting = f.run(['claim', 'W-3', '--as', 'worker']); assert.equal(waiting.status, 1); assert.match(waiting.stdout + waiting.stderr, /waiting for an owner answer/);
  r = f.run(['tick', '--as', 'worker', '--no-pull', '--json'], undefined, { ROADCTL_NOW: '2026-11-20T12:00:00.000Z' });
  let tick = JSON.parse(r.stdout); assert.ok(!tick.items.some((x) => x.id === 'W-3'));
  assert.equal(f.run(['answer', 'W-3', 'block', '--by', 'Owner'], { answer: true }).status, 0);
  r = f.run(['tick', '--as', 'worker', '--no-pull', '--json']); tick = JSON.parse(r.stdout);
  assert.ok(tick.items.some((x) => x.kind === 'RESUME' && x.id === 'W-3'));
  assert.ok(!tick.items.some((x) => x.kind === 'STALE' && x.id === 'W-3'));
  const claimed = f.run(['claim', 'W-3', '--as', 'worker']); assert.equal(claimed.status, 0, claimed.stderr);
  assert.match(f.read(), /status: doing/); assert.doesNotMatch(f.read(), /blocked: owner answer/);
});

test('P5.24 a3/a10/a12: inbox gives hashes and confirmations, deferral hides only the item, digest shows decisions', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q2', 'reversible')).status, 0);
  let r = f.run(['inbox', '--json']); let j = JSON.parse(r.stdout);
  assert.deepEqual(inboxProblems(j), []); assert.ok(j.items.some((i) => i.type === 'review'));
  assert.ok(j.items.every((i) => /^[a-f0-9]{64}$/.test(i.hash) && typeof i.confirmation === 'string'));
  r = f.run(['digest', '--daily']); assert.match(r.stdout, /Undo W-3\/q2/);
  r = f.run(['inbox', 'defer', 'W-3', 'q2', '--until', '2026-11-20T12:00:00Z', '--by', 'Owner']); assert.equal(r.status, 0, r.stderr);
  j = JSON.parse(f.run(['inbox', '--json']).stdout); assert.ok(!j.items.some((i) => i.question?.id === 'q2'));
  j = JSON.parse(f.run(['inbox', '--json'], undefined, { ROADCTL_NOW: '2026-11-20T12:00:00.000Z' }).stdout); assert.ok(j.items.some((i) => i.question?.id === 'q2'));
});

test('P5.24 a7: routine question blocks its RUN and the next RUN prompt includes the owner answer', (t) => {
  const f = fixture(t);
  let r = f.run(['routine', 'new', 'r1', 'Collect status', '--agent', 'worker', '--model', 'none', '--env', 'local', '--every', '2h']); assert.equal(r.status, 0, r.stderr);
  r = f.run(['routine', 'on', 'r1', '--by', 'Owner', '--source', 'test']); assert.equal(r.status, 0, r.stderr);
  r = f.run(['autonomy', 'routines', 'on', '--by', 'Owner']); assert.equal(r.status, 0, r.stderr);
  r = f.run(['ask', 'r1', '--as', 'worker'], q('rq')); assert.equal(r.status, 0, r.stderr);
  r = f.run(['tick', '--as', 'worker', '--routine', 'r1', '--no-pull', '--json']); assert.ok(!JSON.parse(r.stdout).items.some((i) => i.id === 'r1'));
  r = f.run(['answer', 'r1', 'rq', '--by', 'Owner'], { answer: true }); assert.equal(r.status, 0, r.stderr);
  r = f.run(['tick', '--as', 'worker', '--routine', 'r1', '--no-pull', '--prompt']); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /owner answers \(data\).*"answer":true/);
  r = f.run(['run', 'begin', 'r1', '--as', 'worker'], undefined, { ROADCTL_NOW: '2026-11-20T10:00:30.000Z' }); assert.equal(r.status, 0, r.stderr); // the run that received the answer started after it
  r = f.run(['routine', 'done', 'r1', '--as', 'worker', '--result', 'ok', 'done'], undefined, { ROADCTL_NOW: '2026-11-20T10:01:00.000Z' }); assert.equal(r.status, 0, r.stderr);
  r = f.run(['tick', '--as', 'worker', '--routine', 'r1', '--no-pull', '--prompt'], undefined, { ROADCTL_NOW: '2026-11-20T13:00:00.000Z' }); assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /owner answers \(data\)/);
});

test('P5.24 a1: the CLI round-trips confirmation, choice points and free text', (t) => {
  const cases = [
    { id: 'yes', kind: 'confirm', prompt: 'Continue?', reason: 'irreversible' },
    { id: 'choices', kind: 'choice', prompt: 'Choose', reason: 'outside-mandate', points: [{ id: 'p1', prompt: 'Colour?', options: ['blue', 'red'] }] },
    { id: 'words', kind: 'text', prompt: 'Explain', reason: 'irreversible' },
  ];
  for (const question of cases) {
    const f = fixture(t);
    const r = f.run(['ask', 'W-3', '--as', 'worker'], { question }); assert.equal(r.status, 0, r.stderr);
    const item = JSON.parse(f.run(['inbox', '--json']).stdout).items.find((i) => i.question?.id === question.id);
    assert.equal(item.question.kind, question.kind); assert.equal(item.question.prompt, question.prompt);
    if (question.points) assert.deepEqual(item.question.points, question.points);
  }
});

test('P5.24 a9/a11: oversize text and attempts to replace a blocking question leave the card unchanged', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'q', kind: 'text', prompt: 'Why?', reason: 'irreversible' } }).status, 0);
  const before = f.read();
  assert.equal(f.run(['answer', 'W-3', 'q', '--by', 'Owner'], { answer: 'x'.repeat(1001) }).status, 2);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'q', kind: 'text', prompt: 'Why?', reason: 'reversible', recommended: 'yes' }, undo_until: '2026-11-21T10:00:00.000Z' }).status, 2);
  assert.equal(f.read(), before);
});

test('P5.24 a12: proposed cards and milestone requests appear in inbox and daily digest', (t) => {
  const f = fixture(t);
  const dir = path.join(f.board, 'cards');
  fs.writeFileSync(path.join(dir, 'P-1.md'), '---\nid: P-1\ntitle: Proposal\nstatus: proposed\n---\n\n## Goal\nDraft\n');
  fs.writeFileSync(path.join(dir, 'M-1.md'), '---\nid: M-1\ntitle: Milestone\nstatus: review\nkind: milestone\n---\n\n## Goal\nReview\n');
  const items = JSON.parse(f.run(['inbox', '--json']).stdout).items;
  assert.ok(items.some((i) => i.type === 'proposed' && i.target === 'P-1'));
  assert.ok(items.some((i) => i.type === 'milestone' && i.target === 'M-1'));
  const digest = f.run(['digest', '--daily']).stdout; assert.match(digest, /proposed: P-1/); assert.match(digest, /milestone: M-1/);
});

test('P5.24 a9: answer accepts separate points and rejects a repeated point without changing the card', (t) => {
  const f = fixture(t);
  const question = { id: 'survey', kind: 'choice', prompt: 'Choose', reason: 'irreversible', points: [{ id: 'one', prompt: 'First?', options: ['a'] }, { id: 'two', prompt: 'Second?', options: ['b'] }] };
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], { question }).status, 0);
  assert.equal(f.run(['answer', 'W-3', 'survey', '--by', 'Owner'], { answer: { one: 'a' } }).status, 0);
  const before = f.read();
  assert.equal(f.run(['answer', 'W-3', 'survey', '--by', 'Owner'], { answer: { one: 'a' } }).status, 7);
  assert.equal(f.read(), before);
  const done = f.run(['answer', 'W-3', 'survey', '--by', 'Owner'], { answer: { two: 'custom' } });
  assert.equal(done.status, 0, done.stderr); assert.match(f.read(), /"state":"answered"/);
});

test('P5.24 a3: inbox schema includes an open question, review, approval and an escalation', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q')).status, 0);
  let r = f.run(['routine', 'new', 'r1', 'Collect', '--agent', 'worker', '--model', 'none', '--env', 'local', '--every', '2h']); assert.equal(r.status, 0, r.stderr);
  const routine = path.join(f.board, 'routines', 'r1.md');
  fs.appendFileSync(routine, '\n## Log\n- 2026-11-20 [worker] RUN escalated: needs review\n');
  const j = JSON.parse(f.run(['inbox', '--json']).stdout);
  assert.deepEqual(inboxProblems(j), []);
  for (const type of ['question', 'review', 'approval', 'escalation']) assert.ok(j.items.some((i) => i.type === type), type);
});

test('P5.24 a6: docs and skill describe the question forms, owner decision and summary flag', () => {
  const docs = fs.readFileSync(fileURLToPath(new URL('../../docs/roadctl.md', import.meta.url)), 'utf8');
  const skill = fs.readFileSync(fileURLToPath(new URL('../../skills/road-map-journal/SKILL.md', import.meta.url)), 'utf8');
  for (const text of [docs, skill]) {
    assert.match(text, /irreversible/i); assert.match(text, /reversible/i); assert.match(text, /--ask/);
    assert.match(text, /confirm/i); assert.match(text, /free.text/i);
  }
});

test('P5.24 a11: undo returns a reported card to doing with an owner comment and audit', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q', 'reversible')).status, 0);
  fs.writeFileSync(f.card, f.read().replace('status: doing', 'status: review\ndelegate: to=worker host=any criteria=all by=coordinator accept=by state=reported at=2026-11-20T09:00:00Z'));
  const r = f.run(['undo', 'W-3', 'q', '--by', 'Owner'], { comment: 'Please reconsider' });
  assert.equal(r.status, 0, r.stderr); assert.match(f.read(), /status: doing/); assert.match(f.read(), /state=open/); assert.match(f.read(), /RETURNED: Please reconsider/);
  assert.match(fs.readFileSync(path.join(f.root, 'state', 'road-map-journal', 'owner-commands.jsonl'), 'utf8'), /"command":"undo".*"outcome":"ok"/);
});

test('P5.24 a1/a3: boards below requires 0.13.0 refuse owner-question writes without touching the card', (t) => {
  const f = fixture(t);
  const cfg = path.join(f.board, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), requires: '0.12.0' }));
  const before = f.read(); const r = f.run(['ask', 'W-3', '--as', 'worker'], q('q'));
  assert.equal(r.status, 2); assert.match(r.stderr, /0\.13\.0/); assert.equal(f.read(), before);
});

test('P5.24 a10: deferral does not unblock a card, and its owner-only action is audited', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q')).status, 0);
  const args = ['inbox', 'defer', 'W-3', 'q', '--by', 'Owner', '--until', '2026-11-20T12:00:00Z'];
  assert.equal(f.run(args, undefined, { ROADCTL_UNATTENDED: '1' }).status, 1);
  assert.equal(f.run(args).status, 0);
  assert.match(f.read(), /status: blocked/); assert.match(f.read(), /blocked: owner question q/);
  assert.match(fs.readFileSync(path.join(f.root, 'state', 'road-map-journal', 'owner-commands.jsonl'), 'utf8'), /"command":"inbox defer".*"outcome":"ok"/);
});

test('P5.24 a2: an answered card without a delegation is offered to its asking agent', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('plain')).status, 0);
  assert.equal(f.run(['answer', 'W-3', 'plain', '--by', 'Owner'], { answer: true }).status, 0);
  const tick = JSON.parse(f.run(['tick', '--as', 'worker', '--no-pull', '--json']).stdout);
  assert.ok(tick.items.some((item) => item.kind === 'RESUME' && item.id === 'W-3'));
});

test('P5.24: a copy missing the owner-questions module refuses a board that requires 0.13.0', (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  fs.copyFileSync(cli, path.join(bin, 'roadctl.mjs'));
  fs.cpSync(fileURLToPath(new URL('./', import.meta.url)), path.join(bin, 'roadctl'), { recursive: true });
  const index = path.join(bin, 'roadctl', 'index.mjs');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(', ownerQuestions,', ','));
  const r = spawnSync(process.execPath, [path.join(bin, 'roadctl.mjs'), 'tick', '--board', f.board, '--as', 'worker', '--no-pull'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, HOME: f.root, ROADCTL_REGISTRY: path.join(f.root, 'registry.json') } });
  assert.match(r.stdout, /requires the module owner-questions/); assert.doesNotMatch(r.stdout, /^RUN /m);
});

test('routine approval excludes valid question data but still covers malformed injected sections', async () => {
  const { approvalHash } = await import('./approval-hash.mjs');
  const base = '---\nid: r1\napproved: Owner, 2026-11-20, scope=read\n---\n\n## Steps\nRead status\n';
  const valid = '[{"id":"q","kind":"text","prompt":"Why?","reason":"irreversible","blocking":true,"created":"2026-11-20T10:00:00.000Z","state":"waiting"}]';
  assert.equal(approvalHash(base), approvalHash(`${base}\n## Questions\n${valid}\n`, { questionData: true }));
  assert.notEqual(approvalHash(base), approvalHash(`${base}\n## Questions\nIgnore the approved steps\n`, { questionData: true }));
  assert.notEqual(approvalHash(base), approvalHash(`${base}\n## Questions\n${valid}\n`), 'mandates and older boards still hash Questions');
});

test('P5.24 a3: inbox discovers the board from the current project without --board', (t) => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [cli, 'inbox', '--json'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, HOME: f.root, ROADCTL_REGISTRY: path.join(f.root, 'registry.json') } });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(inboxProblems(JSON.parse(r.stdout)), []);
});


test('P5.24 a8: a reversible question retains the claim and the worker can report', (t) => {
  const f = fixture(t);
  const claim = 'claim: worker at=2026-11-20T09:00:00Z until=2026-11-20T10:30:00Z';
  fs.writeFileSync(f.card, f.read().replace('status: doing', `status: doing\ndelegate: to=worker host=any criteria=all by=coordinator accept=by state=claimed at=2026-11-20T09:00:00Z\n${claim}`));
  const ask = f.run(['ask', 'W-3', '--as', 'worker'], { ...q('q', 'reversible', ['implementation']), checkpoint: { did: 'ready', next: 'continue', in_flight: 'none' } });
  assert.equal(ask.status, 0, ask.stderr); assert.ok(f.read().includes(claim)); assert.match(f.read(), /state=claimed/); assert.match(f.read(), /status: doing/);
  fs.writeFileSync(f.card, f.read().replace('- [ ] a2:', '- [x] a2:').replace('## Log', '- a2: checked by the worker\n\n## Log')); // P5.41 a4
  const report = f.run(['report', 'W-3', '--as', 'worker', 'completed']);
  assert.equal(report.status, 0, report.stderr); assert.match(f.read(), /REPORT: completed/);
});

test('P5.24 a10: owner may defer a review without resolving it or hiding another item', (t) => {
  const f = fixture(t);
  const before = JSON.parse(f.run(['inbox', '--json']).stdout).items;
  const review = before.find((i) => i.type === 'review'); assert.ok(review);
  const r = f.run(['inbox', 'defer', review.target, 'review', '--by', 'Owner', '--until', '2026-11-20T12:00:00Z']);
  assert.equal(r.status, 0, r.stderr);
  const now = JSON.parse(f.run(['inbox', '--json']).stdout).items;
  assert.ok(!now.some((i) => i.target === review.target && i.type === 'review'));
  assert.ok(now.some((i) => i.target !== review.target));
  const later = JSON.parse(f.run(['inbox', '--json'], undefined, { ROADCTL_NOW: '2026-11-20T12:00:00.000Z' }).stdout).items;
  assert.ok(later.some((i) => i.target === review.target && i.type === 'review'));
  const card = fs.readdirSync(path.join(f.board, 'cards')).find((name) => name.startsWith(`${review.target}-`));
  assert.match(fs.readFileSync(path.join(f.board, 'cards', card), 'utf8'), /status: review/);
});

test('P5.24 a10: deferring a routine escalation does not change its approval hash', async (t) => {
  const f = fixture(t);
  let r = f.run(['routine', 'new', 'r1', 'Collect', '--agent', 'worker', '--model', 'none', '--env', 'local', '--every', '2h']); assert.equal(r.status, 0, r.stderr);
  r = f.run(['routine', 'on', 'r1', '--by', 'Owner', '--source', 'test']); assert.equal(r.status, 0, r.stderr);
  const file = path.join(f.board, 'routines', 'r1.md');
  fs.appendFileSync(file, '\n## Log\n- 2026-11-20 [worker] RUN escalated: review\n');
  r = f.run(['inbox', 'defer', 'r1', 'escalation', '--by', 'Owner', '--until', '2026-11-20T12:00:00Z']); assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(f.run(['routine', 'list', '--json']).stdout);
  assert.ok(!rows.find((row) => row.id === 'r1').reasons.some((reason) => /changed after approval/.test(reason)));
  const { loadBoard } = await import('../roadctl.mjs');
  const { approvalState } = await import('./approval-hash.mjs');
  const board = loadBoard(f.board); const routine = board.routines.find((item) => item.header.id === 'r1');
  assert.equal(approvalState(board, { ...routine, file: path.relative(board.dir, routine.file) }), 'ok');
  assert.ok(!JSON.parse(f.run(['inbox', '--json']).stdout).items.some((item) => item.target === 'r1' && item.type === 'escalation'));
});

test('P5.24 a5: a blocking question does not prevent an independent delegated card from being offered', (t) => {
  const f = fixture(t);
  const file = path.join(f.board, 'cards', 'other.md');
  fs.writeFileSync(file, '---\nid: X-1\ntitle: Independent\nstatus: doing\napproved: Owner, 2026-11-20, scope=implementation\ndelegate: to=worker host=any criteria=all by=coordinator accept=by state=open at=2026-11-20T09:00:00Z\n---\n\n## Goal\nIndependent\n');
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('block')).status, 0);
  const r = f.run(['tick', '--as', 'worker', '--no-pull', '--json']);
  const tick = JSON.parse(r.stdout);
  assert.ok(!tick.items.some((i) => i.id === 'W-3')); assert.ok(tick.items.some((i) => i.kind === 'TAKE' && i.id === 'X-1'));
});

test('P5.24 a4: answer publishes the checked commit, not HEAD, through a fake git; dirty targets and a failed push are reported', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q')).status, 0);
  const bin = path.join(f.root, 'fake-bin'); fs.mkdirSync(bin);
  const log = path.join(f.root, 'fake-git.log');
  const sha = 'a'.repeat(40);
  const fake = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'rev-parse' && args.includes('HEAD')) console.log(process.env.FAKE_GIT_SHA || '${sha}');
else if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) console.log(process.env.FAKE_GIT_ROOT);
else if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) console.log('origin/main');
else if (args[0] === 'show') console.log(process.env.FAKE_GIT_SHOW || 'board/cards/W-3-eksport-csv.md');
else if (args[0] === 'remote') console.log('origin');
else if (args[0] === 'rev-list') console.log(process.env.FAKE_GIT_AHEAD || '1');
else if (args[0] === 'symbolic-ref') console.log('main');
else if (args[0] === 'config' && args.at(-1).endsWith('.remote')) console.log('origin');
else if (args[0] === 'config' && args.at(-1).endsWith('.merge')) console.log('refs/heads/main');
else if (args[0] === 'status' && process.env.FAKE_GIT_DIRTY) console.log(' M board/cards/W-3-eksport-csv.md');
else if (args[0] === 'log') console.log(process.env.FAKE_GIT_FOREIGN ? 'board/cards/other.md' : 'board/cards/W-3-eksport-csv.md');
else if (args[0] === 'push' && process.env.FAKE_GIT_FAIL) process.exit(1);
`;
  fs.writeFileSync(path.join(bin, 'git'), fake, { mode: 0o755 });
  const over = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GIT_ROOT: f.root, FAKE_GIT_LOG: log };
  const callsNow = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const before = f.read();
  let r = f.run(['answer', 'W-3', 'q', '--by', 'Owner'], { answer: true }, { ...over, FAKE_GIT_DIRTY: '1' });
  assert.equal(r.status, 2); assert.equal(f.read(), before);
  r = f.run(['answer', 'W-3', 'q', '--by', 'Owner'], { answer: true }, { ...over, FAKE_GIT_FAIL: '1' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /committed locally; push failed/);
  let calls = callsNow();
  assert.ok(calls.some((a) => a[0] === 'add' && a.at(-1) === 'board/cards/W-3-eksport-csv.md'));
  assert.ok(calls.some((a) => a[0] === 'commit' && a.at(-1) === 'board/cards/W-3-eksport-csv.md'));
  assert.ok(calls.some((a) => a[0] === 'show' && a.includes(sha)), 'the file list comes from the pinned commit');
  assert.ok(calls.some((a) => a[0] === 'rev-list' && a.includes(`@{u}..${sha}`)), 'the unpushed count comes from the pinned commit');
  assert.ok(calls.some((a) => a[0] === 'push' && a.includes('--no-follow-tags') && a.includes(`${sha}:refs/heads/main`)));
  assert.ok(!calls.some((a) => a[0] === 'push' && a.some((x) => x.startsWith('HEAD:'))), 'never pushes a moving HEAD');
  assert.ok(!calls.some((a) => a[0] === 'log' && a.includes('@{u}..HEAD')), 'no check of a moving HEAD');
  // a commit another process adds after the check stays local: the answer pushes only its own pinned commit
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q2')).status, 0);
  fs.writeFileSync(log, '');
  r = f.run(['answer', 'W-3', 'q2', '--by', 'Owner'], { answer: true }, { ...over, FAKE_GIT_FOREIGN: '1' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /published/);
  calls = callsNow();
  assert.ok(calls.some((a) => a[0] === 'push' && a.includes(`${sha}:refs/heads/main`)));
  assert.ok(!calls.some((a) => a[0] === 'push' && a.some((x) => x.startsWith('HEAD:'))));
  // a second unpushed commit on top of the checked one: published nothing
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q3')).status, 0);
  fs.writeFileSync(log, '');
  r = f.run(['answer', 'W-3', 'q3', '--by', 'Owner'], { answer: true }, { ...over, FAKE_GIT_AHEAD: '2' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /other commits or files are unpushed/);
  assert.ok(!callsNow().some((a) => a[0] === 'push'));
});

test('P5.24 a11: undo does not silently reopen an owner-accepted or otherwise blocked card', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q', 'reversible')).status, 0);
  const original = f.read();
  for (const status of ['done', 'dropped', 'blocked']) {
    fs.writeFileSync(f.card, original.replace('status: doing', `status: ${status}`));
    const before = f.read();
    const r = f.run(['undo', 'W-3', 'q', '--by', 'Owner'], { comment: 'reconsider' });
    assert.equal(r.status, 2); assert.match(r.stderr, /resolve its status/); assert.equal(f.read(), before);
  }
});

test('P5.24 a2/a7: the tick --json contract carries RESUME and the owner answers of a RUN through the schema', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q')).status, 0);
  assert.equal(f.run(['answer', 'W-3', 'q', '--by', 'Owner'], { answer: true }).status, 0);
  let j = JSON.parse(f.run(['tick', '--as', 'worker', '--no-pull', '--json']).stdout);
  assert.deepEqual(tickJsonProblems(j), []);
  const resume = j.items.find((i) => i.kind === 'RESUME');
  assert.ok(resume); assert.equal(resume.id, 'W-3'); assert.equal('delegate' in resume, false);
  let r = f.run(['routine', 'new', 'r1', 'Collect status', '--agent', 'worker', '--model', 'none', '--env', 'local', '--every', '2h']); assert.equal(r.status, 0, r.stderr);
  r = f.run(['routine', 'on', 'r1', '--by', 'Owner', '--source', 'test']); assert.equal(r.status, 0, r.stderr);
  r = f.run(['autonomy', 'routines', 'on', '--by', 'Owner']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.run(['ask', 'r1', '--as', 'worker'], q('rq')).status, 0);
  assert.equal(f.run(['answer', 'r1', 'rq', '--by', 'Owner'], { answer: true }).status, 0);
  j = JSON.parse(f.run(['tick', '--as', 'worker', '--routine', 'r1', '--no-pull', '--json']).stdout);
  assert.deepEqual(tickJsonProblems(j), []);
  const run = j.items.find((i) => i.kind === 'RUN');
  assert.ok(run);
  assert.deepEqual(run.routine.owner_answers.map((a) => ({ id: a.id, prompt: a.prompt, answer: a.answer })), [{ id: 'rq', prompt: 'Proceed?', answer: true }]);
});

test('P5.24 a5/a11: roadctl decides the blocking class; a declared reversible never lowers it', (t) => {
  const reversible = (id, extra = {}) => ({ question: { id, kind: 'confirm', prompt: 'Proceed?', reason: 'reversible', recommended: true, ...extra } });
  // an external area named by the question
  let f = fixture(t);
  let r = f.run(['ask', 'W-3', '--as', 'worker'], reversible('ext', { scope: ['external'] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /status: blocked/);
  assert.match(f.read(), /"blocking":true/);
  assert.match(f.read(), /"state":"waiting"/);
  assert.doesNotMatch(f.read(), /"recommended"/);
  assert.doesNotMatch(f.read(), /"undo_until"/);
  assert.match(f.read(), /ASK ext: waiting for owner \(blocking: .*an external area is involved\)/);
  assert.ok(!JSON.parse(f.run(['inbox', '--json']).stdout).items.some((i) => i.type === 'decision'));
  // an external area recorded on the card
  f = fixture(t);
  fs.writeFileSync(f.card, f.read().replace('scope=implementation', 'scope=implementation+external'));
  r = f.run(['ask', 'W-3', '--as', 'worker'], reversible('card'));
  assert.equal(r.status, 0, r.stderr); assert.match(f.read(), /status: blocked/); assert.match(f.read(), /"blocking":true/);
  // a scope outside the approved scope of the card
  f = fixture(t);
  r = f.run(['ask', 'W-3', '--as', 'worker'], reversible('wide', { scope: ['repo'] }));
  assert.equal(r.status, 0, r.stderr); assert.match(f.read(), /status: blocked/);
  assert.match(f.read(), /outside the approved scope of the card/);
  // a mandate that is not in force: nothing is inside it
  f = fixture(t);
  fs.writeFileSync(path.join(f.board, 'mandate.md'), '---\nmandate: 1\nlevel: L3\nkinds: fix, docs\nmax_size: M\nmerge: branch\nbudget: cards_per_day=2, runs_per_week=10\n---\n\n## Goals\n- G1 (priority 1): ship\n\n## Forbidden\n- nothing\n\n## Tell the owner\n- deploy to production\n');
  r = f.run(['ask', 'W-3', '--as', 'worker'], reversible('nomandate'));
  assert.equal(r.status, 0, r.stderr); assert.match(f.read(), /status: blocked/); assert.match(f.read(), /the mandate is not in force/);
  // an approved mandate: a subject of Tell the owner blocks, the card's own scope does not
  f = fixture(t);
  const mandate = '---\nmandate: 1\nlevel: L3\nkinds: fix, docs\nmax_size: M\nmerge: branch\nbudget: cards_per_day=2, runs_per_week=10\n---\n\n## Goals\n- G1 (priority 1): ship\n\n## Forbidden\n- nothing\n\n## Tell the owner\n- deploy to production\n';
  fs.writeFileSync(path.join(f.board, 'mandate.md'), mandate);
  const shown = JSON.parse(f.run(['mandate', 'show', '--json']).stdout);
  const approved = f.run(['mandate', 'approve', '--by', 'Owner', '--hash', shown.hash]);
  assert.equal(approved.status, 0, approved.stderr);
  fs.writeFileSync(f.card, f.read().replace('status: doing', `status: doing\nkind: fix\nsize: S\ngoal: G1\nby_mandate: ${shown.hash}`));
  r = f.run(['ask', 'W-3', '--as', 'worker'], reversible('tell', { scope: ['deploy'] }));
  assert.equal(r.status, 0, r.stderr); assert.match(f.read(), /status: blocked/); assert.match(f.read(), /a subject of Tell the owner in the mandate/);
  f = fixture(t);
  fs.writeFileSync(path.join(f.board, 'mandate.md'), mandate);
  const shown2 = JSON.parse(f.run(['mandate', 'show', '--json']).stdout);
  assert.equal(f.run(['mandate', 'approve', '--by', 'Owner', '--hash', shown2.hash]).status, 0);
  fs.writeFileSync(f.card, f.read().replace('status: doing', `status: doing\nkind: fix\nsize: S\ngoal: G1\nby_mandate: ${shown2.hash}`));
  r = f.run(['ask', 'W-3', '--as', 'worker'], reversible('inside', { scope: ['implementation'] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /"blocking":false/); assert.match(f.read(), /"state":"decided"/);
});

test('P5.24 a11: after an undo the card is a RESUME task with the comment, delegated or not, never a TAKE', (t) => {
  // undelegated
  let f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q', 'reversible')).status, 0);
  let r = f.run(['undo', 'W-3', 'q', '--by', 'Owner'], { comment: 'redo the export' });
  assert.equal(r.status, 0, r.stderr);
  let tick = JSON.parse(f.run(['tick', '--as', 'worker', '--no-pull', '--json']).stdout);
  assert.deepEqual(tickJsonProblems(tick), []);
  const item = tick.items.find((i) => i.id === 'W-3');
  assert.equal(item.kind, 'RESUME'); assert.equal(item.undo, 'redo the export');
  // delegated and open: the same RESUME, not the plain TAKE the delegation would otherwise offer
  f = fixture(t);
  fs.writeFileSync(f.card, f.read().replace('status: doing', 'status: doing\ndelegate: to=worker host=any criteria=all by=coordinator accept=by state=open at=2026-11-20T09:00:00Z'));
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q', 'reversible')).status, 0);
  tick = JSON.parse(f.run(['tick', '--as', 'worker', '--no-pull', '--json']).stdout);
  assert.ok(tick.items.some((i) => i.kind === 'TAKE' && i.id === 'W-3'), 'before the undo the open delegation is a TAKE');
  r = f.run(['undo', 'W-3', 'q', '--by', 'Owner'], { comment: 'not like that' });
  assert.equal(r.status, 0, r.stderr);
  tick = JSON.parse(f.run(['tick', '--as', 'worker', '--no-pull', '--json']).stdout);
  assert.deepEqual(tickJsonProblems(tick), []);
  assert.ok(!tick.items.some((i) => i.kind === 'TAKE' && i.id === 'W-3'));
  assert.equal(tick.items.find((i) => i.id === 'W-3')?.kind, 'RESUME');
  assert.equal(tick.items.find((i) => i.id === 'W-3')?.undo, 'not like that');
  assert.match(f.run(['tick', '--as', 'worker', '--no-pull', '--prompt']).stdout, /RESUME .*W-3.*the owner undid a decision/);
});

test('P5.24 a5/a11: inbox offers no Undo where the command would refuse (done, blocked)', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q', 'reversible')).status, 0);
  const original = f.read();
  let item = JSON.parse(f.run(['inbox', '--json']).stdout).items.find((i) => i.question?.id === 'q');
  assert.equal(item.undoable, true, 'doing in the window: the undo would pass');
  for (const status of ['done', 'blocked']) {
    fs.writeFileSync(f.card, original.replace('status: doing', `status: ${status}`));
    item = JSON.parse(f.run(['inbox', '--json']).stdout).items.find((i) => i.question?.id === 'q');
    assert.equal(item.undoable, false, status);
    assert.match(item.confirmation, /^Decision W-3\/q: /);
  }
});

test('P5.24 a10: the confirmation is built from roadctl data and the agent wording stays a quote', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'q', kind: 'confirm', prompt: 'Confirm the tiny thing', reason: 'reversible', recommended: true, scope: ['implementation'] }, undo_until: '2027-01-01T00:00:00.000Z' }).status, 0);
  const item = JSON.parse(f.run(['inbox', '--json']).stdout).items.find((i) => i.question?.id === 'q');
  assert.equal(item.type, 'decision');
  assert.equal(item.confirmation, `Undo W-3/q: W-3 "Экспорт отчёта в CSV" scope=implementation hash=${item.hash.slice(0, 12)}`);
  assert.equal(item.quote, 'Confirm the tiny thing');
  assert.ok(!item.confirmation.includes('Confirm the tiny thing'));
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('block')).status, 0);
  const waiting = JSON.parse(f.run(['inbox', '--json']).stdout).items.find((i) => i.question?.id === 'block');
  assert.equal(waiting.confirmation, `Answer W-3/block: W-3 "Экспорт отчёта в CSV" scope=implementation hash=${waiting.hash.slice(0, 12)}`);
  assert.equal(waiting.quote, 'Proceed?');
});

test('P5.24 a11: an older undo does not hide a newer owner answer on the same delegated card: undo, new blocking question, answer, tick gives RESUME', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.card, f.read().replace('status: doing', 'status: doing\ndelegate: to=worker host=any criteria=all by=coordinator accept=by state=open at=2026-11-20T09:00:00Z'));
  const tick = () => JSON.parse(f.run(['tick', '--as', 'worker', '--no-pull', '--json']).stdout);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q1', 'reversible')).status, 0);
  assert.equal(f.run(['undo', 'W-3', 'q1', '--by', 'Owner'], { comment: 'not like that' }).status, 0);
  assert.equal(tick().items.find((i) => i.id === 'W-3')?.undo, 'not like that', 'the undo is a RESUME with its comment');
  // the worker asks again (a blocking question) and the owner answers it: the card is blocked with the answer marker
  let r = f.run(['ask', 'W-3', '--as', 'worker'], q('q2')); assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /status: blocked/);
  r = f.run(['answer', 'W-3', 'q2', '--by', 'Owner'], { answer: true }); assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /^blocked: owner answer q2$/m);
  const t2 = tick();
  assert.deepEqual(tickJsonProblems(t2), []);
  const item = t2.items.find((i) => i.id === 'W-3');
  assert.equal(item?.kind, 'RESUME', JSON.stringify(t2.items));
  assert.equal(item.undo, undefined, 'it is the answer, not the old undo');
  assert.match(f.run(['tick', '--as', 'worker', '--no-pull', '--prompt']).stdout, /RESUME .*W-3.*owner answered/);
});

test('P5.24 a5/a11: the undo window is the board daily overview; without a schedule it is 24 hours', (t) => {
  const f = fixture(t);
  const cfg = path.join(f.board, 'config.json');
  const base = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const untilOf = (id) => JSON.parse(f.run(['inbox', '--json']).stdout).items.find((i) => i.question?.id === id)?.question.undo_until;
  // the caller's own deadline is ignored; the next 09:00 UTC is tomorrow
  fs.writeFileSync(cfg, JSON.stringify({ ...base, digest: { daily: '09:00', tz: 'UTC' } }));
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'q1', kind: 'confirm', prompt: 'P?', reason: 'reversible', recommended: true, scope: ['implementation'] }, undo_until: '2099-01-01T00:00:00.000Z' }).status, 0);
  assert.equal(untilOf('q1'), '2026-11-21T09:00:00.000Z');
  // an overview still ahead today
  fs.writeFileSync(cfg, JSON.stringify({ ...base, digest: { daily: '12:00', tz: 'UTC' } }));
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'q2', kind: 'confirm', prompt: 'P?', reason: 'reversible', recommended: true, scope: ['implementation'] } }).status, 0);
  assert.equal(untilOf('q2'), '2026-11-20T12:00:00.000Z');
  // no schedule: a fixed 24 hours; a malformed one counts as none
  fs.writeFileSync(cfg, JSON.stringify(base));
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'q3', kind: 'confirm', prompt: 'P?', reason: 'reversible', recommended: true, scope: ['implementation'] } }).status, 0);
  assert.equal(untilOf('q3'), '2026-11-21T10:00:00.000Z');
  fs.writeFileSync(cfg, JSON.stringify({ ...base, digest: { daily: '9:00' } }));
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'q4', kind: 'confirm', prompt: 'P?', reason: 'reversible', recommended: true, scope: ['implementation'] } }).status, 0);
  assert.equal(untilOf('q4'), '2026-11-21T10:00:00.000Z');
});

test('P5.24 a8: ask leaves the card uncommitted, so a report with a remote needs roadctl save first, and the help says so', (t) => {
  const f = fixture(t);
  assert.match(f.run(['help', 'ask']).stdout.replace(/\s+/g, ' '), /roadctl save before roadctl report/);
  const docs = fs.readFileSync(fileURLToPath(new URL('../../docs/roadctl.md', import.meta.url)), 'utf8');
  assert.match(docs.replace(/\s+/g, ' '), /run `roadctl save` before `roadctl report`/);
  const claim = 'claim: worker at=2026-11-20T09:00:00Z until=2026-11-20T10:30:00Z';
  fs.writeFileSync(f.card, f.read().replace('status: doing', `status: doing\ndelegate: to=worker host=any criteria=all by=coordinator accept=by state=claimed at=2026-11-20T09:00:00Z\n${claim}`));
  const ask = f.run(['ask', 'W-3', '--as', 'worker'], { ...q('q', 'reversible', ['implementation']), checkpoint: { did: 'ready', next: 'continue', in_flight: 'none' } });
  assert.equal(ask.status, 0, ask.stderr);
  fs.writeFileSync(f.card, f.read().replace('- [ ] a2:', '- [x] a2:').replace('## Log', '- a2: checked by the worker\n\n## Log')); // P5.41 a4: evidence before the report, so the uncommitted-change refusal is what fires
  const bin = path.join(f.root, 'fake-bin'); fs.mkdirSync(bin);
  const fake = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) console.log(process.env.FAKE_GIT_ROOT);
else if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) console.log('origin/main');
else if (args[0] === 'remote') console.log('origin');
else if (args[0] === 'status' && process.env.FAKE_GIT_DIRTY) console.log(' M board/cards/W-3-eksport-csv.md');
`;
  fs.writeFileSync(path.join(bin, 'git'), fake, { mode: 0o755 });
  const over = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GIT_ROOT: f.root, FAKE_GIT_DIRTY: '1' };
  const r = f.run(['report', 'W-3', '--as', 'worker', 'completed'], undefined, over);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /run roadctl save first/);
});

test('P5.24 a5/a11: a missing scope blocks, and a Tell the owner rule is matched by the question text', (t) => {
  const setup = () => {
    const f = fixture(t);
    const mandate = '---\nmandate: 1\nlevel: L3\nkinds: fix, docs\nmax_size: M\nmerge: branch\nbudget: cards_per_day=2, runs_per_week=10\n---\n\n## Goals\n- G1 (priority 1): ship\n\n## Forbidden\n- nothing\n\n## Tell the owner\n- Deploy to production\n';
    fs.writeFileSync(path.join(f.board, 'mandate.md'), mandate);
    const shown = JSON.parse(f.run(['mandate', 'show', '--json']).stdout);
    assert.equal(f.run(['mandate', 'approve', '--by', 'Owner', '--hash', shown.hash]).status, 0);
    fs.writeFileSync(f.card, f.read().replace('status: doing', `status: doing\nkind: fix\nsize: S\ngoal: G1\nby_mandate: ${shown.hash}`));
    return f;
  };
  // no scope at all: the area cannot be established, so the question is blocking even though the words are new
  let f = setup();
  let r = f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'plain', kind: 'confirm', prompt: 'Which of these two?', reason: 'reversible', recommended: true } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /"blocking":true/);
  assert.match(f.read(), /"state":"waiting"/);
  assert.match(f.read(), /no area is named/);
  assert.ok(!JSON.parse(f.run(['inbox', '--json']).stdout).items.some((i) => i.type === 'decision'));
  // the rule is matched by the text, still without a scope
  f = setup();
  r = f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'tell', kind: 'confirm', prompt: 'Deploy to production?', reason: 'reversible', recommended: true } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /a subject of Tell the owner in the mandate/);
  assert.doesNotMatch(f.read(), /"state":"decided"/);
  assert.match(f.read(), /status: blocked/);
  // an area inside the card does not help when the text matches the rule
  f = setup();
  r = f.run(['ask', 'W-3', '--as', 'worker'], { question: { id: 'tell2', kind: 'confirm', prompt: 'DEPLOY to production?', reason: 'reversible', recommended: true, scope: ['implementation'] } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.read(), /"blocking":true/);
  assert.match(f.read(), /a subject of Tell the owner in the mandate/);
  assert.doesNotMatch(f.read(), /"state":"decided"/);
});

test('P5.24 a11: a stored blocking field may only raise the strictness', async (t) => {
  const { readQuestions } = await import('./owner-questions-data.mjs');
  const bad = { id: 'bad', kind: 'confirm', prompt: 'Proceed?', reason: 'irreversible', scope: ['external'], created: '2026-11-20T10:00:00.000Z', state: 'decided', blocking: false, recommended: true, undo_until: '2026-11-21T10:00:00.000Z' };
  assert.throws(() => readQuestions(JSON.stringify([bad])), /invalid blocking class/, 'irreversible and external data cannot be stored as non-blocking');
  const raised = { ...bad, state: 'waiting', blocking: true };
  delete raised.recommended; delete raised.undo_until;
  const rows = readQuestions(JSON.stringify([raised]));
  assert.equal(rows.length, 1); assert.equal(rows[0].blocking, true);
  const f = fixture(t);
  fs.writeFileSync(f.card, `${f.read().trimEnd()}\n\n## Questions\n${JSON.stringify([bad])}\n`);
  const r = f.run(['inbox', '--json']);
  assert.equal(r.status, 2); assert.match(r.stderr, /invalid blocking class/);
});

test('P5.24 a11: RESUME follows the work after a reassignment; the previous agent gets nothing', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.card, f.read().replace('status: doing', 'status: doing\ndelegate: to=worker host=any criteria=all by=coordinator accept=by state=open at=2026-11-20T09:00:00Z'));
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q', 'reversible')).status, 0);
  assert.equal(f.run(['undo', 'W-3', 'q', '--by', 'Owner'], { comment: 'redo' }).status, 0);
  let tick = JSON.parse(f.run(['tick', '--as', 'worker', '--no-pull', '--json']).stdout);
  assert.equal(tick.items.find((i) => i.id === 'W-3')?.kind, 'RESUME');
  // the delegation moves to another agent: the rework task moves with it
  fs.writeFileSync(f.card, f.read().replace('to=worker host=any', 'to=coordinator host=any'));
  tick = JSON.parse(f.run(['tick', '--as', 'coordinator', '--no-pull', '--json']).stdout);
  const item = tick.items.find((i) => i.id === 'W-3');
  assert.equal(item?.kind, 'RESUME'); assert.equal(item.undo, 'redo');
  tick = JSON.parse(f.run(['tick', '--as', 'worker', '--no-pull', '--json']).stdout);
  assert.ok(!tick.items.some((i) => i.id === 'W-3'), 'the previous agent gets neither a RESUME nor a TAKE');
});

test('P5.24 a10: one confirmation contract for every inbox type, the agent text only as a quote', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('dec', 'reversible')).status, 0);
  let r = f.run(['routine', 'new', 'r1', 'Collect', '--agent', 'worker', '--model', 'none', '--env', 'local', '--every', '2h']); assert.equal(r.status, 0, r.stderr);
  fs.appendFileSync(path.join(f.board, 'routines', 'r1.md'), '\n## Log\n- 2026-11-20 [worker] RUN escalated: needs review\n');
  const dir = path.join(f.board, 'cards');
  fs.writeFileSync(path.join(dir, 'P-1.md'), '---\nid: P-1\ntitle: Proposal\nstatus: proposed\n---\n\n## Goal\nDraft\n');
  fs.writeFileSync(path.join(dir, 'M-1.md'), '---\nid: M-1\ntitle: Milestone\nstatus: review\nkind: milestone\n---\n\n## Goal\nReview\n');
  // the open question needs a card that is still doing, so it lives on its own board
  const g = fixture(t);
  assert.equal(g.run(['ask', 'W-3', '--as', 'worker'], q('block')).status, 0);
  const items = [...JSON.parse(f.run(['inbox', '--json']).stdout).items, ...JSON.parse(g.run(['inbox', '--json']).stdout).items];
  for (const type of ['question', 'decision', 'review', 'approval', 'escalation', 'proposed', 'milestone']) assert.ok(items.some((i) => i.type === type), type);
  const verb = { question: 'Answer', decision: 'Undo' };
  for (const i of items) {
    assert.match(i.confirmation, new RegExp(`^${verb[i.type] ?? i.type}`), i.confirmation);
    assert.ok(i.confirmation.includes(i.target), i.confirmation);
    assert.match(i.confirmation, / scope=\S+ hash=[a-f0-9]{12}$/, i.confirmation);
    assert.doesNotMatch(i.confirmation, /Proceed\?|needs review/, 'the agent text never enters the action line');
  }
  for (const i of items.filter((x) => ['question', 'decision'].includes(x.type))) assert.equal(i.quote, 'Proceed?');
  const escalation = items.find((i) => i.type === 'escalation');
  assert.equal(escalation.quote, 'RUN escalated: needs review');
});

test('P5.24 a11: one unreadable Questions section does not remove the other RESUME items', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.card, f.read().replace('status: doing', 'status: doing\ndelegate: to=worker host=any criteria=all by=coordinator accept=by state=open at=2026-11-20T09:00:00Z'));
  assert.equal(f.run(['ask', 'W-3', '--as', 'worker'], q('q', 'reversible')).status, 0);
  assert.equal(f.run(['undo', 'W-3', 'q', '--by', 'Owner'], { comment: 'redo' }).status, 0);
  fs.writeFileSync(path.join(f.board, 'cards', 'broken.md'), '---\nid: B-1\ntitle: Broken\nstatus: doing\n---\n\n## Goal\nx\n\n## Questions\nnot json\n');
  const r = f.run(['tick', '--as', 'worker', '--no-pull', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const tick = JSON.parse(r.stdout);
  assert.equal(tick.items.find((i) => i.id === 'W-3')?.kind, 'RESUME');
  assert.ok(!tick.items.some((i) => i.id === 'B-1'), 'the broken card is skipped here');
  const lint = f.run(['lint']);
  assert.match(lint.stdout, /broken\.md/);
  assert.match(lint.stdout, /Questions section cannot be read/);
});

test('P5.24 a5/a11: the undo window follows the zone offset across a DST change', (t) => {
  const f = fixture(t);
  const cfg = path.join(f.board, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), digest: { daily: '03:30', tz: 'America/New_York' } }));
  const askAt = (id, now) => {
    const r = f.run(['ask', 'W-3', '--as', 'worker'], { question: { id, kind: 'confirm', prompt: 'P?', reason: 'reversible', recommended: true, scope: ['implementation'] } }, { ROADCTL_NOW: now });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(f.run(['inbox', '--json'], undefined, { ROADCTL_NOW: now }).stdout).items.find((i) => i.question?.id === id)?.question.undo_until;
  };
  // asked on the evening before the change: 03:30 the next day is already EDT, so 07:30Z, not 08:30Z
  assert.equal(askAt('q1', '2026-03-07T20:00:00.000Z'), '2026-03-08T07:30:00.000Z');
  // asked after that moment: the next overview is the following day, and the offset is that of the target moment
  assert.equal(askAt('q2', '2026-03-08T07:45:00.000Z'), '2026-03-09T07:30:00.000Z');
});
