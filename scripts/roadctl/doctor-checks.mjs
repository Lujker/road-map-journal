// The checks of `roadctl doctor` (P5.9). Every check is a function of one context object and returns a result or a list of results:
//   { id, subject, status: 'ok' | 'warn' | 'fail' | 'skip', detail, hint }
// subject is the board or agent the result is about (null for the machine); skip means "not checked" and says why in detail.
// Rules: a check only reads (files, `git` queries, `PATH`; two optional probes start `wsl.exe` / `ssh` with a harmless command), starts no
// model, and reaches no network unless `ctx.online` is set. A check that throws is reported as a warning by the runner, never as a crash.
// Text that may carry a secret is never built from the environment: environment variables are listed by NAME only.
//
// ctx = { env, home, platform, cwd, flags, agent, online, host, api, runDir, nodeVersion, spawn }
//   api: the helpers of ctx.api in roadctl.mjs (see docs/developing-roadctl.md); spawn: child_process.spawnSync (replaceable in tests)
import fs from 'node:fs';
import path from 'node:path';
import { INSTALLED_JSON, declaredVersion, fingerprint, readInstalledJson } from './fingerprint.mjs';
import { pauseLine, readPause } from './pause.mjs';

export const STATUSES = ['ok', 'warn', 'fail', 'skip'];
export const CLOCK_TOLERANCE_MS = 5 * 60e3;
export const MIN_NODE_MAJOR = 20; // roadctl is tested on Node 20 and newer
const HARD_MIN_NODE_MAJOR = 18; // structuredClone, fs.cpSync
const PROBE_TIMEOUT_MS = 15000;
const HOST_EXE = { 'claude-code': 'claude', codex: 'codex', hermes: 'hermes' };
const ENTRY_ROOT_NAMES = new Set(['public', 'default', 'default user', 'all users', 'desktop.ini']);

const res = (id, status, detail, hint = null, subject = null) => ({ id, subject, status, detail, hint });
const tilde = (p, home) => (home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p);
const names = (list, n = 5) => (list.length > n ? `${list.slice(0, n).join(', ')} (+${list.length - n} more)` : list.join(', '));
const same = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

/** First match of `name` on the PATH of `env` (what a non-interactive shell would find): a regular, executable file; null otherwise. */
export function which(name, env, platform = process.platform) {
  const win = platform === 'win32';
  const dirs = String(env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  const exts = win ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        if (!fs.statSync(p).isFile()) continue;
        if (!win) fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** null when `p` exists with exactly this letter case; { kind: 'case', actual } when only the case differs; { kind: 'missing' } otherwise. */
export function pathProblem(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) {
    try {
      const real = fs.realpathSync.native(abs);
      if (real !== abs && real.toLowerCase() === abs.toLowerCase()) return { kind: 'case', actual: real }; // a case-insensitive file system
    } catch {
      /* unreadable: treat as present */
    }
    return null;
  }
  // a case-sensitive file system: find the first component that exists only with another letter case
  const root = path.parse(abs).root;
  const parts = path.relative(root, abs).split(path.sep).filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i]);
    if (fs.existsSync(next)) {
      cur = next;
      continue;
    }
    let hit = null;
    try {
      hit = fs.readdirSync(cur).find((n) => n.toLowerCase() === parts[i].toLowerCase()) ?? null;
    } catch {
      /* not a directory */
    }
    if (!hit) return { kind: 'missing' };
    const guess = path.join(cur, hit, ...parts.slice(i + 1));
    const deeper = pathProblem(guess);
    return { kind: 'case', actual: deeper?.kind === 'case' ? deeper.actual : guess };
  }
  return { kind: 'missing' };
}

/** The names a WSLENV value lists (`A:B/p:C/u:D/l`): flags after `/` are dropped. */
export function wslenvNames(value) {
  return String(value ?? '').split(':').map((s) => s.split('/')[0].trim()).filter(Boolean);
}

export const isWsl = (env) => Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);

