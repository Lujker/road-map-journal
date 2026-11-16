// P5.27: `roadctl stats` (module stats.mjs): autonomy metrics counted from Logs in git, the local run ledger, the owner audit and the mandate. Read only.
// Run: node --test scripts/roadctl/stats.test.mjs
// Boards are written by hand with a fixed Log, so every number below can be counted on paper. Nothing here starts a model or reaches a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { statsJsonProblems } from '../testkit/stats-schema.mjs';
import { clock } from '../testkit/time.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const DOCS = fs.readFileSync(path.join(here, '..', '..', 'docs', 'roadctl.md'), 'utf8');
const NOREG = path.join(os.tmpdir(), 'rc-no-registry', 'registry.json');
const NOW = '2026-11-20T12:00:00Z';
const HASH = `sha256-v1:${'a'.repeat(64)}`;
const ME = 'claude-code@home-wsl';
const R = (n, dur) => `[run=r-${String(n).padStart(12, '0')}${dur ? ` dur=${dur}s` : ''} host=h]`;

const card = (id, header, log) => `---\nid: ${id}\ntitle: Card ${id}\n${header}as_of: 2026-11-10\n---\n\n## Goal\nx\n\n## Log\n${log.map((l) => `- ${l}`).join('\n')}\n`;
const routine = (id, log) => `---\nid: ${id}\ntitle: Routine ${id}\nevery: 2h\nenabled: true\nagent: ${ME}\nmodel: haiku\nenv: laptop\n---\n\n## Goal\nx\n\n## Log\n${log.map((l) => `- ${l}`).join('\n')}\n`;

/** An empty workspace with one board `my-app`; files() writes cards and routines, ledger() and audit() write the machine's local files. */
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-stats-'));
  const ws = path.join(dir, 'ws');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.mkdirSync(path.join(board, 'cards'), { recursive: true });
  fs.mkdirSync(path.join(board, 'routines'), { recursive: true });
  fs.writeFileSync(path.join(board, 'config.json'), JSON.stringify({ board_version: 1, title: 'App', status_map: {} }));
  const state = path.join(dir, 'state');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: state, XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'cfg'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: NOREG, ROADCTL_HOST: 'h', ...clock(NOW) };
  delete env.ROADCTL_RUN_ID;
  delete env.ROADCTL_UNATTENDED;
  const stateDir = path.join(state, 'road-map-journal');
  const run = (args = []) => spawnSync(process.execPath, [SELF, 'stats', ...args, '--board', board], { cwd: ws, encoding: 'utf8', env });
  const json = (args = []) => {
    const r = run(['--json', ...args]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(statsJsonProblems(j), []);
    return j;
  };
  return {
    dir, board, stateDir, run, json,
    card: (id, header, log) => fs.writeFileSync(path.join(board, 'cards', `${id}.md`), card(id, header, log)),
    routine: (id, log) => fs.writeFileSync(path.join(board, 'routines', `${id}.md`), routine(id, log)),
    ledger: (rows) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'runs.jsonl'), `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`); },
    audit: (rows) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'owner-commands.jsonl'), `${rows.map((x) => JSON.stringify(x)).join('\n')}\nnot json\n`); },
  };
}

