// Run supervisor (P5.2): `roadctl supervise (--routine ID | --card ID | --orchestrator) --as AGENT [--timeout 30m] [--detach] -- COMMAND...`.
// One run of a command at a time per key (a routine of a project, a card of a project, the orchestrator of an agent), for the WHOLE run:
//   - the lock is a file of the machine state directory taken with the shared helper (state.mjs `acquireLock`), content = the pid of the supervisor,
//     the pulse is its modification time (`heartbeat()` every 30 s); a sidecar `<lock>.run` holds the process group of the command and the run id;
//   - the command runs in a new process group; a timeout is TERM, then KILL of the group; its output goes to a private log (0600, bounded, 30 days);
//   - the outcome comes from the run ledger: a run the command ended itself (`routine done`, `report`, `run done`) keeps that outcome; a run that
//     ended without a result is `failed: no result` and, for a routine, the supervisor writes the result to the routine file (`src=supervisor`) through the
//     same hooks as `routine done` (api.routineDoneWithHooks; a hook may refuse, then nothing is written and the record says so);
//   - an orphan (the supervisor was killed with -9) is found by the next supervise through the pid in the lock and the group in the sidecar:
//     the group is alive -> busy (exit 5); dead -> the lock is taken at once, the old run is `crashed`, a local back-off (10, 20, 40 minutes, then a stop)
//     keeps a routine whose result cannot be written from being offered again on every tick.
// POSIX only (WSL included). Real time is used for processes (pulse, grace, liveness); the times the ledger shows use `nowMs` (ROADCTL_NOW).
// Node standard library only, no side effects at import.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routineAnswerIds } from './owner-questions.mjs';
import { cardDescription, readConductor } from './launch.mjs';
import { escalationFile, readEscalation, writeEscalation, escalationAdmission, conductorDigest, ledgerIsReadable } from './escalation.mjs';
import { timeoutMs } from './run-ledger.mjs';
import { environmentGate } from './environment.mjs';
import { pauseLine, readPause } from './pause.mjs';
import { acquireLock } from './state.mjs';
import { appendLine, beginRun, cleanText, DEFAULT_TIMEOUT_MS, isoAt, ledgerPaths, nowMs, readRuns, recordSkip, runKey, summaryFields, usable, withLedgerLock } from './run-store.mjs';

export const LOG_LIMIT = 1024 * 1024;
export const LOG_KEEP_MS = 30 * 86400e3;
export const LOCK_STALE_MS = 10 * 60 * 1000; // a lock whose pulse is older than this is taken over even by a live pid (the age of the tick lock)
export const EXIT = { ok: 0, failed: 1, usage: 2, notStarted: 4, busy: 5, paused: 6, timeout: 7, aborted: 8 };
export const BACKOFF_MIN = [10, 20, 40];
const SIDE = '.run';
const MAX_TIMER = 2 ** 31 - 1;
const knob = (env, name, dflt) => (Number(env[name]) > 0 ? Number(env[name]) : dflt); // test knobs for the real-time mechanics (docs/roadctl.md)
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const projectOf = (board) => String(board.project).split(/[\\/]/).filter(Boolean).pop();

// ---------------------------------------------------------------- optional adapter for `claude -p --output-format json`

/** Claude's optional JSON result is metadata, never a substitute for the process exit status. Missing data is `unknown`. */
export function claudeResult(text, exitCode) {
  let value;
  try { value = JSON.parse(text); } catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'result') value = {};
  const nonnegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 'unknown';
  const string = (v) => typeof v === 'string' && v.trim() ? v : 'unknown';
  return {
    exit_code: Number.isInteger(exitCode) ? exitCode : 'unknown',
    session_id: string(value.session_id),
    turns: Number.isInteger(value.num_turns) ? nonnegative(value.num_turns) : 'unknown',
    is_error: typeof value.is_error === 'boolean' ? value.is_error : 'unknown',
    subtype: string(value.subtype),
    cost_usd: nonnegative(value.total_cost_usd),
  };
}
const wantsClaudeJson = (argv) => argv.some((a, i) => (a === '--output-format' && argv[i + 1] === 'json') || a === '--output-format=json');

// ---------------------------------------------------------------- the log of a run

/** Retain bounded output and a 600-character tail while reserving room for a footer. */
export function createRunLog(file, header, { limit = LOG_LIMIT } = {}) {
  const head = Buffer.from(`${header}\n`);
  const footerReserve = 1024;
  if (!Number.isInteger(limit) || limit < head.length + footerReserve) throw new Error('log limit too small');
  const fd = fs.openSync(file, 'w', 0o600);
  fs.fchmodSync(fd, 0o600);
  fs.writeSync(fd, head);
  let remaining = limit - head.length - footerReserve;
  let tail = '';
  return {
    write(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (remaining > 0) {
        const bytes = Math.min(remaining, data.length);
        fs.writeSync(fd, data, 0, bytes);
        remaining -= bytes;
      }
      tail = (tail + data.toString('utf8')).slice(-600);
    },
    close(footer) {
      const end = Buffer.from(`\n${footer}\n`);
      fs.writeSync(fd, end.subarray(0, footerReserve));
      fs.closeSync(fd);
      return tail;
    },
  };
}

