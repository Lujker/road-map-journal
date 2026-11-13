// Run ledger module (P5.1): every run of a routine, a delegated task or an orchestrator leaves a record in the machine's state directory
// (runs.jsonl, see run-store.mjs), not only the decision of `tick`. Commands: `run begin|note` (hidden, for agents and schedulers),
// `runs` (the owner's view). Hooks (registry.mjs HOOK_NAMES): tick-before (crashed by time threshold, attempt of a RUN item), tick-ledger
// (folded ticks.jsonl, rotation, skipped: busy), `tick` observer (skipped: limits, not-due), routine-done-before/after (the Log line with
// run_id, duration and host; the end record), claim-after and report-after (a delegated task is a run).
// Everything here degrades quietly: a state directory that cannot be used never stops routine done, claim, report or tick.
import {
  badAttempts, beginRun, clearSkips, DEFAULT_TIMEOUT_MS, finishRun, hostName, isOverdue, ledgerPaths, locateRun, noteRun, nowMs, readRuns, readState,
  reconcileCrashed, recordSkip, recordTick, RUNS_ROTATE_BYTES, rotateIfLarge, runIdFor, cleanText, usable,
} from './run-store.mjs';

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const RUN_USAGE = 'usage: roadctl run begin <routine|card> --as AGENT [--run ID]   |   roadctl run note [RUN_ID] "what was done" [--as AGENT]';
const projectOf = (board) => String(board.project).split(/[\\/]/).filter(Boolean).pop();

// ---------------------------------------------------------------- the line `routine done` leaves in the routine's Log

/** ` [run=ID dur=NNs host=H]`: the last part of the Log line of a run. The other machine sees only git, so this is how it reads the run back. */
export const formatRunTrailer = ({ run_id, duration_s = null, host }) => `[run=${run_id}${Number.isInteger(duration_s) ? ` dur=${duration_s}s` : ''} host=${host}]`;
const TRAILER_RE = / ?\[run=([A-Za-z0-9._:-]+)(?: dur=(\d+)s)? host=([A-Za-z0-9._-]+)\]$/;
/** The inverse: { text (without the trailer), run_id, duration_s (null when the run had no begin), host }, or null when the text has no trailer. */
export function parseRunTrailer(text) {
  const m = TRAILER_RE.exec(String(text ?? ''));
  return m ? { text: String(text).slice(0, m.index), run_id: m[1], duration_s: m[2] === undefined ? null : Number(m[2]), host: m[3] } : null;
}

/** `timeout:` of a routine header (`30m`, `2h`, `1d`; 5 minutes to 30 days) in ms, or the default; invalid values fall back to the default (lint reports them). */
export function timeoutMs(value) {
  const m = String(value ?? '').match(/^(\d+)(m|h|d)$/);
  const ms = m ? Number(m[1]) * { m: 60e3, h: 3600e3, d: 864e5 }[m[2]] : NaN;
  return Number.isFinite(ms) && ms >= 5 * 60e3 && ms <= 30 * 864e5 ? ms : DEFAULT_TIMEOUT_MS;
}

const routineOf = (board, id) => (board.routines ?? []).find((r) => r.header.id === id);
const taskAnchor = (card) => /\bat=(\S+)/.exec(card?.header?.claim ?? '')?.[1] ?? null;
const taskUntil = (card) => Date.parse(/\buntil=(\S+)/.exec(card?.header?.claim ?? '')?.[1] ?? '');

const attempt = (fn) => {
  try {
    return fn();
  } catch {
    return undefined; // a ledger problem is never an error of the command that called the hook
  }
};

// ---------------------------------------------------------------- commands

