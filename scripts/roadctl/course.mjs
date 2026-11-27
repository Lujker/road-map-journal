// Model-free course proposals. A single atomic board file is the commit point.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMandate, TELL_OWNER_FLOOR } from './mandate.mjs';
import { acquireLock, stateDir } from './state.mjs';

const FILE = 'course.json';
const hash = (x) => `sha256-v1:${crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex')}`;
const hashRe = /^sha256-v1:[a-f0-9]{64}$/;
const status = (board, c) => board.config.status_map?.[c.header.status] ?? c.header.status;
const text = (s) => typeof s === 'string' && s.trim() === s && s.length > 0 && s.length <= 500 && !/[\x00-\x1f\x7f]/.test(s);
const fields = ['plan_mandate', 'plan_course', 'plan_generation'];
export function basisProblems(header) {
  const problems = [];
  if (fields.some((k) => k in header) && !(hashRe.test(header.plan_mandate ?? '') && hashRe.test(header.plan_course ?? '') && /^[1-9]\d*$/.test(header.plan_generation ?? '') && Number.isSafeInteger(Number(header.plan_generation)))) problems.push('plan basis needs mandate and course hashes and a positive generation');
  if (header.work_course !== undefined && !hashRe.test(header.work_course)) problems.push('work_course needs a basis hash');
  return problems;
}
const validCurrent = (c) => c && typeof c === 'object' && hashRe.test(c.mandate) && hashRe.test(c.revision) && Number.isSafeInteger(c.generation) && c.generation > 0 && text(c.author) && text(c.source) && typeof c.at === 'string' && Number.isFinite(Date.parse(c.at)) && text(c.objective) && Array.isArray(c.added) && c.added.length <= 100 && c.added.every(text) && Array.isArray(c.deferred) && c.deferred.length <= 100 && c.deferred.every(text) && new Set(c.deferred).size === c.deferred.length && c.revision === hash({ objective: c.objective, added: c.added, deferred: c.deferred });