/** The fixture counted by hand in the tests: 6 routine runs, 4 task runs. */
function fixture() {
  const r = rig();
  r.routine('mr-status', [
    `2026-11-01 [${ME}] RUN ok: did: a ${R(1, 60)}`,
    `2026-11-02 [${ME}] RUN ok: did: b | ask: need a decision ${R(2, 120)}`,
    `2026-11-03 [${ME}] RUN escalated: did: c | problem: permanent: disk-full: no space; transient: dns-timeout: one lookup ${R(3, 180)}`,
    `2026-11-04 [${ME}] RUN ok: did: d ${R(4, 30)}`,
    '2026-11-05 [Owner] OFF by Owner, then on again',
    `2026-11-08 [${ME}] RUN ok: did: e ${R(5)}`,
  ]);
  r.card('P5.1', 'status: review\napproved: Owner, 2026-11-01, scope=implementation\naccepted: Owner, 2026-11-12\n', [`2026-11-05 [${ME}] REPORT: did: x ${R(6, 300)}`, `2026-11-06 [${ME}] ACCEPTED the reported result (criteria all); not yet verified by the owner`]);
  r.card('P5.2', 'status: review\napproved: Owner, 2026-11-01, scope=implementation\n', [
    `2026-11-07 [${ME}] approved by mandate ${HASH}`,
    `2026-11-08 [${ME}] REPORT: did: y | problem: transient: dns-timeout: again ${R(7)}`,
    `2026-11-09 [${ME}] RETURNED: fix the test`,
    `2026-11-10 [${ME}] REPORT: did: y2 ${R(8)}`,
  ]);
  r.card('F-1', 'status: done\napproved: Owner, 2026-11-10, scope=implementation\naccepted: Owner, 2026-11-13\n', [`2026-11-07 [${ME}] approved by mandate ${HASH}`, `2026-11-11 [${ME}] REPORT: did: z ${R(9)}`]);
  r.ledger([
    { event: 'end', run_id: 'r-000000000001', kind: 'routine', id: 'mr-status', project: 'my-app', outcome: 'ok', started: '2026-11-01T09:00:00Z', finished: '2026-11-01T09:01:00Z', duration_s: 60 }, // the same run as the Log line: counted once
    { event: 'end', run_id: 'r-00000000c0de', kind: 'routine', id: 'mr-status', project: 'my-app', outcome: 'crashed', started: '2026-11-09T09:00:00Z', finished: '2026-11-09T09:00:07Z', duration_s: 7 },
    { event: 'skip', run_id: 'r-5000000000b0', kind: 'routine', id: 'mr-status', project: 'my-app', outcome: 'skipped', reason: 'busy', count: 3, finished: '2026-11-09T10:00:00Z' },
    { event: 'end', run_id: 'r-other', kind: 'routine', id: 'x', project: 'another-app', outcome: 'ok', finished: '2026-11-09T10:00:00Z' }, // another project: not counted
  ]);
  r.audit([
    { time: '2026-11-09T08:00:00Z', command: 'routine on', target: 'mr-status', by: 'Owner', outcome: 'ok', unattended: false },
    { time: '2026-11-09T08:30:00Z', command: 'approve', target: 'P5.2', by: 'x', outcome: 'refused', unattended: true }, // a refused attempt is not the owner
    { time: '2026-11-09T08:40:00Z', command: 'approve', target: 'unrelated', by: 'Owner', outcome: 'ok', unattended: false },
  ]);
  return r;
}

test('P5.27 a1: the numbers on a prepared Log of routines and cards, the ledger and the audit equal the count by hand', () => {
  const j = fixture().json();
  assert.equal(j.stats, 1);
  assert.deepEqual(j.projects, ['my-app']);
  assert.deepEqual(j.sources, { board_logs: 9, local_runs: 1, owner_audit: 2, owner_git: 6 }); // git: 3 `approved`, 2 `accepted`, 1 routine OFF; audit: the 2 ok rows
  assert.deepEqual({ ...j.runs, duration_s: undefined }, { total: 10, ok: 8, escalated: 1, failed: 0, crashed: 1, timeout: 0, aborted: 0, skipped: { busy: 3 }, duration_s: undefined });
  assert.deepEqual(j.runs.duration_s, { n: 6, median: 90, p90: 300 }); // 7 30 60 120 180 300
  // without the owner: r1 only on the routine (r2 asked, r3 escalated, r4 has OFF in git, r5 has `routine on` in the audit, the crash is not ok); P5.2 twice (the RETURNED is not the owner)
  assert.deepEqual(j.autonomy, { runs: 10, without_owner: 3, share: 0.3, by_routine: { 'my-app/mr-status': { runs: 6, without_owner: 1, share: 0.167 } }, by_track: { F: { runs: 1, without_owner: 0, share: 0 }, P5: { runs: 3, without_owner: 2, share: 0.667 } } });
  assert.deepEqual(j.owner_wait.review_to_acceptance, { n: 2, median_days: 4, p90_days: 6, open: 1, open_oldest_days: 10, unknown_start: 0 }); // P5.1 6 days, F-1 2 days; P5.2 in review since 11-10
  assert.deepEqual(j.escalations, { escalated_runs: 1, asks: 1, top_problems: [{ key: 'dns-timeout', kind: 'transient', n: 2 }, { key: 'disk-full', kind: 'permanent', n: 1 }] });
  assert.deepEqual(j.returns, { returned: 1, cards: 1, task_reports: 4, share_of_reports: 0.25 });
  assert.deepEqual(j.mandate.started_by_mandate, { n: 2, cards: ['F-1', 'P5.2'] });
  // the text form says the same
  const text = fixture().run().stdout;
  assert.match(text, /without the owner: 3 of 10 \(30%\)/);
  assert.match(text, /my-app\/mr-status: 1 of 6 \(17%\)/);
  assert.match(text, /returned from review: 1 \(1 cards, 25% of 4 task reports\)/);
});

