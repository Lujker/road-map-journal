// `roadctl digest` (P5.13): the text the owner gets about unattended runs, printed by a command that needs no model, so a scheduler can forward it
// (a Hermes `no_agent` job, cron, anything that sends the output to a chat). roadctl itself sends nothing. Empty output means silence.
//
//   roadctl digest [--since-state NAME] [--dry-run] [--all] [--json]   what is new since the last digest of this state name: problems and questions
//   roadctl digest --daily [--all] [--json]                             the overview: a line per routine (overdue ones included), this machine's
//                                                                       crashed and skipped runs, the owner's commands of the last 24 hours
//
// Sources: the Log lines of the routines and the REPORT lines of the cards of the boards (git, so a run on another machine arrives after `pull`),
// and the local run ledger for what never reaches a board (crashed, timeout, aborted, skipped, the duty orchestrator's `run done`).
// Delivery state (what was already shown, which problem keys are open) is local: `digest.state.json` in the state directory, moved only after the text
// was printed (a delivery that fails afterwards loses the message: the daily overview is the safety net). Policy per routine: header `notify`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readPause, pauseLine } from './pause.mjs';
import { parseRunTrailer } from './run-ledger.mjs';
import { LOCK_STALE_MS, acquireLock } from './state.mjs';
import { cleanText, hostName, isoAt, nowMs, readJsonl, readRuns, stateDir } from './run-store.mjs';
import { parseLogText, renderSummary, wordsFor } from './run-summary.mjs';

export const NOTIFY = ['problems', 'always', 'never'];
export const DEFAULT_STATE_NAME = 'default';
const FIRST_USE_MS = 2 * 864e5; // a state name used for the first time reports only what happened in the last two days; older lines are marked seen
const OLD_MS = 30 * 864e5; // a run older than this is never reported (the same 30 days as the local details)
const SEEN_KEEP_MS = 60 * 864e5;
const DAY_MS = 864e5;
const MAX_CHARS = 3500; // one message must fit a chat (the smallest common limit is 4096 characters)
const NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const BAD = new Set(['crashed', 'timeout', 'aborted']); // outcomes that only the local ledger knows

const stateFile = (env) => path.join(stateDir(env), 'digest.state.json');
export const digestStateFile = stateFile; // seam (P5.28): the state-directory test compares it with the other modules
export const ownerCommandsFile = (env) => path.join(stateDir(env), 'owner-commands.jsonl');

// ---------------------------------------------------------------- the delivery state

function readState(env) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(env), 'utf8'));
    if (s && typeof s === 'object' && s.names && typeof s.names === 'object') return { v: 1, names: s.names };
  } catch {
    /* missing or broken: a state name then starts again (first use) */
  }
  return { v: 1, names: {} };
}

function writeState(env, state) {
  const file = stateFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  fs.renameSync(tmp, file);
}

/** One digest at a time per machine: two schedulers must not both print (and so both deliver) the same event. { ok, release }. seam (P5.28): the lock is state.mjs `acquireLock` (stale after 60 s, no waiting). */
function lockDigest(env) {
  const l = acquireLock(`${stateFile(env)}.lock`, { staleMs: LOCK_STALE_MS.digest, strict: true, content: String(process.pid) });
  if (l.ok) return { ok: true, release: () => l.release() };
  return { ok: false, reason: l.reason === 'held' ? 'another digest is running' : `the state directory cannot be used (${l.reason})` };
}

// ---------------------------------------------------------------- events

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const projectOf = (board) => String(board.project).split(/[\\/]/).filter(Boolean).pop();
const dayMs = (d) => Date.parse(`${d}T12:00:00Z`); // the Log has a date only: noon is the best guess

