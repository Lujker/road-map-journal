// Local pause switch (P5.5, core): `roadctl pause [--reason TEXT] [--until SPAN|TIME]` and `roadctl resume`.
//
// A pause is state of THIS machine, not of a board: one file `pause.json` in the machine state directory (the one of ticks.jsonl; WSL and native
// Windows have different ones). It is never written to git and never changes a card, a routine or `config.json`, so it is not a board format and
// needs no `requires` (docs/developing-roadctl.md). While it is in force `roadctl tick` starts nothing of any kind (TAKE, ACCEPT, START, STALE, RUN):
// it prints a stable text, writes one folded line to the ledger, asks no limits gate, pulls nothing and exits 6.
//
// Seam (named hook `pause-state`, called by roadctl.mjs in `tick`, `status` and `routine list`): returns { paused } or {} for "not paused".
// Rules that keep the switch safe:
//   - a file that cannot be read or understood counts as PAUSED (fail closed); `roadctl resume` removes it either way;
//   - `--until` is judged by roadctl's clock (ROADCTL_NOW in tests); an expired pause is ignored but the file stays until the next pause or resume;
//   - the reason is data for people: one line, sanitised, never part of an instruction.
// Node standard library only, no side effects at import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanText } from './run-store.mjs';

export const PAUSE_FILE = 'pause.json';
export const MAX_REASON = 200;
export const MAX_SPAN_MS = 90 * 86400e3; // a relative --until longer than this is most likely a typo; no --until means "until resume"
const UNITS = { m: 60e3, h: 3600e3, d: 86400e3 };
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const pauseFile = (dir) => path.join(dir, PAUSE_FILE);
const dirOf = (ctx) => path.dirname(ctx.api.tickLedgerPath(ctx.env)); // the same directory as the ledger and the tick locks

/** `--until`: a span (`30m`, `2h`, `1d`, at most 90d) from now, or a full ISO-8601 time with a zone (`2026-11-14T09:00:00Z`). Returns epoch ms; throws an Error with the usage. */
export function parseUntil(value, now) {
  const usage = '--until is a span like 30m, 2h or 1d (at most 90d), or a time with a zone like 2026-11-14T09:00:00Z';
  if (typeof value !== 'string') throw new Error(usage);
  const m = /^(\d+)([mhd])$/.exec(value);
  if (m) {
    const ms = Number(m[1]) * UNITS[m[2]];
    if (!(ms > 0) || ms > MAX_SPAN_MS) throw new Error(usage);
    return now + ms;
  }
  if (ISO_ZONED.test(value) && Number.isFinite(Date.parse(value))) {
    if (Date.parse(value) <= now) throw new Error('--until is already in the past');
    return Date.parse(value);
  }
  throw new Error(usage);
}

/**
 * The pause of this machine, or null. { state: 'paused' | 'expired', since, by, reason, until, unreadable? }; since/by/reason/until are strings or null.
 * A missing file is no pause; any other failure to read it is a pause (fail closed).
 */
