// Installs the fake executors of fake-exec.mjs into a directory that a test puts on PATH, and reads what they recorded.
// POSIX only (the wrappers are shell scripts): tests that use them skip on win32, see FAKES_SKIP.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_NAMES = ['claude', 'codex', 'ssh', 'hermes', 'wsl.exe'];
export const FAKES_SKIP = { skip: process.platform === 'win32' && 'the fake executables are shell scripts' };
const IMPL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-exec.mjs');

/** Writes one wrapper per name into `dir` (created) and returns `dir`. `extra` adds executables: { name: shell script body }, for a test's own stub (for example a roadctl wrapper). */
export function installFakes(dir, { names = FAKE_NAMES, extra = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  for (const n of names) fs.writeFileSync(path.join(dir, n), `#!/bin/sh\nexec ${q(process.execPath)} ${q(IMPL)} ${n} "$@"\n`, { mode: 0o755 });
  for (const [n, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

/** The recorded calls (parsed), optionally of one fake, oldest first; rpc lines of codex app-server have `event: 'rpc'`. */
export function readCalls(log, name) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !name || c.name === name);
}

/** A call that checks the limits (claude -p ... stream-json, codex app-server), not a start of work. */
export const isProbe = (c) => !c.event && ((c.name === 'claude' && c.argv.includes('stream-json')) || (c.name === 'codex' && c.argv[0] === 'app-server'));