test('P5.27 a1: --since leaves out what is older', () => {
  const j = fixture().json(['--since', '2026-11-08']);
  assert.equal(j.since, '2026-11-08');
  assert.equal(j.runs.total, 5); // r5, the crash, P5.2 twice, F-1
  assert.deepEqual(j.returns, { returned: 1, cards: 1, task_reports: 3, share_of_reports: 0.333 });
  assert.equal(j.mandate.started_by_mandate.n, 0);
  assert.equal(statsFlagProblem(['--since', 'yesterday']).status, 2);
});

const statsFlagProblem = (a) => fixture().run(a);

test('P5.27 a2: without Log runs, ledger, audit and questions every row is empty (0 or null) and the command exits 0', () => {
  const r = rig();
  r.card('P5.9', 'status: ready\n', [`2026-11-01 [${ME}] note`]);
  const j = r.json();
  assert.deepEqual(j.sources, { board_logs: 0, local_runs: 0, owner_audit: 0, owner_git: 0 });
  assert.deepEqual(j.runs, { total: 0, ok: 0, escalated: 0, failed: 0, crashed: 0, timeout: 0, aborted: 0, skipped: {}, duration_s: { n: 0, median: null, p90: null } });
  assert.deepEqual(j.autonomy, { runs: 0, without_owner: 0, share: null, by_routine: {}, by_track: {} });
  assert.deepEqual(j.owner_wait, { review_to_acceptance: { n: 0, median_days: null, p90_days: null, open: 0, open_oldest_days: null, unknown_start: 0 }, question_to_answer: { n: 0, median_days: null, p90_days: null } });
  assert.deepEqual(j.escalations, { escalated_runs: 0, asks: 0, top_problems: [] });
  assert.deepEqual(j.returns, { returned: 0, cards: 0, task_reports: 0, share_of_reports: null });
  assert.equal(fs.existsSync(r.stateDir), false, 'no state directory was needed or made');
  const text = r.run();
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /without the owner: 0 of 0 \(-\)/);
  // a ledger and an audit file with only broken lines
  fs.mkdirSync(r.stateDir, { recursive: true });
  fs.writeFileSync(path.join(r.stateDir, 'runs.jsonl'), 'broken\n');
  fs.writeFileSync(path.join(r.stateDir, 'owner-commands.jsonl'), '{"command": 5}\n');
  assert.equal(r.json().runs.total, 0);
});

test('P5.27 a3: stats writes nothing: the board and the state directory are byte for byte the same after it', () => {
  const r = fixture();
  const snap = () => {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, 'utf8'); } };
    walk(r.dir);
    return JSON.stringify(Object.entries(out).sort());
  };
  const before = snap();
  r.run();
  r.json();
  r.json(['--since', '2026-11-05', '--accept-from', '2026-11-12']);
  assert.equal(snap(), before);
});

test('P5.27 a4: --json has the documented schema (strict checker), the checker can fail, and docs/roadctl.md describes every metric', () => {
  const j = fixture().json();
  assert.deepEqual(statsJsonProblems(j), []);
  assert.deepEqual(statsJsonProblems({ ...j, extra: 1 }), ['stats: unknown key extra']);
  assert.deepEqual(statsJsonProblems({ ...j, returns: { ...j.returns, share_of_reports: 2 } }), ['stats.returns.share_of_reports: wrong type or value (2)']);
  const { runs, ...partial } = j;
  assert.deepEqual(statsJsonProblems(partial), ['stats: missing runs']);
  const section = DOCS.slice(DOCS.indexOf('## Autonomy metrics'), DOCS.indexOf('## What was tested'));
  assert.ok(section.length > 1000);
  for (const k of ['sources', 'runs', 'autonomy', 'by_routine', 'by_track', 'owner_wait.review_to_acceptance', 'owner_wait.question_to_answer', 'escalations', 'top_problems', 'returns', 'mandate', 'started_by_mandate', 'proposed', 'undone_share', 'blocking_questions_per_week', 'milestone_returns', '--since', '--accept-from', 'Without the owner']) assert.ok(section.includes(k), `docs: ${k}`);
  assert.equal(rc.ALL_COMMANDS.stats.effect, 'read');
  assert.equal(rc.ALL_COMMANDS.stats.owner, undefined);
});

