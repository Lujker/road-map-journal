import test from 'node:test';
import assert from 'node:assert/strict';
import { makeQuestion, answerQuestion, undoQuestion, readQuestions, writeQuestions } from './owner-questions-data.mjs';

const now = '2026-11-20T10:00:00.000Z';
const later = '2026-11-21T10:00:00.000Z';
const create = (q) => makeQuestion(q, now, later);

test('three question forms survive JSON round trip with their fields', () => {
  const questions = [
    create({ id: 'q1', kind: 'confirm', prompt: 'Proceed?', reason: 'irreversible' }),
    create({ id: 'q2', kind: 'choice', prompt: 'Choose', reason: 'outside-mandate', points: [{ id: 'one', prompt: 'Which?', options: ['A', 'B'] }] }),
    create({ id: 'q3', kind: 'text', prompt: 'What?', reason: 'reversible', recommended: 'A' }),
  ];
  assert.deepEqual(readQuestions(writeQuestions(questions)), questions);
  assert.throws(() => readQuestions('[{"id":"x"},{"id":"x"}]'), /invalid Questions/);
  assert.throws(() => readQuestions('{broken'), /invalid Questions/);
});

test('irreversible and outside-mandate questions wait; reversible decisions record a recommendation', () => {
  for (const reason of ['irreversible', 'outside-mandate']) {
    const q = create({ id: reason, kind: 'confirm', prompt: 'Proceed?', reason });
    assert.equal(q.blocking, true);
    assert.equal(q.state, 'waiting');
    assert.throws(() => create({ id: reason, kind: 'confirm', prompt: 'Proceed?', reason, recommended: true }), /cannot apply/);
  }
  const q = create({ id: 'q', kind: 'confirm', prompt: 'Proceed?', reason: 'reversible', recommended: false });
  assert.equal(q.state, 'decided');
  assert.equal(q.recommended, false);
  assert.equal(q.undo_until, later);
});

test('answer validates type, length and point IDs, and a second answer has a distinct error', () => {
  const q = create({ id: 'q', kind: 'choice', prompt: 'Choose', reason: 'irreversible', points: [{ id: 'a', prompt: 'Which?', options: ['one', 'two'] }] });
  for (const answer of [{ a: 'x'.repeat(1001) }, { b: 'one' }, { a: 'one', b: 'two' }]) assert.throws(() => answerQuestion(q, answer, now), /invalid answer/);
  const a = answerQuestion(q, { a: 'custom' }, now);
  assert.equal(a.answer.a, 'custom');
  assert.throws(() => answerQuestion(a, { a: 'one' }, now), (e) => e.code === 'already-answered');
});

test('undo requires a comment and rejects an expired window with a distinct error', () => {
  const q = create({ id: 'q', kind: 'text', prompt: 'Proceed?', reason: 'reversible', recommended: 'yes' });
  assert.throws(() => undoQuestion(q, '', now), /comment/);
  assert.equal(undoQuestion(q, 'Please reconsider', now).state, 'undone');
  assert.throws(() => undoQuestion(q, 'Too late', later), (e) => e.code === 'undo-expired');
  const blocking = create({ id: 'blocked', kind: 'text', prompt: 'Proceed?', reason: 'outside-mandate' });
  assert.throws(() => undoQuestion(blocking, 'Do it', now), /cannot be undone/);
});

test('card Questions section stores and restores all forms without altering other sections or CRLF', async () => {
  const { addQuestion, putQuestions, questionsFromItem } = await import('./owner-questions-data.mjs');
  const card = '---\r\nid: W-1\r\nstatus: doing\r\n---\r\n\r\n## Goal\r\nKeep this.\r\n\r\n## Log\r\n- old\r\n';
  let rows = [];
  for (const q of [
    { id: 'confirm', kind: 'confirm', prompt: 'Proceed?', reason: 'irreversible' },
    { id: 'choice', kind: 'choice', prompt: 'Choose', reason: 'outside-mandate', points: [{ id: 'p', prompt: 'Pick', options: ['one'] }] },
    { id: 'text', kind: 'text', prompt: 'Explain', reason: 'reversible', recommended: 'default' },
  ]) rows = addQuestion(rows, create(q));
  const saved = putQuestions(card, rows);
  assert.deepEqual(questionsFromItem(saved), rows);
  assert.match(saved, /## Goal\r\nKeep this\.\r\n\r\n## Log\r\n- old\r\n/);
  assert.doesNotMatch(saved, /(?<!\r)\n/);
  assert.throws(() => addQuestion(rows, create({ id: 'confirm', kind: 'confirm', prompt: 'Proceed?', reason: 'reversible', recommended: true })), (e) => e.code === 'duplicate-question');
  assert.throws(() => questionsFromItem(`${saved}\r\n## Questions\r\n[]\r\n`), /duplicate/);
});


test('persisted data rejects a forged blocking downgrade and malformed state', () => {
  const q = create({ id: 'guard', kind: 'confirm', prompt: 'Publish?', reason: 'irreversible' });
  for (const broken of [
    { ...q, blocking: false },
    { ...q, state: 'answered', answer: 'yes', answered: now },
    { ...q, state: 'decided' },
    { ...q, created: '2026-02-31T00:00:00.000Z' },
  ]) assert.throws(() => readQuestions(JSON.stringify([broken])));
});
