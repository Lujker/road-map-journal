// `roadctl stats` (P5.27): autonomy metrics for the owner, counted from what is already written: the Log lines of routines and cards in git (RUN, REPORT, RETURNED,
// ACCEPTED, `accepted`, `approved by mandate`), this machine's run ledger (P5.1: crashed, timeout, aborted, skipped runs, durations), the audit of owner commands
// (P5.3, owner-commands.jsonl plus the owner's traces in git) and the mandate (P5.33). Read only: nothing is written anywhere. Channels only show these numbers.
//
// Day granularity: the Log has a date and no time, so every comparison is by day. Not built yet (P5.24 questions and `undo`, P5.34 proposals, P5.35 milestones):
// their fields are in the JSON as null / empty, and a reader tolerates extra fields, so they fill in later without a change of the schema (scripts/testkit/stats-schema.mjs).
import fs from 'node:fs';
import { questionsFromItem } from './owner-questions-data.mjs';
import { boardEvents, loadBoards, readOwnerCommands } from './digest.mjs';
import { readMandate, takes } from './mandate.mjs';
import { cleanText, isoAt, nowMs, readRuns } from './run-store.mjs';

export const STATS_VERSION = 1;
const DAY = 864e5;
const DATE_RE = /^\d{4}-\d\d-\d\d$/;
const projectOf = (board) => String(board.project).split(/[\\/]/).filter(Boolean).pop();
const dayNum = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY);
const round = (x, k = 1000) => Math.round(x * k) / k;
const share = (n, d) => (d ? round(n / d) : null);
const trackOf = (id) => (String(id).includes('.') ? String(id).split('.')[0] : String(id).replace(/[-_]?\d+$/, '') || String(id)); // P5.27 -> P5, W-1 -> W: the kind of work of a card, no new key

/** { n, median, p90 } of a list of numbers; nothing: n 0 and nulls. */
function spread(list) {
  const v = list.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, p90: null };
  const mid = v.length >> 1;
  return { n: v.length, median: round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, 10), p90: v[Math.ceil(0.9 * v.length) - 1] };
}

/** What the owner's commands left in git, with their day: card `approved` and `accepted`, routine ON/OFF Log lines. [{ project, command, target, date }]. */
function gitCommands(boards) {
  const out = [];
  const day = (s) => String(s ?? '').split(',').map((x) => x.trim())[1];
  for (const b of boards) {
    const project = projectOf(b);
    for (const c of b.cards ?? []) {
      for (const [key, command] of [['approved', 'approve'], ['accepted', 'done']]) {
        const date = day(c.header[key]);
        if (c.header.id && DATE_RE.test(date ?? '')) out.push({ project, command, target: c.header.id, date });
      }
    }
    for (const r of b.routines ?? []) for (const l of r.log ?? []) if (/^(ON|OFF)\b/.test(l.text) && r.header.id) out.push({ project, command: `routine ${l.text.slice(0, 3).trim().toLowerCase()}`, target: r.header.id, date: l.date });
  }
  return out;
}

/** Every finished run the boards and this machine's ledger tell about, once: { project, id, kind, key, outcome, date, run_id, duration_s, fields }. */
function collectRuns(boards, env, since) {
  const names = new Set(boards.map(projectOf));
  const runs = boards.flatMap((b) => boardEvents(b, env)).map((e) => ({ project: e.project, id: e.id, kind: e.kind, outcome: e.outcome, date: e.date, run_id: e.run_id, duration_s: e.duration_s, fields: e.fields }));
  const seen = new Set(runs.map((r) => r.run_id).filter(Boolean));
  const skipped = {};
  for (const r of readRuns(env).values()) {
    const time = Date.parse(r.finished ?? r.started ?? '');
    if (!Number.isFinite(time) || r.outcome === 'started' || !names.has(r.project) || isoAt(time).slice(0, 10) < since) continue;
    if (r.outcome === 'skipped') skipped[r.reason] = (skipped[r.reason] ?? 0) + (r.count ?? 1);
    else if (!seen.has(r.run_id)) runs.push({ project: r.project, id: r.id, kind: r.kind, outcome: r.outcome, date: isoAt(time).slice(0, 10), run_id: r.run_id, duration_s: r.duration_s, fields: { did: r.did, decisions: r.decisions, problems: r.problems, needs_owner: r.needs_owner, not_checked: r.not_checked }, local: true });
  }
  return { runs: runs.filter((r) => r.date >= since), skipped };
}

