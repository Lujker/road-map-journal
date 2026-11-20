// The owner-question state is kept in the card or routine, not in machine-local state.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_TEXT = 1000;
const text = (v) => typeof v === 'string' && v.trim() && v.length <= MAX_TEXT && !/[\x00-\x1f\x7f]/.test(v);
const fail = (message, code = 'invalid') => { throw Object.assign(new Error(message), { code }); };
const instant = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));

/** Validate and create one question. Blocking is required for irreversible or out-of-mandate decisions. */
export function makeQuestion(input, now, undoUntil) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('question must be an object');
  const { id, kind, prompt, reason, points, recommended } = input;
  if (!ID.test(id ?? '') || !['confirm', 'choice', 'text'].includes(kind) || !text(prompt)) fail('invalid question id, kind or prompt');
  if (!['reversible', 'irreversible', 'outside-mandate'].includes(reason)) fail('invalid decision reason');
  if (!instant(now) || !instant(undoUntil) || Date.parse(undoUntil) <= Date.parse(now)) fail('invalid decision window');
  if (kind === 'choice') {
    if (!Array.isArray(points) || !points.length || points.length > 20) fail('choice needs 1 to 20 points');
    const ids = new Set();
    for (const p of points) {
      if (!p || !ID.test(p.id ?? '') || ids.has(p.id) || !text(p.prompt) || !Array.isArray(p.options) || p.options.length > 20 || p.options.some((v) => !text(v)) || new Set(p.options).size !== p.options.length) fail('invalid choice point');
      ids.add(p.id);
    }
  } else if (points !== undefined) fail('points only apply to choice questions');
  const blocking = reason !== 'reversible';
  if (blocking && recommended !== undefined) fail('blocking questions cannot apply a recommendation');
  if (!blocking && !validAnswer({ kind, points }, recommended)) fail('a reversible question requires a valid recommendation');
  return { id, kind, prompt, reason, ...(points ? { points: structuredClone(points) } : {}), blocking, created: now,
    state: blocking ? 'waiting' : 'decided', ...(blocking ? {} : { recommended: structuredClone(recommended), undo_until: undoUntil }) };
}

/** The response shape is fixed by the question; free text is bounded and never silently truncated. */
export function validAnswer(q, value) {
  if (q.kind === 'confirm') return typeof value === 'boolean';
  if (q.kind === 'text') return Boolean(text(value));
  if (q.kind !== 'choice' || !value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(q.points)) return false;
  const ids = q.points.map((p) => p.id);
  return Object.keys(value).length === ids.length && q.points.every((p) => Object.hasOwn(value, p.id) && text(value[p.id]));
}

export function answerQuestion(question, answer, now) {
  if (!question || question.state !== 'waiting') fail('question already answered or not waiting', 'already-answered');
  if (!instant(now) || !validAnswer(question, answer)) fail('invalid answer');
  return { ...question, state: 'answered', answer: structuredClone(answer), answered: now };
}

export function undoQuestion(question, comment, now) {
  if (!question || question.state !== 'decided' || question.blocking || !instant(now) || !instant(question.undo_until)) fail('decision cannot be undone');
  if (Date.parse(now) >= Date.parse(question.undo_until)) fail('undo window expired', 'undo-expired');
  if (!text(comment)) fail('undo requires a comment');
  return { ...question, state: 'undone', undo_comment: comment, undone: now };
}

/** Store JSON on one line in a dedicated section; reject malformed or duplicate state. */
export function readQuestions(section) {
  if (!section?.trim()) return [];
  let rows;
  try { rows = JSON.parse(section.trim()); } catch { fail('invalid Questions JSON'); }
  if (!Array.isArray(rows) || rows.some((q) => !q || !ID.test(q.id ?? '')) || new Set(rows.map((q) => q.id)).size !== rows.length) fail('invalid Questions data');
  return rows;
}
export const writeQuestions = (rows) => JSON.stringify(rows);
