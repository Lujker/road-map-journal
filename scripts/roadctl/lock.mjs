// `roadctl lock -- COMMAND` (P5.41 a6): the shared build lock of a project. Two agents that run the tests of one repository at the same time (two worktrees,
// one machine) wait for each other instead of fighting over CPU, ports and caches. The lock is a file: `--file`, else `ROADCTL_BUILD_LOCK`, else the key
// `build_lock` of the board's config.json (an absolute path; boards without it are unchanged), else `build.lock` in the state directory of roadctl.
// With flock(1) on the machine the lock is a flock on that file, so a hand-written `flock FILE cmd` and `roadctl lock` exclude each other; without flock
// (macOS, Windows) a lock file with a heartbeat does the same between roadctl calls. The code of COMMAND is the code of `roadctl lock`.
// Node standard library only, no side effects at import.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock, stateDir } from './state.mjs';

const USAGE = 'usage: roadctl lock [--file PATH] [--wait SPAN] -- COMMAND [ARGS...]';
export const WAIT_EXIT = 73; // could not get the lock in time (the command did not start)
const DEFAULT_WAIT_S = 2 * 3600;
const STALE_MS = 5 * 60 * 1000; // fallback lock: a holder that stops its heartbeat for this long is taken over
const HEARTBEAT_MS = 30 * 1000;

/** `90s`, `30m`, `2h`, `1d` or plain seconds -> seconds; null when it is not a span. */
export function spanSeconds(s) {
  const m = /^(\d+)\s*([smhd]?)$/.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : null;
}

/** The lock file: flag, environment, `build_lock` of the board config, the state directory. */
export function lockFile({ flags = {}, env = process.env, config = null } = {}) {
  const pick = [flags.file, env.ROADCTL_BUILD_LOCK, config?.build_lock].find((v) => typeof v === 'string' && v.trim());
  if (pick) {
    if (!path.isAbsolute(pick.trim())) throw new Error('the lock file must be an absolute path');
    return pick.trim();
  }
  return path.join(stateDir(env), 'build.lock');
}

const hasFlock = (env) => env.ROADCTL_LOCK_NO_FLOCK !== '1' && spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;
const codeOf = (code, signal) => (typeof code === 'number' ? code : 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal] ?? 1));

function viaFlock(file, argv, waitS, env) {
  return new Promise((resolve) => {
    const child = spawn('flock', ['-w', String(waitS), '-E', String(WAIT_EXIT), file, ...argv], { stdio: 'inherit', env });
    child.on('error', () => resolve(127));
    child.on('exit', (code, signal) => resolve(codeOf(code, signal)));
  });
}

async function viaFile(file, argv, waitS, env) {
  const end = Date.now() + waitS * 1000;
  let lock;
  for (;;) {
    lock = acquireLock(`${file}.roadctl`, { staleMs: STALE_MS, waitMs: 0, strict: true });
    if (lock.ok) break;
    if (lock.reason !== 'held') throw new Error(`the lock file cannot be used (${lock.reason})`);
    if (Date.now() >= end) return WAIT_EXIT;
    await new Promise((r) => setTimeout(r, 100));
  }
  const beat = setInterval(() => lock.heartbeat(), HEARTBEAT_MS);
  try {
    return await new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env });
      child.on('error', () => resolve(127));
      child.on('exit', (code, signal) => resolve(codeOf(code, signal)));
    });
  } finally {
    clearInterval(beat);
    lock.release();
  }
}

export default {
  name: 'lock',
  commands: {
    lock: {
      group: 'Record', effect: 'write', hidden: true,
      summary: 'run a command under the shared build lock of the project',
      purpose: 'Runs COMMAND (after --) while holding the build lock of the project, so two test runs of one repository never overlap; the second caller waits (up to --wait, default 2h) and then runs. The lock file is --file, else ROADCTL_BUILD_LOCK, else the key build_lock of the board config.json (an absolute path), else build.lock in the roadctl state directory. With flock(1) on the machine it is a flock on that file (a plain `flock FILE cmd` and roadctl lock exclude each other); without it a lock file with a heartbeat is used between roadctl calls. The exit code is the code of COMMAND; 73: the lock was not free in time and COMMAND did not start; 2: usage. Starts nothing but COMMAND.',
      usage: [USAGE.slice(7)],
      flags: [['--file PATH', 'the lock file (absolute path)'], ['--wait SPAN', 'how long to wait for the lock: 90s, 30m, 2h (default 2h)'], ['--board DIR', 'board whose config.json names build_lock']],
      examples: ['roadctl lock -- node --test scripts/', 'roadctl lock --wait 30m -- npm test'],
      changes: 'Creates the lock file; the lock is released when COMMAND ends. No board file.',
      exits: 'the code of COMMAND; 73 the lock was not free in time; 2 usage error',
      async run({ flags, rest, env, api }) {
        if (!rest.length) throw new Error(USAGE);
        const wait = flags.wait === undefined ? DEFAULT_WAIT_S : spanSeconds(flags.wait);
        if (wait === null) throw new Error(`--wait must be like 90s, 30m or 2h; ${USAGE}`);
        let config = null;
        try { config = api.loadBoard(api.findBoard(process.cwd(), typeof flags.board === 'string' ? flags.board : undefined)).config; } catch { /* no board: the default lock */ }
        const file = lockFile({ flags, env, config });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const code = hasFlock(env) ? await viaFlock(file, rest, wait, env) : await viaFile(file, rest, wait, env);
        if (code === WAIT_EXIT) process.stderr.write(`roadctl lock: the build lock ${file} was not free within ${wait}s; the command did not start\n`);
        return code;
      },
    },
  },
};