export function readCourse(board) {
  let raw;
  try { raw = fs.readFileSync(path.join(board.dir, FILE), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('course file is malformed'); }
  if (!value || value.version !== 1 || (value.current !== null && !validCurrent(value.current)) || (value.previous !== null && !validCurrent(value.previous)) || !Array.isArray(value.history) || !value.history.length || !value.history.every((c, i, all) => validCurrent(c) && (!i || c.generation > all[i - 1].generation)) || value.last_generation !== value.history.at(-1).generation || (value.current && JSON.stringify(value.current) !== JSON.stringify(value.history.at(-1))) || (value.previous && !value.history.some((c) => JSON.stringify(c) === JSON.stringify(value.previous))) || typeof value.ambiguous !== 'boolean') throw new Error('course file is malformed');
  return value;
}

export function courseState(board, api) {
  if ((api.compareVersions(board.config.requires, '0.17.0') ?? -1) < 0) return null;
  const c = readCourse(board);
  if (!c) {
    if ((api.compareVersions(board.config.requires, '0.17.0') ?? -1) >= 0) throw new Error('course is missing; confirm a course before starting');
    return null;
  }
  if (!c.current) throw new Error('course is not active; confirm a course before starting');
  const m = readMandate(board, api);
  if (!m || m.state !== 'approved' || m.problems.length || m.hash !== c.current.mandate) throw new Error('course mandate is missing, changed or not approved; reassess the course');
  return c;
}

export function courseReason(board, card, api) {
  try {
    const c = courseState(board, api)?.current;
    if (!c) return null;
    if (c.deferred.includes(card.header.id)) return 'deferred by the current course';
    if (card.header.plan_mandate !== c.mandate || card.header.plan_course !== c.revision || card.header.plan_generation !== String(c.generation)) return 'plan basis is stale or missing; reassess this future work';
    return null;
  } catch (e) { return e.message; }
}

export function activeCourseStale(board, card, api) {
  if (status(board, card) !== 'doing') return false;
  try {
    const c = courseState(board, api)?.current;
    return Boolean(c && (card.header.work_course ? card.header.work_course !== hash(c) : courseReason(board, card, api) !== null));
  } catch { return true; }
}
export function currentCourseRevision(board, api) { const c = courseState(board, api)?.current; return c ? hash(c) : null; }
export function basisLines(board, api) {
  const c = courseState(board, api)?.current;
  return c ? `plan_mandate: ${c.mandate}\nplan_course: ${c.revision}\nplan_generation: ${c.generation}\n` : '';
}

function proposal(input, board) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'added,course,deferred,objective' || input.course !== 1 || !text(input.objective) || !Array.isArray(input.added) || input.added.length > 100 || !input.added.every(text) || !Array.isArray(input.deferred) || input.deferred.length > 100 || !input.deferred.every(text) || new Set(input.deferred).size !== input.deferred.length) throw new Error('proposal needs course: 1, objective, added and deferred lists');
  for (const id of input.deferred) {
    const matches = board.cards.filter((c) => c.header.id === id);
    if (matches.length !== 1 || !['idea', 'ready', 'parked'].includes(status(board, matches[0])) || matches[0].header.claim) throw new Error(`cannot defer ${id}: only unstarted future cards may be deferred`);
  }
  return { objective: input.objective, added: input.added, deferred: input.deferred };
}
function snapshot(board, input, api) {
  const p = proposal(input, board);
  const previous = readCourse(board);
  const mandate = readMandate(board, api);
  if (!mandate || mandate.state !== 'approved' || mandate.problems.length) throw new Error('an approved, valid mandate is required');
  if ((previous?.last_generation ?? 0) >= Number.MAX_SAFE_INTEGER) throw new Error('plan generation is exhausted');
  const current = { ...p, mandate: mandate.hash, revision: hash(p), generation: (previous?.last_generation ?? 0) + 1 };
  const agreement = { level: mandate.level, kinds: mandate.kinds, max_size: mandate.max_size, merge: mandate.merge, budget: mandate.budget, forbidden: mandate.forbidden, tell_owner: [...TELL_OWNER_FLOOR, ...mandate.tell_extra] };
  const preserved = board.cards.filter((c) => ['idea', 'ready', 'parked'].includes(status(board, c)) && !p.deferred.includes(c.header.id)).map((c) => c.header.id);
  const files = board.cards.map((c) => [c.name, fs.readFileSync(c.file, 'utf8')]);
  const md = path.join(board.dir, 'milestones');
  const milestones = fs.existsSync(md) ? fs.readdirSync(md).filter((f) => f.endsWith('.md')).sort().map((f) => [f, fs.readFileSync(path.join(md, f), 'utf8')]) : [];
  const activeMilestones = milestones.filter(([f]) => api.parseCard(path.join(md, f)).header.milestone_done !== 'true').map(([f]) => `milestone:${f.slice(0, -3)}`);
  const impact = { added: p.added, preserved: [...preserved, ...activeMilestones], deferred: p.deferred, reassess: board.cards.filter((c) => status(board, c) === 'doing').map((c) => c.header.id).concat(preserved, activeMilestones) };
  const token = hash({ current, previous, config: board.config, files, milestones });
  return { current, previous, agreement, impact, token };
}
function save(board, data) {
  const file = path.join(board.dir, FILE), tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
function command(ctx) {
  const { args, flags, api, env, out } = ctx;
  const dir = api.findBoard(process.cwd(), typeof flags.board === 'string' ? flags.board : undefined, env);
  if (!dir) throw new Error('no board found');
  const sub = args[1];
  if (!['preview', 'confirm', 'undo', 'effect', 'show'].includes(sub)) throw new Error('usage: roadctl course preview FILE | confirm FILE --hash HASH --by OWNER | show | undo --hash HASH --by OWNER | effect --hash HASH --by OWNER');
  const run = () => {
    const board = api.loadBoard(dir);
    if ((api.compareVersions(board.config.requires, '0.17.0') ?? -1) < 0 || api.boardRequires(board.config)) throw new Error('board must require supported roadctl 0.17.0 or newer');
    if (sub === 'show') { const c = readCourse(board); out(JSON.stringify(c, null, 2)); return 0; }
    if (['preview', 'confirm'].includes(sub)) {
      if (args.length !== 3) throw new Error('proposal file required');
      const file = path.resolve(args[2]);
      if (fs.statSync(file).size > 1048576) throw new Error('proposal too large');
      const s = snapshot(board, JSON.parse(fs.readFileSync(file, 'utf8')), api);
      if (sub === 'preview') {
        const rollback = s.previous?.ambiguous ? 'Automatic rollback is impossible after a recorded ambiguous external effect.' : 'Undo is available until an ambiguous external effect is recorded.';
        if (flags.json) out(JSON.stringify({ proposal: s.current, agreement: s.agreement, impact: s.impact, confirmation_hash: s.token, rollback, permission: 'The existing mandate remains the authority; this proposal grants no permission.' }, null, 2));
        else {
          out(`Course: ${s.current.objective}`);
          out(`Existing agreement: ${s.agreement.level}; work ${s.agreement.kinds.join(', ') || '(none)'}, size ${s.agreement.max_size ?? '-'}, merge ${s.agreement.merge}; budget ${Object.entries(s.agreement.budget).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
          out(`Forbidden: ${s.agreement.forbidden.join('; ') || '(none listed)'}`);
          out(`Tell the owner: ${s.agreement.tell_owner.join('; ')}`);
          for (const [label, items] of Object.entries(s.impact)) out(`${label}: ${items.length ? items.join(', ') : '(none)'}`);
          out(rollback);
          out(`The existing mandate remains the authority; this grants no permission. Confirmation hash: ${s.token}`);
        }
        return 0;
      }
      if (!text(flags.by) || flags.hash !== s.token) throw new Error('confirmation needs --by and the current preview hash');
      if (flags.source !== undefined && !text(flags.source)) throw new Error('source must be a nonempty single line');
      if (ctx.audit) ctx.audit.hash = s.token;
      const current = { ...s.current, author: flags.by, at: new Date(api.nowMs(env)).toISOString(), source: flags.source ?? 'unspecified' };
      save(board, { version: 1, current, previous: s.previous?.current ?? null, history: [...(s.previous?.history ?? []), current], last_generation: current.generation, ambiguous: s.previous?.ambiguous ?? false, by: flags.by });
      out('course confirmed; future work requires the new basis, active work needs a checkpoint; save the board'); return 0;
    }
    if (args.length !== 2 || !text(flags.by)) throw new Error('owner name required');
    const c = readCourse(board);
    if (!c || flags.hash !== hash(c)) throw new Error('course changed; run course show for its current hash');
    if (ctx.audit) ctx.audit.hash = flags.hash;
    if (!c.current) throw new Error('no active course');
    if (sub === 'effect') { c.ambiguous = true; save(board, c); out('external effect may have happened; automatic rollback is unavailable'); return 0; }
    if (c.ambiguous) throw new Error('automatic rollback is impossible after an ambiguous external effect');
    if (!c.previous) { save(board, { version: 1, current: null, previous: null, history: c.history, last_generation: c.last_generation, ambiguous: false, by: flags.by }); out('initial course undone; starts remain paused until a course is confirmed'); return 0; }
    const m = readMandate(board, api);
    if (!m || m.state !== 'approved' || m.problems.length || m.hash !== c.previous.mandate) throw new Error('previous course mandate is not currently approved');
    if (c.last_generation >= Number.MAX_SAFE_INTEGER) throw new Error('plan generation is exhausted');
    const generation = c.last_generation + 1;
    const restored = { ...c.previous, generation, author: flags.by, at: new Date(api.nowMs(env)).toISOString(), source: 'undo' };
    save(board, { version: 1, current: restored, previous: c.current, history: [...c.history, restored], last_generation: generation, ambiguous: false, by: flags.by });
    out('previous course restored as a new generation; future work needs reassessment'); return 0;
  };
  if (['preview', 'show'].includes(sub)) {
    if (sub === 'show') { const board = api.loadBoard(dir), c = readCourse(board); out(JSON.stringify({ course: c, hash: c ? hash(c) : null }, null, 2)); return 0; }
    return run();
  }
  const result = api.withRepoLock(api.loadBoard(dir), () => {
    const name = crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex');
    const lock = acquireLock(path.join(stateDir(env), 'course-locks', `${name}.lock`), { staleMs: 600000, strict: true, content: JSON.stringify({ pid: process.pid, host: os.hostname() }), isStale: api.repoLockDead });
    if (!lock.ok) throw new Error(`course operation is locked (${lock.reason})`);
    try { return run(); } finally { lock.release(); }
  });
  if (result && typeof result === 'object' && result.status === 'busy') throw new Error(result.message);
  return result;
}

export default {
  name: 'course', headerKeys: ['plan_mandate', 'plan_course', 'plan_generation', 'work_course'],
  hooks: {
    'start-admit'({ board, card, api }) { const reason = courseReason(board, card, api); return reason ? { admit: false, reason } : {}; },
    'board-lint'({ board, api }) {
      const findings = [];
      try { courseState(board, api); } catch (e) { findings.push({ level: /course (is missing|is not active)/.test(e.message) ? 'warning' : 'error', file: FILE, text: e.message }); }
      const md = path.join(board.dir, 'milestones');
      const milestones = fs.existsSync(md) ? fs.readdirSync(md).filter((f) => f.endsWith('.md')).map((f) => api.parseCard(path.join(md, f))) : [];
      for (const item of [...board.cards, ...milestones]) for (const problem of basisProblems(item.header)) findings.push({ level: 'error', file: item.name, text: problem });
      return { findings };
    },
  },
  commands: { course: { group: 'Owner only', effect: 'write', owner: { sub: ['confirm', 'undo', 'effect'] }, hidden: true,
    summary: 'preview and confirm a project course', purpose: 'Preview a typed proposal without writing; confirm the exact preview as the owner. The mandate remains the authority. Mark a possible external effect before it happens; automatic rollback then refuses.',
    usage: ['roadctl course preview FILE', 'roadctl course confirm FILE --hash HASH --by OWNER', 'roadctl course show', 'roadctl course undo --hash HASH --by OWNER', 'roadctl course effect --hash HASH --by OWNER'],
    flags: [['--hash HASH', 'hash from preview or show'], ['--by OWNER', 'owner name'], ['--source TEXT', 'confirmation source, if known']], examples: ['roadctl course preview proposal.json'], changes: 'Confirm, undo and effect write course.json; preview and show do not write.', exits: '0 success; 1 refused; 2 invalid input', run: command } },
};