function gitq(ctx, args, cwd) {
  const r = ctx.spawn('git', args, { cwd, encoding: 'utf8', timeout: 8000, env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

const installedDir = (ctx) => path.join(ctx.home, '.local', 'share', 'road-map-journal');
const stateDirOf = (ctx) => path.dirname(ctx.api.tickLedgerPath(ctx.env));

// ---------------------------------------------------------------- this machine: runtime, versions, installed copy

export function checkRuntime(ctx) {
  const out = [];
  const fp = fingerprint(ctx.runDir);
  const kind = fs.existsSync(path.join(ctx.runDir, '..', 'skills', 'road-map-journal')) ? 'a checkout' : 'an installed copy';
  out.push(res('version', 'ok', `roadctl ${ctx.api.VERSION}, sha ${fp.short ?? 'unknown'}, ${fp.count} file(s) in ${tilde(ctx.runDir, ctx.home)} (${kind})`));
  const major = Number(String(ctx.nodeVersion).replace(/^v/, '').split('.')[0]);
  if (!Number.isFinite(major) || major < HARD_MIN_NODE_MAJOR) out.push(res('node', 'fail', `Node ${ctx.nodeVersion} is too old for roadctl`, `install Node ${MIN_NODE_MAJOR} or newer and put it first in PATH`));
  else if (major < MIN_NODE_MAJOR) out.push(res('node', 'warn', `Node ${ctx.nodeVersion}: roadctl is tested on Node ${MIN_NODE_MAJOR} and newer`, `use Node ${MIN_NODE_MAJOR} or newer`));
  else out.push(res('node', 'ok', `Node ${ctx.nodeVersion}`));
  const g = ctx.spawn('git', ['--version'], { encoding: 'utf8', timeout: 8000, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (g.error || g.status !== 0) out.push(res('git', 'fail', 'git was not found in PATH', 'install git and make it visible to non-interactive shells (cron, ssh commands, wsl.exe -e)'));
  else out.push(res('git', 'ok', String(g.stdout).trim()));
  return out;
}

export function checkInstalledCopy(ctx) {
  const dir = installedDir(ctx);
  const shown = tilde(dir, ctx.home);
  const out = [];
  if (!fs.existsSync(path.join(dir, 'roadctl.mjs'))) {
    return [res('installed-copy', 'warn', `no installed copy at ${shown} (hooks, launchers and scheduled runs point there)`, 'node scripts/update-installed.mjs --roadctl --apply   (from a checkout of road-map-journal)')];
  }
  const fp = fingerprint(dir);
  const rec = readInstalledJson(dir);
  const version = fp.version;
  const parts = [`version ${version ?? 'unknown'}`, `sha ${fp.short}`, `${fp.count} file(s)`];
  let status = 'ok';
  let hint = null;
  const problems = [];
  if (version && ctx.api.compareVersions(version, '0.2.0') === -1) {
    status = 'warn';
    problems.push(`version ${version} is older than 0.2.0 and cannot see "requires" in board/config.json: it would run a board that asks for a newer roadctl`);
    hint = 'update this copy first: node scripts/update-installed.mjs --roadctl --apply';
  } else if (!version) {
    status = 'warn';
    problems.push('the version of the copy could not be read');
  }
  if (!rec) {
    status = 'warn';
    problems.push(`no ${INSTALLED_JSON}: installed by hand or by an older update-installed.mjs, so the recorded checksum is unknown`);
    hint ??= 'node scripts/update-installed.mjs --roadctl --apply   (writes installed.json)';
  } else if (rec.sha !== fp.sha) {
    status = 'warn';
    const changed = Object.keys({ ...rec.files, ...fp.files }).filter((rel) => rec.files?.[rel] !== fp.files[rel]);
    problems.push(`the files differ from what was installed (sha ${String(rec.sha).slice(0, 12)} recorded, ${fp.short} found${changed.length ? `; changed: ${names(changed)}` : ''}): edited by hand or updated in part`);
    hint ??= 'reinstall from a checkout: node scripts/update-installed.mjs --roadctl --apply';
  }
  out.push(res('installed-copy', status, `${shown}: ${parts.join(', ')}${problems.length ? `; ${problems.join('; ')}` : ''}`, hint));
  // modules folder
  if (!fs.existsSync(path.join(dir, 'roadctl', 'index.mjs'))) {
    out.push(res('installed-modules', 'fail', `${shown} has roadctl.mjs but no roadctl/ modules folder (index.mjs): built-in commands work, module commands (doctor and later ones) and hooks of modules do not`, 'node scripts/update-installed.mjs --roadctl --apply   (installs the whole roadctl/ folder)'));
  } else {
    const have = new Set(copyList(dir));
    const missing = copyList(ctx.runDir).filter((rel) => !have.has(rel));
    const recorded = Object.keys(rec?.files ?? {}).filter((rel) => !have.has(rel));
    if (recorded.length) out.push(res('installed-modules', 'fail', `files recorded at install are missing: ${names(recorded)}`, 'node scripts/update-installed.mjs --roadctl --apply'));
    else if (missing.length && !same(dir, ctx.runDir)) out.push(res('installed-modules', 'warn', `the installed copy lacks files this copy has: ${names(missing)}`, 'node scripts/update-installed.mjs --roadctl --apply'));
    else out.push(res('installed-modules', 'ok', `modules folder present (${have.size - 1} module file(s))`));
  }
  // against the copy that runs doctor
  if (same(dir, ctx.runDir)) out.push(res('installed-current', 'ok', 'this is the installed copy'));
  else if (fp.sha === fingerprint(ctx.runDir).sha) out.push(res('installed-current', 'ok', `the installed copy is identical to this copy (sha ${fp.short})`));
  else {
    const here = fingerprint(ctx.runDir);
    const older = version && ctx.api.compareVersions(version, ctx.api.VERSION) === -1;
    out.push(res('installed-current', 'warn', `the installed copy (${version ?? 'unknown'}, sha ${fp.short}) differs from this copy (${ctx.api.VERSION}, sha ${here.short})${older ? ': the installed one is older' : ''}`, 'node scripts/update-installed.mjs --roadctl --apply   (from the checkout you want installed)'));
  }
  return out;
}

const copyList = (dir) => Object.keys(fingerprint(dir).files);

export function checkLauncher(ctx) {
  if (ctx.platform === 'win32') return res('launcher', 'skip', 'not checked on native Windows (the launcher is a POSIX script)');
  const bin = path.join(ctx.home, '.local', 'bin');
  const file = path.join(bin, 'roadctl');
  if (!fs.existsSync(file)) return res('launcher', 'warn', `no launcher ${tilde(file, ctx.home)}`, 'create it: a script that runs `node ~/.local/share/road-map-journal/roadctl.mjs "$@"`, or call the installed file directly');
  const onPath = String(ctx.env.PATH ?? '').split(':').some((d) => d && path.resolve(d) === path.resolve(bin));
  return onPath ? res('launcher', 'ok', `${tilde(file, ctx.home)} exists and ${tilde(bin, ctx.home)} is in PATH`) : res('launcher', 'warn', `${tilde(file, ctx.home)} exists but ${tilde(bin, ctx.home)} is not in PATH here`, 'add it to PATH for non-interactive shells too (cron, ssh commands, wsl.exe -e), not only in the login profile');
}

// ---------------------------------------------------------------- environment: variables, clock, wsl.exe and ssh

export function checkEnvironment(ctx) {
  const out = [];
  const set = Object.keys(ctx.env).filter((k) => k.startsWith('ROADCTL_')).sort();
  const knobs = set.filter((k) => ['ROADCTL_NOW', 'ROADCTL_DATE'].includes(k));
  out.push(res('env', knobs.length ? 'warn' : 'ok', set.length ? `ROADCTL_* set (names only): ${set.join(', ')}` : 'no ROADCTL_* variable is set', knobs.length ? `${knobs.join(' and ')} replace${knobs.length === 1 ? 's' : ''} the clock or the date of roadctl: meant for tests; unset ${knobs.length === 1 ? 'it' : 'them'} on a machine that runs routines` : null));
  const wsl = isWsl(ctx.env);
  if (ctx.platform === 'win32' || wsl || ctx.env.WSLENV !== undefined) {
    const listed = new Set(wslenvNames(ctx.env.WSLENV));
    const unlisted = set.filter((k) => !listed.has(k));
    if (!set.length) out.push(res('wsl-env', 'ok', `no ROADCTL_* variable to pass; WSLENV ${listed.size ? `lists ${names([...listed])}` : 'is empty'}`));
    else if (unlisted.length) out.push(res('wsl-env', 'warn', `set here but not in WSLENV: ${unlisted.join(', ')}; a command started through wsl.exe does not receive them`, `add them to WSLENV (names separated by ':', for example ${unlisted[0]}/u)`));
    else out.push(res('wsl-env', 'ok', `every ROADCTL_* variable set here is listed in WSLENV`));
    out.push(wslProbe(ctx));
  } else {
    out.push(res('wsl-env', 'skip', 'not WSL and not Windows: WSLENV does not apply'));
  }
  out.push(sshProbe(ctx));
  return out;
}

/** Start `wsl.exe -e sh -c 'echo "$VAR"'` with a probe variable that WSLENV is told to carry: proves the transport itself passes variables. */
function wslProbe(ctx) {
  const exe = which('wsl.exe', ctx.env, ctx.platform);
  if (!exe) return res('wsl-probe', 'skip', 'wsl.exe is not in PATH: not probed');
  const name = 'ROADCTL_DOCTOR_PROBE';
  const env = { ...ctx.env, [name]: 'probe-ok', WSLENV: [...new Set([...wslenvNames(ctx.env.WSLENV), name])].join(':') };
  const r = ctx.spawn(exe, ['-e', 'sh', '-c', `echo "$${name}"`], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return res('wsl-probe', 'warn', `wsl.exe could not run a command (${r.error ? r.error.code ?? 'error' : `exit ${r.status}`})`, 'check that the distribution starts: wsl.exe -e true');
  return String(r.stdout).trim() === 'probe-ok'
    ? res('wsl-probe', 'ok', 'a variable listed in WSLENV reached a command started through wsl.exe')
    : res('wsl-probe', 'warn', 'a variable listed in WSLENV did NOT reach a command started through wsl.exe', 'pass ROADCTL_* explicitly in the command (wsl.exe -e env ROADCTL_X=... roadctl ...) or fix WSLENV');
}

/** ssh carries environment variables only when the server allows them (AcceptEnv) or the remote command sets them: opt-in, it contacts a host. */
function sshProbe(ctx) {
  if (!ctx.host) return res('ssh-env', 'skip', 'not probed: ssh passes ROADCTL_* only if the server accepts them or the remote command sets them; use --online --host HOST to test a host');
  const name = 'ROADCTL_DOCTOR_PROBE';
  const exe = which('ssh', ctx.env, ctx.platform);
  if (!exe) return res('ssh-env', 'fail', 'ssh was not found in PATH', 'install an ssh client', ctx.host);
  const r = ctx.spawn(exe, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', `SendEnv=${name}`, '--', ctx.host, `echo "$${name}"`], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: { ...ctx.env, [name]: 'probe-ok' }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status === 255) return res('ssh-env', 'warn', `could not reach ${ctx.host} over ssh (key login without a prompt is needed)`, 'check ssh access from this machine: ssh -o BatchMode=yes HOST true', ctx.host);
  return String(r.stdout).trim() === 'probe-ok'
    ? res('ssh-env', 'ok', `${ctx.host}: the server passes a ROADCTL_* variable (AcceptEnv)`, null, ctx.host)
    : res('ssh-env', 'warn', `${ctx.host}: the server does not pass ROADCTL_* variables sent with SendEnv`, 'set them in the remote command itself: ssh HOST \'ROADCTL_X=value roadctl ...\'', ctx.host);
}

export function checkClock(ctx) {
  const now = ctx.api.nowMs();
  const fixed = Boolean(ctx.env.ROADCTL_NOW);
  const seen = new Set();
  const behind = [];
  let checked = 0;
  for (const b of boardsOf(ctx)) {
    const sc = ctx.api.syncContext({ dir: b.dir, project: path.dirname(b.dir) });
    if (!sc || seen.has(sc.root)) continue;
    seen.add(sc.root);
    const g = gitq(ctx, ['log', '-1', '--format=%ct', '@{u}'], sc.root);
    if (!g.ok || !/^\d+$/.test(g.out)) continue;
    checked++;
    const skew = Number(g.out) * 1000 - now;
    if (skew > CLOCK_TOLERANCE_MS) behind.push({ name: b.name, minutes: Math.round(skew / 60e3) });
  }
  const source = fixed ? 'ROADCTL_NOW' : 'the machine clock';
  if (behind.length) {
    const worst = Math.max(...behind.map((x) => x.minutes));
    return res('clock', 'warn', `${source} is at least ${worst} minute(s) behind the newest commit of origin (${names(behind.map((x) => x.name))}); last_run + every and lease times are judged by this clock`, fixed ? 'unset ROADCTL_NOW' : 'set the machine clock from a time server (WSL: wsl.exe --shutdown, then start again, resets a drifted VM clock)');
  }
  if (!checked) return res('clock', 'skip', `${source}: no repository with a fetched upstream to compare with`);
  return res('clock', 'ok', `${source} is not behind the newest fetched commit of origin (${checked} repository(ies))`);
}

// ---------------------------------------------------------------- paths and state directories

export function checkPaths(ctx) {
  const problems = [];
  let checked = 0;
  const look = (what, p) => {
    if (!p) return;
    checked++;
    const q = pathProblem(p);
    if (!q) return;
    if (q.kind === 'case') problems.push(`${what}: ${tilde(path.resolve(p), ctx.home)} has the wrong letter case, the path on disk is ${tilde(q.actual, ctx.home)}`);
    else problems.push(`${what}: ${tilde(path.resolve(p), ctx.home)} does not exist`);
  };
  const ws = ctx.env.ROADCTL_WORKSPACE?.trim();
  if (ws) look('ROADCTL_WORKSPACE', ws);
  if (ws && !fs.existsSync(path.join(ws, 'projects')) && fs.existsSync(ws)) problems.push(`ROADCTL_WORKSPACE: ${tilde(ws, ctx.home)} has no projects/ folder, so it is not used as a workspace`);
  try {
    const pointer = fs.readFileSync(path.join(installedDir(ctx), 'workspace'), 'utf8').trim().split(/\r?\n/)[0];
    look('workspace pointer file', pointer);
  } catch {
    /* optional */
  }
  if (ctx.env.ROADCTL_REGISTRY?.trim()) look('ROADCTL_REGISTRY', ctx.env.ROADCTL_REGISTRY.trim());
  let text = '';
  try {
    text = fs.readFileSync(ctx.api.userBoardsFile(ctx.env), 'utf8');
  } catch {
    /* no user list */
  }
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) look('boards list', path.join(line, 'config.json'));
  if (ctx.flags.board) look('--board', path.join(String(ctx.flags.board), 'config.json'));
  if (problems.length) return res('paths', 'warn', problems.join('; '), 'fix the path (letter case matters on Linux and in WSL), or remove the entry: roadctl boards remove <dir>');
  return res('paths', 'ok', checked ? `${checked} configured path(s) exist with the right letter case` : 'no workspace, pointer, registry or boards list configured (a board in the project folder is found by searching upwards)');
}

function writableOrCreatable(p) {
  let cur = path.resolve(p);
  for (;;) {
    if (fs.existsSync(cur)) {
      try {
        fs.accessSync(cur, fs.constants.W_OK);
        return { ok: true, exists: cur === path.resolve(p) };
      } catch {
        return { ok: false, exists: cur === path.resolve(p) };
      }
    }
    const up = path.dirname(cur);
    if (up === cur) return { ok: false, exists: false };
    cur = up;
  }
}

export function checkState(ctx) {
  const out = [];
  const dir = stateDirOf(ctx);
  const w = writableOrCreatable(dir);
  const shown = tilde(dir, ctx.home);
  if (!w.ok) out.push(res('state-dir', 'warn', `state directory ${shown} ${w.exists ? 'is not writable' : 'cannot be created'}: tick would run WITHOUT its lock and could not keep a ledger`, 'make it writable, or point XDG_STATE_HOME at a writable place'));
  else if (!w.exists) out.push(res('state-dir', 'ok', `state directory ${shown} does not exist yet; it is created by the first tick`));
  else {
    const locks = fs.readdirSync(dir).filter((n) => /^tick-.*\.lock$/.test(n));
    out.push(res('state-dir', 'ok', `state directory ${shown} is writable${locks.length ? `; lock file(s): ${names(locks)}` : ''}`));
  }
  const pz = readPause(dir, ctx.api.nowMs()); // P5.5: a forgotten pause is the usual reason for "nothing runs"; reported only when the file exists
  if (pz?.state === 'paused') out.push(res('pause', 'warn', `this machine is paused: ${pauseLine(pz)}; roadctl tick starts nothing here (exit 6)`, 'roadctl resume (the pause is local to this state directory; another machine or the WSL/Windows twin is not affected)'));
  else if (pz) out.push(res('pause', 'ok', `an expired pause file (until ${pz.until}) is in ${shown}; it is ignored, roadctl resume removes it`));
  const cache = ctx.api.limitsCachePath(ctx.env);
  try {
    const age = Math.round((ctx.api.nowMs() - fs.statSync(cache).mtimeMs) / 60e3);
    out.push(res('limits-cache', 'ok', `limits cache ${tilde(cache, ctx.home)} read ${age >= 0 ? `${age} minute(s) ago` : 'at a time later than the clock'} (doctor never polls limits)`));
  } catch {
    out.push(res('limits-cache', 'skip', `no limits cache at ${tilde(cache, ctx.home)} (doctor never polls limits; roadctl limits does)`));
  }
  out.push(checkTwoStateDirs(ctx, dir));
  return out;
}

/** WSL and native Windows keep separate state directories (locks, ledger, limits confirmations); a scheduler may use one and a person the other. */
function checkTwoStateDirs(ctx, dir) {
  const hermes = path.join(ctx.home, '.road-map-journal');
  const extra = fs.existsSync(hermes) ? ` A Hermes monitor state directory also exists: ${tilde(hermes, ctx.home)} (its own, not shared).` : '';
  if (isWsl(ctx.env)) {
    const homes = [];
    if (ctx.env.ROADCTL_WINDOWS_HOME?.trim()) homes.push(ctx.env.ROADCTL_WINDOWS_HOME.trim());
    else {
      try {
        for (const e of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) if (e.isDirectory() && !ENTRY_ROOT_NAMES.has(e.name.toLowerCase())) homes.push(path.join('/mnt/c/Users', e.name));
      } catch {
        /* no Windows drive mounted */
      }
    }
    const found = homes.map((h) => path.join(h, '.local', 'state', 'road-map-journal')).filter((d) => fs.existsSync(d) && !same(d, dir));
    if (found.length) return res('state-dirs', 'warn', `two state directories: this WSL one ${tilde(dir, ctx.home)} and the native Windows one ${names(found)}; locks, the ledger, a pause and limit confirmations are not shared between them, so a tick from Windows and a tick from WSL do not see each other`, 'decide which side runs the scheduler and use only that one (the other: delete the directory or never call roadctl there)');
    return res('state-dirs', 'ok', `one state directory (${tilde(dir, ctx.home)}); no native Windows one found${homes.length ? '' : ' (no Windows home located: set ROADCTL_WINDOWS_HOME to check)'}.${extra}`);
  }
  if (ctx.platform === 'win32') return res('state-dirs', 'skip', `native Windows: this state directory is ${tilde(dir, ctx.home)}; the WSL one lives in the WSL home and is not looked at from here. Run roadctl doctor inside WSL too.${extra}`);
  return res('state-dirs', 'ok', `one state directory (${tilde(dir, ctx.home)}); the check for a second one applies to WSL and Windows.${extra}`);
}

// ---------------------------------------------------------------- registry and executors

export function loadRegistryResult(ctx) {
  try {
    return { reg: ctx.api.loadRegistry(ctx.env), error: null };
  } catch (e) {
    return { reg: null, error: String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 300) };
  }
}

export function checkRegistry(ctx, loaded) {
  const where = tilde(ctx.api.registryPath(ctx.env), ctx.home);
  if (loaded.error) return res('registry', 'fail', loaded.error, `fix or remove ${where}: tick, limits and delegation stop with exit 2 while it is broken`);
  if (!loaded.reg) return res('registry', 'skip', `no registry (optional; looked at ${where})`);
  const table = ctx.api.providerTable(loaded.reg);
  const bad = Object.entries(loaded.reg.agents).filter(([, a]) => a?.provider !== undefined && !Object.hasOwn(table, a.provider)).map(([n, a]) => `${n} names provider ${a.provider}`);
  if (bad.length) return res('registry', 'fail', `${where}: ${names(bad)}, which is not in "providers"`, 'add the provider to "providers" or fix the name');
  return res('registry', 'ok', `${where} is readable: ${Object.keys(loaded.reg.agents).length} agent(s), providers ${Object.keys(table).join(', ')}`);
}

export function checkExecutors(ctx, loaded) {
  const exes = ['claude', 'codex', 'hermes'];
  if (!ctx.agent) {
    const found = exes.filter((e) => which(e, ctx.env, ctx.platform));
    return res('executors', 'skip', `no --agent given, so no executor is required (found in PATH: ${found.length ? found.join(', ') : 'none of claude, codex, hermes'}; not found: ${exes.filter((e) => !found.includes(e)).join(', ') || 'none'})`, 'roadctl doctor --agent <name> checks the one that runs here');
  }
  const a = ctx.agent;
  const reg = loaded.reg;
  const out = [];
  const entry = reg?.agents?.[a];
  if (reg && !entry) out.push(res('agent', 'warn', `${a} is not in the registry (${tilde(reg.path, ctx.home)}); its host is guessed from its name`, 'add it under "agents" in the registry, or check the spelling', a));
  else if (!reg) out.push(res('agent', 'skip', 'no registry: the host is guessed from the agent name', null, a));
  else out.push(res('agent', 'ok', `${a} is in the registry (host ${entry.host ?? 'unset'})`, null, a));
  const host = ctx.api.hostOfAgent(a, reg);
  const exe = HOST_EXE[host];
  if (exe) {
    const p = which(exe, ctx.env, ctx.platform);
    out.push(p ? res('executor', 'ok', `${exe} found at ${tilde(p, ctx.home)} (host ${host})`, null, a) : res('executor', 'fail', `${exe} was not found in PATH (host ${host}): a run for ${a} cannot start here`, `install ${exe}, or add its directory to PATH for non-interactive shells (cron, ssh, wsl.exe -e); PATH here is ${ctx.env.PATH ? 'set' : 'empty'}`, a));
  } else if (host === 'script') out.push(res('executor', 'ok', `${a} is a script agent: no model executor needed`, null, a));
  else out.push(res('executor', 'warn', `unknown host ${host}: cannot tell which command ${a} runs`, 'name the host in the registry: "host": "claude-code" | "codex" | "hermes" | "script"', a));
  const launch = typeof entry?.launch === 'string' ? ctx.api.splitCommand(entry.launch)[0] : null;
  if (launch && launch !== exe && !which(launch, ctx.env, ctx.platform)) out.push(res('launch', 'warn', `the registry's launch command for ${a} starts ${launch}, which is not in PATH`, 'install it or fix "launch" (roadctl itself never runs it)', a));
  const provider = entry?.provider;
  const pv = provider ? ctx.api.providerTable(reg)[provider] : null;
  if (pv?.probe === 'command' && pv.command) {
    const first = ctx.api.splitCommand(pv.command)[0];
    if (first && !which(first, ctx.env, ctx.platform)) out.push(res('limits-command', 'warn', `the limits command of provider ${provider} (${first}) is not in PATH: limits would be unknown and tick would block`, 'install it or fix the provider "command"', a));
  }
  return out;
}

// ---------------------------------------------------------------- boards

/** Known boards plus the board found from the working directory (or --board), without duplicates. */
export function boardsOf(ctx) {
  if (ctx._boards) return ctx._boards;
  const list = [];
  const add = (dir, name) => {
    if (!dir || list.some((b) => same(b.dir, dir))) return;
    list.push({ dir, name: name ?? path.basename(path.dirname(dir)) });
  };
  for (const b of ctx.api.knownBoards(ctx.env)) add(b.dir, b.name);
  try {
    add(ctx.api.findBoard(ctx.cwd, ctx.flags.board ? String(ctx.flags.board) : undefined, ctx.env));
  } catch {
    /* --board without config.json is reported by checkPaths */
  }
  ctx._boards = list;
  return list;
}

export function checkBoards(ctx, loaded) {
  const boards = boardsOf(ctx);
  if (!boards.length) return [res('boards', 'warn', 'no board found (no board/config.json above the working directory, no workspace, no boards list)', 'run from a project with a board, or: roadctl boards add <dir>, or set ROADCTL_WORKSPACE')];
  const out = [res('boards', 'ok', `${boards.length} board(s): ${names(boards.map((b) => b.name), 8)}`)];
  const inst = installedDir(ctx);
  const installedVersion = fs.existsSync(path.join(inst, 'roadctl.mjs')) ? declaredVersion(inst) : null;
  const roots = new Set();
  for (const b of boards) {
    let board;
    try {
      board = ctx.api.loadBoard(b.dir);
    } catch (e) {
      out.push(res('board-load', 'fail', `${tilde(b.dir, ctx.home)}: cannot be read (${String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 160)})`, 'check board/config.json and run roadctl lint --board DIR', b.name));
      continue;
    }
    const needs = ctx.api.boardRequires(board.config);
    if (needs) out.push(res('board-requires', 'fail', `${needs}: this copy refuses the board (tick offers nothing from it)`, 'update roadctl: node scripts/update-installed.mjs --roadctl --apply, from a checkout that has the needed version', b.name));
    else out.push(res('board-requires', 'ok', board.config.requires === undefined ? 'no "requires": any copy may use this board' : `requires ${board.config.requires}; this copy is ${ctx.api.VERSION}`, null, b.name));
    if (installedVersion && !same(inst, ctx.runDir)) {
      const inNeeds = ctx.api.boardRequires(board.config, installedVersion);
      if (inNeeds) out.push(res('board-requires-installed', 'fail', `the installed copy (${installedVersion}) is too old: ${inNeeds}`, 'board requires a newer copy: node scripts/update-installed.mjs --roadctl --apply', b.name));
    }
    out.push(...gitChecks(ctx, board, b, roots));
    out.push(routineCheck(ctx, board, b, loaded));
  }
  return out;
}

function gitChecks(ctx, board, b, roots) {
  const sc = ctx.api.syncContext(board);
  if (!sc) return [res('board-git', 'skip', 'the board is not in a git repository (nothing to commit or push)', null, b.name)];
  const out = [];
  const g = gitq(ctx, ['rev-parse', '--absolute-git-dir'], sc.root);
  if (g.ok && g.out) {
    let writable = true;
    try {
      fs.accessSync(g.out, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    const lock = fs.existsSync(path.join(g.out, 'index.lock'));
    if (!writable) out.push(res('board-git', 'fail', `${tilde(g.out, ctx.home)} is not writable by this user: roadctl save and pull cannot commit`, 'fix the ownership or permissions of the repository (a clone made by another user or by root)', b.name));
    else if (lock) out.push(res('board-git', 'warn', `${tilde(path.join(g.out, 'index.lock'), ctx.home)} exists: a git command is running or crashed; commits are refused until it is gone`, 'make sure no git process is running, then remove the lock file', b.name));
    else out.push(res('board-git', 'ok', `${tilde(g.out, ctx.home)} is writable`, null, b.name));
  } else out.push(res('board-git', 'warn', 'git could not tell where the repository directory is', null, b.name));
  const st = ctx.api.syncState(board);
  const bits = [];
  if (st.pending > 0) bits.push(`${st.pending} uncommitted change(s)`);
  if (st.behind > 0) bits.push(`behind origin by ${st.behind} commit(s) as last fetched`);
  if (st.ahead > 0) bits.push(`${st.ahead} commit(s) not pushed`);
  if (bits.length) out.push(res('board-sync', 'warn', bits.join('; '), 'roadctl pull, then roadctl save (a person decides what is committed)', b.name));
  else if (['no-remote', 'no-upstream'].includes(st.state)) out.push(res('board-sync', 'skip', st.state === 'no-remote' ? 'the repository has no remote (local only)' : 'the branch has no upstream', null, b.name));
  else out.push(res('board-sync', 'ok', 'nothing uncommitted, nothing to push', null, b.name));
  if (ctx.online && !roots.has(sc.root)) {
    roots.add(sc.root);
    const r = ctx.spawn('git', ['ls-remote', '--heads', 'origin'], { cwd: sc.root, encoding: 'utf8', timeout: 15000, env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: ctx.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    out.push(r.status === 0 ? res('origin-reachable', 'ok', 'origin answers (git ls-remote, read only)', null, b.name) : res('origin-reachable', 'warn', 'origin did not answer', 'check the network, the remote URL and the key (roadctl pull works offline-tolerantly, but nothing is shared)', b.name));
  }
  return out;
}

function routineCheck(ctx, board, b, loaded) {
  if (!board.routines?.length) return res('routines', 'skip', 'no routines on this board', null, b.name);
  const rows = ctx.api.routineRows(board, ctx.api.nowMs());
  const problems = [];
  const benign = /^(outside hours|disabled|board switch off)$/;
  for (const r of rows) {
    const bad = r.reasons.filter((x) => !benign.test(x));
    if (r.enabled && bad.length) problems.push(`${r.id ?? r.file}: ${bad.join('; ')}`);
    if (loaded.reg && r.agent && !loaded.reg.agents[r.agent]) problems.push(`${r.id ?? r.file}: agent ${r.agent} is not in the registry`);
  }
  const enabled = rows.filter((r) => r.enabled);
  if (enabled.length && rows.some((r) => r.enabled && r.reasons.includes('board switch off'))) problems.push(`${enabled.length} routine(s) enabled but the board switch is off (roadctl autonomy routines on, owner only)`);
  const mine = ctx.agent ? rows.filter((r) => r.agent === ctx.agent).length : null;
  const tail = `${rows.length} routine(s), ${enabled.length} enabled${mine === null ? '' : `, ${mine} for ${ctx.agent}`}`;
  if (problems.length) return res('routines', 'warn', `${tail}; inconsistent: ${names(problems, 4)}`, 'roadctl routine list shows why each one would not run', b.name);
  return res('routines', 'ok', tail, null, b.name);
}

export const CHECKS = [
  ['runtime', checkRuntime],
  ['installed-copy', checkInstalledCopy],
  ['launcher', checkLauncher],
  ['environment', checkEnvironment],
  ['clock', checkClock],
  ['paths', checkPaths],
  ['state', checkState],
  ['registry', (ctx, loaded) => checkRegistry(ctx, loaded)],
  ['executors', (ctx, loaded) => checkExecutors(ctx, loaded)],
  ['boards', (ctx, loaded) => checkBoards(ctx, loaded)],
];