function runBegin({ flags, args, out, env, api }) {
  const id = args[2];
  const as = typeof flags.as === 'string' ? flags.as : null;
  if (!id || !as) throw new Error(RUN_USAGE);
  if (flags.run !== undefined && !(typeof flags.run === 'string' && RUN_ID_RE.test(flags.run))) throw new Error(`${RUN_USAGE}; --run is an id of letters, digits and . _ : - (up to 64)`);
  const dir = api.findBoard(process.cwd(), typeof flags.board === 'string' ? flags.board : undefined, env);
  if (!dir) throw new Error('no board found; run inside the project or use --board DIR / --project NAME');
  const board = api.loadBoard(dir);
  const now = nowMs(env);
  const explicit = flags.run ?? (RUN_ID_RE.test(env.ROADCTL_RUN_ID ?? '') ? env.ROADCTL_RUN_ID : undefined);
  const r = routineOf(board, id);
  let p;
  if (r) {
    if (r.header.agent !== as) {
      process.stderr.write(`roadctl run begin: refused: only the routine's agent (${cleanText(r.header.agent ?? '-', 60)}) may begin its run, not ${cleanText(as, 60)}\n`);
      return 1;
    }
    p = { kind: 'routine', project: projectOf(board), id, agent: as, model: r.header.model ?? null, anchor: r.header.last_run ?? null, deadlineMs: now + timeoutMs(r.header.timeout) };
  } else {
    const card = board.cards.find((c) => c.header.id === id);
    if (!card) throw new Error(`no routine or card with id ${cleanText(id, 60)}`);
    const until = taskUntil(card);
    p = { kind: 'task', project: projectOf(board), id, agent: as, model: null, anchor: taskAnchor(card), deadlineMs: Number.isFinite(until) && until > now ? until : now + DEFAULT_TIMEOUT_MS };
  }
  const res = beginRun(env, { ...p, runId: explicit, now, version: api.VERSION });
  if (res.status === 'unavailable') {
    process.stderr.write(`roadctl run begin: warning: ${res.reason}; this run is not recorded (it can still go on)\n`);
    out(flags.json ? JSON.stringify({ status: 'unavailable', run_id: null }) : 'run not recorded (run ledger unavailable)');
    return 0;
  }
  const run = res.run;
  if (flags.json) out(JSON.stringify({ status: res.status, run }, null, 2));
  else if (res.status === 'already') out(`run ${run.run_id} already begun at ${run.started ?? '?'} by ${run.agent ?? '?'} (${run.outcome}); do not start another`);
  else out(`run ${run.run_id} begun (${run.kind} ${run.project}/${run.id}, attempt ${run.attempt}); counts as crashed if not finished by ${run.deadline}`);
  return res.status === 'already' ? 5 : 0;
}

function runNote({ flags, args, out, env }) {
  const rest = args.slice(2);
  if (rest.length < 1 || rest.length > 2) throw new Error(RUN_USAGE);
  const text = rest.at(-1);
  if (!String(text).trim()) throw new Error(RUN_USAGE);
  let runId = rest.length === 2 ? rest[0] : env.ROADCTL_RUN_ID?.trim();
  const u = usable(env);
  if (!u.ok) {
    process.stderr.write(`roadctl run note: warning: ${u.reason}; the note is not recorded\n`);
    return 0;
  }
  const runs = readRuns(env);
  if (!runId) {
    const as = typeof flags.as === 'string' ? flags.as : null;
    const open = [...runs.values()].filter((r) => r.outcome === 'started' && r.agent === as);
    if (!as || open.length !== 1) throw new Error(`${RUN_USAGE}; without a run id, ROADCTL_RUN_ID or exactly one open run of --as AGENT is needed (${as ? `${open.length} open` : 'no --as'})`);
    runId = open[0].run_id;
  }
  if (!runs.has(runId)) throw new Error(`no run ${cleanText(runId, 70)} in the run ledger of this machine (roadctl runs --open)`);
  const ok = noteRun(env, runId, text, nowMs(env));
  out(ok ? `noted on run ${runId}` : `run ${runId}: the note could not be written (run ledger unavailable)`);
  return 0;
}

const stamp = (r) => r.finished ?? r.started ?? '';