/** All finished runs and reports the boards tell about, as events: { sig, kind, project, id, outcome, agent, run_id, host, duration_s, fields, time, policy, language }. */
function boardEvents(board, env) {
  const project = projectOf(board);
  const language = board.config?.language;
  const events = [];
  for (const r of board.routines ?? []) {
    const id = r.header.id;
    if (!id) continue;
    const policy = NOTIFY.includes(r.header.notify) ? r.header.notify : 'problems';
    const last = Date.parse(r.header.last_run ?? '');
    const runs = r.log.map((l) => ({ l, m: /^RUN (ok|escalated|failed): (.*)$/s.exec(l.text) })).filter((x) => x.m);
    runs.forEach(({ l, m }, i) => {
      const tr = parseRunTrailer(m[2]);
      const parsed = parseLogText(tr ? tr.text : m[2]);
      const lastOne = i === runs.length - 1 && Number.isFinite(last) && l.date === isoAt(last).slice(0, 10);
      events.push({ sig: `${project}/${id}|${tr?.run_id ?? `h-${hash(`${l.date}|${l.author}|${m[2]}`)}`}`, kind: 'routine', project, id, outcome: m[1], agent: l.author, run_id: tr?.run_id ?? null, host: tr?.host ?? null, duration_s: tr?.duration_s ?? null, fields: parsed.fields, time: lastOne ? last : dayMs(l.date), date: l.date, policy, language });
    });
  }
  for (const c of board.cards ?? []) {
    const id = c.header?.id;
    if (!id) continue;
    for (const l of c.log ?? []) {
      const m = /^REPORT: (.*)$/s.exec(l.text);
      if (!m) continue;
      const tr = parseRunTrailer(m[1]);
      const parsed = parseLogText(tr ? tr.text : m[1]);
      events.push({ sig: `${project}/${id}|${tr?.run_id ?? `h-${hash(`${l.date}|${l.author}|${m[1]}`)}`}`, kind: 'task', project, id, outcome: 'ok', agent: l.author, run_id: tr?.run_id ?? null, host: tr?.host ?? null, duration_s: tr?.duration_s ?? null, fields: parsed.fields, time: dayMs(l.date), date: l.date, policy: 'problems', language });
    }
  }
  return events;
}

/** The runs only this machine knows (crashed, timeout, aborted; the orchestrator's own summaries; skipped streaks). */
function localEvents(env, policies, languages) {
  const out = [];
  for (const r of readRuns(env).values()) {
    const time = Date.parse(r.finished ?? r.started ?? '');
    if (!Number.isFinite(time) || r.outcome === 'started') continue;
    const target = `${r.project ?? '-'}/${r.id}`;
    const skipped = r.outcome === 'skipped';
    if (!skipped && !BAD.has(r.outcome) && r.kind !== 'orchestrator') continue; // the board's Log line tells these
    out.push({ sig: `local|${r.run_id}`, kind: r.kind, project: r.project, id: r.id, outcome: r.outcome, reason: r.reason, count: r.count, agent: r.agent, run_id: r.run_id, host: r.host, duration_s: r.duration_s, fields: { did: r.did, decisions: r.decisions, problems: r.problems, needs_owner: r.needs_owner, not_checked: r.not_checked }, time, local: true, policy: r.kind === 'routine' ? policies.get(target) ?? 'problems' : 'problems', language: languages.get(r.project) });
  }
  return out;
}

const keyOf = (s) => `${hash(String(s).toLowerCase())}`;

/** The open-problem keys of an event: the agent's problems, the outcome when it is not ok, a question for the owner. Map key -> { kind, text }. */
function keysOf(ev) {
  const m = new Map();
  if (ev.outcome === 'skipped') return m;
  for (const p of ev.fields.problems ?? []) m.set(p.key, { kind: p.kind, text: p.text });
  if (ev.outcome !== 'ok') m.set(ev.outcome, { kind: 'outcome', text: ev.outcome });
  if (ev.fields.needs_owner) m.set(`ask:${keyOf(ev.fields.needs_owner)}`, { kind: 'ask', text: ev.fields.needs_owner });
  return m;
}

// ---------------------------------------------------------------- the owner's commands (written by the audit of P5.3; read here)

/** Lines of owner-commands.jsonl: { time (ISO), command, target, by, outcome }. A missing file is no commands. */
export function readOwnerCommands(env, sinceMs, untilMs) {
  return readJsonl(ownerCommandsFile(env)).filter((r) => typeof r.command === 'string' && Number.isFinite(Date.parse(r.time)) && Date.parse(r.time) >= sinceMs && Date.parse(r.time) <= untilMs);
}

