import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { changeHeader, log } from './owner-questions.mjs';
import { RULE_REQUIRES } from './rule-acceptance.mjs';

function command({ args, flags, api, env, out }) {
  const [sub, id] = args.slice(1);
  if (args.length !== 3 || !['continue', 'move'].includes(sub) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id ?? '') || typeof flags.by !== 'string' || !/^[A-Za-z0-9@._:-]{1,100}$/.test(flags.by)) throw new Error('usage: roadctl milestone continue ID --by OWNER | milestone move ID --to YYYY-MM-DD | --cards A,B --by OWNER');
  const dir = api.findBoard(process.cwd(), typeof flags.board === 'string' ? flags.board : undefined, env);
  if (!dir) throw new Error('no board found');
  const board = api.loadBoard(dir);
  if ((api.compareVersions(board.config.requires, RULE_REQUIRES) ?? -1) < 0 || api.boardRequires(board.config)) throw new Error(`board must require supported roadctl ${RULE_REQUIRES} or newer`);
  const file = path.join(board.dir, 'milestones', `${id}.md`);
  if (!fs.existsSync(file)) throw new Error('unknown milestone');
  const m = api.parseCard(file);
  if (m.errors.length) throw new Error('invalid milestone');
  const ready = api.readyMilestones(board).some((x) => x.id === id);
  const waiting = api.readyMilestones(board, { waiting: true }).some((x) => x.id === id);
  let raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  raw = raw.replace(/\r\n/g, '\n');
  const set = (key, value) => { raw = changeHeader(raw, key, value); };
  let message;
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
      group: 'Owner only', effect: 'write', owner: { sub: ['continue', 'move'] }, hidden: true,
      summary: 'continue or move a milestone',
      purpose: 'Owner decisions on an existing milestone. Continue records consideration without accepting cards. Moving a date or cards does not waive a pending decision.',
      usage: ['roadctl milestone continue ID --by OWNER', 'roadctl milestone move ID (--to YYYY-MM-DD | --cards A,B) --by OWNER'],
      flags: [['--by OWNER', 'owner name'], ['--to DATE', 'new date'], ['--cards IDS', 'new card list']],
      examples: ['roadctl milestone continue M-1 --by Owner'],
      changes: 'Writes the milestone and its Log and the owner audit.', exits: '0 ok; 1 refused; 2 invalid arguments.', run: command,
    },
  },
};