export function readPause(dir, now) {
  let text;
  try {
    text = fs.readFileSync(pauseFile(dir), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    return { state: 'paused', since: null, by: null, reason: 'the pause file cannot be read', until: null, unreadable: true };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { state: 'paused', since: null, by: null, reason: 'the pause file is not understood; roadctl resume removes it', until: null, unreadable: true };
  const str = (v, n) => (typeof v === 'string' && cleanText(v, n) ? cleanText(v, n) : null);
  const until = typeof j.until === 'string' && Number.isFinite(Date.parse(j.until)) ? j.until : null;
  const p = { state: 'paused', since: str(j.since, 40), by: str(j.by, 60), reason: str(j.reason, MAX_REASON), until };
  if (until && now >= Date.parse(until)) p.state = 'expired';
  return p;
}

/** One line for people: `PAUSED since T by NAME until T: reason`. */
export const pauseLine = (p) => `PAUSED${p.since ? ` since ${p.since}` : ''}${p.by ? ` by ${p.by}` : ''}${p.until ? ` until ${p.until}` : ''}: ${p.reason ?? 'no reason given'}`;

/** The data a consumer sees (tick --json, status --json): only the facts. */
export const pauseData = (p) => ({ since: p.since, by: p.by, reason: p.reason, until: p.until });

function writePause(dir, rec) {
  fs.mkdirSync(dir, { recursive: true });
  const file = pauseFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`);
  fs.renameSync(tmp, file); // atomic: a tick sees the old pause or the new one, never half of one
}

const who = (env) => {
  try {
    return env.USER || env.USERNAME || os.userInfo().username || 'unknown';
  } catch {
    return env.USER || env.USERNAME || 'unknown';
  }
};

const shown = (p, env) => (env.HOME && p.startsWith(env.HOME + path.sep) ? `~${p.slice(env.HOME.length)}` : p);

function pauseCommand({ flags, args, out, env, api }) {
  const dir = dirOf({ env, api });
  const now = api.nowMs(env);
  if (args[1] === 'status' && args.length === 2) {
    const p = readPause(dir, now);
    const active = p?.state === 'paused';
    if (flags.json) out(JSON.stringify({ paused: active, ...(p ? { pause: { ...pauseData(p), ...(p.state === 'expired' ? { expired: true } : {}) } } : {}) }, null, 2));
    else out(active ? pauseLine(p) : p ? `not paused (the pause until ${p.until} has expired)` : 'not paused');
    return 0;
  }
  if (args.length > 1) throw new Error('usage: roadctl pause [--reason TEXT] [--until SPAN|TIME] [--by NAME]   |   roadctl pause status [--json]   (undo: roadctl resume)');
  for (const k of ['reason', 'until', 'by']) if (Object.hasOwn(flags, k) && (typeof flags[k] !== 'string' || !flags[k].trim() || flags[k].startsWith('--'))) throw new Error(`--${k} needs a value`);
  const until = Object.hasOwn(flags, 'until') ? parseUntil(flags.until.trim(), now) : null;
  const before = readPause(dir, now);
  const rec = { v: 1, since: isoAt(now), by: cleanText(flags.by ?? who(env), 60) || 'unknown', reason: Object.hasOwn(flags, 'reason') ? cleanText(flags.reason, MAX_REASON) || null : null, until: until === null ? null : isoAt(until), roadctl: api.VERSION };
  try {
    writePause(dir, rec);
  } catch (e) {
    throw new Error(`cannot write the pause file ${shown(pauseFile(dir), env)}: ${String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 120)}; nothing is paused`);
  }
  out(`${before?.state === 'paused' ? 'updated: ' : ''}${pauseLine(rec)}`);
  out(`This machine only (${shown(pauseFile(dir), env)}): roadctl tick now starts nothing and exits 6; no board or git change. A run that has already started is not stopped. Undo: roadctl resume`);
  return 0;
}

function resumeCommand({ out, env, api }) {
  const dir = dirOf({ env, api });
  const file = pauseFile(dir);
  const before = readPause(dir, api.nowMs(env));
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    throw new Error(`cannot remove the pause file ${shown(file, env)}: ${String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 120)}; still paused`);
  }
  out(before?.state === 'paused' ? `resumed (was ${pauseLine(before)})` : before ? 'not paused (an expired pause was removed)' : 'not paused; nothing to do');
  return 0;
}

export default {
  name: 'pause',
  hooks: {
    /** `tick`, `status`, `routine list`: { paused } while this machine is paused (an expired or missing pause: {}). */
    'pause-state'(ctx) {
      const p = readPause(dirOf(ctx), ctx.api.nowMs(ctx.env));
      if (p?.state !== 'paused') return {};
      return { paused: pauseData(p), line: `${pauseLine(p)} (roadctl tick starts nothing on this machine; roadctl resume ends it)` };
    },
  },
  commands: {
    pause: {
      group: 'Owner only',
      owner: true, // seam (P5.28)
      effect: 'write',
      summary: 'stop everything unattended on this machine (undo: resume)',
      purpose: 'The owner\'s stop switch for ONE machine, in force at once and without git: writes pause.json in the machine state directory (who, when, reason, optional end). While it exists roadctl tick starts nothing of any kind (TAKE, ACCEPT, START, STALE, RUN): it prints "tick AGENT: paused" and the reason, asks no limits gate, pulls nothing, records one folded line in the ledger (a skipped run with the reason paused) and exits 6, so a scheduler and a monitor start no model. A run that has already started is not stopped. The pause belongs to the state directory: WSL and native Windows have separate ones, another machine is paused over ssh (ssh HOST roadctl pause), and the switch shared through git is roadctl autonomy routines off. roadctl status, routine list, tick --json and doctor show an active pause. Without --until it lasts until roadctl resume; a pause that cannot be read counts as a pause. `roadctl pause status` prints the state without a board.',
      usage: ['roadctl pause [--reason TEXT] [--until SPAN|TIME] [--by NAME]', 'roadctl pause status [--json]'],
      flags: [['--reason TEXT', 'why (one line, up to 200 characters); shown by tick, status, routine list and doctor'], ['--until X', 'end the pause by itself: a span (30m, 2h, 1d, at most 90d) or a time with a zone (2026-11-14T09:00:00Z); an ended pause is ignored, resume removes the file'], ['--by NAME', 'who paused (default: the login name of the user)'], ['--json', 'with pause status: machine-readable output']],
      examples: ['roadctl pause --reason "limits are low until Monday"', 'roadctl pause --until 4h --reason "debugging the scheduler"', 'roadctl pause status', 'ssh HOST roadctl pause --reason "away"'],
      changes: 'Writes only $XDG_STATE_HOME/road-map-journal/pause.json (default ~/.local/state). No board, no git, no card. Starts no model.',
      exits: '0 paused (or status printed); 2 usage error or the file cannot be written',
      run: pauseCommand,
    },
    resume: {
      group: 'Owner only',
      owner: true, // seam (P5.28)
      hidden: true, // the overview has one line left (the help test caps it at 70); `roadctl help resume` and `roadctl pause` name it
      effect: 'write',
      summary: 'end the pause of this machine',
      purpose: 'Removes pause.json from the machine state directory: roadctl tick decides as before (limits, work, routines due) from the next run, a scheduler starts models again. Also removes a pause file that cannot be read, and one whose --until has passed. Not paused: nothing happens, exit 0. Owner only: an agent does not resume what the owner paused.',
      usage: ['roadctl resume'],
      flags: [],
      examples: ['roadctl resume', 'ssh HOST roadctl resume'],
      changes: 'Deletes $XDG_STATE_HOME/road-map-journal/pause.json. No board, no git.',
      exits: '0 resumed or was not paused; 2 the file cannot be removed (still paused)',
      run: resumeCommand,
    },
  },
};