test('P5.27 a5: "without the owner" on three cases: the run asked (needs_owner), the owner ran a command on the same target after it, a clean run', () => {
  const r = rig();
  r.routine('asks', [`2026-11-01 [${ME}] RUN ok: did: a | ask: which one? ${R(1)}`]);
  r.routine('commanded', [`2026-11-01 [${ME}] RUN ok: did: a ${R(2)}`]);
  r.routine('clean', [`2026-11-01 [${ME}] RUN ok: did: a ${R(3)}`]);
  r.audit([{ time: '2026-11-03T08:00:00Z', command: 'routine off', target: 'commanded', outcome: 'ok' }, { time: '2026-11-03T08:00:00Z', command: 'routine off', target: 'clean-other', outcome: 'ok' }]);
  const g = r.json().autonomy.by_routine;
  assert.deepEqual([g['my-app/asks'], g['my-app/commanded'], g['my-app/clean']].map((x) => x.without_owner), [0, 0, 1]);
  // the command counts only up to the next run of that target: a later run is clean again
  r.routine('commanded', [`2026-11-01 [${ME}] RUN ok: did: a ${R(2)}`, `2026-11-02 [${ME}] RUN ok: did: b ${R(4)}`]);
  assert.deepEqual(r.json().autonomy.by_routine['my-app/commanded'], { runs: 2, without_owner: 1, share: 0.5 }, 'the command of 11-03 is after the last run: it belongs to the 11-02 run');
});

test('P5.27 a6: --accept-from leaves acceptances before the date out of the wait and counts the wait from that date', () => {
  const r = fixture();
  const all = r.json().owner_wait.review_to_acceptance;
  assert.deepEqual([all.n, all.median_days, all.open_oldest_days], [2, 4, 10]);
  const from = r.json(['--accept-from', '2026-11-13']);
  assert.equal(from.accept_from, '2026-11-13');
  assert.deepEqual(from.owner_wait.review_to_acceptance, { n: 1, median_days: 0, p90_days: 0, open: 1, open_oldest_days: 7, unknown_start: 0 }); // P5.1 (accepted 11-12) is out; F-1 counts from 11-13; P5.2 waits since 11-13
  assert.equal(r.run(['--accept-from', '13.11']).status, 2);
});

test('P5.27 a7: the mandate rows count the cards started by the mandate from the Log, and are empty without them; the parts of P5.24, P5.34 and P5.35 stay null', () => {
  const r = fixture();
  const j = r.json();
  assert.deepEqual(j.mandate.boards, [{ project: 'my-app', level: null, state: 'none' }]);
  assert.deepEqual(j.mandate.started_by_mandate, { n: 2, cards: ['F-1', 'P5.2'] });
  assert.deepEqual([j.mandate.proposed, j.mandate.undone_share, j.mandate.blocking_questions_per_week, j.mandate.milestone_returns], [null, null, null, null]);
  fs.writeFileSync(path.join(r.board, 'mandate.md'), '---\nmandate: 1\nlevel: L2\n---\n');
  assert.deepEqual(r.json().mandate.boards, [{ project: 'my-app', level: 'L2', state: 'unapproved' }]);
  const empty = rig();
  empty.card('P5.9', 'status: ready\n', [`2026-11-01 [${ME}] note`]);
  assert.deepEqual(empty.json().mandate, { boards: [{ project: 'my-app', level: null, state: 'none' }], started_by_mandate: { n: 0, cards: [] }, proposed: null, undone_share: null, blocking_questions_per_week: null, milestone_returns: null });
});