/**
 * The definition of "without the owner": the run ended `ok`, it asked nothing (no `needs_owner`), and the owner ran no command on the same target in the
 * days after it up to the next run of that target (the day of the next run included). Sets `r.owner_cmds` on every run; returns the runs.
 */
function markOwner(runs, commands) {
  const by = new Map();
  for (const r of runs) (by.get(`${r.project}/${r.id}`) ?? by.set(`${r.project}/${r.id}`, []).get(`${r.project}/${r.id}`)).push(r);
  for (const list of by.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    list.forEach((r, i) => {
      const end = list[i + 1]?.date ?? '9999-12-31';
      r.owner_cmds = commands.filter((c) => c.target === r.id && (!c.project || c.project === r.project) && c.date > r.date && c.date <= end).length;
      r.autonomous = r.outcome === 'ok' && !r.fields.needs_owner && r.owner_cmds === 0;
    });
  }
  return runs;
}

const group = (runs, keyOf) => {
  const g = {};
  for (const r of runs) {
    const k = keyOf(r);
    g[k] ??= { runs: 0, without_owner: 0 };
    g[k].runs++;
    if (r.autonomous) g[k].without_owner++;
  }
  return Object.fromEntries(Object.keys(g).sort().map((k) => [k, { ...g[k], share: share(g[k].without_owner, g[k].runs) }]));
};

/** Wait of the owner for the review of cards: the day a card reached review (its last ACCEPTED or REPORT Log line) to `accepted`, counted from `acceptFrom` when it is later. */
function reviewWait(boards, { since, acceptFrom, today }) {
  const closed = [];
  let open = 0;
  let unknown = 0;
  const openAges = [];
  for (const b of boards) {
    for (const c of b.cards ?? []) {
      const h = c.header;
      const start = (c.log ?? []).filter((l) => /^(ACCEPTED the reported|REPORT:)/.test(l.text)).map((l) => l.date).sort().at(-1);
      const accepted = String(h.accepted ?? '').split(',').map((x) => x.trim())[1];
      const status = b.config?.status_map?.[h.status ?? ''] ?? h.status;
      if (DATE_RE.test(accepted ?? '')) {
        if (accepted < since || (acceptFrom && accepted < acceptFrom)) continue;
        if (!start) unknown++;
        else closed.push(Math.max(0, dayNum(accepted) - dayNum(acceptFrom && acceptFrom > start ? acceptFrom : start)));
      } else if (status === 'review') {
        if (!start) unknown++;
        else {
          open++;
          openAges.push(Math.max(0, dayNum(today) - dayNum(acceptFrom && acceptFrom > start ? acceptFrom : start)));
        }
      }
    }
  }
  const s = spread(closed);
  return { n: s.n, median_days: s.median, p90_days: s.p90, open, open_oldest_days: openAges.length ? Math.max(...openAges) : null, unknown_start: unknown };
}

