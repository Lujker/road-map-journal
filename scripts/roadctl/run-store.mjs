// Storage of the run ledger (P5.1): the machine state directory, runs.jsonl, ticks.state.json, locking, rotation. No roadctl.mjs import,
// no side effects at import; Node standard library only. Used by run-ledger.mjs (the module) and by its tests.
//
// Files (in `${XDG_STATE_HOME:-~/.local/state}/road-map-journal/`, next to ticks.jsonl; never inside a git work tree):
//   runs.jsonl        append-only, one JSON line (at most 4096 bytes with the newline) per event of a run: begin, note, end, crash, skip, skips.
//                     The folded view of the lines of one run_id is the run record (RUN_FIELDS). runs.jsonl.1 is the one previous generation.
//   ticks.state.json  the last tick decision per agent and filter with a counter and the first and last time; the skipped-run folding state.
//   ledger.lock       a short lock around every check-then-append and every read-modify-write of the state file.
// A reader tolerates broken lines and a missing file. Every write returns a status instead of throwing: a ledger that cannot be written must
// never stop `routine done`, `claim`, `report` or `tick`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_LINE = 4096; // bytes of one line including the newline (Cyrillic text is two bytes a character)
export const TICKS_ROTATE_BYTES = 1024 * 1024;
export const RUNS_ROTATE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 2 * 3600e3; // an open run without an end counts as crashed after this long (header `timeout:` of a routine overrides)
export const STATE_KEEP_MS = 30 * 86400e3;

export const KINDS = ['routine', 'task', 'orchestrator'];
export const SOURCES = ['agent', 'supervisor', 'tick'];
export const OUTCOMES = ['started', 'ok', 'escalated', 'failed', 'timeout', 'aborted', 'crashed', 'skipped'];
export const SKIP_REASONS = ['busy', 'limits', 'not-due', 'paused']; // paused (P5.5): the owner's local switch (roadctl pause)
export const PROBLEM_KINDS = ['transient', 'permanent', 'unknown'];
/** Outcomes of a run that did not finish by itself: they count as attempts when the same routine is offered again. */
export const BAD_OUTCOMES = new Set(['crashed', 'failed', 'timeout', 'aborted']);
/** The fields of a run record, in the order `roadctl runs --json` prints them. docs/roadctl.md describes each one. */
export const RUN_FIELDS = ['run_id', 'kind', 'id', 'project', 'agent', 'model', 'host', 'source', 'started', 'finished', 'duration_s', 'outcome', 'reason', 'attempt', 'roadctl', 'usage', 'did', 'decisions', 'problems', 'needs_owner', 'not_checked', 'writes', 'ref', 'note', 'count', 'deadline'];
const DEFAULTS = { project: null, agent: null, model: null, host: null, source: 'agent', started: null, finished: null, duration_s: null, outcome: 'started', reason: null, attempt: 1, roadctl: null, usage: null, did: [], decisions: [], problems: [], needs_owner: null, not_checked: null, writes: [], ref: null, note: null, count: 1, deadline: null };

// ---------------------------------------------------------------- time, names, paths

