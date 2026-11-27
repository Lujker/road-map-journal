// Project mandate and autonomy levels (P5.33). One file per board, `board/mandate.md`, that the owner approves as a whole by its content hash (the helper
// of P5.15: `approved_hash` is outside the hash, everything else, `## Goals` included, is in it). Inside its limits an agent takes `ready` cards without
// `approved`, `auto` and the queue; nothing is autonomous until the owner approved the mandate, and any edit takes the approval away.
//
//   ---
//   mandate: 1
//   level: L3                         L1 routines, L2 cards approved one by one (as before), L3 mandate in the agent's branch, L4 also merge to main
//   kinds: fix, docs, tests           fix feature docs tests refactor research
//   max_size: M                       S M L (the card's `size`)
//   merge: branch                     branch | main (main needs L4)
//   budget: cards_per_day=2, runs_per_week=10
//   plan_max_cards: 5                 optional (0.11.0, P5.34): the most cards one plan may propose; `roadctl plan check` reads it
//   approved: Owner, 2026-11-16       written by `roadctl mandate approve`, with approved_hash
//   ---
//   ## Goals        - G1 (priority 1): text      stable ids, explicit priority; a card's `goal` names one
//   ## Forbidden    what is never done (goes into the launch prompt; roadctl does not enforce it)
//   ## Tell the owner   extra reasons to write to the owner; the floor in TELL_OWNER_FLOOR is code and cannot be removed here
//
// What roadctl itself checks: the hook `approval-basis` answers "is this card admitted by the mandate": level, approved hash, board `requires`, the card's
// `kind`/`size`/`goal`, ready and dependencies done, no delegation, the four labelled lines (Environment, Checks, Allowed changes, Stop conditions) filled in
// its Plan or Delegation, and the budget (counted from the Log lines this module writes). `tick` offers START, `delegate` takes the card (writes `by_mandate`
// and a Log line), `lint` accepts a `doing` card whose `by_mandate` is the current approved hash. A word of the card never admits it: `by_mandate` is only
// believed when it equals the hash of the approved mandate now. The rest (Forbidden, the way of merging) is an agreement checked afterwards, not a sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { HASH_KEY, approvalHash } from './approval-hash.mjs';

