// The machine state directory and the one lock helper of roadctl (seam, P5.28). No roadctl.mjs import, no side effects at import,
// Node standard library only: roadctl.mjs, run-store.mjs, digest.mjs and later modules (supervise, the service, repository writes) share it.
//
// State directory: `${XDG_STATE_HOME:-~/.local/state}/road-map-journal/`, defined only here (a copy of roadctl.mjs without this folder uses a
// small inline fallback, marked `seam (P5.28): lone-copy fallback` there). `xdgDir(env, name, fallback)` is the XDG rule for any base directory.
//
// Lock (`acquireLock`): a file created exclusively (`wx`). Whoever created it owns it; the owner may call `heartbeat()` (touches the file) so a
// supervisor that lives longer than the stale time keeps its lock. A lock whose modification time is older than `staleMs` (real time: a lock is
// about real processes, not the ROADCTL_NOW clock) belongs to nobody and is taken over. The takeover itself is guarded: removing a stale lock and
// creating the new one happen while holding `<lock>.takeover` (also created exclusively), and the age is checked again under the guard, so two
// processes that both saw the same stale lock cannot both win. The content of the lock file is not part of the contract (older files hold
// a pid, `{}` or JSON): only its modification time and, for release, the token of the owner count.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const xdgDir = (env, name, fallback) => (env[name]?.trim() ? env[name].trim() : path.join(os.homedir(), ...fallback));
export const stateDir = (env = process.env) => path.join(xdgDir(env, 'XDG_STATE_HOME', ['.local', 'state']), 'road-map-journal');

/** Lifetimes of the existing locks (ms), kept as they were when the three self-made locks were replaced by `acquireLock`. */
export const LOCK_STALE_MS = { tick: 10 * 60 * 1000, ledger: 30 * 1000, digest: 60 * 1000 };
const GUARD_STALE_MS = 5000; // the takeover guard is held for microseconds; one older than this belongs to a process that died inside it
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const NOOP = Object.freeze({ ok: true, held: false, release() {}, heartbeat() {} });

/**
 * Take the lock file `file`.
 *   staleMs   age (by modification time) after which an existing lock is taken over; required
 *   waitMs    how long to wait for a held lock (0: give up at once)
 *   content   what to write (default: a JSON line with pid and token); the token of the owner is kept in memory
 *   strict    true: an unusable directory is a failure ({ ok: false, reason }); default false: `{ ok: true, held: false }` (go on without a lock)
 * Returns { ok: true, held: true, release(), heartbeat() } or { ok: false, reason: 'held' | code }.
 * `release()` removes the file only while it is still the owner's own (the token in the file, or the unchanged caller-supplied content).
 */
export function acquireLock(file, { staleMs, waitMs = 0, pollMs = 15, content, strict = false } = {}) {
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new Error('acquireLock needs staleMs');
  const token = crypto.randomBytes(8).toString('hex');
  const body = content ?? JSON.stringify({ pid: process.pid, token });
  const end = Date.now() + waitMs;
  const lost = (code) => (strict ? { ok: false, reason: code } : NOOP);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return lost(e.code ?? 'error');
  }
  const owned = () => {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (content !== undefined) return text === body; // a caller-supplied content has no token: ours while it is unchanged
      return JSON.parse(text)?.token === token;
    } catch {
      return false;
    }
  };
  const handle = {
    ok: true,
    held: true,
    release() {
      try {
        if (owned()) fs.rmSync(file, { force: true });
      } catch {
        /* already gone or taken over */
      }
    },
    heartbeat() {
      try {
        if (owned()) {
          const t = new Date();
          fs.utimesSync(file, t, t);
          return true;
        }
      } catch {
        /* gone */
      }
      return false;
    },
  };
  const age = () => Date.now() - fs.statSync(file).mtimeMs;
  for (;;) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return handle;
    } catch (e) {
      if (e.code !== 'EEXIST') return lost(e.code ?? 'error');
    }
    let stale = false;
    try {
      stale = age() > staleMs;
    } catch {
      continue; // vanished in between: try again at once
    }
    if (stale) {
      const guard = `${file}.takeover`;
      let got = false;
      try {
        fs.writeFileSync(guard, String(process.pid), { flag: 'wx' });
        got = true;
      } catch {
        try {
          if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.rmSync(guard, { force: true }); // a dead taker; the next round competes for the guard again
        } catch {
          /* gone */
        }
      }
      if (got) {
        try {
          let still = false;
          try {
            still = age() > staleMs; // checked again under the guard: someone else may have replaced the lock since
          } catch {
            still = false;
          }
          if (still) fs.rmSync(file, { force: true });
          try {
            fs.writeFileSync(file, body, { flag: 'wx' });
            return handle;
          } catch {
            /* a creator slipped in after the removal, or the lock was fresh: not ours */
          }
        } finally {
          fs.rmSync(guard, { force: true });
        }
      }
    }
    if (Date.now() >= end) return { ok: false, reason: 'held' };
    sleepSync(pollMs);
  }
}

/** The age in ms of a lock file (by modification time), or null when there is none. For doctors and supervisors. */
export function lockAgeMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
