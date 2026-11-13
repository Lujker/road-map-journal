// Time in tests. Two rules (see docs/developing-roadctl.md):
// 1. Anything roadctl reads as "now" comes from here: tests pass ROADCTL_NOW (an ISO-8601 UTC time), never the clock of the machine.
// 2. Real time is only for real processes (a lock held by a live process, a child that must stop, a background job that must start):
//    those tests use sleepSync / waitFor / wallClock below, the one named place that touches the wall clock.
export const T0 = '2026-11-10T10:00:00Z';

/** Environment that fixes roadctl's clock: `{ ROADCTL_NOW: iso }`. */
export const clock = (iso = T0) => ({ ROADCTL_NOW: iso });

/** `iso` moved by whole minutes (negative: earlier), as an ISO string without milliseconds. */
export const shift = (minutes, iso = T0) => new Date(Date.parse(iso) + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The same instant in ms, for functions that take a time (rc.routineRows(board, ms)). */
export const ms = (iso = T0) => Date.parse(iso);

// ---- real time (processes), not roadctl's clock
export const sleepSync = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
/** The wall clock: only for aging a lock or a file the way a real process would (mtime), never as an input of roadctl's decisions. */
export const wallClock = () => Date.now();
/** Polls `fn` until it returns something truthy (returned) or `timeoutMs` passes (returns the last falsy value). */
export function waitFor(fn, { timeoutMs = 5000, stepMs = 50 } = {}) {
  const end = wallClock() + timeoutMs;
  let v = fn();
  while (!v && wallClock() < end) {
    sleepSync(stepMs);
    v = fn();
  }
  return v;
}
