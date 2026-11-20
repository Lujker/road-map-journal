import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const pathFor = (dir, file) => path.join(dir, file);
import { makeQuestion, answerQuestion, undoQuestion, addQuestion, putQuestions, questionsFromItem } from './owner-questions-data.mjs';

const REQUIRES = '0.13.0';
const agentPattern = /^[A-Za-z0-9@._:-]{1,100}$/;
const asLine = (s) => String(s).replace(/[\r\n|]/g, ' ').replace(/[`<>\[\]]/g, '').trim();
const when = (env, api) => new Date(api.nowMs(env)).toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function input() {
  const buffer = Buffer.alloc(16385);
  let n = 0;
  while (n < buffer.length) {
    const r = fs.readSync(0, buffer, n, buffer.length - n, null);
    if (!r) break;
    n += r;
  }
  if (n > 16384) throw new Error('input exceeds 16384 bytes');
  try { return JSON.parse(buffer.subarray(0, n).toString('utf8')); } catch { throw new Error('expected JSON input'); }
}
function boardOf(flags, api) {
  if (typeof flags.board !== 'string') throw new Error('--board DIR is required');
  const dir = api.findBoard(process.cwd(), flags.board);
  const board = api.loadBoard(dir);
  if (api.boardRequires(board.config) || (api.compareVersions(board.config.requires, REQUIRES) ?? -1) < 0) throw new Error(`board requires must be at least ${REQUIRES} and supported`);
  return board;
}
function itemOf(board, id) {
  const matches = [...board.cards, ...(board.routines ?? [])].filter((x) => x.header.id === id);
  if (matches.length !== 1 || matches[0].errors?.length) throw new Error('target must identify one valid card or routine');
  return { item: matches[0], routine: !board.cards.includes(matches[0]) };
}
function changeHeader(raw, key, value) {
  return raw.replace(/^(---\n)([\s\S]*?)(\n---)/, (_, first, block, last) => {
    const lines = block.split('\n').filter((line) => !line.startsWith(`${key}:`));
    if (value !== null) lines.push(`${key}: ${value}`);
    return first + lines.join('\n') + last;
  });
}
function log(raw, date, by, message) {
  const entry = `- ${date} [${asLine(by)}] ${asLine(message)}`;
  if (!/^## Log$/m.test(raw)) return `${raw.replace(/\n*$/, '\n')}\n## Log\n${entry}\n`;
  return raw.replace(/(^## Log\n)([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m, (_, header, body) => `${header}${body.replace(/\n*$/, '\n')}${entry}\n\n`);
}
function write(item, raw) {
  fs.writeFileSync(item.file, item.eol === '\r\n' ? raw.replace(/\n/g, '\r\n') : raw, 'utf8');
}
function rawItem(item) { return fs.readFileSync(item.file, 'utf8').replace(/\r\n/g, '\n'); }
function handoff(v) {
  const fields = ['did', 'next', 'in_flight'];
  if (!v || Object.keys(v).length !== 3 || fields.some((k) => typeof v[k] !== 'string' || !v[k].trim() || v[k].length > 350 || /[\x00-\x1f\x7f]/.test(v[k]))) throw new Error('claimed work needs checkpoint {did,next,in_flight}');
  return `checkpoint: did: ${v.did} | next: ${v.next} | in-flight: ${v.in_flight}`;
}
const common = { group: 'Record', hidden: true, usage: [], flags: [], examples: [], exits: '0 success; 1 refused; 2 invalid input; 7 already answered; 8 undo expired' };
const spec = (summary, purpose, usage, flags, examples, changes, run, extra = {}) => ({ ...common, effect: 'write', summary, purpose, usage, flags, examples, changes, run, ...extra });

function ask({ args, flags, api, env, out }) {
  if (args.length !== 2 || !agentPattern.test(flags.as ?? '')) throw new Error('usage: roadctl ask ID --board DIR --as AGENT < question.json');
  const board = boardOf(flags, api);
  const { item, routine } = itemOf(board, args[1]);
  if (!routine && (board.config.status_map?.[item.header.status] ?? item.header.status) !== 'doing') throw new Error('ask requires a doing card');
  if (routine && item.header.agent !== flags.as) throw new Error('only the routine agent may ask');
  const data = input();
  const timestamp = when(env, api);
  const until = data.question?.reason === 'reversible' ? data.undo_until : new Date(Date.parse(timestamp) + 1).toISOString();
  const q = { ...makeQuestion(data.question, timestamp, until), agent: flags.as };
  let raw = rawItem(item);
  const rows = questionsFromItem(raw);
  if (rows.some((x) => x.state === 'waiting')) throw new Error('an owner question is already waiting');
  const info = routine ? null : api.delegationInfo(item);
  if (info?.errors.length) throw new Error('invalid delegation');
  if (info?.delegate?.state === 'claimed') {
    if (info.claim?.agent !== flags.as || api.leaseExpired(info.claim, api.nowMs(env))) throw new Error('only the current claimant may ask');
    raw = log(raw, timestamp.slice(0, 10), flags.as, handoff(data.checkpoint));
  }
  if (q.blocking && !routine) {
    raw = changeHeader(raw, 'status', 'blocked');
    raw = changeHeader(raw, 'blocked', `owner question ${q.id}`);
    if (info?.delegate?.state === 'claimed') {
      raw = changeHeader(raw, 'delegate', api.formatDelegate({ ...info.delegate, state: 'open' }));
      raw = changeHeader(raw, 'claim', null);
    }
  }
  raw = log(raw, timestamp.slice(0, 10), flags.as, q.blocking ? `ASK ${q.id}: waiting for owner` : `ASK ${q.id}: decided, can be undone until ${q.undo_until}`);
  raw = putQuestions(raw, addQuestion(rows, q));
  write(item, raw);
  out(`ask ${args[1]}/${q.id}: ${q.state}; not committed`);
  return 0;
}
function resolve({ args, flags, api, env, out }, undo = false) {
  if (args.length !== 3 || !agentPattern.test(flags.by ?? '')) throw new Error(`usage: roadctl ${undo ? 'undo' : 'answer'} ID QUESTION --board DIR --by OWNER < response.json`);
  const board = boardOf(flags, api);
  const { item, routine } = itemOf(board, args[1]);
  const data = input();
  let raw = rawItem(item);
  const rows = questionsFromItem(raw);
  const index = rows.findIndex((q) => q.id === args[2]);
  if (index < 0) throw new Error('question not found');
  const timestamp = when(env, api);
  try { rows[index] = undo ? undoQuestion(rows[index], data.comment, timestamp) : answerQuestion(rows[index], data.answer, timestamp); }
  catch (e) { if (e.code === 'already-answered') { out('answer: already answered'); return 7; } if (e.code === 'undo-expired') { out('undo: window expired'); return 8; } throw e; }
  if (!routine && !undo && item.header.status === 'blocked' && item.header.blocked === `owner question ${args[2]}` && !rows.some((q) => q.state === 'waiting')) {
    if (item.header.delegate) raw = changeHeader(raw, 'blocked', `owner answer ${args[2]}`);
    else { raw = changeHeader(raw, 'status', 'doing'); raw = changeHeader(raw, 'blocked', null); }
  }
  if (undo && !routine) {
    const info = api.delegationInfo(item);
    if (info.errors.length) throw new Error('invalid delegation');
    if (info.delegate?.state === 'reported') raw = changeHeader(raw, 'delegate', api.formatDelegate({ ...info.delegate, state: 'open' }));
    if ((board.config.status_map?.[item.header.status] ?? item.header.status) === 'review') raw = changeHeader(raw, 'status', 'doing');
    raw = log(raw, timestamp.slice(0, 10), flags.by, `RETURNED: ${data.comment}`);
  }
  raw = log(raw, timestamp.slice(0, 10), flags.by, `${undo ? 'UNDO' : 'ANSWER'} ${args[2]}: ${JSON.stringify(undo ? data.comment : data.answer)}`);
  write(item, putQuestions(raw, rows));
  out(`${undo ? 'undo' : 'answer'} ${args[1]}/${args[2]}: recorded; not committed`);
  return 0;
}

function inbox({ args, flags, api, env, out }) {
  if (args[1] === 'defer') {
    if (args.length !== 4 || !agentPattern.test(flags.by ?? '') || typeof flags.until !== 'string') throw new Error('usage: roadctl inbox defer ID QUESTION --until ISO --by OWNER --board DIR');
    const board = boardOf(flags, api);
    const { item } = itemOf(board, args[2]);
    const time = new Date(flags.until);
    if (!Number.isFinite(time.getTime()) || time.getTime() <= api.nowMs(env)) throw new Error('deferral must be a future time');
    const raw = rawItem(item), rows = questionsFromItem(raw), q = rows.find((x) => x.id === args[3]);
    if (!q || !['waiting', 'decided'].includes(q.state)) throw new Error('no open question or decision');
    q.defer_until = time.toISOString();
    write(item, putQuestions(log(raw, when(env, api).slice(0, 10), flags.by, `DEFER ${q.id} until ${q.defer_until}`), rows));
    out(`inbox: deferred ${args[2]}/${q.id} until ${q.defer_until}`);
    return 0;
  }
  if (args.length !== 1) throw new Error('usage: roadctl inbox --board DIR [--json]');
  const board = boardOf(flags, api);
  const items = ownerItems(board, api.nowMs(env));
  if (flags.json) out(JSON.stringify({ version: 1, items }, null, 2));
  else if (!items.length) out('inbox: empty');
  else for (const i of items) out(`${i.type} ${i.target}: ${i.confirmation}`);
  return 0;
}
export function ownerItems(board, time) {
  const items = [];
  for (const item of [...board.cards, ...(board.routines ?? [])]) {
    const raw = rawItem(item);
    for (const q of questionsFromItem(raw)) {
      if (!['waiting', 'decided'].includes(q.state) || (q.defer_until && Date.parse(q.defer_until) > time)) continue;
      const content = JSON.stringify(q);
      const undoable = q.state === 'decided' && Date.parse(q.undo_until) > time;
      items.push({ type: q.state === 'waiting' ? 'question' : 'decision', target: item.header.id, question: q, ...(q.state === 'decided' ? { undoable } : {}), hash: sha(content), confirmation: `${q.state === 'waiting' ? 'Answer' : undoable ? 'Undo' : 'Decision'} ${item.header.id}/${q.id}: ${q.prompt}` });
    }
    if (board.cards.includes(item) && ['review', 'ready', 'proposed'].includes(item.header.status)) {
      const type = item.header.status === 'proposed' ? 'proposed' : item.header.kind === 'milestone' && item.header.status === 'review' ? 'milestone' : item.header.status === 'review' ? 'review' : (!item.header.approved ? 'approval' : null);
      if (type) items.push({ type, target: item.header.id, title: item.header.title, hash: sha(raw), confirmation: `${type}: ${item.header.id} ${item.header.title}` });
    }
    if (!board.cards.includes(item)) {
      const lastRun = [...(item.log ?? [])].reverse().find((l) => /^RUN (ok|escalated|failed):/.test(l.text));
      if (lastRun && /^RUN escalated:/.test(lastRun.text)) items.push({ type: 'escalation', target: item.header.id, text: lastRun.text, hash: sha(JSON.stringify(lastRun)), confirmation: `Review escalation ${item.header.id}: ${lastRun.text}` });
    }
  }
  return items;
}
export default {
  name: 'owner-questions',
  cardSections: ['Questions'], routineSections: ['Questions'],
  tickKinds: { RESUME: { prompt: ({ agent }) => `RESUME read the owner's answer; claim the card with roadctl claim <id> --as ${agent} and continue`, text: (item) => `owner answered: ${item.title}` } },
  hooks: {
    'tick-items'({ board, agent, api }) {
      if ((api.compareVersions(board.config.requires, REQUIRES) ?? -1) < 0) return {};
      return { items: board.cards.filter((card) => card.header.status === 'blocked' && /^owner answer /.test(card.header.blocked ?? '')).flatMap((card) => {
        const id = card.header.blocked.slice('owner answer '.length);
        const question = questionsFromItem(rawItem(card)).find((q) => q.id === id && q.state === 'answered' && q.agent === agent);
        return question ? [{ kind: 'RESUME', id: card.header.id, title: card.header.title }] : [];
      }) };
    },
    'routine-reasons'({ board, routine, api }) {
      if ((api.compareVersions(board.config.requires, REQUIRES) ?? -1) < 0) return {};
      try {
        const raw = fs.readFileSync(pathFor(board.dir, routine.file), 'utf8');
        return questionsFromItem(raw).some((q) => q.state === 'waiting') ? { reasons: ['waiting for owner answer'], lint: 'none' } : {};
      } catch { return { reasons: ['owner question data unreadable'], lint: 'error' }; }
    },
    'tick-before'({ items, boardDirs, api }) {
      const run = {};
      for (const item of items.filter((x) => x.kind === 'RUN')) {
        const board = api.loadBoard(boardDirs[item.project]);
        if ((api.compareVersions(board.config.requires, REQUIRES) ?? -1) < 0) continue;
        const routine = board.routines.find((r) => r.header.id === item.id);
        if (!routine) continue;
        const answers = questionsFromItem(rawItem(routine)).filter((q) => q.state === 'answered').map((q) => ({ id: q.id, prompt: q.prompt, answer: q.answer }));
        if (answers.length) run[`${item.project}/${item.id}`] = { owner_answers: answers };
      }
      return { run };
    },
  },
  commands: {
    ask: spec('record a question for the owner', 'Reads JSON {question:{id,kind,prompt,reason,points?,recommended?},undo_until?,checkpoint?}; kind is confirm, choice or text, reason is reversible, irreversible or outside-mandate. Reversible needs a recommended answer and undo_until at the next daily overview. A claimed card needs checkpoint {did,next,in_flight}. Blocking questions release the lease; reversible decisions let the agent continue.', ['roadctl ask ID --board DIR --as AGENT < question.json'], [['--board DIR', 'board directory'], ['--as AGENT', 'asking agent']], ['roadctl ask W-3 --board ./board --as worker < question.json'], 'Writes the question and checkpoint to the target file.', ask),
    inbox: spec('list owner questions and decisions', 'Lists questions and owner decisions as text or versioned JSON.', ['roadctl inbox --board DIR [--json]'], [['--board DIR', 'board directory'], ['--json', 'print JSON'], ['--until ISO', 'hide a question until this time'], ['--by OWNER', 'owner name for deferral']], ['roadctl inbox --board ./board --json'], 'Reads board files; defer writes the item.', inbox, { effect: 'write', owner: { sub: ['defer'] } }),
    answer: spec('answer an owner question', 'Owner only; reads JSON {answer:VALUE}: a boolean for confirm, a string for text or a map of point IDs to answers for choice. Choice points may be answered separately. Writes the item Log and owner audit; refuses in an unattended run.', ['roadctl answer ID QUESTION --board DIR --by OWNER < answer.json'], [['--board DIR', 'board directory'], ['--by OWNER', 'owner name']], ['roadctl answer W-3 q1 --board ./board --by Owner < answer.json'], 'Writes the answer and Log entry.', (ctx) => resolve(ctx), { owner: true }),
    undo: spec('undo a reversible decision', 'Owner only; reads JSON {comment:TEXT}, returns a reported card for rework and refuses after undo_until or in an unattended run.', ['roadctl undo ID QUESTION --board DIR --by OWNER < comment.json'], [['--board DIR', 'board directory'], ['--by OWNER', 'owner name']], ['roadctl undo W-3 q1 --board ./board --by Owner < comment.json'], 'Writes the undo and Log entry.', (ctx) => resolve(ctx, true), { owner: true }),
  },
};
