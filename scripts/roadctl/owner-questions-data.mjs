// The owner-question state is kept in the card or routine, not in machine-local state.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_TEXT = 1000;
const text = (v) => typeof v === 'string' && v.trim() && v.length <= MAX_TEXT && !/[\x00-\x1f\x7f]/.test(v);
const fail = (message, code = 'invalid') => { throw Object.assign(new Error(message), { code }); };
const instant = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

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
  if (!instant(now) || !instant(question.created) || Date.parse(now) < Date.parse(question.created) || !validAnswer(question, answer)) fail('invalid answer');
  return { ...question, state: 'answered', answer: structuredClone(answer), answered: now };
}

export function undoQuestion(question, comment, now) {
  if (!question || question.state !== 'decided' || question.blocking || question.reason !== 'reversible' || !instant(now) || !instant(question.undo_until)) fail('decision cannot be undone');
  if (!instant(question.created) || Date.parse(now) < Date.parse(question.created)) fail('invalid undo time');
  if (Date.parse(now) >= Date.parse(question.undo_until)) fail('undo window expired', 'undo-expired');
  if (!text(comment)) fail('undo requires a comment');
  return { ...question, state: 'undone', undo_comment: comment, undone: now };
}

/** Store JSON on one line in a dedicated section; reject malformed or duplicate state. */
export function readQuestions(section) {
  if (!section?.trim()) return [];
  let rows;
  try { rows = JSON.parse(section.trim()); } catch { fail('invalid Questions JSON'); }
  if (!Array.isArray(rows) || rows.length > 200 || new Set(rows.map((q) => q?.id)).size !== rows.length) fail('invalid Questions data');
  for (const q of rows) {
    if (!q || typeof q !== 'object' || Array.isArray(q) || !instant(q.created)) fail('invalid Questions data');
    const allowed = ['id', 'kind', 'prompt', 'reason', 'points', 'blocking', 'created', 'state', 'recommended', 'undo_until', 'answer', 'answered', 'undo_comment', 'undone', 'agent', 'defer_until'];
    if (Object.keys(q).some((k) => !allowed.includes(k))) fail('invalid Questions data');
    const blocking = q.reason !== 'reversible';
    const window = blocking ? new Date(Date.parse(q.created) + 1).toISOString() : q.undo_until;
    const base = makeQuestion({ id: q.id, kind: q.kind, prompt: q.prompt, reason: q.reason, ...(q.points === undefined ? {} : { points: q.points }), ...(q.recommended === undefined ? {} : { recommended: q.recommended }) }, q.created, window);
    if (q.blocking !== base.blocking) fail('invalid blocking class');
    if (q.agent !== undefined && (typeof q.agent !== 'string' || !/^[A-Za-z0-9@._:-]{1,100}$/.test(q.agent))) fail('invalid question agent');
    if (q.defer_until !== undefined && !instant(q.defer_until)) fail('invalid deferral');
    if (blocking) {
      if (!['waiting', 'answered'].includes(q.state) || q.undo_until !== undefined || q.undo_comment !== undefined || q.undone !== undefined) fail('invalid question state');
      if (q.state === 'waiting' && (q.answer !== undefined || q.answered !== undefined)) fail('invalid question state');
      if (q.state === 'answered' && (!validAnswer(q, q.answer) || !instant(q.answered) || Date.parse(q.answered) < Date.parse(q.created))) fail('invalid answer');
    } else {
      if (!['decided', 'undone'].includes(q.state) || q.answer !== undefined || q.answered !== undefined) fail('invalid decision state');
      if (q.state === 'decided' && (q.undo_comment !== undefined || q.undone !== undefined)) fail('invalid decision state');
      if (q.state === 'undone' && (!text(q.undo_comment) || !instant(q.undone) || Date.parse(q.undone) < Date.parse(q.created) || Date.parse(q.undone) >= Date.parse(q.undo_until))) fail('invalid undo');
    }
  }
  return rows;
}
export function writeQuestions(rows) {
  if (!Array.isArray(rows)) fail('invalid Questions data');
  const serialized = JSON.stringify(rows);
  readQuestions(serialized);
  return serialized;
}

/** Add a question without replacing an earlier decision or changing its blocking class. */
export function addQuestion(rows, question) {
  if (rows.some((q) => q.id === question.id)) fail('question id already exists', 'duplicate-question');
  return [...rows, question];
}

/** Update only the Questions section, preserving other sections and the file's line endings. */
export function putQuestions(markdown, rows) {
  if (typeof markdown !== 'string' || !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(markdown)) fail('invalid item file');
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const normalized = markdown.replace(/\r\n/g, '\n');
  const headings = [...normalized.matchAll(/^## Questions\s*$/gm)];
  if (headings.length > 1) fail('duplicate Questions section');
  const body = `## Questions\n${writeQuestions(rows)}\n\n`;
  let result;
  if (!headings.length) result = `${normalized.replace(/\n*$/, '\n')}\n${body}`;
  else {
    const start = headings[0].index;
    const after = normalized.slice(start + headings[0][0].length);
    const next = /^## /m.exec(after);
    result = normalized.slice(0, start) + body + (next ? after.slice(next.index) : '');
  }
  return eol === '\r\n' ? result.replace(/\n/g, '\r\n') : result;
}

export function questionsFromItem(markdown) {
  if (typeof markdown !== 'string') fail('invalid item file');
  const normalized = markdown.replace(/\r\n/g, '\n');
  const headings = [...normalized.matchAll(/^## Questions\s*$/gm)];
  if (headings.length > 1) fail('duplicate Questions section');
  if (!headings.length) return [];
  const after = normalized.slice(headings[0].index + headings[0][0].length);
  const next = /^## /m.exec(after);
  return readQuestions(next ? after.slice(0, next.index) : after);
}
