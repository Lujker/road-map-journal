// The summary of a run (P5.13): the fields an agent fills in (`--did`, `--decision`, `--problem`, `--ask`, `--not-checked`), their limits,
// the one-line form that goes into the Log of a routine or a card (the only copy another machine can read: git), and the short plain text
// that is shown to the owner. Pure functions: no file, no clock, no roadctl.mjs import (run-ledger.mjs and digest.mjs use it).
//
// The Log form is `did: a; b | decision: c | problem: transient: key: text; unknown: key2: text | ask: question | not-checked: what`
// (fields in this order, left out when empty, the run trailer ` [run=... host=...]` of run-ledger.mjs after it). Values never contain
// `|` or `;` (they are replaced when the field is collected), so the line parses back into the same fields.
import crypto from 'node:crypto';
import { cleanText, PROBLEM_KINDS } from './run-store.mjs';

/** Limits of the summary fields: items, characters per item. Over a limit the text is cut (with a `…`) and extra items are dropped; the agent is told on stderr, the run is still recorded. */
export const LIMITS = Object.freeze({ did: [3, 120], decision: [3, 160], problem: [3, 160], ask: [1, 200], notChecked: [1, 160] });
export const SUMMARY_FLAGS = ['did', 'decision', 'problem', 'ask', 'not-checked'];
export const LOG_MAX = 1500; // the longest Log line (sanitizeText of roadctl.mjs), trailer included
const KEY_RE = /^[A-Za-z0-9._-]{1,40}$/;
const PROBLEM_RE = new RegExp(`^(${PROBLEM_KINDS.join('|')}): ([A-Za-z0-9._-]{1,40}): (.+)$`, 's');

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** One value: control characters, backticks and angle brackets gone (like every text roadctl writes), `|` and `;` replaced (they are the separators of the Log form), cut. */
const clean = (s, n) => cut(cleanText(s, 100000).replace(/\|/g, '/').replace(/;/g, ','), n);
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter((x) => typeof x === 'string' && x.trim());

export const hasSummaryFlags = (flags) => SUMMARY_FLAGS.some((k) => flags?.[k] !== undefined);

/** `kind: key: text` (what the agent types) to { kind, key, text }; a missing kind is `unknown`, a missing key is derived from the text (and warned about: the same problem cannot be recognised next time). */
export function parseProblemArg(raw, warn = () => {}) {
  const s = cleanText(raw, 100000);
  const m = PROBLEM_RE.exec(s);
  if (m) return { kind: m[1], key: m[2], text: clean(m[3], LIMITS.problem[1]) };
  const k = new RegExp(`^(${PROBLEM_KINDS.join('|')}): (.+)$`, 's').exec(s);
  const text = k ? k[2] : s;
  const key = `p-${crypto.createHash('sha1').update(text.toLowerCase()).digest('hex').slice(0, 8)}`;
  warn(`--problem ${JSON.stringify(cut(s, 60))} is not "transient|permanent|unknown: key: text"; recorded as ${k ? k[1] : 'unknown'} with the key ${key} (a fixed key lets the owner see the same problem only once)`);
  return { kind: k ? k[1] : 'unknown', key, text: clean(text, LIMITS.problem[1]) };
}

/**
 * The summary fields of a command line. flags: the parsed flags (did, decision, problem: arrays or strings; ask, not-checked: strings), text: the
 * positional text of the old form. strict: the board asks for `--did` (config.json `"summary": "required"`); then the text alone is not enough.
 * Returns { structured, fields, error, warnings }: `structured` is false for the old form (no summary flag, not strict): the caller leaves everything as it was.
 */