function runsCommand({ flags, args, out, env }) {
  let n = 20;
  for (let i = 1; i < args.length; i++) {
    const m = args[i] === '-n' ? args[i + 1] : /^-n(\d+)$/.exec(args[i])?.[1];
    if (m !== undefined) n = Number(m);
  }
  if (!Number.isInteger(n) || n < 1) throw new Error('usage: roadctl runs [--open] [--json] [--as AGENT] [-n 20]');
  let rows = [...readRuns(env).values()];
  if (flags.open) rows = rows.filter((r) => r.outcome === 'started');
  if (typeof flags.as === 'string') rows = rows.filter((r) => r.agent === flags.as);
  rows.sort((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : a.run_id < b.run_id ? -1 : 1));
  rows = rows.slice(-n);
  if (flags.json) out(JSON.stringify(rows, null, 2));
  else if (!rows.length) out(flags.open ? 'no open runs' : 'no runs recorded');
  else {
    const now = nowMs(env);
    for (const r of rows) {
      const late = isOverdue(r, now) ? ' OVERDUE (will be marked crashed by the next tick)' : '';
      out(`${stamp(r)} ${r.outcome}${r.reason && r.outcome === 'skipped' ? `:${r.reason}` : ''} ${r.kind} ${r.project ?? '-'}/${r.id} ${r.agent ?? '-'} run=${r.run_id}${r.duration_s !== null ? ` dur=${r.duration_s}s` : ''}${r.attempt > 1 ? ` attempt=${r.attempt}` : ''}${r.count > 1 ? ` x${r.count}` : ''}${r.outcome === 'crashed' || r.outcome === 'started' ? (r.note ? ` last note: ${cleanText(r.note, 80)}` : '') : ''}${late}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------- the module

export default {
  name: 'run-ledger',
  commands: {
    run: {
      group: 'Record', effect: 'write', hidden: true, summary: 'begin a run or leave a checkpoint in the local run ledger',
      purpose: 'For paths without a supervisor. `begin` records the start of a run of a routine (or of a card) and prints its run id; a second `begin` of the same thing while the first is open answers "already begun" with exit code 5, so two schedulers on one machine do not both run it. `note` leaves a cheap local checkpoint on an open run; the last one stays in the record if the run is broken off. The run id can come from ROADCTL_RUN_ID instead of the command line, and `routine done` finds its run by itself. Nothing goes to git; a state directory that cannot be written is a warning, not a failure.',
      usage: ['roadctl run begin <routine|card> --as AGENT [--run ID]', 'roadctl run note [RUN_ID] "what was done" [--as AGENT]'],
      flags: [['--as AGENT', 'the agent that runs it (for a routine: the routine\'s own agent)'], ['--run ID', 'use this run id instead of the derived one (ROADCTL_RUN_ID does the same)'], ['--json', 'machine-readable output of begin']],
      examples: ['roadctl run begin server-watch --as claude-code@home-wsl', 'roadctl run note "checked 7 of 9 servers"'],
      changes: 'Appends to runs.jsonl in the machine state directory (not to the board, not to git).',
      exits: '0 recorded (or not recorded because the ledger is unavailable, with a warning); 5 already begun; 1 refused (not the routine\'s agent); 2 usage error',
      run(ctx) {
        const sub = ctx.args[1];
        if (sub === 'begin') return runBegin(ctx);
        if (sub === 'note') return runNote(ctx);
        throw new Error(RUN_USAGE);
      },
    },
    runs: {
      group: 'Look', effect: 'read', hidden: true, summary: 'runs of routines, tasks and orchestrators on this machine',
      purpose: 'Reads the local run ledger: when each run started and ended, its outcome (started, ok, escalated, failed, timeout, aborted, crashed, skipped with a reason busy, limits or not-due), attempt, duration and the summary fields. A run that has no end after its deadline is marked crashed by the next tick. The ledger is per machine and holds the text of run summaries; it is never inside a git work tree. Writes nothing.',
      usage: ['roadctl runs [--open] [--json] [--as AGENT] [-n 20]'],
      flags: [['--open', 'only runs that have begun and not ended'], ['--as AGENT', 'only runs of this agent'], ['--json', 'an array of run records (fields: docs/roadctl.md, "Run ledger")']],
      examples: ['roadctl runs', 'roadctl runs --open', 'roadctl runs --json -n 50'],
      changes: 'Nothing.', exits: '0 ok; 2 usage error',
      run: runsCommand,
    },
  },

  hooks: {
    /** Before the decision of a tick: mark overdue unsupervised runs crashed (time threshold only), rotate runs.jsonl, tell the RUN items their attempt. */
    'tick-before'({ env, items }) {
      const now = nowMs(env);
      if (!usable(env).ok) return {};
      attempt(() => reconcileCrashed(env, now));
      attempt(() => rotateIfLarge(ledgerPaths(env).runs, RUNS_ROTATE_BYTES));
      const runs = readRuns(env);
      const run = {};
      for (const i of items) {
        if (i.kind !== 'RUN') continue;
        const n = badAttempts(runs, `routine:${i.project}/${i.id}`, i.routine?.last_run);
        if (n > 0) run[`${i.project}/${i.id}`] = { attempt: n + 1 };
      }
      return { run };
    },

    /** The ticks.jsonl line: folded and rotated (inside tick only); a busy or paused tick (it decided nothing: no lock) also leaves a skipped record with that reason. */
    'tick-ledger'({ env, entry, api }) {
      const skip = ['busy', 'paused'].includes(entry.decision) ? entry.decision : null; // paused: P5.5, the owner's local switch
      const handled = recordTick(env, entry, { rotate: !skip });
      const now = Date.parse(entry.time);
      const ours = (s) => s.agent === entry.agent && ['busy', 'paused'].includes(s.reason);
      if (skip) recordSkip(env, { kind: entry.filter?.routine ? 'routine' : 'orchestrator', project: null, id: entry.filter?.routine ?? entry.agent, agent: entry.agent, reason: skip, now, version: api?.VERSION });
      else if (Object.values(readState(env).skips).some(ours)) clearSkips(env, (k, s) => ours(s));
      return { handled };
    },

    /** The Log line of a routine run gets run_id, duration and host; a `--run` that belongs to another routine is refused. */
    'routine-done-before'({ board, id, flags, env, text }) {
      const r = routineOf(board, id);
      const base = cleanText(text, 1500);
      if (!r || !base) return {}; // routineDone refuses these itself
      if (flags.run !== undefined && !(typeof flags.run === 'string' && RUN_ID_RE.test(flags.run))) return { refuse: '--run is an id of letters, digits and . _ : - (up to 64)' };
      const now = nowMs(env);
      const key = { kind: 'routine', project: projectOf(board), id };
      const anchor = r.header.last_run ?? null;
      const explicit = flags.run ?? (RUN_ID_RE.test(env.ROADCTL_RUN_ID ?? '') ? env.ROADCTL_RUN_ID : undefined);
      let plan = { run_id: runIdFor(`${key.kind}:${key.project}/${id}`, anchor, 1), run: null, problem: null };
      if (usable(env).ok) plan = attempt(() => locateRun(env, { ...key, runId: explicit, anchor })) ?? plan;
      else if (explicit) plan.run_id = explicit;
      if (plan.problem) return { refuse: plan.problem };
      if (!plan.run && !explicit) return { plan, now, anchor, key }; // no begin and no id given: the Log line stays as it always was (old boards and tests); the ledger still gets the run
      const duration_s = plan.run?.started ? Math.max(0, Math.round((now - Date.parse(plan.run.started)) / 1000)) : null;
      const trailer = formatRunTrailer({ run_id: plan.run_id, duration_s, host: hostName(env) });
      return { text: `${cleanText(text, 1500 - trailer.length - 1)} ${trailer}`, plan, now, anchor, key };
    },

    /** After `routine done` recorded the run: the end record (the run found by the before hook, or a whole record when there was no begin). */
    'routine-done-after'({ board, id, as, result, text, done, env, prior, api }) {
      if (!prior?.plan || !['recorded', 'recorded-local'].includes(done?.status)) return;
      attempt(() => finishRun(env, { runId: prior.plan.run_id, plan: prior.plan, ...prior.key, agent: as, model: routineOf(board, id)?.header.model ?? null, outcome: result, fields: { did: [cleanText(text, 120)], writes: [`routine:${id}`] }, anchor: prior.anchor, now: prior.now, version: api.VERSION }));
    },

    /** A claim starts a run of the task (a claim still open is marked crashed first: the lease ran out and the card was taken over). */
    'claim-after'({ board, id, as, r, env, api }) {
      if (!['claimed', 'claimed-local'].includes(r?.status)) return;
      const now = nowMs(env);
      const until = Date.parse(r.claim?.until ?? '');
      attempt(() => beginRun(env, { kind: 'task', project: projectOf(board), id, agent: as, model: null, anchor: r.claim?.at ?? null, deadlineMs: Number.isFinite(until) && until > now ? until : now + DEFAULT_TIMEOUT_MS, now, version: api.VERSION, supersede: true }));
    },

    /** A report ends the run of the task (the report text is the first summary line until P5.13 gives the agent proper fields). */
    'report-after'({ board, id, as, r, text, env, api }) {
      if (!['reported', 'reported-local'].includes(r?.status)) return;
      const key = { kind: 'task', project: projectOf(board), id };
      const now = nowMs(env);
      attempt(() => {
        const plan = locateRun(env, { ...key, anchor: null });
        finishRun(env, { runId: plan.run_id, plan, ...key, agent: as, model: null, outcome: 'ok', fields: { did: [cleanText(text, 120)], writes: [`card:${id}`] }, anchor: null, now, version: api.VERSION });
      });
    },
  },

  /** Observer after the decision: skipped: limits (a closed gate with items) and skipped: not-due (a routine that is allowed but not due), folded. */
  tick({ env, agent, decision, items, routines = [], filter, api }) {
    if (!usable(env).ok) return;
    const now = nowMs(env);
    const version = api?.VERSION;
    const drop = [];
    if (decision === 'blocked-reserve' || decision === 'blocked-unknown') {
      for (const i of items.filter((x) => x.kind === 'RUN')) recordSkip(env, { kind: 'routine', project: i.project, id: i.id, agent, reason: 'limits', now, version });
      if (items.some((x) => x.kind !== 'RUN')) recordSkip(env, { kind: 'orchestrator', project: null, id: agent, agent, reason: 'limits', now, version });
    } else drop.push((k, s) => s.agent === agent && s.reason === 'limits');
    const looksAt = (r) => r.agent === agent && (!filter || (filter.routine ? r.id === filter.routine : !filter.kinds || filter.kinds.includes('run')));
    for (const r of routines.filter(looksAt)) {
      const key = `routine:${r.project}/${r.id}|${agent}`;
      if (!r.reasons.length && !r.due) recordSkip(env, { kind: 'routine', project: r.project, id: r.id, agent, reason: 'not-due', now, version });
      else drop.push((k, s) => k === key && s.reason === 'not-due');
    }
    if (drop.length) clearSkips(env, (k, s) => drop.some((f) => f(k, s)));
  },
};