/** Remove only regular run logs older than 30 days; other state is untouched. */
export function pruneRunLogs(dir, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const name of names) {
    if (!/^r-[A-Za-z0-9._-]+\.log$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && now - stat.mtimeMs > LOG_KEEP_MS) fs.unlinkSync(file);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

// ---------------------------------------------------------------- the lock, its sidecar and the local state of a key

const slugOf = (...parts) => parts.map((p) => String(p ?? '-').replace(/[^A-Za-z0-9._@-]/g, '_')).join('.');
export const lockFile = (dir, kind, project, id) => path.join(dir, `supervise-${slugOf(kind, project, id)}.lock`);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const groupAlive = (pgid) => Number.isInteger(pgid) && pgid > 1 && alive(-pgid);
const signalGroup = (pgid, sig) => {
  if (process.env.ROADCTL_SUPERVISE_SIGLOG) { try { fs.appendFileSync(process.env.ROADCTL_SUPERVISE_SIGLOG, `${sig} ${pgid}\n`); } catch { /* a test knob */ } }
  try { process.kill(-pgid, sig); } catch { /* gone */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lockBody = (a, t) => JSON.stringify({ pid: process.pid, token: crypto.randomBytes(6).toString('hex'), key: runKey(t), agent: a.as, kind: t.kind, project: t.project, id: t.id });

/**
 * What holds the lock `file`, read only: { state: 'free' | 'live' | 'orphan-live' | 'orphan-dead' | 'stop-unsaved', pid, side, raw (the text of the lock), info (its content) }.
 * live: the supervisor is alive and its pulse is fresh; orphan-live: the supervisor died but its command's group still runs; orphan-dead: nothing is left of it.
 */
export function inspectLock(file) {
  let age;
  let raw;
  try { age = Date.now() - fs.statSync(file).mtimeMs; raw = fs.readFileSync(file, 'utf8'); } catch { return { state: 'free', pid: null, side: null, raw: null, info: null }; }
  let info = null;
  try { info = JSON.parse(raw); } catch { /* an unreadable lock has no owner */ }
  const pid = info?.pid ?? null;
  const side = readJson(file + SIDE);
  const r = (state) => ({ state, pid, side, raw, info });
  if (info?.stop_unsaved) return r('stop-unsaved'); // the dead owner could not save a stop: nobody takes this lock until --reset
  if (!Number.isInteger(pid)) return r(age <= LOCK_STALE_MS ? 'live' : 'free'); // a lock without readable content proves nothing about its owner: busy until it is stale by age
  if (alive(pid) && (pid === process.pid || age <= LOCK_STALE_MS)) return r('live');
  if (groupAlive(side?.pgid)) return r('orphan-live');
  return r(alive(pid) ? 'free' : 'orphan-dead'); // a live pid with an old pulse is taken over by acquireLock
}

/** A guard is the taker's own `pid`; it is removed only when that process is dead, or when it is older than the lock itself may be (LOCK_STALE_MS), never because 5 seconds passed. */
export function dropStaleGuard(guard) {
  try {
    const pid = Number(fs.readFileSync(guard, 'utf8'));
    if (!alive(pid) || Date.now() - fs.statSync(guard).mtimeMs > LOCK_STALE_MS) fs.rmSync(guard, { force: true });
  } catch { /* gone, or being written: look again */ }
}

/**
 * Take the lock of a dead supervisor. The check that the owner is still the one we saw, and the removal, happen while holding the takeover guard of the shared
 * helper (`<lock>.takeover`, created exclusively), so a second process that saw the same dead lock cannot remove the NEW lock of the first one.
 * Returns the lock handle, or null when it was not ours to take (someone else has it now, or the guard is busy: the caller looks again).
 */
export function takeDeadLock(file, observedRaw, body) {
  const guard = `${file}.takeover`;
  try {
    fs.writeFileSync(guard, String(process.pid), { flag: 'wx' });
  } catch {
    dropStaleGuard(guard);
    return null;
  }
  try {
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch { /* no lock any more: just take it */ }
    if (cur !== null) {
      if (cur !== observedRaw) return null; // changed hands since we looked
      let info = null;
      try { info = JSON.parse(cur); } catch { /* unreadable: nothing proves the owner is gone */ }
      if (!info || info.stop_unsaved || alive(info.pid)) return null;
      fs.rmSync(file, { force: true });
    }
    const l = acquireLock(file, { staleMs: LOCK_STALE_MS, waitMs: 0, strict: true, content: body });
    return l.ok ? { ...l, file } : null;
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

/** Local state of keys that went wrong: { key: { n, until, stopped, reason } } in supervise.state.json, changed under the ledger lock. A file that cannot be read is a stop (fail closed). */
const stateFile = (dir) => path.join(dir, 'supervise.state.json');
function readState(dir) {
  let text;
  try { text = fs.readFileSync(stateFile(dir), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? {} : { __unreadable: true }; }
  try {
    const s = JSON.parse(text);
    return s && typeof s === 'object' && !Array.isArray(s) ? s : { __unreadable: true };
  } catch { return { __unreadable: true }; }
}
/** Read-modify-write under the ledger lock; true only when the new state is on disk. A state file that cannot be read is NOT rewritten (it may hold stops nobody can see): only `force` (--reset) replaces it. */
function updateState(env, dir, fn, { force = false } = {}) {
  try {
    const r = withLedgerLock(env, () => {
      const s = readState(dir);
      if (s.__unreadable) {
        if (!force) return false;
        delete s.__unreadable;
      }
      fn(s);
      const tmp = `${stateFile(dir)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(s)}\n`);
      fs.renameSync(tmp, stateFile(dir));
      return true;
    });
    return r.locked && r.value === true;
  } catch { return false; }
}
const persist = (env, dir, fn) => { for (let i = 0; i < 3; i++) if (updateState(env, dir, fn)) return true; return false; };
/** Run `fn` while holding the takeover guard of the lock (the shared helper's `<lock>.takeover`, created exclusively); retried a few times, { guarded: false } when it stays busy. */
function underGuard(file, fn) {
  const guard = `${file}.takeover`;
  for (let i = 0; i < 10; i++) {
    try {
      fs.writeFileSync(guard, String(process.pid), { flag: 'wx' });
    } catch {
      dropStaleGuard(guard);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }
    try { return { guarded: true, value: fn() }; } finally { fs.rmSync(guard, { force: true }); }
  }
  return { guarded: false };
}

/**
 * The end of a run, for the lock `file` that `body` created: ONLY while the file still holds our own content (checked under the guard) the sidecar is removed and the
 * lock is released, or, when a stop could not be saved (`unsavedReason`), replaced by a copy with the `stop_unsaved` marker (nobody takes it until --reset).
 * Returns 'ok', or 'lost' when the lock is not ours any more (another process took it: its lock and sidecar are left alone), or 'unknown' when the guard stayed busy.
 * shortcut: on 'unknown' no `stop_unsaved` marker is set, so a stop that could not be saved may be lost once this process exits (the plain lock is then taken as a dead one); a retry that waits longer for the guard, or a marker written without it, when a guard that stays busy for 200 ms is seen in practice.
 */
export function finishLock(file, body, unsavedReason = null) {
  const g = underGuard(file, () => {
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch { /* gone */ }
    if (cur !== body) return 'lost';
    fs.rmSync(file + SIDE, { force: true });
    if (!unsavedReason) { fs.rmSync(file, { force: true }); return 'ok'; }
    const tmp = `${file}.${process.pid}.stop.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...JSON.parse(body), stop_unsaved: cleanText(unsavedReason, 200) }));
      fs.renameSync(tmp, file);
    } catch { fs.rmSync(tmp, { force: true }); } // shortcut: when even the marker cannot be written the lock stays as it was and is taken over as an ordinary dead lock; a second mark needs another place to write, when a disk that fails this way is seen
    return 'ok';
  });
  return g.guarded ? g.value : 'unknown';
}

/** --reset: remove the lock only if it still is the very marked lock we saw (`observedRaw`), under the guard; a lock that changed hands is left alone. */
export function removeMarkedLock(file, observedRaw) {
  const g = underGuard(file, () => {
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch { return false; }
    if (cur !== observedRaw) return false;
    fs.rmSync(file, { force: true });
    return true;
  });
  return g.guarded && g.value === true;
}
const penalty = (s, key, now) => {
  const n = (s[key]?.n ?? 0) + 1;
  return { n, until: isoAt(now + BACKOFF_MIN[Math.min(n, BACKOFF_MIN.length) - 1] * 60e3), stopped: n >= BACKOFF_MIN.length };
};
const appendEnd = (env, rec) => { for (let i = 0; i < 3; i++) if (appendLine(ledgerPaths(env).runs, rec)) return true; return false; };

// ---------------------------------------------------------------- one run

const USAGE = 'usage: roadctl supervise (--routine ID | --card ID | --orchestrator) --as AGENT [--timeout 30m] [--stdin] [--model NAME] [--detach] [--board DIR] -- COMMAND [ARGS...]   |   roadctl supervise (--routine ID | --card ID | --orchestrator) --as AGENT --reset';
const WINDOWS = 'roadctl supervise is not supported on native Windows (it needs POSIX process groups and signals); run it inside WSL';
const NEEDS_VERSION = '0.6.0'; // the first roadctl that reads the `src=supervisor` trailer
const UNIT = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
const defaultIo = { err: (s) => process.stderr.write(s) };

/** Check the arguments: { sel: { kind, id }, as, timeout (ms or null), argv } or throw the usage. */
function parseArgs({ flags, rest }) {
  const picked = [['routine', flags.routine], ['card', flags.card], ['orchestrator', flags.orchestrator]].filter(([, v]) => v !== undefined && v !== false);
  if (picked.length !== 1) throw new Error(USAGE);
  const [kind, value] = picked[0];
  if (kind !== 'orchestrator' && (typeof value !== 'string' || !AGENT_RE.test(value))) throw new Error(USAGE);
  if (typeof flags.as !== 'string' || !AGENT_RE.test(flags.as)) throw new Error(USAGE);
  let timeout = null;
  if (flags.timeout !== undefined) {
    const m = /^(\d+)([smhd])$/.exec(String(flags.timeout));
    if (!m || !Number(m[1])) throw new Error(`${USAGE}; --timeout is a span like 90s, 30m, 2h or 1d`);
    timeout = Number(m[1]) * UNIT[m[2]];
  }
  if (!flags.reset && !rest.length && !flags['auto-profile']) throw new Error(`${USAGE}; the command to supervise goes after --`);
  if (flags.model !== undefined && (typeof flags.model !== 'string' || !AGENT_RE.test(flags.model))) throw new Error(`${USAGE}; --model is the model name of this run`);
  if (kind !== 'routine' && flags['owner-answers'] !== undefined) throw new Error('--owner-answers is only for routine runs');
  return { sel: { kind, id: kind === 'orchestrator' ? flags.as : value }, as: flags.as, timeout, argv: rest, stdin: Boolean(flags.stdin), model: flags.model ?? null };
}

/** The key parts of the run ledger and what the board says about the target. Throws when the board does not know the routine or the card. */
function targetOf(sel, as, board, timeout, model = null) {
  if (sel.kind === 'orchestrator') return { kind: 'orchestrator', project: null, id: as, model, anchor: null, timeout: timeout ?? DEFAULT_TIMEOUT_MS, nodata: 'no data' };
  const project = projectOf(board);
  const nodata = String(board.config?.language ?? '').toLowerCase().startsWith('ru') ? 'нет данных' : 'no data';
  if (sel.kind === 'card') {
    if (!board.cards.some((c) => c.header.id === sel.id)) throw new Error(`no card ${cleanText(sel.id, 60)} on the board`);
    return { kind: 'task', project, id: sel.id, model, anchor: null, timeout: timeout ?? DEFAULT_TIMEOUT_MS, nodata };
  }
  const r = (board.routines ?? []).find((x) => x.header.id === sel.id);
  if (!r) throw new Error(`no routine ${cleanText(sel.id, 60)} on the board`);
  if (r.header.agent !== as) throw new Error(`the routine ${cleanText(sel.id, 60)} belongs to ${cleanText(r.header.agent ?? '-', 60)}, not ${cleanText(as, 60)}`);
  return { kind: 'routine', project, id: sel.id, model: r.header.model ?? null, anchor: r.header.last_run ?? null, timeout: timeout ?? timeoutMs(r.header.timeout), nodata };
}

/** A routine's board must say it needs a roadctl that reads `src=supervisor`: an older copy would show the line without its run. Returns a refusal text or null. */
function needsBoardVersion(api, board) {
  const c = api.compareVersions(board.config?.requires ?? '', NEEDS_VERSION);
  if (c !== null && c >= 0) return api.boardRequires(board.config); // declared: but a board that asks for a roadctl newer than this copy is not ours to write either
  return `the board does not declare "requires": "${NEEDS_VERSION}" in board/config.json; the supervisor writes the Log line trailer src=supervisor, which older copies of roadctl do not read (see docs/roadctl.md, Run supervisor); install ${NEEDS_VERSION} on every machine of the board, then set it`;
}

function busyResult(ctx, a, t, why) {
  recordSkip(ctx.env, { kind: t.kind, project: t.project, id: t.id, agent: a.as, reason: 'busy', now: nowMs(ctx.env), version: ctx.api.VERSION });
  return { code: EXIT.busy, text: `busy: ${why}` };
}

/** Is the run still allowed? Under the lock: pause, the local state of the key (back-off, stop), requires, "allowed and due" (a routine). Returns { code, text } to refuse, or null. */
function recheck(ctx, t, board, dir, now) {
  const { env, api } = ctx;
  const p = readPause(dir, now);
  if (p?.state === 'paused') return { code: EXIT.paused, text: `paused: ${pauseLine(p)}` };
  const key = runKey(t);
  const st = readState(dir);
  if (st.__unreadable) return { code: EXIT.notStarted, text: `the local state file supervise.state.json cannot be read, so nothing starts (${key}); roadctl supervise <the same selector> --as AGENT --reset rewrites it` };
  const s = st[key];
  if (s?.stopped) return { code: EXIT.notStarted, text: `stopped on this machine ${s.reason ?? `after ${s.n} runs in a row without a written result`} (${key}); look at roadctl runs, then roadctl supervise <the same selector> --as AGENT --reset` };
  if (s?.until && now < Date.parse(s.until)) return { code: EXIT.notStarted, text: `backing off until ${s.until} after a run whose result could not be written (${key})` };
  if (!board) return null;
  const needs = api.boardRequires(board.config);
  if (needs) return { code: EXIT.notStarted, text: needs };
  if (t.kind === 'routine') {
    const unsupported = needsBoardVersion(api, board);
    if (unsupported) return { code: EXIT.notStarted, text: unsupported };
    const row = api.routineRows(board, now, env).find((x) => x.id === t.id);
    if (!row || row.reasons.length) return { code: EXIT.notStarted, text: `the routine would not run now: ${row ? row.reasons.join('; ') : 'not found'}` };
    if (!row.due) return { code: EXIT.notStarted, text: 'the routine is not due any more' };
  }
  return null;
}

/**
 * Record a result of a routine in its file through the same hooks as `routine done` (routineDoneWithHooks): the run ledger finds the run by ROADCTL_RUN_ID, the Log
 * line gets the trailer with src=supervisor (`source` is an argument of the call), and a hook may refuse (then nothing is written). Returns the routineDone result, or { status: 'skipped' } for a card or the orchestrator.
 */
function writeRoutineResult(ctx, bdir, t, as, run_id, fields, outcome = null) {
  if (t.kind !== 'routine') return { status: 'skipped' };
  try {
    const board = ctx.api.loadBoard(bdir); // read now: the version the board declares is checked right before this write, whatever it said when the run began
    const needs = needsBoardVersion(ctx.api, board);
    if (needs) return { status: 'unsupported', message: needs };
    const flags = { did: fields.did, problem: fields.problems.map((p) => `${p.kind}: ${p.key}: ${p.text}`) };
    const env = { ...ctx.env, ROADCTL_RUN_ID: run_id };
    return ctx.api.routineDoneWithHooks(board, t.id, { as, result: 'failed', text: fields.did[0], flags, env, io: ctx.io ?? defaultIo, source: 'supervisor', outcome }).r;
  } catch (e) {
    return { status: 'error', message: cleanText(e.message, 120) };
  }
}
const EMPTY = { did: [], decisions: [], problems: [], needs_owner: null, not_checked: null }; // the shape of a summary
const written = (r) => ['recorded', 'recorded-local'].includes(r.status);
const notWritten = (w) => `; the routine file was not written (${w.status}${w.message ? `: ${cleanText(w.message, 100)}` : ''})`;

/**
 * The supervisor of an earlier run died: its open runs are crashed, a failed result is written to the routine file (through the hooks), the local state counts it.
 * A routine whose result cannot be written backs off 10, 20, 40 minutes and then stops; a card cannot know what its dead run did, so it stops at once.
 * Returns false when the record or the state could not be saved: the caller must not start anything then.
 */
function reconcileOrphans(ctx, bdir, dir, t, as, now) {
  const key = runKey(t);
  const opens = [...readRuns(ctx.env).values()].filter((r) => r.outcome === 'started' && runKey(r) === key && r.source === 'supervisor');
  if (!opens.length) return true;
  const n = (readState(dir)[key]?.n ?? 0) + 1;
  const card = t.kind === 'task';
  let good = true;
  let wrote = false;
  for (const run of opens) {
    const fields = { ...EMPTY, did: [cleanText(run.note || t.nodata, 120)], problems: [{ kind: 'unknown', key: 'crashed', text: 'the supervisor died; the run has no result' }, ...(n >= BACKOFF_MIN.length && !card ? [{ kind: 'permanent', key: 'supervise-stop', text: `${n} runs in a row ended without a result: stopped on this machine until roadctl supervise --reset` }] : [])] };
    const w = writeRoutineResult(ctx, bdir, t, as, run.run_id, fields, 'crashed');
    wrote = written(w);
    if (w.status === 'unsupported') good = false; // the board no longer declares the version: nothing was written, the lock is kept marked
    const dur = run.started ? Math.max(0, Math.round((now - Date.parse(run.started)) / 1000)) : null;
    const reason = `the supervisor died (no end, the command is gone)${t.kind === 'routine' && !wrote ? notWritten(w) : ''}`;
    if (!appendEnd(ctx.env, { event: 'crash', run_id: run.run_id, finished: isoAt(now), duration_s: dur, outcome: 'crashed', reason, note: run.note, source: 'supervisor', ...summaryFields(fields) })) good = false;
  }
  const next = card ? { n, until: null, stopped: true, reason: 'because the last run of the card died without a result and what it did is unknown' } : { n, until: wrote ? null : isoAt(now + BACKOFF_MIN[Math.min(n, BACKOFF_MIN.length) - 1] * 60e3), stopped: n >= BACKOFF_MIN.length };
  return persist(ctx.env, dir, (s) => { s[key] = next; }) && good;
}

/** The `subtype` of the last JSON line of `claude -p --output-format json` when the model ran out of turns: Claude Code 2.1.x says `error_max_turns`, an older or shortened form is `max_turns` (P5.4 a3/a7). */
const MAX_TURNS_SUBTYPES = ['error_max_turns', 'max_turns'];

/** Everything after the lock is held. Returns { code, text, run_id?, outcome? }. `started(run_id)` is called when the command runs (a detached parent waits for it). */
async function runLocked(ctx, a, t, bdir, dir, lock, started) {
  const { env, api } = ctx;
  const now = nowMs(env);
  const key = runKey(t);
  const side = lock.file + SIDE;
  if (!reconcileOrphans(ctx, bdir, dir, t, a.as, now)) { const text = `the record of an earlier run that died could not be saved (the ledger or supervise.state.json is not writable); nothing starts (${key})`; return { code: EXIT.failed, text, unsavedStop: text }; }
  fs.rmSync(side, { force: true });
  const board = bdir ? api.loadBoard(bdir) : null; // the board is read again: it may have changed since `tick`
  const refuse = recheck(ctx, t, board, dir, now);
  if (refuse) return refuse;
  let auto = null;
  if (ctx.flags['auto-profile'] !== undefined) {
    if (t.kind !== 'task' || typeof ctx.flags['auto-profile'] !== 'string' || ctx.flags.detach || ctx.rest.length || ctx.flags.timeout || ctx.flags.model || ctx.flags.stdin) return { code: EXIT.notStarted, text: 'auto escalation requires a card and profile without command, timeout, model or stdin overrides' };
    const cond = readConductor(env);
    if (cond.state !== 'ok') return { code: EXIT.notStarted, text: cond.reason };
    let digest;
    try { digest = conductorDigest(cond.conductor); } catch { return { code: EXIT.notStarted, text: 'the conductor settings or MCP file cannot be read' }; }
    const card = board.cards.find((c) => c.header.id === t.id);
    const scope = /\bscope=([^\s,]+)/.exec(card?.header.approved ?? '')?.[1]?.split('+') ?? [];
    const status = board.config?.status_map?.[card?.header.status] ?? card?.header.status;
    if (!card || !['ready', 'doing'].includes(status) || !scope.includes('implementation') || !scope.includes('auto') || card.header.blocked) return { code: EXIT.notStarted, text: 'the card is blocked, closed or no longer approved for automatic implementation' };
    const byId = new Map(board.cards.map((c) => [c.header.id, c]));
    const deps = String(card.header.depends_on ?? '').split(/[\s,]+/).filter(Boolean);
    if (deps.some((id) => !api.depMet(board, card, id, byId))) return { code: EXIT.notStarted, text: 'a card dependency is no longer satisfied' };
    const file = escalationFile(dir, bdir, t.id);
    let prior;
    try { prior = readEscalation(file); } catch (e) { return { code: EXIT.notStarted, text: e.message }; }
    const ledger = ledgerPaths(env);
    if (!ledgerIsReadable([ledger.runs, ledger.runsPrev])) return { code: EXIT.notStarted, text: 'the run ledger contains unreadable records' };
    const profile = ctx.flags['auto-profile'];
    let d;
    let reg = null;
    try {
      reg = api.loadRegistry(env);
      const previous = prior ? [{ run_id: prior.run_id, model: prior.model, outcome: prior.outcome, duration_s: prior.used_s }] : null;
      d = cardDescription({ ...ctx, flags: { ...ctx.flags, card: t.id, profile } }, cond, board, bdir, reg, previous);
    } catch (e) { return { code: EXIT.notStarted, text: e.message }; }
    const info = api.delegationInfo(card);
    if (info.errors.length || !info.delegate || !api.eligibility(info.delegate, d.agent, reg).ok) return { code: EXIT.notStarted, text: 'the card has no valid delegation to this agent' };
    if (!prior) {
      const check = api.claimable(board, card, d.agent, reg);
      if (check.reasons?.length) return { code: EXIT.notStarted, text: `the delegation cannot be claimed: ${check.reasons.join('; ')}` };
    }
    const { state: delegateState, ...delegation } = info.delegate;
    const delegationHash = crypto.createHash('sha256').update(JSON.stringify(delegation)).digest('hex');
    if (!prior && (delegateState !== 'open' || info.claim)) return { code: EXIT.notStarted, text: 'the initial delegation is not open' };
    if (prior && (delegateState !== 'claimed' || !info.claim || info.claim.agent !== d.agent || api.leaseExpired(info.claim, now) || prior.delegation_hash !== delegationHash)) return { code: EXIT.notStarted, text: 'the original delegation or claim is no longer valid' };
    if (a.as !== d.agent) return { code: EXIT.notStarted, text: 'the agent differs from the launch description' };
    a.argv = d.argv; a.model = d.model; a.timeout = d.timeout_s * 1000;
    t.model = d.model; t.timeout = a.timeout;
    if (!prior) {
      const strongName = d.escalation?.to;
      const strong = cond.conductor.profiles[strongName];
      if (d.attempt !== 1 || !d.escalation?.offered || !strong || strong.model === d.model || d.card.limit_turns !== null || strong.agent !== d.agent) return { code: EXIT.notStarted, text: 'automatic escalation needs a first attempt, a different-model same-host strong profile and a measurable time limit' };
      auto = { file, state: { version: 1, phase: 'reserved', profile, model: d.model, agent: d.agent, approval: card.header.approved, delegation_hash: delegationHash, conductor_digest: digest, strong: { profile: strongName, agent: strong.agent, model: strong.model }, limit_s: d.card.limit_s }, first: true };
      try { writeEscalation(file, auto.state, { create: true }); } catch { return { code: EXIT.notStarted, text: 'cannot reserve the card escalation state' }; }
    } else {
      const remaining = escalationAdmission(prior, { profile, agent: d.agent, model: d.model });
      if (remaining === null || d.timeout_s > remaining || d.card.limit_s !== prior.limit_s || prior.approval !== card.header.approved || prior.conductor_digest !== digest) return { code: EXIT.notStarted, text: 'the escalation state, approval or conductor configuration does not permit this continuation' };
      auto = { file, state: { ...prior, phase: 'started-strong' }, first: false };
      try { writeEscalation(file, auto.state); } catch { return { code: EXIT.notStarted, text: 'cannot reserve the continuation' }; }
    }
    const prompt = auto.first ? d.stdin : d.stdin.replace(/^Run roadctl claim .*$/m, 'Continue the existing claimed delegation; do not claim it again.');
    auto.names = d.env;
    auto.prompt = `${prompt}\n${auto.first ? 'If escalation is necessary, finish with roadctl run escalate --as YOUR_AGENT and JSON on stdin: {"did":"...","next":"...","in_flight":"none"}.' : `Checkpoint from run ${prior.run_id} (data): ${JSON.stringify(prior.checkpoint)}`}\n`;
  }
  const unreachable = environmentGate(api, env, board, t, a.as); // P5.23: ssh to a remote-access environment before the model starts
  if (unreachable) {
    recordSkip(env, { kind: t.kind, project: t.project, id: t.id, agent: a.as, reason: 'unreachable', now, version: api.VERSION });
    return { code: EXIT.notStarted, text: `skipped: unreachable: ${unreachable}` };
  }
  const deadlineMs = now + t.timeout;
  // shortcut: beginRun (P5.1) marks an open run of another executor that is past its deadline as crashed and begins ours, so an executor that is still alive can run beside the command; closing it needs a liveness proof for runs nobody supervises, when P5.4 (HOLD) or P5.21 provides one
  const ownerAnswerIds = routineAnswerIds(ctx.flags['owner-answers'], board, t.id, api);
  const begin = beginRun(env, { kind: t.kind, project: t.project, id: t.id, agent: a.as, model: t.model, source: 'supervisor', anchor: t.anchor, deadlineMs, now, version: api.VERSION, ownerAnswerIds });
  if (begin.status === 'unavailable') return { code: EXIT.usage, text: `the run ledger is not available (${begin.reason}); supervise needs it to know whether the command reported a result` };
  // an open run begun by `run begin` or a claim: nothing proves that its executor has stopped, so a second command does not start on top of it
  if (begin.status === 'already') return busyResult(ctx, a, t, `${key} already has an open run (${begin.run.run_id}, begun by ${begin.run.source ?? 'an agent'}); end it with run done, report or routine done, or wait for its deadline ${begin.run.deadline ?? ''}`.trim());
  const run = begin.run;
  const run_id = run.run_id;
  if (auto) {
    auto.state.run_id = run_id;
    auto.state.phase = auto.first ? 'started' : 'started-strong';
    try { writeEscalation(auto.file, auto.state); } catch { return { code: EXIT.notStarted, text: 'cannot bind the run to the escalation state' }; }
  }
  const logDir = path.join(dir, 'run-logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  pruneRunLogs(logDir, now);
  const logName = `${/^r-/.test(run_id) ? '' : 'r-'}${run_id.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
  const log = createRunLog(path.join(logDir, logName), cleanText(`START ${isoAt(now)} run=${run_id} key=${key} timeout=${Math.round(t.timeout / 1000)}s cmd=${a.argv.join(' ')}`, 400), { limit: knob(env, 'ROADCTL_SUPERVISE_LOG_LIMIT', LOG_LIMIT) });
  const t0 = Date.now();
  const { ROADCTL_SUPERVISE_CHILD: _own, ...childEnv } = env;
  const grace = knob(env, 'ROADCTL_SUPERVISE_GRACE_MS', 5000);
  let spawnError = null;
  let fatal = null;
  let stopping = null;
  let pgid = null;
  let killTimer = null;
  let result = { code: null, signal: null };
  let stdoutTail = '';
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  const termGroup = () => {
    signalGroup(pgid, 'SIGTERM');
    killTimer = setTimeout(() => { if (groupAlive(pgid)) signalGroup(pgid, 'SIGKILL'); }, grace);
  };
  const stop = (why) => {
    if (stopping) return;
    stopping = why;
    if (pgid) termGroup(); // before the group exists the request is kept and applied right after the spawn
  };
  const onSignal = () => stop('aborted');
  const onExit = () => { if (pgid) signalGroup(pgid, 'SIGKILL'); }; // any way out of this process (an uncaught error included) takes the group with it
  const timers = [
    setInterval(() => lock.heartbeat(), knob(env, 'ROADCTL_SUPERVISE_HEARTBEAT_MS', 30000)),
    setInterval(() => { const p = readPause(dir, nowMs(env)); if (p?.state === 'paused' && p.now) stop('paused'); }, knob(env, 'ROADCTL_SUPERVISE_POLL_MS', 1000)),
    setTimeout(() => stop('timeout'), Math.min(t.timeout, MAX_TIMER)),
  ];
  for (const s of signals) process.on(s, onSignal);
  process.on('exit', onExit);
  let child = null;
  try {
    const autoNames = auto ? new Set([...auto.names, 'HOME', 'PATH', 'LANG', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'ROADCTL_WORKSPACE', 'ROADCTL_REGISTRY', 'ROADCTL_NOW', 'ROADCTL_DATE', 'ROADCTL_HOST']) : null;
    const childVars = auto ? Object.fromEntries(Object.entries(childEnv).filter(([key]) => autoNames.has(key))) : childEnv;
    child = spawn(a.argv[0], a.argv.slice(1), { detached: true, stdio: [auto ? 'pipe' : a.stdin ? 'inherit' : 'ignore', 'pipe', 'pipe'], env: { ...childVars, ROADCTL_RUN_ID: run_id }, cwd: process.cwd() });
    if (auto) { child.stdin.on('error', () => {}); child.stdin.end(auto.prompt); }
    child.on('error', (e) => { spawnError = e; });
    pgid = child.pid ?? null;
    if (pgid) {
      if (env.ROADCTL_SUPERVISE_FAULT === 'after-spawn') throw new Error('injected fault after the spawn'); // a test knob: the group must not stay without a supervisor
      child.stdout.on('data', (c) => { log.write(c); stdoutTail = (stdoutTail + c.toString('utf8')).slice(-65536); });
      child.stderr.on('data', (c) => log.write(c));
      // shortcut: a SIGKILL of the supervisor between the spawn and this write leaves a group whose id nobody saved, so the next supervise takes the lock for dead; closing it needs the group created by a helper that reports its id first, when this is seen in practice
      fs.writeFileSync(`${side}.tmp`, JSON.stringify({ pid: process.pid, pgid, run_id, key, started: isoAt(now), deadline: isoAt(deadlineMs) }));
      fs.renameSync(`${side}.tmp`, side); // whole or not there: a reader never sees half of it
      if (stopping) termGroup();
      started?.(run_id);
      result = await new Promise((resolve) => {
        let r = null;
        const end = () => resolve(r ?? { code: null, signal: null });
        child.on('error', end);
        child.on('exit', (code, signal) => { r = { code, signal }; setTimeout(end, 1000); }); // the output of a grandchild that outlives the command is not waited for
        child.on('close', end);
      });
      if (groupAlive(pgid)) signalGroup(pgid, 'SIGKILL'); // whatever the command left in its group dies with it; a group that is gone is not signalled
    } else await sleep(20); // a command that cannot start: the 'error' event comes on the next tick
  } catch (e) {
    fatal = e;
    if (pgid) signalGroup(pgid, 'SIGKILL');
  } finally {
    for (const x of timers) { clearInterval(x); clearTimeout(x); }
    clearTimeout(killTimer);
    for (const s of signals) process.off(s, onSignal);
    process.off('exit', onExit);
    child?.stdout?.destroy();
    child?.stderr?.destroy();
  }

  const finishedMs = nowMs(env);
  const dur = Math.max(0, Math.round((finishedMs - Date.parse(run.started ?? isoAt(now))) / 1000));
  const exitText = fatal ? `supervisor error: ${cleanText(fatal.message, 100)}` : spawnError ? `cannot start: ${spawnError.code ?? 'error'}` : result.signal ? `killed by ${result.signal}` : `exit ${result.code}`;
  const tail = log.close(`END ${isoAt(finishedMs)} ${exitText} duration=${Math.round((Date.now() - t0) / 1000)}s${stopping ? ` stopped=${stopping}` : ''}`);
  const usage = { exit_code: spawnError ? 127 : result.code ?? 'unknown', ...(result.signal ? { signal: result.signal } : {}), tail: cleanText(tail, 600), ...(wantsClaudeJson(a.argv) ? { claude: claudeResult(stdoutTail.trim().split('\n').filter(Boolean).at(-1) ?? '', result.code) } : {}) };

  // the outcome: what the command reported itself (an end in the ledger) wins; otherwise the supervisor says why there is none
  const after = readRuns(env).get(run_id);
  let outcome = after && after.outcome !== 'started' ? after.outcome : null;
  let text;
  let penalized = false;
  const lost = []; // protections that could not be saved: the exit code says so
  let unsaved = false; // a stop or back-off that could not be saved: the lock stays, marked
  if (outcome) text = `${outcome} (reported by the command; ${exitText}; ${dur}s)`;
  else {
    const maxTurns = !stopping && MAX_TURNS_SUBTYPES.includes(usage.claude?.subtype); // P5.4 a3/a7: the model ran out of turns mid-work (it may have written outside): an aborted run, never a plain failure that the routine repeats after `every`
    outcome = stopping === 'timeout' ? 'timeout' : stopping || maxTurns ? 'aborted' : 'failed';
    const reason = stopping === 'timeout' ? `no result within ${Math.round(t.timeout / 1000)}s` : stopping === 'paused' ? 'stopped by pause --now' : stopping ? 'the supervisor was told to stop' : maxTurns ? `the model stopped at max_turns (${usage.claude.turns ?? '?'} turns) without a result` : 'no result';
    const fields = { ...EMPTY, did: [cleanText(after?.note || t.nodata, 120)], problems: [{ kind: 'unknown', key: maxTurns ? 'max-turns' : outcome === 'failed' ? 'no-result' : outcome, text: `${reason} (${exitText})` }], writes: [`${t.kind}:${t.id}`] };
    const w = writeRoutineResult(ctx, bdir, t, a.as, run_id, fields, outcome);
    const refused = t.kind === 'routine' && !written(w);
    if (w.status === 'unsupported') { lost.push('the board no longer declares requires 0.6.0: nothing was written to the routine file'); unsaved = true; }
    if (!appendEnd(env, { event: 'end', run_id, finished: isoAt(finishedMs), duration_s: dur, outcome, reason: `${reason}${refused ? notWritten(w) : ''}`, source: 'supervisor', usage, ...summaryFields(fields) })) lost.push('the end of the run could not be written to the ledger (the next supervise marks it crashed)');
    if (refused) {
      penalized = true;
      if (!persist(env, dir, (s) => { s[key] = penalty(s, key, finishedMs); })) { lost.push('the back-off could not be saved to supervise.state.json'); unsaved = true; }
    }
    if (t.kind === 'task') { // what a card's run did before it ended without a result is unknown: no second run on top of it until the owner looks
      penalized = true;
      if (!persist(env, dir, (s) => { s[key] = { n: (s[key]?.n ?? 0) + 1, until: null, stopped: true, reason: `because the last run of the card ended ${outcome} without a result (${reason}) and what it did is unknown` }; })) { lost.push('the stop of the card could not be saved to supervise.state.json'); unsaved = true; }
    }
    text = `${outcome}: ${reason} (${exitText}; ${dur}s)${t.kind === 'routine' ? `; routine file: ${w.status}` : ''}`;
  }
  if (auto && auto.first && outcome === 'escalated' && result.code === 0 && !stopping && !fatal && !spawnError) {
    for (let i = 0; i < 20 && groupAlive(pgid); i++) await sleep(50);
    let checkpoint;
    try { checkpoint = JSON.parse(after.note); } catch { checkpoint = null; }
    if (checkpoint && checkpoint.in_flight === 'none' && typeof checkpoint.did === 'string' && typeof checkpoint.next === 'string' && !groupAlive(pgid)) {
      const state = { ...auto.state, phase: 'ready', outcome, group_gone: true, used_s: Math.ceil((Date.now() - t0) / 1000), checkpoint: { run_id, ...checkpoint } };
      try { writeEscalation(auto.file, state); } catch { lost.push('the escalation state could not be saved'); }
    }
  }
  if (!penalized) updateState(env, dir, (s) => { if (!s[key]?.stopped) delete s[key]; }); // a run that got to its end clears the count of orphans (a failed clear only leaves the old, stricter state)
  const code = ['ok', 'escalated'].includes(outcome) ? EXIT.ok : outcome === 'timeout' ? EXIT.timeout : outcome === 'aborted' ? EXIT.aborted : EXIT.failed;
  if (lost.length) return { code: code === EXIT.ok ? EXIT.failed : code, text: `${text}; WARNING: ${lost.join('; ')}`, run_id, outcome, ...(unsaved ? { unsavedStop: lost.join('; ') } : {}) };
  return { code, text, run_id, outcome };
}

/** The whole run: arguments, board, lock, the run. Returns { code, text, run_id?, outcome? }. */
export async function superviseRun(ctx, opts = {}) {
  if (typeof ctx.flags.card !== 'string') return superviseRunInner(ctx, opts);
  if ((opts.platform ?? process.platform) === 'win32') throw new Error(WINDOWS);
  const dir = path.dirname(ctx.api.tickLedgerPath(ctx.env));
  const bdir = ctx.api.findBoard(process.cwd(), typeof ctx.flags.board === 'string' ? ctx.flags.board : undefined, ctx.env);
  if (!bdir) return superviseRunInner(ctx, opts);
  let stateFile;
  try { stateFile = escalationFile(dir, bdir, ctx.flags.card); }
  catch (e) { if (ctx.flags['auto-profile']) throw e; return superviseRunInner(ctx, opts); }
  const file = `${stateFile}.lock`;
  const held = acquireLock(file, { staleMs: LOCK_STALE_MS, waitMs: 0, strict: true });
  if (!held.ok) return { code: EXIT.busy, text: 'the automatic escalation is already running or its lock cannot be acquired' };
  const pulse = setInterval(() => held.heartbeat(), knob(ctx.env, 'ROADCTL_SUPERVISE_HEARTBEAT_MS', 30000));
  try {
    if (!ctx.flags['auto-profile'] && !ctx.flags.reset) {
      let state;
      try { state = readEscalation(stateFile); } catch { state = null; }
      if (state && state.phase !== 'invalidated') {
        try { writeEscalation(stateFile, { ...state, phase: 'invalidated' }); }
        catch { return { code: EXIT.notStarted, text: 'cannot invalidate the earlier automatic escalation; manual run did not start' }; }
      }
    }
    return await superviseRunInner(ctx, opts);
  } finally { clearInterval(pulse); held.release(); }
}

async function superviseRunInner(ctx, { platform = process.platform, started } = {}) {
  const { env, api } = ctx;
  if (platform === 'win32') throw new Error(WINDOWS);
  if (typeof ctx.flags['auto-profile'] === 'string' && ctx.flags.as === undefined) {
    const c = readConductor(env);
    const p = c.state === 'ok' && c.conductor.profiles?.[ctx.flags['auto-profile']];
    if (!p) return { code: EXIT.notStarted, text: c.reason ?? 'no such automatic profile' };
    ctx.flags.as = p.agent;
  }
  const a = parseArgs(ctx);
  const dir = path.dirname(api.tickLedgerPath(env)); // the machine state directory
  let bdir = null;
  let t;
  if (a.sel.kind === 'orchestrator') t = targetOf(a.sel, a.as, null, a.timeout, a.model);
  else {
    bdir = api.findBoard(process.cwd(), typeof ctx.flags.board === 'string' ? ctx.flags.board : undefined, env);
    if (!bdir) throw new Error('no board found; run inside the project or use --board DIR / --project NAME');
    const board = api.loadBoard(bdir);
    t = targetOf(a.sel, a.as, board, a.timeout, a.model);
    const needs = t.kind === 'routine' && !ctx.flags.reset ? needsBoardVersion(api, board) : null;
    if (needs) return { code: EXIT.notStarted, text: needs };
  }
  const key = runKey(t);
  const file = lockFile(dir, t.kind, t.project, t.id);
  if (ctx.flags.reset) {
    if (!updateState(env, dir, (s) => { delete s[key]; }, { force: true })) return { code: EXIT.failed, text: `could not clear the local state of ${key} (supervise.state.json is locked or not writable)` };
    const marked = inspectLock(file);
    if (marked.state === 'stop-unsaved' && !removeMarkedLock(file, marked.raw)) return { code: EXIT.failed, text: `the state of ${key} is cleared, but its marked lock could not be removed (it changed hands, or the takeover guard is busy); look again, then repeat --reset` };
    return { code: EXIT.ok, text: `the local back-off and stop of ${key} are cleared` };
  }
  const u = usable(env);
  if (!u.ok) return { code: EXIT.usage, text: `the run ledger is not available (${u.reason}); supervise needs it` };
  const p0 = readPause(dir, nowMs(env));
  if (p0?.state === 'paused') return { code: EXIT.paused, text: `paused: ${pauseLine(p0)}` };
  const body = lockBody(a, t);
  // the previous holder: alive -> busy; a dead supervisor with a living command -> busy (finished off when its time is up); nothing left -> its lock is taken over under the guard
  let lock = null;
  for (let i = 0; i < 6 && !lock; i++) {
    if (i) await sleep(20);
    const held = inspectLock(file);
    if (held.state === 'stop-unsaved') return { code: EXIT.notStarted, text: `stopped on this machine: the stop of ${key} could not be saved (${held.info.stop_unsaved}); fix the state directory, then roadctl supervise <the same selector> --as AGENT --reset` };
    if (held.state === 'live') return busyResult(ctx, a, t, `${key} is supervised by ${held.pid ? `pid ${held.pid}` : 'a process whose lock cannot be read yet'} (run ${held.side?.run_id ?? '?'})`);
    if (held.state === 'orphan-live') {
      if (!(held.side.deadline && nowMs(env) >= Date.parse(held.side.deadline))) return busyResult(ctx, a, t, `the supervisor of ${key} died but its command still runs (process group ${held.side.pgid}, run ${held.side.run_id ?? '?'})`);
      signalGroup(held.side.pgid, 'SIGTERM'); // its time is up: finish it off, then look again
      await sleep(knob(env, 'ROADCTL_SUPERVISE_GRACE_MS', 5000));
      signalGroup(held.side.pgid, 'SIGKILL');
      await sleep(50);
      continue;
    }
    if (held.state === 'orphan-dead') lock = takeDeadLock(file, held.raw, body);
    else {
      const l = acquireLock(file, { staleMs: LOCK_STALE_MS, waitMs: 0, strict: true, content: body });
      if (l.ok) lock = { ...l, file };
      else if (l.reason !== 'held') throw new Error(`cannot take the lock ${path.basename(file)} (${l.reason})`);
    }
  }
  if (!lock) return busyResult(ctx, a, t, `${key} is being taken by another supervisor`);
  let res = null;
  let ended = 'ok';
  try {
    res = await runLocked(ctx, a, t, bdir, dir, lock, started);
  } finally {
    ended = finishLock(file, body, res?.unsavedStop ?? null); // sidecar and lock are touched only while the lock is still ours
  }
  if (ended === 'ok') return res;
  const why = ended === 'lost' ? 'the lock of the key changed hands before the end of the run (another process took it); its lock and sidecar were left alone' : 'the lock could not be released (the takeover guard stayed busy); it is taken over as a dead lock';
  return { ...res, code: res.code === EXIT.ok ? EXIT.failed : res.code, text: `${res.text}; WARNING: ${why}` };
}

// ---------------------------------------------------------------- --detach: a supervisor of its own session; the parent returns when the command runs

const ROADCTL = fileURLToPath(new URL('../roadctl.mjs', import.meta.url));

function detachParent(ctx) {
  const { flags, rest, out } = ctx;
  const sel = flags.routine !== undefined ? ['--routine', flags.routine] : flags.card !== undefined ? ['--card', flags.card] : ['--orchestrator'];
  const argv = [ROADCTL, 'supervise', ...sel, '--as', String(flags.as), ...(flags.timeout !== undefined ? ['--timeout', String(flags.timeout)] : []), ...(flags.stdin ? ['--stdin'] : []), ...(flags.model !== undefined ? ['--model', String(flags.model)] : []), ...(typeof flags.board === 'string' ? ['--board', flags.board] : []), '--', ...rest];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { detached: true, stdio: [flags.stdin ? 'inherit' : 'ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ROADCTL_SUPERVISE_CHILD: '1' }, cwd: process.cwd() });
    let done = false;
    const finish = (code, line) => {
      if (done) return;
      done = true;
      if (child.connected) child.disconnect();
      child.unref();
      if (code === 0) out(line);
      else process.stderr.write(`roadctl supervise: ${line}\n`);
      resolve(code);
    };
    child.on('message', (m) => (m?.status === 'started' ? finish(0, flags.json ? JSON.stringify({ run_id: m.run_id }) : `run_id=${m.run_id}`) : finish(m?.code || EXIT.failed, m?.text ?? 'did not start')));
    child.on('exit', (code) => finish(code || EXIT.failed, `the detached supervisor ended before the command started (exit ${code})`));
    child.on('error', (e) => finish(EXIT.failed, `cannot detach: ${e.message}`));
  });
}

async function superviseCommand(ctx) {
  const asChild = typeof process.send === 'function' && ctx.env.ROADCTL_SUPERVISE_CHILD === '1';
  if (ctx.flags.detach && !asChild) {
    if (process.platform === 'win32') throw new Error(WINDOWS);
    parseArgs(ctx); // a usage error is the parent's, at once
    return detachParent(ctx);
  }
  let told = false;
  const tell = (msg) => new Promise((r) => { told = true; process.send(msg, () => r()); });
  let r;
  try {
    r = await superviseRun(ctx, { started: asChild ? (run_id) => tell({ status: 'started', run_id }) : undefined });
  } catch (e) {
    if (asChild && !told) await tell({ status: 'refused', code: EXIT.usage, text: e.message });
    throw e;
  }
  if (asChild) {
    if (!told) await tell({ status: 'refused', code: r.code, text: r.text });
    if (process.connected) process.disconnect();
    return r.code;
  }
  const line = ctx.flags.json ? JSON.stringify({ code: r.code, outcome: r.outcome ?? null, run_id: r.run_id ?? null, text: r.text }) : `roadctl supervise: ${r.run_id ? `${r.run_id} ` : ''}${r.text}`;
  if (r.code === 0) ctx.out(line);
  else process.stderr.write(`${line}\n`);
  return r.code;
}

// ---------------------------------------------------------------- the module

export default {
  name: 'supervise',
  commands: {
    supervise: {
      group: 'Record', effect: 'write', hidden: true, summary: 'run a command under a lock, a timeout and a result check',
      purpose: 'Runs COMMAND (after --) as one supervised run of a routine, a card or the orchestrator of an agent. One run per key at a time on this machine, for the whole run: a second supervise of the same key exits 5 (busy, recorded as skipped: busy), and `tick` offers no RUN for a routine whose run is live. Under the lock it checks again that the run is still allowed (pause, requires, "allowed and due" for a routine), begins the run in the run ledger (ROADCTL_RUN_ID is passed to the command), starts the command in its own process group, keeps a pulse in the lock every 30 seconds and a private log (mode 0600, bounded, kept 30 days; its last 600 characters go to the ledger). A command that outlives --timeout (default: the routine\'s timeout, else 2 hours) gets TERM, then KILL, for its whole group (outcome timeout). A command that ends without a result in the ledger (routine done, report, run done) is "failed: no result"; for a routine the supervisor then writes the result to the routine file itself (the Log line ends with src=supervisor). TERM, INT or HUP to the supervisor, or pause --now, stops the group (outcome aborted). If the supervisor itself is killed with -9, the next supervise finds the orphan: its command alive -> busy, gone -> the lock is taken at once and the old run is crashed, and a local back-off (10, 20, 40 minutes, then a stop until --reset) keeps a routine whose result cannot be written from being offered on every tick. The result is written through the same hooks as `routine done` (a refusing hook means nothing is written). A routine\'s board must say "requires": "0.6.0" in config.json; a card whose run ended without a result is not run again until --reset; an open run begun by `run begin` or a claim is not taken over (busy); `tick` only marks the RUN of a dead supervisor (recover), the recovery is done by supervise. --detach prints run_id and returns while the supervisor goes on in its own session (it survives a dropped ssh). POSIX only (WSL included); native Windows is refused. In manual mode COMMAND is yours. With --auto-profile it builds and starts the local conductor template under the lock, spending one card time budget across an original run and at most one permitted strong-profile continuation; the worker uses run escalate with a run-bound checkpoint. The automatic path needs an approved, delegated card and uses a persistent local state; changed settings, a live or unknown outcome, or revoked approval refuse continuation.',
      usage: ['roadctl supervise --routine ID --as AGENT [--timeout 30m] [--stdin] [--detach] [--board DIR] -- COMMAND [ARGS...]', 'roadctl supervise --card ID --as AGENT [--timeout 30m] [--stdin] [--model NAME] [--detach] -- COMMAND [ARGS...]', 'roadctl supervise --card ID --auto-profile NAME [--board DIR]', 'roadctl supervise --orchestrator --as AGENT [--timeout 30m] [--detach] -- COMMAND [ARGS...]', 'roadctl supervise (--routine ID | --card ID | --orchestrator) --as AGENT --reset'],
      flags: [['--routine ID', 'supervise a run of this routine (the routine\'s own agent in --as)'], ['--card ID', 'supervise a run of this card'], ['--auto-profile NAME', 'opt in to one measured escalation using this local conductor profile'], ['--orchestrator', 'supervise the orchestrator run of the agent in --as'], ['--as AGENT', 'the agent that runs it'], ['--timeout SPAN', 'kill the command after this long: 90s, 30m, 2h, 1d (default: the routine\'s timeout, else 2h)'], ['--owner-answers IDS', 'comma-separated IDs included in the routine launch prompt'], ['--stdin', 'the command reads this process\'s stdin (the prompt of `roadctl launch`); without it the command gets none'], ['--model NAME', 'record the model of this run (for a card or the orchestrator; a routine\'s model is its own header): an escalated second attempt keeps the actual models'], ['--detach', 'print run_id and return at once; the supervisor goes on in its own session'], ['--reset', 'clear the local back-off or stop of this key; starts nothing'], ['--json', 'machine-readable output']],
      examples: ['roadctl supervise --routine server-watch --as claude-code@home-wsl --timeout 30m -- claude -p --max-turns 30 "$(cat prompt.txt)"', 'roadctl supervise --routine server-watch --as claude-code@home-wsl --detach -- ./run-watch.sh', 'roadctl supervise --orchestrator --as claude-code@home-wsl -- claude -p "$(roadctl tick --as claude-code@home-wsl --prompt)"'],
      changes: 'Writes in the machine state directory (the lock supervise-<key>.lock and its .run file, run-logs/, supervise.state.json, runs.jsonl). For a routine whose run left no result it writes the routine file (last_run, last_result failed, a Log line) and commits and pushes it like routine done. No other board file.',
      exits: '0 the run ended ok or escalated (or --detach started it, or --reset); 1 failed (no result, or the command reported failed); 2 usage error or unsupported platform; 4 not started (not allowed or not due any more, back-off or stop); 5 busy; 6 paused; 7 timeout; 8 aborted',
      run: superviseCommand,
    },
  },
  hooks: {
    /** `tick`, `routine list`, `status`: a routine whose supervised run is live, backing off or stopped is not offered again. */
    'routine-reasons'({ board, routine, env, api, now }) {
      const id = routine.header.id;
      if (!id) return {};
      const dir = path.dirname(api.tickLedgerPath(env));
      const project = projectOf(board);
      const h = inspectLock(lockFile(dir, 'routine', project, id));
      if ((h.state === 'live' || h.state === 'orphan-live') && h.pid !== process.pid) return { reasons: ['a supervised run is live'], lint: 'none' };
      if (h.state === 'stop-unsaved') return { reasons: ['stopped by the supervisor: a stop could not be saved (roadctl supervise --reset)'], lint: 'none' };
      const c = api.compareVersions(board.config?.requires ?? '', NEEDS_VERSION);
      if (c === null || c < 0) return {}; // a board that cannot be supervised is not touched by the local state of the supervisor
      const st = readState(dir);
      if (st.__unreadable) return { reasons: ['supervise.state.json cannot be read (roadctl supervise --reset)'], lint: 'none' };
      const s = st[`routine:${project}/${id}`];
      if (s?.stopped) return { reasons: ['stopped by the supervisor (roadctl supervise --reset)'], lint: 'none' };
      if (s?.until && now < Date.parse(s.until)) return { reasons: [`supervisor back-off until ${s.until}`], lint: 'none' };
      return {};
    },
    /**
     * This hook of `tick` only READS (the ledger records `tick` itself writes are the run ledger's own hooks, P5.1): a routine that is offered (RUN) while a supervised run of it is still open in the ledger and nothing holds its lock any more died with its
     * supervisor. The item gets `routine.recover` (the text of tick changes once, a monitor starts the supervisor), and `supervise` does the recovery under its
     * own lock after it has checked the board's `requires`: tick writes no board file, pushes nothing and changes no ledger record in this hook.
     */
    'tick-before'({ env, items }) {
      const open = new Map([...readRuns(env).values()].filter((r) => r.outcome === 'started' && r.source === 'supervisor' && r.kind === 'routine').map((r) => [runKey(r), r]));
      const run = {};
      for (const i of items) {
        const o = i.kind === 'RUN' ? open.get(`routine:${i.project}/${i.id}`) : null;
        if (o) run[`${i.project}/${i.id}`] = { recover: `supervised run ${o.run_id} died` };
      }
      return { run };
    },
  },
};