export function collectFields(flags, text, { strict = false } = {}) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const structured = strict || hasSummaryFlags(flags);
  if (!structured) return { structured: false, fields: null, error: null, warnings };
  let did = list(flags.did);
  if (!did.length && !strict && String(text ?? '').trim()) did = [String(text)];
  if (!did.length) return { structured: true, fields: null, error: 'a run summary needs --did "what was done" (1 to 3 times, up to 120 characters each)', warnings };
  const items = (v, [max, len], name) => {
    const all = list(v);
    if (all.length > max) warn(`more than ${max} --${name}: the first ${max} are kept`);
    const out = all.slice(0, max).map((x) => {
      const t = clean(x, 100000);
      if (t.length > len) warn(`--${name} "${cut(t, 24)}" is longer than ${len} characters: cut`);
      return cut(t, len);
    });
    return out;
  };
  const one = (v, [, len], name) => {
    const all = list(v);
    if (!all.length) return null;
    if (all.length > 1) warn(`more than one --${name}: the first is kept`);
    const t = clean(all[0], 100000);
    if (t.length > len) warn(`--${name} is longer than ${len} characters: cut`);
    return cut(t, len);
  };
  const problems = list(flags.problem).slice(0, LIMITS.problem[0] + 5).map((p) => parseProblemArg(p, warn));
  if (list(flags.problem).length > LIMITS.problem[0]) warn(`more than ${LIMITS.problem[0]} --problem: the first ${LIMITS.problem[0]} are kept`);
  const seen = new Set();
  const fields = {
    did: items(did, LIMITS.did, 'did'),
    decisions: items(flags.decision, LIMITS.decision, 'decision'),
    problems: problems.slice(0, LIMITS.problem[0]).filter((p) => !seen.has(p.key) && seen.add(p.key)),
    needs_owner: one(flags.ask, LIMITS.ask, 'ask'),
    not_checked: one(flags['not-checked'], LIMITS.notChecked, 'not-checked'),
  };
  return { structured: true, fields, error: null, warnings };
}

// ---------------------------------------------------------------- the Log form

const problemText = (p) => `${p.kind}: ${p.key}: ${p.text}`;

/** The Log text of the fields, at most `max` characters: when it is too long the longest texts are shortened (decisions first, did last) until it fits. */
export function formatLogText(fields, max = LOG_MAX) {
  const f = structuredClone(fields);
  const render = () => [
    f.did.length ? `did: ${f.did.join('; ')}` : '',
    f.decisions.length ? `decision: ${f.decisions.join('; ')}` : '',
    f.problems.length ? `problem: ${f.problems.map(problemText).join('; ')}` : '',
    f.needs_owner ? `ask: ${f.needs_owner}` : '',
    f.not_checked ? `not-checked: ${f.not_checked}` : '',
  ].filter(Boolean).join(' | ');
  // every shortenable text: [get, set], in the order of what may be shortened first
  const slots = () => [
    ...f.decisions.map((x, i) => [() => x, (v) => { f.decisions[i] = v; }]),
    ...(f.not_checked ? [[() => f.not_checked, (v) => { f.not_checked = v; }]] : []),
    ...(f.needs_owner ? [[() => f.needs_owner, (v) => { f.needs_owner = v; }]] : []),
    ...f.problems.map((p, i) => [() => p.text, (v) => { f.problems[i] = { ...p, text: v }; }]),
    ...f.did.map((x, i) => [() => x, (v) => { f.did[i] = v; }]),
  ];
  let line = render();
  for (let i = 0; i < 400 && line.length > max; i++) {
    const room = slots().find(([get]) => get().length > 24);
    if (!room) return cut(line, max);
    const [get, set] = room;
    set(cut(get(), Math.max(24, get().length - Math.max(10, line.length - max))));
    line = render();
  }
  return line;
}

