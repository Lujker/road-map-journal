import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { changeHeader, log, ownerItems } from './owner-questions.mjs';
import { RULE_REQUIRES, ruleDependencySatisfied } from './rule-acceptance.mjs';
import { acquireLock, milestoneTransactionFile } from './state.mjs';

function applyTransaction(board, journalFile, transaction, id, hash, action) {
  if (transaction?.action !== action || transaction.id !== id || transaction.hash !== hash || !Array.isArray(transaction.entries) || !transaction.entries.length) throw new Error('pending milestone operation requires its original id and hash');
  const files = new Map(board.cards.map((c) => [c.header.id, c.file]));
  files.set('@milestone', path.join(board.dir, 'milestones', `${id}.md`));
  const seen = new Set();
  const entries = transaction.entries.map((entry) => {
    if (!entry || !files.has(entry.id) || seen.has(entry.id) || typeof entry.before !== 'string' || typeof entry.after !== 'string') throw new Error('invalid milestone transaction');
    seen.add(entry.id);
    const file = files.get(entry.id), current = fs.readFileSync(file, 'utf8');
    if (current !== entry.before && current !== entry.after) throw new Error(`milestone recovery refused: ${entry.id} changed outside the operation`);
    return { ...entry, file, current };
  });
  if (!seen.has('@milestone')) throw new Error('invalid milestone transaction');
  for (const entry of entries) {
    if (entry.current === entry.after) continue;
    if (fs.readFileSync(entry.file, 'utf8') !== entry.before) throw new Error(`milestone recovery refused: ${entry.id} changed outside the operation`);
    const tmp = `${entry.file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, entry.after, { flag: 'wx', mode: fs.statSync(entry.file).mode });
      fs.renameSync(tmp, entry.file);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  fs.unlinkSync(journalFile);
}

function command(ctx) {
  const dir = ctx.api.findBoard(process.cwd(), typeof ctx.flags.board === 'string' ? ctx.flags.board : undefined, ctx.env);
  if (!dir) throw new Error('no board found');
  const board = ctx.api.loadBoard(dir);
  if ((ctx.api.compareVersions(board.config.requires, RULE_REQUIRES) ?? -1) < 0 || ctx.api.boardRequires(board.config)) throw new Error(`board must require supported roadctl ${RULE_REQUIRES} or newer`);
  const journal = milestoneTransactionFile(board, ctx.env);
  const result = ctx.api.withRepoLock(board, () => {
    const lock = acquireLock(`${journal}.lock`, { staleMs: 600000, strict: true, content: JSON.stringify({ pid: process.pid, host: os.hostname() }), isStale: ctx.api.repoLockDead });
    if (!lock.ok) throw new Error(`milestone operation is locked (${lock.reason})`);
    try { return runCommand({ ...ctx, board: ctx.api.loadBoard(dir), journal }); } finally { lock.release(); }
  });
  if (result && typeof result === 'object' && result.status === 'busy') throw new Error(result.message);
  return result;
}

function runCommand({ args, flags, api, env, out, board, journal }) {
  const [sub, id] = args.slice(1);
  if (args.length !== 3 || !['add', 'continue', 'move', 'done', 'return'].includes(sub) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id ?? '') || (sub !== 'add' && (typeof flags.by !== 'string' || !/^[A-Za-z0-9@._:-]{1,100}$/.test(flags.by)))) throw new Error('usage: roadctl milestone continue ID --by OWNER | milestone move ID --to YYYY-MM-DD | --cards A,B --by OWNER');
  if (fs.existsSync(journal)) {
    if (!['done', 'return'].includes(sub)) throw new Error('finish the pending milestone operation first');
    applyTransaction(board, journal, JSON.parse(fs.readFileSync(journal, 'utf8')), id, flags.hash, sub);
    out(`milestone ${id}: ${sub} (recovered)`);
    return 0;
  }
  const file = path.join(board.dir, 'milestones', `${id}.md`);
  if (sub === 'add') {
    if (typeof flags.cards !== 'string' || typeof flags.why !== 'string' || !flags.why.trim() || /[\r\n\x00-\x1f]/.test(flags.why) || flags.why.length > 500) throw new Error('add needs --cards A,B and --why TEXT');
    const ids = flags.cards.split(',').map((x) => x.trim());
    if (ids.some((x) => !x || !board.cards.some((c) => c.header.id === x)) || new Set(ids).size !== ids.length) throw new Error('cards must name distinct existing cards');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nid: ${id}\ncards: ${ids.join(', ')}\n---\n\n## Goal\n${flags.why.trim()}\n`, { flag: 'wx' });
    out(`milestone ${id}: added`);
    return 0;
  }
  if (!fs.existsSync(file)) throw new Error('unknown milestone');
  const m = api.parseCard(file);
  if (m.errors.length) throw new Error('invalid milestone');
  if (m.header.milestone_done === 'true') throw new Error('milestone is already accepted');
  const ready = api.readyMilestones(board).some((x) => x.id === id);
  const waiting = api.readyMilestones(board, { waiting: true }).some((x) => x.id === id);
  let raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  raw = raw.replace(/\r\n/g, '\n');
  const set = (key, value) => { raw = changeHeader(raw, key, value); };
  let message;
  if (sub === 'done' || sub === 'return') {
    const item = ownerItems(board, Number.MAX_SAFE_INTEGER, api).find((x) => x.type === 'milestone' && x.target === id && Array.isArray(x.cards));
    if (!item || !ready) throw new Error('milestone is not ready');
    if (typeof flags.hash !== 'string' || flags.hash !== item.hash) throw new Error('milestone hash does not match the current inbox item');
    const selected = sub === 'return' && typeof flags.cards === 'string' ? flags.cards.split(',').map((x) => x.trim()) : item.cards;
    if (sub === 'return' && typeof flags.cards !== 'string') throw new Error('return needs --cards A,B');
    if (sub === 'return' && (typeof flags.reason !== 'string' || !flags.reason.trim() || flags.reason.length > 400 || /[\r\n\x00-\x1f]/.test(flags.reason))) throw new Error('return needs --reason TEXT');
    const cards = selected.map((cardId) => board.cards.find((c) => c.header.id === cardId));
    if (!selected.length || selected.some((id) => !item.cards.includes(id)) || new Set(selected).size !== cards.length || cards.some((c) => !c || c.errors.length)) throw new Error('invalid milestone cards');
    const now = new Date(api.nowMs(env)).toISOString().slice(0, 10);
    const changes = [];
    for (const c of cards) {
      const st = board.config.status_map?.[c.header.status] ?? c.header.status;
      if (st === 'done' && sub === 'done') continue;
      if (!['review', ...(sub === 'return' ? ['done'] : [])].includes(st) || c.header.accepted !== 'rule' || (sub === 'done' && (!ruleDependencySatisfied(board, c, api) || api.criteriaProblems(c).length))) throw new Error(`card ${c.header.id} is not currently accepted by rule`);
      const old = fs.readFileSync(c.file, 'utf8');
      const crlf = old.includes('\r\n');
      let updated = old.replace(/\r\n/g, '\n');
      updated = changeHeader(updated, 'status', sub === 'done' ? 'done' : 'doing');
      updated = changeHeader(updated, 'accepted', sub === 'done' ? `${flags.by}, ${now}` : null);
      if (sub === 'return') {
        for (const key of ['rule_id', 'rule_deps', 'rule_content']) updated = changeHeader(updated, key, null);
        updated = log(updated, now, flags.by, `RETURNED from milestone ${id}: ${flags.reason.trim()}`);
      }
      updated = changeHeader(updated, 'as_of', now);
      changes.push({ id: c.header.id, before: old, after: crlf ? updated.replace(/\n/g, '\r\n') : updated });
    }
    if (sub === 'done') set('milestone_done', 'true');
    set('milestone_waiting', null); set('milestone_continued', null);
    raw = log(raw, now, flags.by, sub === 'done' ? `MILESTONE DONE hash ${item.hash}` : `MILESTONE RETURN cards ${selected.join(', ')}: ${flags.reason.trim()}`);
    changes.push({ id: '@milestone', before: fs.readFileSync(file, 'utf8'), after: eol === '\r\n' ? raw.replace(/\n/g, eol) : raw });
    const tmp = `${journal}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ action: sub, id, hash: item.hash, entries: changes }), { flag: 'wx', mode: 0o600 });
      fs.linkSync(tmp, journal);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    applyTransaction(board, journal, { action: sub, id, hash: item.hash, entries: changes }, id, item.hash, sub);
    out(`milestone ${id}: ${sub === 'done' ? 'accepted' : 'returned'}`);
    return 0;
  }
  if (sub === 'continue') {
    if (flags.to !== undefined || flags.cards !== undefined) throw new Error('continue does not take --to or --cards');
    if (m.header.milestone_continued === 'true') { out(`milestone ${id}: already continued`); return 0; }
    if (!waiting) throw new Error('milestone is not awaiting a decision');
    set('milestone_continued', 'true'); set('milestone_waiting', null);
    message = 'MILESTONE CONTINUE';
  } else {
    if ((typeof flags.to === 'string') === (typeof flags.cards === 'string')) throw new Error('move needs exactly one of --to or --cards');
    if (typeof flags.to === 'string') {
      const date = flags.to;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('invalid date');
      if (m.header.date === date) { out(`milestone ${id}: unchanged`); return 0; }
      set('date', date); message = `MILESTONE MOVE date ${date}`;
    } else {
      const ids = flags.cards.split(',').map((x) => x.trim());
      if (!ids.length || ids.some((x) => !x || !board.cards.some((c) => c.header.id === x)) || new Set(ids).size !== ids.length) throw new Error('cards must name distinct existing cards');
      const cards = ids.join(', ');
      if ((m.header.cards ?? '').split(',').map((x) => x.trim()).join(', ') === cards) { out(`milestone ${id}: unchanged`); return 0; }
      if (waiting || (ready && m.header.milestone_continued !== 'true')) set('milestone_waiting', 'true');
      set('milestone_continued', null); set('cards', cards); message = `MILESTONE MOVE cards ${cards}`;
    }
  }
  raw = log(raw, new Date(api.nowMs(env)).toISOString().slice(0, 10), flags.by, message);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, eol === '\r\n' ? raw.replace(/\n/g, eol) : raw, { flag: 'wx', mode: fs.statSync(file).mode });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  out(`milestone ${id}: ${message.toLowerCase()}`);
  return 0;
}

export default {
  name: 'milestone',
  commands: {
    milestone: {
      group: 'Owner only', effect: 'write', owner: { sub: ['continue', 'move', 'done', 'return'] }, hidden: true,
      summary: 'add, continue, move or accept a milestone',
      purpose: 'Owner decisions on an existing milestone. Continue records consideration without accepting cards. Moving a date or cards does not waive a pending decision.',
      usage: ['roadctl milestone add ID --cards A,B --why TEXT', 'roadctl milestone continue ID --by OWNER', 'roadctl milestone done ID --hash HASH --by OWNER', 'roadctl milestone return ID --cards A,B --reason TEXT --hash HASH --by OWNER', 'roadctl milestone move ID (--to YYYY-MM-DD | --cards A,B) --by OWNER'],
      flags: [['--hash HASH', 'current inbox hash for done or return'], ['--reason TEXT', 'reason for return'], ['--why TEXT', 'milestone purpose'], ['--by OWNER', 'owner name'], ['--to DATE', 'new date'], ['--cards IDS', 'new card list']],
      examples: ['roadctl milestone continue M-1 --by Owner'],
      changes: 'Writes the milestone and its Log and the owner audit.', exits: '0 ok; 1 refused; 2 invalid arguments.', run: command,
    },
  },
};