const DAILY = {
  en: { head: 'roadctl daily overview', ago: 'ago', every: 'every', overdue: 'OVERDUE', last: 'last run', never: 'never run', blocked: 'not running', off: 'routines are switched off (board switch)', machine: 'this machine, last 24h', crashed: 'crashed', skipped: 'skipped', owner: 'owner commands, last 24h', more: 'more', tasks: 'tasks reported, last 24h', none: 'no enabled routines', orch: 'orchestrator', by: 'by' },
  ru: { head: 'суточная сводка roadctl', ago: 'назад', every: 'каждые', overdue: 'ПРОСРОЧЕНА', last: 'последний запуск', never: 'ещё не запускалась', blocked: 'не запускается', off: 'рутины выключены (переключатель доски)', machine: 'эта машина, 24 ч', crashed: 'оборвано', skipped: 'пропущено', owner: 'команды владельца за 24 ч', more: 'ещё', tasks: 'отчёты по поручениям за 24 ч', none: 'нет включённых рутин', orch: 'оркестратор', by: 'от' },
};
const dailyWords = (language) => (String(language ?? '').toLowerCase().startsWith('ru') ? DAILY.ru : DAILY.en);
const ageText = (ms) => (ms < 90 * 60e3 ? `${Math.max(0, Math.round(ms / 60e3))}m` : ms < 48 * 3600e3 ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / DAY_MS)}d`);
const everyMs = (every) => {
  const m = /^(\d+)(m|h|d)$/.exec(String(every ?? ''));
  return m ? Number(m[1]) * { m: 60e3, h: 3600e3, d: DAY_MS }[m[2]] : NaN;
};
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------- the command

function loadBoards(flags, env, api, warn) {
  const dirs = flags.all ? api.knownBoards(env).map((b) => b.dir) : [api.findBoard(process.cwd(), typeof flags.board === 'string' ? flags.board : undefined, env)];
  if (!flags.all && !dirs[0]) throw new Error('no board found; run inside the project or use --board DIR / --project NAME / --all');
  if (flags.all && !api.hasBoardSources(env)) throw new Error('no workspace found; set ROADCTL_WORKSPACE, use --workspace DIR or add a board with roadctl boards add');
  const out = [];
  for (const dir of dirs) {
    try {
      out.push(api.loadBoard(dir));
    } catch (e) {
      warn(`roadctl digest: warning: board ${cleanText(dir, 80)} not read: ${cleanText(e.message, 120)}`);
    }
  }
  return out;
}

const DIGEST_USAGE = 'usage: roadctl digest [--since-state NAME] [--dry-run] [--all] [--json]   |   roadctl digest --daily [--all] [--json]';

function digestCommand({ flags, args, out, env, api }) {
  if (args.length > 1) throw new Error(DIGEST_USAGE);
  const name = flags['since-state'] === undefined ? DEFAULT_STATE_NAME : flags['since-state'];
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`${DIGEST_USAGE}; the state name is letters, digits and . _ - (up to 40)`);
  const warn = (s) => process.stderr.write(`${s}\n`);
  const now = nowMs(env);
  const boards = loadBoards(flags, env, api, warn);
  const language = boards[0]?.config?.language;
  const refused = new Map(boards.map((b) => [projectOf(b), api.boardRequires(b.config)]).filter(([, why]) => why));
  const usable = boards.filter((b) => !refused.has(projectOf(b)));
  const result = flags.daily ? daily({ boards: usable, refused, env, api, now, language }) : immediate({ boards: usable, refused, env, api, now, name, dry: Boolean(flags['dry-run']), warn });
  if (flags.json) out(JSON.stringify({ mode: flags.daily ? 'daily' : 'immediate', state: flags.daily ? null : name, ...result.json, text: result.lines.join('\n') }, null, 2));
  else for (const l of result.lines) out(l);
  result.commit?.(); // the delivery state moves after the text is printed
}

// ---------------------------------------------------------------- immediate: problems and questions, each told once

function immediate({ boards, refused, env, api, now, name, dry, warn }) {
  const lock = dry ? { ok: true, release() {} } : lockDigest(env);
  if (!lock.ok) {
    warn(`roadctl digest: ${lock.reason}; nothing printed, nothing marked`);
    return { lines: [], json: { events: [], resolved: [] }, commit() {} };
  }
  try {
    const state = readState(env);
    const mine = state.names[name] ?? { seen: {}, active: {}, started: null };
    const first = !state.names[name];
    const policies = new Map();
    const languages = new Map();
    const unpublished = new Map();
    for (const b of boards) {
      languages.set(projectOf(b), b.config?.language);
      for (const r of b.routines ?? []) if (r.header.id) policies.set(`${projectOf(b)}/${r.header.id}`, NOTIFY.includes(r.header.notify) ? r.header.notify : 'problems');
    }
    const host = hostName(env);
    const events = [...boards.flatMap((b) => boardEvents(b, env)), ...localEvents(env, policies, languages)].sort((a, b) => a.time - b.time);
    const known = new Set(events.filter((e) => e.run_id && !e.local).map((e) => e.run_id));
    const blocks = [];
    const shown = [];
    const resolvedAll = [];
    const marks = [];
    const active = structuredClone(mine.active);
    let size = 0;
    let cut = 0;
    const push = (lines, sig) => {
      const text = lines.join('\n');
      if (size + text.length + 1 > MAX_CHARS && blocks.length) return false;
      blocks.push(text);
      size += text.length + 1;
      marks.push(sig);
      return true;
    };
    // a board that needs a newer roadctl: its line, once; forgotten when it no longer does
    for (const [project, why] of refused) {
      const slot = (active[`@requires/${project}`] ??= {});
      if (!slot.requires) {
        slot.requires = { kind: 'requires', text: why, since: now };
        blocks.push(`requires: ${project}: ${why}`);
        size += blocks.at(-1).length + 1;
      }
    }
    for (const key of Object.keys(active)) if (key.startsWith('@requires/') && !refused.has(key.slice(10))) delete active[key];
    const tooOld = (ev) => now - ev.time > OLD_MS || (first && now - ev.time > FIRST_USE_MS);
    for (const ev of events) {
      if (mine.seen[ev.sig] !== undefined) continue;
      if (ev.local && ev.run_id && known.has(ev.run_id)) continue;
      const old = tooOld(ev);
      if (old) continue; // never told, so it opens no problem either (a failure of the same kind later is news); commit() marks it seen
      const target = `${ev.project ?? '-'}/${ev.id}`;
      const policy = ev.policy;
      const words = wordsFor(ev.language);
      const keys = keysOf(ev);
      const prev = active[target] ?? {};
      const fresh = [...keys.keys()].filter((k) => !prev[k]);
      const gone = ev.outcome === 'skipped' ? [] : Object.keys(prev).filter((k) => !keys.has(k) && prev[k].kind !== 'ask');
      const speaks = !old && policy !== 'never';
      let lines = null;
      if (speaks && ev.outcome === 'skipped') {
        if (policy === 'always' && ev.local) lines = [`${ev.kind} ${target}: ${words.skipped} ${ev.reason}${ev.count > 1 ? ` x${ev.count}` : ''}`];
      } else if (speaks && (policy === 'always' || fresh.length)) {
        let fields = ev.fields;
        if (policy !== 'always') {
          const told = new Set([...keys.keys()].filter((k) => prev[k]));
          fields = { ...ev.fields, problems: ev.fields.problems.filter((p) => !told.has(p.key)), needs_owner: ev.fields.needs_owner && told.has(`ask:${keyOf(ev.fields.needs_owner)}`) ? null : ev.fields.needs_owner };
        }
        lines = renderSummary({ ...ev, fields, unpublished: unpublishedOf(api, boards, ev, unpublished, host, now) }, ev.language);
      }
      const resolved = speaks ? gone.map((k) => `${words.resolved}: ${target}: ${k}`) : [];
      const all = lines ? [...lines, ...resolved].slice(0, 6) : resolved;
      if (all.length) {
        if (!push(all, ev.sig)) {
          cut++;
          continue; // does not fit this message: it stays unseen (its state change waits too) and comes next time
        }
        if (lines) shown.push({ sig: ev.sig, kind: ev.kind, target, outcome: ev.outcome, agent: ev.agent, run_id: ev.run_id, host: ev.host, fields: ev.fields });
        resolvedAll.push(...resolved);
      } else marks.push(ev.sig);
      if (ev.outcome !== 'skipped') {
        const next = {};
        for (const [k, v] of keys) next[k] = prev[k] ?? { kind: v.kind, text: v.text, since: now };
        if (Object.keys(next).length) active[target] = next;
        else delete active[target];
      }
    }
    if (cut) blocks.push(`${cut} ${DAILY.en.more}: roadctl digest`);
    const lines = blocks.flatMap((b, i) => (i ? ['', ...b.split('\n')] : b.split('\n')));
    // the mark moves after the text was printed (the caller prints `lines`, then calls commit)
    const commit = () => {
      try {
        if (!dry) {
          mine.active = active;
          mine.started ??= now;
          for (const sig of marks) mine.seen[sig] = now;
          for (const ev of events) if (tooOld(ev) && mine.seen[ev.sig] === undefined) mine.seen[ev.sig] = now; // too old to ever report: not looked at again
          for (const [k, t] of Object.entries(mine.seen)) if (now - t > SEEN_KEEP_MS) delete mine.seen[k];
          state.names[name] = mine;
          writeState(env, state);
        }
      } catch (e) {
        warn(`roadctl digest: warning: the delivery state could not be written (${e.code ?? 'error'}); the same text may come again`);
      } finally {
        lock.release();
      }
    };
    return { lines, json: { events: shown, resolved: resolvedAll }, commit };
  } catch (e) {
    lock.release();
    throw e;
  }
}

/** True when the event is a run of this machine whose Log line is not in git yet (commit ahead of the server or an uncommitted board change). */
function unpublishedOf(api, boards, ev, cache, host, now) {
  if (ev.local || (ev.host && ev.host !== host) || now - ev.time > 2 * DAY_MS) return false;
  const board = boards.find((b) => projectOf(b) === ev.project);
  if (!board) return false;
  if (!cache.has(ev.project)) {
    let st = null;
    try {
      st = api.syncState(board);
    } catch {
      /* no sync information: no mark */
    }
    cache.set(ev.project, Boolean(st && ['ok', 'offline', 'no-upstream'].includes(st.state) && (st.ahead > 0 || st.pending > 0 || st.state === 'no-upstream')));
  }
  return cache.get(ev.project);
}

// ---------------------------------------------------------------- daily: one line per routine, overdue ones included

function daily({ boards, refused, env, api, now, language }) {
  const w = dailyWords(language);
  const lines = [];
  const rowsJson = [];
  for (const [project, why] of refused) lines.push(`requires: ${project}: ${why}`);
  const pause = readPause(stateDir(env), now); // P5.5: a paused machine starts nothing, so every routine is "late" for a reason the owner set himself
  if (pause?.state === 'paused') lines.push(short(pauseLine(pause), 200));
  const events = boards.flatMap((b) => boardEvents(b, env));
  for (const b of boards) {
    const project = projectOf(b);
    const bw = dailyWords(b.config?.language);
    const rows = api.routineRows(b, now);
    if (rows.length && rows.every((r) => r.reasons.includes('board switch off')) && rows.some((r) => r.enabled)) {
      lines.push(`${project}: ${bw.off}`);
      continue;
    }
    for (const r of rows) {
      if (!r.enabled) continue;
      const target = `${project}/${r.id}`;
      const last = Date.parse(r.last_run ?? '');
      const age = Number.isFinite(last) ? now - last : null;
      const every = everyMs(r.every);
      const reasons = r.reasons.filter((x) => x !== 'outside hours');
      const mine = events.filter((e) => e.kind === 'routine' && e.project === project && e.id === r.id).at(-1);
      let line;
      let state;
      if (reasons.length) {
        state = 'blocked';
        line = `${target}: ${bw.blocked} (${short(reasons.join('; '), 80)})`;
      } else if (age === null) {
        state = 'never';
        line = `${target}: ${bw.never}`;
      } else if (!r.reasons.includes('outside hours') && Number.isFinite(every) && age > 2 * every) {
        state = 'overdue';
        line = `${target}: ${bw.overdue}, ${bw.last} ${ageText(age)} ${bw.ago} (${bw.every} ${r.every})`;
      } else {
        state = r.last_result ?? 'ok';
        const f = mine?.fields;
        const extra = f ? [f.problems?.length ? `${wordsFor(b.config?.language).problem} ${f.problems.map((p) => p.key).join(', ')}` : '', f.needs_owner ? `${wordsFor(b.config?.language).ask}: ${short(f.needs_owner, 60)}` : '', !f.problems?.length && !f.needs_owner && f.did?.[0] ? short(f.did[0], 70) : ''].filter(Boolean) : [];
        line = `${target}: ${wordsFor(b.config?.language)[state] ?? state} ${ageText(age)} ${bw.ago}${extra.length ? ` - ${extra.join('; ')}` : ''}`;
      }
      lines.push(line);
      rowsJson.push({ routine: target, state, last_run: r.last_run, last_result: r.last_result });
    }
  }
  // orchestrator runs, crashed and skipped runs of this machine in the last 24 hours
  const since = now - DAY_MS;
  const runs = [...readRuns(env).values()].filter((r) => Date.parse(r.finished ?? r.started ?? '') >= since);
  const orch = new Map();
  for (const r of runs.filter((x) => x.kind === 'orchestrator' && x.outcome !== 'skipped' && x.outcome !== 'started')) orch.set(r.agent, r);
  for (const [agent, r] of orch) lines.push(`${w.orch} ${agent}: ${r.outcome} ${ageText(now - Date.parse(r.finished))} ${w.ago}${r.did?.[0] ? ` - ${short(r.did[0], 70)}` : ''}`);
  const crashed = runs.filter((r) => BAD.has(r.outcome)).length;
  const skips = {};
  for (const r of runs.filter((x) => x.outcome === 'skipped')) skips[r.reason] = (skips[r.reason] ?? 0) + (r.count ?? 1);
  const machine = [crashed ? `${w.crashed} ${crashed}` : '', ...Object.entries(skips).map(([k, n]) => `${w.skipped} ${k} ${n}`)].filter(Boolean);
  if (machine.length) lines.push(`${w.machine}: ${machine.join(', ')}`);
  // tasks reported in the last 24 hours (the Log has a date: yesterday and today count)
  const day = isoAt(since).slice(0, 10);
  const reported = events.filter((e) => e.kind === 'task' && e.date >= day);
  if (reported.length) lines.push(`${w.tasks}: ${reported.length} (${reported.slice(0, 4).map((e) => `${e.project}/${e.id}`).join(', ')}${reported.length > 4 ? ', …' : ''})`);
  // what the owner's commands did (the audit of P5.3 writes owner-commands.jsonl; no file, no line)
  const cmds = readOwnerCommands(env, since, now);
  if (cmds.length) lines.push(`${w.owner}: ${cmds.length} (${cmds.slice(0, 3).map((c) => `${cleanText(c.command, 30)}${c.target ? ` ${cleanText(c.target, 30)}` : ''}${c.by ? ` ${w.by} ${cleanText(c.by, 40)}` : ''}${c.outcome && c.outcome !== 'ok' ? ` ${cleanText(c.outcome, 20)}` : ''}`).join('; ')}${cmds.length > 3 ? `; +${cmds.length - 3}` : ''})`);
  if (!lines.length) lines.push(`${w.head}: ${w.none}`);
  else lines.unshift(`${w.head} ${isoAt(now).slice(0, 10)}`);
  // one message must fit a chat
  let size = 0;
  const kept = [];
  for (const l of lines) {
    if (size + l.length + 1 > MAX_CHARS) break;
    kept.push(l);
    size += l.length + 1;
  }
  if (kept.length < lines.length) kept.push(`+${lines.length - kept.length} ${w.more}: roadctl routine list`);
  return { lines: kept, json: { routines: rowsJson, owner_commands: cmds.length } };
}

// ---------------------------------------------------------------- the module

export default {
  name: 'digest',
  commands: {
    digest: {
      group: 'Look', effect: 'write', hidden: true, summary: 'what to tell the owner about unattended runs: problems at once, a daily overview',
      purpose: 'Model-free text for a scheduler to forward to the owner (a chat, mail); roadctl sends nothing itself, and an empty output means silence. Without flags: what is new since the last digest of this state name and needs attention (a routine that escalated or failed, a run that crashed, a problem the agent reported with a new key, a question for the owner), each told once; a problem that went away is one "resolved" line. Policy per routine: header `notify: problems` (default; only the above), `always` (every run, skipped ones too) or `never`. `--daily`: one line per enabled routine (last result and age; OVERDUE when it has not run for twice its `every` inside its `hours`), the crashed and skipped runs of this machine, tasks reported and the owner\'s commands of the last 24 hours. The runs of another machine arrive through git: run `roadctl pull` first. A run of the duty orchestrator (`roadctl run done`) is local to its machine. What was told is remembered per state name in the state directory and marked only after the text was produced: if the delivery fails afterwards the message is lost and the daily overview is the safety net.',
      usage: ['roadctl digest [--since-state NAME] [--dry-run] [--all] [--json]', 'roadctl digest --daily [--all] [--json]'],
      flags: [['--since-state NAME', 'the delivery state to use (default "default"); one name per recipient or channel'], ['--daily', 'the overview instead of the news; does not change the delivery state'], ['--dry-run', 'print what would be sent without marking it as sent'], ['--all', 'every board of the central workspace, not only this project'], ['--json', 'machine-readable output (text, events)']],
      examples: ['roadctl pull && roadctl digest --all', 'roadctl digest --daily --all', 'roadctl digest --dry-run --since-state telegram'],
      changes: 'The delivery state in the machine state directory (digest.state.json); nothing on the board, nothing in git. With --daily or --dry-run nothing.',
      exits: '0 ok (also when there is nothing to say); 2 usage error or no board found',
      run: digestCommand,
    },
  },
};