/** The inverse of formatLogText: { structured, fields }. A text that does not start with a known label is the old free form: it becomes the one `did` item. */
export function parseLogText(text) {
  const t = String(text ?? '').trim();
  const empty = { did: [], decisions: [], problems: [], needs_owner: null, not_checked: null };
  if (!/^(did|decision|problem|ask|not-checked): /.test(t)) return { structured: false, fields: { ...empty, did: t ? [cut(t, 400)] : [] } };
  const fields = { ...empty };
  for (const part of t.split(' | ')) {
    const m = /^(did|decision|problem|ask|not-checked): (.*)$/s.exec(part);
    if (!m) continue;
    const [, label, body] = m;
    if (label === 'did') fields.did = body.split('; ').filter(Boolean);
    else if (label === 'decision') fields.decisions = body.split('; ').filter(Boolean);
    else if (label === 'problem') fields.problems = body.split('; ').flatMap((x) => { const p = PROBLEM_RE.exec(x); return p ? [{ kind: p[1], key: p[2], text: p[3] }] : []; });
    else if (label === 'ask') fields.needs_owner = body;
    else fields.not_checked = body;
  }
  return { structured: true, fields };
}

// ---------------------------------------------------------------- what the owner reads

const WORDS = {
  en: { did: 'did', decisions: 'decided', problem: 'problem', ask: 'needs from you', notChecked: 'not checked', unpublished: 'not published: waits for roadctl save', resolved: 'resolved', task: 'task', routine: 'routine', orchestrator: 'orchestrator', crashed: 'CRASHED', timeout: 'TIMEOUT', aborted: 'ABORTED', failed: 'FAILED', escalated: 'ESCALATED', ok: 'ok', skipped: 'skipped', min: 'm', sec: 's' },
  ru: { did: 'сделано', decisions: 'решено', problem: 'проблема', ask: 'нужно от вас', notChecked: 'не проверено', unpublished: 'не опубликовано: ждёт roadctl save', resolved: 'снято', task: 'поручение', routine: 'рутина', orchestrator: 'оркестратор', crashed: 'ОБОРВАН', timeout: 'ТАЙМАУТ', aborted: 'ПРЕРВАН', failed: 'СБОЙ', escalated: 'ЭСКАЛАЦИЯ', ok: 'ок', skipped: 'пропуск', min: 'м', sec: 'с' },
};
/** The words of a board's language (`language` of config.json; `ru` or English, anything else is English). Headings follow the board, the text of the agent is shown as written. */
export const wordsFor = (language) => (String(language ?? '').toLowerCase().startsWith('ru') ? WORDS.ru : WORDS.en);

const durText = (s, w) => (!Number.isFinite(s) ? '' : s >= 90 ? `${Math.round(s / 60)}${w.min}` : `${s}${w.sec}`);

/**
 * The text for the owner: at most six lines, plain text (no markdown, no raw output). ev: { kind, project, id, outcome, agent, duration_s, fields,
 * unpublished, hide: Set of problem keys not to show (already told) }. Lines: header, did, decisions, problems, ask, not checked.
 */
export function renderSummary(ev, language) {
  const w = wordsFor(language);
  const f = ev.fields ?? { did: [], decisions: [], problems: [], needs_owner: null, not_checked: null };
  const where = ev.project ? `${ev.project}/${ev.id}` : ev.id;
  const head = `${w[ev.kind] ?? ev.kind} ${where}: ${w[ev.outcome] ?? String(ev.outcome).toUpperCase()}${ev.agent || ev.duration_s != null ? ` (${[ev.agent, durText(ev.duration_s, w)].filter(Boolean).join(', ')})` : ''}`;
  const lines = [head];
  if (f.did.length) lines.push(`${w.did}: ${f.did.join('; ')}`);
  if (f.decisions.length) lines.push(`${w.decisions}: ${f.decisions.join('; ')}`);
  const problems = f.problems.filter((p) => !ev.hide?.has(p.key));
  if (problems.length) lines.push(`${w.problem}: ${problems.map((p) => `${p.kind} ${p.key}: ${p.text}`).join('; ')}`);
  if (f.needs_owner) lines.push(`${w.ask}: ${f.needs_owner}`);
  if (f.not_checked) lines.push(`${w.notChecked}: ${f.not_checked}`);
  if (ev.unpublished) lines[lines.length - 1] += ` [${w.unpublished}]`;
  return lines.slice(0, 6);
}