/** "Now" in ms: ROADCTL_NOW (ISO-8601 UTC, tests and replays) or the machine clock. */
export const nowMs = (env = process.env) => (env.ROADCTL_NOW && Number.isFinite(Date.parse(env.ROADCTL_NOW)) ? Date.parse(env.ROADCTL_NOW) : Date.now());
export const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const hostName = (env = process.env) => String(env.ROADCTL_HOST || os.hostname() || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'unknown';

/** Like roadctl's sanitizeText: control characters, backticks and angle brackets removed, one line, cut to n characters. */
export function cleanText(s, n = 200) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[`<>]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export const stateDir = (env = process.env) => path.join(env.XDG_STATE_HOME?.trim() ? env.XDG_STATE_HOME.trim() : path.join(os.homedir(), '.local', 'state'), 'road-map-journal');
export function ledgerPaths(env = process.env) {
  const dir = stateDir(env);
  const f = (n) => path.join(dir, n);
  return { dir, runs: f('runs.jsonl'), runsPrev: f('runs.jsonl.1'), ticks: f('ticks.jsonl'), ticksPrev: f('ticks.jsonl.1'), state: f('ticks.state.json'), lock: f('ledger.lock') };
}

/** The root of the git work tree that contains `dir`, or null. A repository in the home directory itself is not counted (nothing could avoid it). */
export function gitWorkTreeOf(dir, env = process.env) {
  const home = path.resolve(env.HOME || env.USERPROFILE || os.homedir());
  let p = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(p, '.git'))) return p === home ? null : p;
    const up = path.dirname(p);
    if (up === p) return null;
    p = up;
  }
}

/** { ok: true } when the ledger may be written: the state directory is not inside a git work tree and can be created. */
export function usable(env = process.env) {
  const p = ledgerPaths(env);
  const tree = gitWorkTreeOf(p.dir, env);
  if (tree) return { ok: false, reason: 'the state directory is inside a git work tree (the ledger holds the text of run summaries and must not be committed)' };
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `the state directory cannot be created (${e.code ?? 'error'})` };
  }
}

// ---------------------------------------------------------------- lines: fit to 4 KB, append, read

function strings(o, acc = []) {
  if (typeof o !== 'object' || o === null) return acc;
  for (const k of Object.keys(o)) {
    if (typeof o[k] === 'string') acc.push([o, k]);
    else strings(o[k], acc);
  }
  return acc;
}

/** One JSON line that fits MAX_LINE bytes: the longest strings are cut (to half) until it does, then whole text fields go. The input is not changed. */
export function fitLine(obj, max = MAX_LINE) {
  const rec = structuredClone(obj);
  let line = JSON.stringify(rec);
  for (let i = 0; i < 400 && Buffer.byteLength(line) > max - 1; i++) {
    const [o, k] = strings(rec).sort((a, b) => b[0][b[1]].length - a[0][a[1]].length)[0] ?? [];
    if (o && o[k].length > 24) o[k] = `${o[k].slice(0, Math.ceil(o[k].length / 2))}…`;
    else {
      const f = ['note', 'did', 'decisions', 'problems', 'writes', 'reason'].find((x) => x in rec);
      if (!f) break;
      delete rec[f];
    }
    line = JSON.stringify(rec);
  }
  if (Buffer.byteLength(line) > max - 1) line = JSON.stringify({ run_id: rec.run_id, event: rec.event });
  return `${line}\n`;
}

/** Append one fitted line with a single write (O_APPEND: lines of concurrent writers do not mix). Returns false when it could not be written. */
export function appendLine(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, fitLine(obj));
    return true;
  } catch {
    return false;
  }
}

/** All parsable lines of a JSONL file (a broken or half-written line is skipped); [] when the file is missing. */
export function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((l) => {
    if (!l.trim()) return [];
    try {
      const v = JSON.parse(l);
      return v && typeof v === 'object' && !Array.isArray(v) ? [v] : [];
    } catch {
      return [];
    }
  });
}

/** One previous generation: `file` becomes `file.1` (an older `file.1` is replaced) once it is larger than maxBytes. Call it only under the tick lock. */
export function rotateIfLarge(file, maxBytes) {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the lock (real time: it is about real processes)

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run fn while holding ledger.lock; { locked: false } when the lock could not be taken in time (the caller then skips or falls back, never fails). */
export function withLedgerLock(env, fn, { timeoutMs = 2000, staleMs = 30000 } = {}) {
  const { lock } = ledgerPaths(env);
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') return { locked: false, error: e.code };
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmSync(lock, { force: true });
      } catch {
        /* vanished */
      }
      if (Date.now() > end) return { locked: false };
      sleepSync(15);
    }
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    try {
      fs.rmSync(lock, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- run records

export const runKey = (r) => `${r.kind}:${r.project ?? '-'}/${r.id}`;
export const runIdFor = (key, anchor, attempt) => `r-${crypto.createHash('sha256').update(`${key}\n${anchor ?? ''}\n${attempt}`).digest('hex').slice(0, 12)}`;

/** A full record in schema order with defaults; null when the lines never said what kind of run it is. */
function normalize(rec) {
  if (!rec.kind || !rec.id) return null;
  return Object.fromEntries(RUN_FIELDS.map((k) => [k, rec[k] === undefined ? (k in DEFAULTS ? structuredClone(DEFAULTS[k]) : null) : rec[k]]));
}

/** Fold the lines of runs.jsonl into run records (Map run_id -> record). Rules in docs/roadctl.md; in short: the first end wins, a real end replaces a `crashed` mark. */
export function foldRuns(lines) {
  const map = new Map();
  for (const line of lines) {
    if (typeof line.run_id !== 'string') continue;
    const { event, ...rest } = line;
    const cur = map.get(line.run_id);
    const open = !cur || cur.outcome === 'started' || cur.outcome === undefined;
    if (!cur) map.set(line.run_id, { ...rest });
    else if (event === 'begin' || event === 'skip') Object.assign(cur, Object.fromEntries(Object.entries(rest).filter(([k]) => !(k in cur) || cur[k] == null)));
    else if (event === 'note') Object.assign(cur, { note: rest.note });
    else if (event === 'skips') Object.assign(cur, { count: rest.count, finished: rest.finished });
    else if (event === 'crash') {
      if (open) Object.assign(cur, rest);
    } else if (event === 'end') {
      if (open || cur.outcome === 'crashed') Object.assign(cur, rest);
    }
  }
  return map;
}

/** Run records of both generations, with the live counter of folded skips from ticks.state.json. Map run_id -> record (complete records only). */
export function readRuns(env = process.env) {
  const p = ledgerPaths(env);
  const folded = foldRuns([...readJsonl(p.runsPrev), ...readJsonl(p.runs)]);
  const state = readState(env);
  for (const s of Object.values(state.skips ?? {})) {
    const r = folded.get(s.run_id);
    if (r && Number.isInteger(s.count)) Object.assign(r, { count: s.count, finished: s.last });
  }
  const out = new Map();
  for (const [id, rec] of folded) {
    const n = normalize(rec);
    if (n) out.set(id, n);
  }
  return out;
}

/** True for an open run that no supervisor looks after and whose deadline has passed (the pid of a run is never consulted). */
export const isOverdue = (run, now) => run.outcome === 'started' && run.source !== 'supervisor' && Boolean(run.deadline) && now >= Date.parse(run.deadline);

/** How many runs of this key since `anchor` (an ISO time, usually the routine's last_run) ended badly: `attempt` of the next run is this plus one. */
export function badAttempts(runs, key, anchor) {
  const from = Date.parse(anchor ?? '');
  let n = 0;
  for (const r of runs.values()) {
    if (runKey(r) !== key || !BAD_OUTCOMES.has(r.outcome)) continue;
    if (Number.isFinite(from) && Date.parse(r.started ?? r.finished ?? '') < from) continue;
    n++;
  }
  return n;
}

/** The unfinished run of a key, if any. */
export const openRun = (runs, key) => [...runs.values()].find((r) => r.outcome === 'started' && runKey(r) === key) ?? null;

const crashLine = (run, now, reason) => ({ event: 'crash', run_id: run.run_id, finished: isoAt(now), duration_s: run.started ? Math.max(0, Math.round((now - Date.parse(run.started)) / 1000)) : null, outcome: 'crashed', reason, note: run.note });

/**
 * Mark every overdue unsupervised run as crashed (a time threshold only, `nowMs` clock). Idempotent: under the lock, so two ticks do not both
 * write it. Returns the run records that were marked.
 */
export function reconcileCrashed(env, now) {
  if (!usable(env).ok) return [];
  const r = withLedgerLock(env, () => {
    const marked = [];
    for (const run of readRuns(env).values()) {
      if (!isOverdue(run, now)) continue;
      if (appendLine(ledgerPaths(env).runs, crashLine(run, now, `no end by the deadline ${run.deadline}`))) marked.push(run);
    }
    return marked;
  });
  return r.locked ? r.value : [];
}

/**
 * Start a run. p: { kind, project, id, agent, model, source, runId, anchor, deadlineMs (absolute), now, version, supersede }.
 * Status: begun | already (an open run of the same key exists, or the explicit run id does) | unavailable.
 * An open run that is overdue is marked crashed first; with `supersede` (a new claim) any open run of the key is.
 */
export function beginRun(env, p) {
  const u = usable(env);
  if (!u.ok) return { status: 'unavailable', reason: u.reason };
  const r = withLedgerLock(env, () => {
    const runs = readRuns(env);
    const key = runKey(p);
    const open = openRun(runs, key);
    if (open) {
      if (!p.supersede && !isOverdue(open, p.now)) return { status: 'already', run: open };
      if (!appendLine(ledgerPaths(env).runs, crashLine(open, p.now, p.supersede && !isOverdue(open, p.now) ? 'superseded by a new claim' : `no end by the deadline ${open.deadline}`))) return { status: 'unavailable', reason: 'runs.jsonl cannot be written' };
      Object.assign(open, { outcome: 'crashed' });
    }
    if (p.runId && runs.has(p.runId)) return { status: 'already', run: runs.get(p.runId) };
    const attempt = badAttempts(runs, key, p.anchor) + 1;
    let run_id = p.runId || runIdFor(key, p.anchor, attempt);
    for (let salt = 1; runs.has(run_id); salt++) run_id = runIdFor(key, p.anchor, `${attempt}.${salt}`);
    const rec = { event: 'begin', run_id, kind: p.kind, id: p.id, project: p.project ?? null, agent: p.agent, model: p.model ?? null, host: hostName(env), source: p.source ?? 'agent', started: isoAt(p.now), outcome: 'started', attempt, roadctl: p.version ?? null, deadline: p.deadlineMs ? isoAt(p.deadlineMs) : null };
    if (!appendLine(ledgerPaths(env).runs, rec)) return { status: 'unavailable', reason: 'runs.jsonl cannot be written' };
    return { status: 'begun', run: normalize({ ...DEFAULTS, ...rec }) };
  });
  return r.locked ? r.value : { status: 'unavailable', reason: 'the ledger is locked by another process' };
}

/**
 * Where an end would be recorded, without writing: the run named by `runId`, else the open run of the key, else a new id (from the key, the
 * anchor and the number of earlier bad attempts: the same inputs give the same id). { run_id, run (or null), problem (or null) }.
 */
export function locateRun(env, p) {
  const runs = readRuns(env);
  const key = runKey(p);
  if (p.runId) {
    const run = runs.get(p.runId) ?? null;
    if (run && runKey(run) !== key) return { run_id: p.runId, run, problem: `run ${p.runId} belongs to ${runKey(run)}, not ${key}` };
    return { run_id: p.runId, run, problem: null };
  }
  const run = openRun(runs, key);
  if (run) return { run_id: run.run_id, run, problem: null };
  const attempt = badAttempts(runs, key, p.anchor) + 1;
  let run_id = runIdFor(key, p.anchor, attempt);
  for (let salt = 1; runs.has(run_id); salt++) run_id = runIdFor(key, p.anchor, `${attempt}.${salt}`);
  return { run_id, run: null, problem: null };
}

const SUMMARY_LISTS = ['did', 'decisions', 'writes'];
/** Keep only well-formed summary fields (P5.13 sets their limits; the ledger checks types and the 4 KB line). */
export function summaryFields(f = {}) {
  const out = {};
  for (const k of SUMMARY_LISTS) if (Array.isArray(f[k])) out[k] = f[k].filter((x) => typeof x === 'string').map((x) => cleanText(x, 400));
  if (Array.isArray(f.problems)) out.problems = f.problems.filter((x) => x && PROBLEM_KINDS.includes(x.kind) && typeof x.key === 'string' && typeof x.text === 'string').map((x) => ({ kind: x.kind, key: cleanText(x.key, 80), text: cleanText(x.text, 300) }));
  for (const k of ['needs_owner', 'not_checked', 'ref']) if (typeof f[k] === 'string') out[k] = cleanText(f[k], 400);
  return out;
}

/**
 * End a run. p: { runId, plan (from locateRun), kind, project, id, agent, model, source, outcome, reason, fields, anchor, now, version }.
 * An existing run gets one `end` line (a real end replaces a `crashed` mark); without a begin the line is a whole record (started null, no duration).
 */
export function finishRun(env, p) {
  if (!usable(env).ok) return { status: 'unavailable' };
  const run = p.plan?.run ?? null;
  const finished = isoAt(p.now);
  const rec = { event: 'end', run_id: p.runId, finished, outcome: p.outcome, reason: p.reason ?? null, ...summaryFields(p.fields) };
  if (run?.started) rec.duration_s = Math.max(0, Math.round((p.now - Date.parse(run.started)) / 1000));
  if (!run) {
    const runs = readRuns(env);
    const attempt = badAttempts(runs, runKey(p), p.anchor) + 1;
    Object.assign(rec, { kind: p.kind, id: p.id, project: p.project ?? null, agent: p.agent, model: p.model ?? null, host: hostName(env), source: p.source ?? 'agent', started: null, duration_s: null, attempt, roadctl: p.version ?? null });
  }
  return appendLine(ledgerPaths(env).runs, rec) ? { status: 'ended', run_id: p.runId, duration_s: rec.duration_s ?? null } : { status: 'unavailable' };
}

/** A checkpoint: the last one stays in the record. Returns false when nothing was written. */
export const noteRun = (env, runId, text, now) => appendLine(ledgerPaths(env).runs, { event: 'note', run_id: runId, note: cleanText(text, 300), noted: isoAt(now) });

// ---------------------------------------------------------------- ticks.state.json: tick folding and skipped runs

export function readState(env = process.env) {
  try {
    const s = JSON.parse(fs.readFileSync(ledgerPaths(env).state, 'utf8'));
    if (s && typeof s === 'object' && !Array.isArray(s)) return { v: 1, ticks: s.ticks && typeof s.ticks === 'object' ? s.ticks : {}, skips: s.skips && typeof s.skips === 'object' ? s.skips : {} };
  } catch {
    /* missing or broken: start again */
  }
  return { v: 1, ticks: {}, skips: {} };
}

function writeState(env, state) {
  const { state: file } = ledgerPaths(env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  fs.renameSync(tmp, file); // atomic: a reader sees the old or the new file, never half of one
}

/** Read-modify-write of the state file under the ledger lock. fn(state, p) returns true when the state changed. { ok: false } when it could not be done. */
function withState(env, fn) {
  if (!usable(env).ok) return { ok: false };
  try {
    const r = withLedgerLock(env, () => {
      const state = readState(env);
      const changed = fn(state, ledgerPaths(env));
      if (changed) writeState(env, state);
      return true;
    });
    return { ok: r.locked && r.value === true };
  } catch {
    return { ok: false }; // a full disk or a read-only directory: the caller falls back, nothing stops
  }
}

const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** Decisions whose repeats are folded into one line: a gate that stays closed or a tick that stays busy says the same thing every five minutes. `idle` and `work` keep one line per tick, as before. */
export const FOLDED_DECISIONS = new Set(['blocked-reserve', 'blocked-unknown', 'busy', 'paused']);

/**
 * The ticks.jsonl line of one tick. Repeats of a blocked or busy decision (everything but the time equal to the last tick of the same agent
 * and filter) only move the counter and the last time in ticks.state.json; any other tick is appended as before, and the state keeps the
 * streak of the last decision for every tick. `rotate`: also keep one previous generation of ticks.jsonl (only inside tick, under its lock).
 * Returns true when the entry was handled here; false means the caller should append it as before (the state directory is not usable, or the lock is busy).
 */
export function recordTick(env, entry, { rotate = false, maxBytes = TICKS_ROTATE_BYTES } = {}) {
  const key = `${entry.agent}|${entry.filter ? stable(entry.filter) : ''}`;
  const { time, ...rest } = entry;
  const sig = stable(rest);
  const now = Date.parse(time);
  const r = withState(env, (state, p) => {
    if (rotate) rotateIfLarge(p.ticks, maxBytes);
    const cur = state.ticks[key];
    for (const [k, v] of Object.entries(state.ticks)) if (!Number.isFinite(Date.parse(v.last)) || now - Date.parse(v.last) > STATE_KEEP_MS) delete state.ticks[k];
    const same = cur && cur.sig === sig;
    if (same && FOLDED_DECISIONS.has(entry.decision) && fs.existsSync(p.ticks)) {
      cur.count++;
      cur.last = time;
      return true;
    }
    if (!appendLine(p.ticks, entry)) throw new Error('ticks.jsonl cannot be written');
    state.ticks[key] = same ? { ...cur, count: cur.count + 1, last: time } : { sig, decision: entry.decision, count: 1, first: time, last: time };
    return true;
  });
  return r.ok;
}

const closeSkip = (p, s) => {
  if (s.count > 1) appendLine(p.runs, { event: 'skips', run_id: s.run_id, count: s.count, finished: s.last });
};

/**
 * A skipped run (reason busy | limits | not-due | paused), folded: the same skip of the same thing in a row is one record whose counter is kept in
 * ticks.state.json and written to runs.jsonl when the streak ends. p: { kind, project, id, agent, reason, now, version }.
 */
export function recordSkip(env, p) {
  const key = `${p.kind}:${p.project ?? '-'}/${p.id}|${p.agent}`;
  const t = isoAt(p.now);
  return withState(env, (state, paths) => {
    const cur = state.skips[key];
    if (cur && cur.reason === p.reason) {
      cur.count++;
      cur.last = t;
      return true;
    }
    if (cur) closeSkip(paths, cur);
    const run_id = `s-${crypto.createHash('sha256').update(`${key}\n${p.reason}\n${t}`).digest('hex').slice(0, 12)}`;
    const rec = { event: 'skip', run_id, kind: p.kind, id: p.id, project: p.project ?? null, agent: p.agent, host: hostName(env), source: 'tick', started: t, finished: t, duration_s: 0, outcome: 'skipped', reason: p.reason, roadctl: p.version ?? null };
    if (!appendLine(paths.runs, rec)) throw new Error('runs.jsonl cannot be written');
    state.skips[key] = { run_id, reason: p.reason, count: 1, first: t, last: t, agent: p.agent };
    return true;
  }).ok;
}

/** End the skip streaks for which `match(key, streak)` is true (the thing ran, or is no longer skipped). */
export function clearSkips(env, match) {
  const p = ledgerPaths(env);
  if (!fs.existsSync(p.state)) return true;
  return withState(env, (state, paths) => {
    let changed = false;
    for (const [k, s] of Object.entries(state.skips)) {
      if (!match(k, s)) continue;
      closeSkip(paths, s);
      delete state.skips[k];
      changed = true;
    }
    return changed;
  }).ok;
}