/** The whole report as data (the JSON of `roadctl stats --json`). */
export function computeStats({ boards, env, api, since = '0000-00-00', acceptFrom = null }) {
  const now = nowMs(env);
  const today = isoAt(now).slice(0, 10);
  const { runs, skipped } = collectRuns(boards, env, since);
  const audit = readOwnerCommands(env, Date.parse(`${since === '0000-00-00' ? '1970-01-01' : since}T00:00:00Z`), now).filter((c) => c.outcome === 'ok').map((c) => ({ project: null, command: c.command, target: c.target, date: String(c.time).slice(0, 10) }));
  const git = gitCommands(boards).filter((c) => c.date >= since);
  markOwner(runs, [...audit, ...git]);
  const problems = new Map();
  for (const r of runs) for (const p of r.fields.problems ?? []) problems.set(p.key, { key: p.key, kind: p.kind, n: (problems.get(p.key)?.n ?? 0) + 1 });
  const taskRuns = runs.filter((r) => r.kind === 'task').length;
  const returned = boards.flatMap((b) => (b.cards ?? []).flatMap((c) => (c.log ?? []).filter((l) => /^RETURNED:/.test(l.text) && l.date >= since).map(() => c.header.id)));
  const outcome = (o) => runs.filter((r) => r.outcome === o).length;
  const taken = boards.flatMap((b) => takes(b).filter((t) => t.date >= since).map((t) => t.id));
  let questions = [];
  const questionFormat = boards.length > 0 && boards.every((b) => (api.compareVersions(b.config.requires, '0.13.0') ?? -1) >= 0);
  let questionsValid = questionFormat;
  if (questionFormat) for (const b of boards) for (const item of [...b.cards, ...(b.routines ?? [])]) {
    try { questions.push(...questionsFromItem(fs.readFileSync(item.file, 'utf8'))); } catch { questionsValid = false; }
  }
  const decisions = questions.filter((q) => !q.blocking && q.created.slice(0, 10) >= since && Date.parse(q.created) <= now);
  const blocking = questions.filter((q) => q.blocking && Date.parse(q.created) > now - 7 * DAY && Date.parse(q.created) <= now && q.created.slice(0, 10) >= since);
  const proposed = since === '0000-00-00' && boards.length && boards.every((b) => (api.compareVersions(b.config.requires, '0.15.0') ?? -1) >= 0)
    ? boards.flatMap((b) => b.cards.filter((c) => (b.config.status_map?.[c.header.status] ?? c.header.status) === 'idea' && /^sha256-v1:[a-f0-9]{64}$/.test(c.header.proposed ?? ''))).length : null;
  return {
    stats: STATS_VERSION,
    generated: isoAt(now),
    since: since === '0000-00-00' ? null : since,
    accept_from: acceptFrom,
    projects: boards.map(projectOf),
    sources: { board_logs: runs.filter((r) => !r.local).length, local_runs: runs.filter((r) => r.local).length, owner_audit: audit.length, owner_git: git.length },
    runs: { total: runs.length, ok: outcome('ok'), escalated: outcome('escalated'), failed: outcome('failed'), crashed: outcome('crashed'), timeout: outcome('timeout'), aborted: outcome('aborted'), skipped, duration_s: spread(runs.map((r) => r.duration_s)) },
    autonomy: { runs: runs.length, without_owner: runs.filter((r) => r.autonomous).length, share: share(runs.filter((r) => r.autonomous).length, runs.length), by_routine: group(runs.filter((r) => r.kind === 'routine'), (r) => `${r.project}/${r.id}`), by_track: group(runs.filter((r) => r.kind !== 'routine'), (r) => (r.kind === 'task' ? trackOf(r.id) : r.kind)) },
    owner_wait: { review_to_acceptance: reviewWait(boards, { since, acceptFrom, today }), question_to_answer: { n: 0, median_days: null, p90_days: null } },
    escalations: { escalated_runs: outcome('escalated'), asks: runs.filter((r) => r.fields.needs_owner).length, top_problems: [...problems.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)).slice(0, 10) },
    returns: { returned: returned.length, cards: new Set(returned).size, task_reports: taskRuns, share_of_reports: share(returned.length, taskRuns) },
    mandate: { boards: boards.map((b) => { const m = readMandate(b, api); return { project: projectOf(b), level: m?.level ?? null, state: m?.state ?? 'none' }; }), started_by_mandate: { n: taken.length, cards: [...new Set(taken)].sort() }, proposed, undone_share: questionsValid ? share(decisions.filter((q) => q.state === 'undone').length, decisions.length) : null, blocking_questions_per_week: questionsValid ? blocking.length : null, milestone_returns: null },
  };
}

const pct = (s) => (s === null ? '-' : `${Math.round(s * 100)}%`);
const days = (s) => (s.n ? `median ${s.median_days}d, p90 ${s.p90_days}d (${s.n})` : 'none');

export function formatStats(j) {
  const a = j.autonomy;
  const w = j.owner_wait.review_to_acceptance;
  const L = [`roadctl stats ${j.generated.slice(0, 10)}: ${j.projects.join(', ')}${j.since ? `, since ${j.since}` : ''}`];
  L.push(`runs: ${j.runs.total} (ok ${j.runs.ok}, escalated ${j.runs.escalated}, failed ${j.runs.failed}, crashed ${j.runs.crashed}, timeout ${j.runs.timeout}, aborted ${j.runs.aborted}); run time ${j.runs.duration_s.n ? `median ${j.runs.duration_s.median}s, p90 ${j.runs.duration_s.p90}s` : 'unknown'}`);
  L.push(`without the owner: ${a.without_owner} of ${a.runs} (${pct(a.share)})`);
  for (const [k, g] of Object.entries({ ...a.by_routine, ...a.by_track })) L.push(`  ${cleanText(k, 60)}: ${g.without_owner} of ${g.runs} (${pct(g.share)})`);
  L.push(`owner wait, review to acceptance${j.accept_from ? ` (from ${j.accept_from})` : ''}: ${days({ n: w.n, median_days: w.median_days, p90_days: w.p90_days })}; ${w.open} still in review${w.open_oldest_days === null ? '' : `, oldest ${w.open_oldest_days}d`}`);
  L.push(`escalations: ${j.escalations.escalated_runs} runs, ${j.escalations.asks} questions to the owner${j.escalations.top_problems.length ? `; problems: ${j.escalations.top_problems.map((p) => `${cleanText(p.key, 40)} x${p.n}`).join(', ')}` : ''}`);
  L.push(`returned from review: ${j.returns.returned} (${j.returns.cards} cards, ${pct(j.returns.share_of_reports)} of ${j.returns.task_reports} task reports)`);
  L.push(`mandate: ${j.mandate.boards.map((b) => `${b.project} ${b.level ?? 'none'}`).join(', ')}; cards started by it: ${j.mandate.started_by_mandate.n}; proposed now: ${j.mandate.proposed ?? 'unknown'}; undone: ${pct(j.mandate.undone_share)}; blocking questions, last 7 days: ${j.mandate.blocking_questions_per_week ?? 'unknown'}; milestone returns: not counted yet`);
  return L;
}