export const MANDATE_REQUIRES = '0.8.0';
export const PLAN_REQUIRES = '0.11.0'; // plan_max_cards (P5.34)
export const MANDATE_FILE = 'mandate.md';
export const LEVELS = ['L1', 'L2', 'L3', 'L4'];
export const KINDS = ['fix', 'feature', 'docs', 'tests', 'refactor', 'research'];
export const SIZES = ['S', 'M', 'L'];
export const MERGES = ['branch', 'main'];
export const TELL_OWNER_FLOOR = ['an owner-only command was refused', 'an attempt at something forbidden', 'the same card failed twice in a row', 'a question about something irreversible'];
const KEYS = ['mandate', 'level', 'kinds', 'max_size', 'merge', 'budget', 'plan_max_cards', 'approved', HASH_KEY]; // any other key (the reserved `external` included) is a problem: unknown means closed
const LABELS = { Environment: ['Environment', 'Role'], Checks: ['Checks'], 'Allowed changes': ['Allowed changes', 'Effects'], 'Stop conditions': ['Stop conditions'] };
const TAKEN_RE = /^approved by mandate (sha256-v1:[0-9a-f]{64})$/;
const DAY = 864e5;
const clean = (s, n = 100) => String(s ?? '').replace(/[\u0000-\u001f\u007f`<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); // like roadctl's sanitize, but `_` stays: key names such as max_size are read in these lines

const statusOf = (board, card) => board.config.status_map?.[card.header.status ?? ''] ?? card.header.status ?? '';

/** The mandate of a board as data, or null when the board has no mandate file. Never throws on content. */
export function readMandate(board, api) {
  const file = path.join(board.dir, MANDATE_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const problems = [];
  const m = raw.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const header = Object.create(null);
  const sections = {};
  if (!m) problems.push('no header between --- lines');
  else {
    for (const line of m[1].split('\n')) {
      if (!line.trim()) continue;
      const kv = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
      if (!kv) problems.push(`bad header line: ${clean(line, 40)}`);
      else if (kv[1] in header) problems.push(`duplicate key ${kv[1]}`);
      else header[kv[1]] = kv[2].trim();
    }
    const parts = m[2].split(/^## (.+)$/m);
    for (let i = 1; i < parts.length; i += 2) sections[parts[i].trim()] = parts[i + 1] ?? '';
  }
  for (const k of Object.keys(header)) if (!KEYS.includes(k)) problems.push(k === 'external' ? 'external: opening external systems is reserved and refused until the end of the pilot' : `unknown key ${clean(k, 30)}`);
  if (header.mandate !== '1') problems.push('mandate: 1 is required (the format version)');
  const level = LEVELS.includes(header.level) ? header.level : null;
  if (!level) problems.push(`level must be one of ${LEVELS.join(', ')}`);
  const gated = level !== 'L1' && level !== 'L2'; // L3, L4 and an unreadable level (fail closed)
  const kinds = (header.kinds ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const k of kinds) if (!KINDS.includes(k)) problems.push(`kinds: unknown kind ${clean(k, 20)} (known: ${KINDS.join(', ')})`);
  if (gated && !kinds.length) problems.push('kinds is required at L3 and L4');
  if (header.max_size !== undefined && !SIZES.includes(header.max_size)) problems.push(`max_size must be one of ${SIZES.join(', ')}`);
  if (gated && header.max_size === undefined) problems.push('max_size is required at L3 and L4');
  if (header.merge !== undefined && !MERGES.includes(header.merge)) problems.push(`merge must be one of ${MERGES.join(', ')}`);
  if (header.merge === 'main' && level !== 'L4') problems.push('merge: main needs level L4');
  const budget = {};
  for (const part of (header.budget ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const b = part.match(/^(cards_per_day|runs_per_week)=(\d+)$/);
    if (!b || Number(b[2]) < 1) problems.push(`budget: ${clean(part, 30)} is not cards_per_day=N or runs_per_week=N (N at least 1)`);
    else budget[b[1]] = Number(b[2]);
  }
  if (gated && !(budget.cards_per_day && budget.runs_per_week)) problems.push('budget needs cards_per_day=N and runs_per_week=N at L3 and L4');
  if (header.plan_max_cards !== undefined && !/^[1-9]\d{0,3}$/.test(header.plan_max_cards)) problems.push('plan_max_cards must be a whole number of at least 1 (the card limit of one plan, P5.34)');
  const goals = [];
  for (const line of (sections.Goals ?? '').split('\n')) {
    if (!line.startsWith('- ')) continue;
    const g = line.match(/^- ([A-Za-z0-9._-]+) \(priority (\d+)\)\s*:?\s*(.*)$/);
    if (!g) problems.push(`Goals: not like "- G1 (priority 1): text": ${clean(line, 40)}`);
    else goals.push({ id: g[1], priority: Number(g[2]), text: g[3].trim() });
  }
  for (const [what, key] of [['id', 'id'], ['priority', 'priority']]) {
    const seen = new Set();
    for (const g of goals) if (seen.has(g[key])) problems.push(`Goals: the ${what} ${g[key]} is used twice (a goal must be unambiguous)`);
    else seen.add(g[key]);
  }
  const bullets = (name) => (sections[name] ?? '').split('\n').filter((l) => l.startsWith('- ')).map((l) => clean(l.slice(2), 200));
  const hash = approvalHash(raw);
  const stored = header[HASH_KEY];
  const state = !stored ? 'unapproved' : stored === hash ? 'approved' : 'changed';
  const raised = (api.compareVersions(board.config?.requires ?? '0', MANDATE_REQUIRES) ?? -1) >= 0; // an unreadable `requires` is null: the board is refused anyway
  if (!raised) problems.push(`the board must require roadctl ${MANDATE_REQUIRES} (config.json "requires"); until then the mandate takes nothing`);
  // always-on: an older copy on another machine reads plan_max_cards as malformed (alerts, lint errors that block save); requires makes it refuse the board cleanly instead
  if (header.plan_max_cards !== undefined && (api.compareVersions(board.config?.requires ?? '0', PLAN_REQUIRES) ?? -1) < 0) problems.push(`plan_max_cards needs the board to require roadctl ${PLAN_REQUIRES} (config.json "requires"), so older copies on other machines refuse the board instead of reading the mandate as malformed`);
  const approvedBy = (header.approved ?? '').split(',').map((x) => x.trim());
  return { file, header, level, gated, kinds, max_size: header.max_size ?? null, plan_max_cards: header.plan_max_cards === undefined ? null : Number(header.plan_max_cards), merge: header.merge ?? 'branch', budget, goals, forbidden: bullets('Forbidden'), tell_extra: bullets('Tell the owner'), hash, state, problems, approved: header.approved ? { by: approvedBy[0], date: approvedBy[1] ?? null } : null };
}

/** The mandate lets cards in at all: approved by the owner, unchanged, well formed, level L3 or L4. */
const live = (m) => m.state === 'approved' && !m.problems.length && (m.level === 'L3' || m.level === 'L4');

function filled(card, names) {
  const text = `${card.sections.Plan ?? ''}\n${card.sections.Delegation ?? ''}`;
  return names.some((n) => text.split('\n').some((l) => {
    const v = l.match(new RegExp(`^\\s*(?:[-*]\\s*)?${n}\\s*:\\s*(.+)$`, 'i'))?.[1].trim();
    return v && !/^\(.*\)$/.test(v) && !/^(tbd|todo|n\/a|none|\.\.\.|-|\?)$/i.test(v);
  }));
}

/** Cards taken by the mandate, from the Log lines `approved by mandate <hash>` of every card: [{ id, date }]. */
export const takes = (board) => board.cards.flatMap((c) => c.log.filter((l) => TAKEN_RE.test(l.text)).map((l) => ({ id: c.header.id, date: l.date })));

/** Is `card` admitted by mandate `m`? mode: 'start' (tick: ready), 'delegate' (ready or doing) or 'work' (lint: a card already taken). { ok, reasons, rank }. */
export function admission(board, card, m, mode, api) {
  const reasons = [];
  if (m.state !== 'approved') reasons.push(m.state === 'changed' ? 'the mandate changed after approval: the owner approves it again (roadctl mandate approve)' : 'the mandate is not approved');
  if (m.problems.length) reasons.push(`the mandate is malformed: ${m.problems[0]} (roadctl lint)`);
  if (m.level !== 'L3' && m.level !== 'L4') reasons.push(`level ${m.level ?? '?'}: the mandate takes nothing, cards go through approve`);
  const h = card.header;
  if (!KINDS.includes(h.kind ?? '')) reasons.push(h.kind ? `kind ${clean(h.kind, 20)} is not a known kind` : 'the card has no kind');
  else if (!m.kinds.includes(h.kind)) reasons.push(`kind ${h.kind} is outside the mandate (${m.kinds.join(', ')})`);
  if (!SIZES.includes(h.size ?? '')) reasons.push(h.size ? `size ${clean(h.size, 20)} is not S, M or L` : 'the card has no size');
  else if (m.max_size && SIZES.indexOf(h.size) > SIZES.indexOf(m.max_size)) reasons.push(`size ${h.size} is above max_size ${m.max_size}`);
  const goal = m.goals.find((g) => g.id === h.goal);
  if (h.goal && !goal) reasons.push(`goal ${clean(h.goal, 30)} is not in the mandate Goals`);
  if (mode === 'work') {
    if (h.by_mandate !== m.hash) reasons.push('by_mandate is not the hash of the approved mandate: take the card again with roadctl delegate');
  } else {
    const st = statusOf(board, card);
    if (!(mode === 'delegate' ? ['ready', 'doing'] : ['ready']).includes(st)) reasons.push(`not ready (${st})`);
    if ('delegate' in h || 'claim' in h) reasons.push('delegated');
    const byId = new Map(board.cards.map((c) => [c.header.id, c]));
    const open = (h.depends_on ?? '').split(',').map((x) => x.trim()).filter(Boolean).filter((d) => !api.depMet(board, card, d, byId));
    if (open.length) reasons.push(`deps open: ${open.join(', ')}`);
    const lacking = Object.entries(LABELS).filter(([, names]) => !filled(card, names)).map(([label]) => label);
    if (lacking.length) reasons.push(`Plan or Delegation lacks (or only has the template for): ${lacking.join(', ')}`);
    const today = api.today();
    const all = takes(board);
    const cardsToday = new Set(all.filter((t) => t.date === today && t.id !== h.id).map((t) => t.id)).size;
    const runsWeek = all.filter((t) => Date.parse(t.date) > Date.parse(today) - 7 * DAY && Date.parse(t.date) <= Date.parse(today)).length;
    if (m.budget.cards_per_day && cardsToday >= m.budget.cards_per_day) reasons.push(`the budget of ${m.budget.cards_per_day} card(s) a day is used`);
    if (m.budget.runs_per_week && runsWeek >= m.budget.runs_per_week) reasons.push(`the budget of ${m.budget.runs_per_week} run(s) a week is used`);
  }
  return { ok: !reasons.length, reasons, rank: goal?.priority ?? Number.MAX_SAFE_INTEGER };
}

/** `mandate show|check`: what is on the board, what tick would take now and why it would not take the rest. Reads only. */
export function describe(board, api) {
  const m = readMandate(board, api);
  const project = path.basename(board.project);
  const base = { project, file: m ? m.file : null, exists: Boolean(m), state: m?.state ?? 'none', hash: m?.hash ?? null, approved: m?.approved ?? null, level: m?.level ?? null, kinds: m?.kinds ?? [], max_size: m?.max_size ?? null, merge: m?.merge ?? null, budget: m && Object.keys(m.budget).length ? m.budget : null, goals: m?.goals ?? [], forbidden: m?.forbidden ?? [], tell_owner: { floor: TELL_OWNER_FLOOR, extra: m?.tell_extra ?? [] }, problems: m?.problems ?? [] };
  const ready = board.cards.filter((c) => c.header.id && statusOf(board, c) === 'ready');
  const cards = !m ? [] : ready.map((c) => {
    const v = admission(board, c, m, 'start', api);
    return { id: c.header.id, admitted: v.ok, reasons: v.reasons, rank: v.ok ? v.rank : null };
  });
  const next = cards.filter((c) => c.admitted).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id, 'en', { numeric: true }))[0]?.id ?? null;
  return { ...base, takes: Boolean(m && live(m)), tick: { next, cards } };
}

function formatDescription(d) {
  if (!d.exists) return [`${d.project}: no mandate (board/${MANDATE_FILE}); nothing is taken by mandate`];
  const L = [`${d.project}: mandate ${d.state === 'approved' ? 'approved' : d.state === 'changed' ? 'CHANGED after approval' : 'not approved'} | level ${d.level ?? '?'} | ${d.takes ? 'cards are taken inside its limits' : 'takes nothing'}`];
  L.push(`  hash ${d.hash}${d.approved ? ` | approved by ${d.approved.by}${d.approved.date ? ` on ${d.approved.date}` : ''}` : ''}`);
  L.push(`  kinds ${d.kinds.join(', ') || '-'} | max size ${d.max_size ?? '-'} | merge ${d.merge} | budget ${d.budget ? Object.entries(d.budget).map(([k, v]) => `${k}=${v}`).join(', ') : '-'}`);
  for (const g of d.goals) L.push(`  goal ${g.id} (priority ${g.priority}): ${g.text}`);
  for (const p of d.problems) L.push(`  PROBLEM ${p}`);
  L.push(`  tell the owner (always): ${d.tell_owner.floor.join('; ')}${d.tell_owner.extra.length ? ` | also: ${d.tell_owner.extra.join('; ')}` : ''}`);
  L.push(`  tick would START: ${d.tick.next ?? 'nothing'}`);
  for (const c of d.tick.cards) L.push(`  [${c.id}] ${c.admitted ? `admitted (rank ${c.rank > 1e15 ? 'last' : c.rank})` : `not admitted: ${c.reasons.join('; ')}`}`);
  return L;
}

const USAGE = 'usage: roadctl mandate [show|check] [--json]   |   roadctl mandate approve --by NAME [--hash H]   (the owner approves; an agent never does)';

function boardOf(ctx) {
  const dir = ctx.api.findBoard(process.cwd(), typeof ctx.flags.board === 'string' ? ctx.flags.board : undefined, ctx.env);
  if (!dir) throw new Error('no board found; run inside the project or use --board DIR / --project NAME');
  return ctx.api.loadBoard(dir);
}

function mandateCommand(ctx) {
  const { flags, args, out, io, api } = ctx;
  const sub = args[1] ?? 'show';
  if (args.length > 2 || !['show', 'check', 'approve'].includes(sub)) throw new Error(USAGE);
  const board = boardOf(ctx);
  if (sub !== 'approve') {
    const d = describe(board, api);
    if (flags.json) out(JSON.stringify(d, null, 2));
    else for (const l of formatDescription(d)) out(l);
    return sub === 'check' && d.exists && (d.state === 'changed' || d.problems.length) ? 1 : 0;
  }
  if (typeof flags.by !== 'string' || !flags.by.trim()) throw new Error(`${USAGE}; --by NAME is required`);
  const refuse = (why) => { io.err(`roadctl mandate: refused: ${why}\n`); return 1; }; // an unattended run never gets here: the owner gate (owner-gate.mjs) refuses it and writes the audit line
  const m = readMandate(board, api);
  if (!m) return refuse(`no board/${MANDATE_FILE}`);
  if (m.problems.length) return refuse(`the mandate is malformed: ${m.problems.join('; ')}`);
  if (flags.hash !== undefined && flags.hash !== m.hash) return refuse(`--hash ${clean(String(flags.hash), 80)} is not the hash of the file now (${m.hash}); look at roadctl mandate show and approve what you saw`);
  let t = fs.readFileSync(m.file, 'utf8');
  const eol = t.includes('\r\n') ? '\r\n' : '\n';
  const set = (text, key, value) => (new RegExp(`^${key}:.*$`, 'm').test(text.match(/^---\r?\n[\s\S]*?\r?\n---/)[0]) ? text.replace(new RegExp(`^${key}:.*$`, 'm'), () => `${key}: ${value}`) : text.replace(/\r?\n---/, () => `${eol}${key}: ${value}${eol}---`));
  t = set(set(t, 'approved', `${clean(flags.by, 40)}, ${api.today()}`), HASH_KEY, m.hash);
  if (approvalHash(t) !== m.hash) return refuse('internal: the approval line changed the hash'); // the record is outside the hash by construction
  fs.writeFileSync(m.file, t);
  if (ctx.audit) ctx.audit.hash = m.hash;
  out(`mandate approved by ${clean(flags.by, 40)}: ${m.hash} (level ${m.level}). Not committed: run roadctl save`);
  return 0;
}

/** The one line the digest tells when the approved mandate was edited, else null. */
export const changedAfterApproval = (board, api) => (readMandate(board, api)?.state === 'changed' ? 'the mandate changed after approval: nothing is taken by it until the owner runs roadctl mandate approve' : null);

export default {
  name: 'mandate',
  headerKeys: ['kind', 'size', 'goal', 'by_mandate'],
  hooks: {
    'start-admit'({ board, api }) {
      return readMandate(board, api)?.state === 'changed'
        ? { admit: false, reason: 'the mandate changed after approval; the owner must approve it again' }
        : {};
    },
    /** START, `delegate` and lint rule 6: another basis than `approved` for a card. {} = this module has nothing to say (no mandate, or level L1/L2: the card path is unchanged). */
    'approval-basis'({ board, card, mode, api }) {
      const m = readMandate(board, api);
      if (!m || !m.gated) return {};
      const v = admission(board, card, m, mode, api);
      if (!v.ok) return { ok: false, reasons: v.reasons };
      return { ok: true, rank: v.rank, ...(mode === 'work' ? {} : { header: { by_mandate: m.hash }, log: `approved by mandate ${m.hash}` }) };
    },
    /** `lint`: the mandate file and the cards that name a goal. */
    'board-lint'({ board, api }) {
      const m = readMandate(board, api);
      if (!m) return {};
      const findings = m.problems.map((text) => ({ level: 'error', file: MANDATE_FILE, text }));
      if (m.state === 'changed') findings.push({ level: 'error', file: MANDATE_FILE, text: 'the mandate changed after approval: nothing is taken by it until the owner approves it again with roadctl mandate approve' });
      else if (m.state === 'unapproved' && m.gated) findings.push({ level: 'warning', file: MANDATE_FILE, text: 'the mandate is not approved: nothing is taken by it' });
      for (const c of board.cards) if (c.header.goal && !m.goals.some((g) => g.id === c.header.goal) && !['done', 'dropped'].includes(statusOf(board, c))) findings.push({ level: 'warning', file: c.name, text: `goal ${clean(c.header.goal, 30)} is not in the mandate Goals` });
      return { findings };
    },
  },
  commands: {
    mandate: {
      group: 'Owner only',
      owner: true,
      ownerReads: ['show', 'check', ''], // P5.3: the owner gate refuses `approve` unattended and audits it; show and check only read
      hidden: true, // the overview is at its 70-line cap; `roadctl help mandate`, `roadctl help autonomy` and docs/roadctl.md name it
      effect: 'write',
      summary: 'the project mandate: show it, check it, approve it (owner only)',
      purpose: 'One file, board/mandate.md, holds the limits inside which an agent takes ready cards without approve, auto and the queue: level (L1 routines, L2 cards approved one by one, L3 mandate in the agent\'s branch, L4 also merge to main), kinds, max_size, merge, budget, Goals, Forbidden, Tell the owner. show and check read: level, limits, hash, approved / changed after approval / not approved, what tick would START now and why each other ready card is not admitted (check exits 1 when the mandate changed after approval or is malformed). approve is the owner\'s command: it records approved and approved_hash (the content hash of the whole file, Goals included; an edit takes the approval away) and refuses in an unattended run (ROADCTL_UNATTENDED or ROADCTL_RUN_ID), without --by, and when --hash is not the hash of the file now. Nothing is autonomous until the owner approved the mandate; the limits are an agreement checked at START, delegate and lint, not a sandbox.',
      usage: ['roadctl mandate [show|check] [--json]', 'roadctl mandate approve --by NAME [--hash H]'],
      flags: [['--json', 'show, check: machine-readable output'], ['--by NAME', 'approve: the owner who approves'], ['--hash H', 'approve: the hash you were shown; a different hash refuses']],
      examples: ['roadctl mandate show', 'roadctl mandate check --json', 'roadctl mandate approve --by Owner --hash sha256-v1:...'],
      changes: 'show, check: nothing. approve: the approved and approved_hash header of board/mandate.md and one line in owner-commands.jsonl of the machine state directory. Not committed: run roadctl save.',
      exits: '0 ok; 1 refused (unattended, no file, malformed, hash differs), or check found a changed or malformed mandate; 2 usage error or no board found',
      run: mandateCommand,
    },
  },
};