const STATS_USAGE = 'usage: roadctl stats [--since DATE] [--accept-from DATE] [--all] [--json]';

function statsCommand({ flags, args, out, env, api }) {
  if (args.length > 1) throw new Error(STATS_USAGE);
  for (const f of ['since', 'accept-from']) if (flags[f] !== undefined && !(typeof flags[f] === 'string' && DATE_RE.test(flags[f]))) throw new Error(`${STATS_USAGE}; --${f} is a date YYYY-MM-DD`);
  const warn = (s) => process.stderr.write(`${s}\n`);
  const boards = loadBoards(flags, env, api, warn).filter((b) => {
    const why = api.boardRequires(b.config);
    if (why) warn(`roadctl stats: warning: board ${projectOf(b)} skipped: ${cleanText(why, 120)}`);
    return !why;
  });
  const j = computeStats({ boards, env, api, since: flags.since ?? '0000-00-00', acceptFrom: flags['accept-from'] ?? null });
  if (flags.json) out(JSON.stringify(j, null, 2));
  else for (const l of formatStats(j)) out(l);
  return 0;
}

export default {
  name: 'stats',
  commands: {
    stats: {
      group: 'Look', effect: 'read', hidden: true, summary: 'autonomy metrics: how much work ran without the owner, how long the owner takes, why runs escalate',
      purpose: 'Numbers for the owner who decides which kinds of work may go without confirmation; roadctl counts them from the Log lines of routines and cards in git (RUN, REPORT, RETURNED, ACCEPTED, `accepted`), this machine\'s run ledger (crashed, timeout, aborted and skipped runs, durations), the audit of owner commands (owner-commands.jsonl and the owner\'s traces in git) and the mandate. A run is WITHOUT THE OWNER when it ended ok, asked nothing (no `ask`) and the owner ran no command on the same routine or card after it, up to the next run of that target (days are compared, the Log has no time; a command on the day of the next run counts for the earlier run). Shown: the share of such runs per routine and per kind of work (the id of a routine, the track prefix of a card id such as P5); the wait for acceptance (the day a card reached review to its `accepted`, median and p90, and the cards still in review); escalations (runs that escalated, questions, the most frequent `--problem` keys); returns from review (RETURNED lines against task reports); failures, timeouts and run time; the mandate (level, cards started by it). Question to answer and milestone returns are not counted yet. Proposed is the current snapshot on 0.15 boards, not a historical count; it is null with --since. Undone share counts reversible decisions created in the selected period; blocking questions per week counts the last seven days, bounded by --since. Unreadable question data makes both numbers unknown. The runs of another machine arrive through git: run `roadctl pull` first. Read only.',
      usage: ['roadctl stats [--since DATE] [--accept-from DATE] [--all] [--json]'],
      flags: [['--since DATE', 'count only runs, returns and owner commands from that day (YYYY-MM-DD); default: all history'], ['--accept-from DATE', 'the wait for acceptance counts from that day and leaves out acceptances before it; for deferred acceptance of a pile of cards in review, give the date of the release candidate'], ['--all', 'every board of the central workspace, not only this project'], ['--json', 'machine-readable output (schema: scripts/testkit/stats-schema.mjs)']],
      examples: ['roadctl stats', 'roadctl stats --all --since 2026-11-01 --json', 'roadctl stats --accept-from 2026-11-20'],
      changes: 'Nothing: no board file, no state file, no git.',
      exits: '0 ok (also when there is no data); 2 usage error or no board found',
      run: statsCommand,
    },
  },
};
