#!/usr/bin/env node
// Targeted, reportable update of the globally installed road-map-journal skill
// on ONE host, using the `skills` CLI (npx). Dry run by default.
//
//   node scripts/update-installed.mjs            # inspect and report only
//   node scripts/update-installed.mjs --apply    # back up, update, verify
//
// It never touches other skills. It refuses to overwrite an installed copy whose
// content does not match what the skills lock file recorded (local edits) unless
// --force is given; a backup is always made first. It cannot update copies that
// the skills CLI does not manage (for example account-synced Claude copies); those
// are only reported. It does not prove that a running agent session has reloaded
// the skill.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeInstalledJson } from './roadctl/fingerprint.mjs';

export const SKILL = 'road-map-journal';
export const DEFAULT_SOURCE = 'Lujker/road-map-journal';
export const DEFAULT_CLI = 'skills@1.7.6';
export const MIN_NODE = [22, 20, 0];

export function nodeOk(version = process.versions.node) {
  const v = version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > MIN_NODE[i]) return true;
    if ((v[i] || 0) < MIN_NODE[i]) return false;
  }
  return true;
}

function git(args, opts = {}) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.fileMode=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

/** Git tree hash of a directory, line endings normalised to LF (Windows installs use CRLF). */
export function folderHash(dir, tmpRoot = os.tmpdir()) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'rmj-hash-'));
  try {
    git(['init', '-q'], { cwd: tmp });
    for (const rel of listFiles(dir)) {
      const dest = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const text = fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
      fs.writeFileSync(dest, text);
    }
    git(['add', '-A', '.'], { cwd: tmp });
    return git(['write-tree'], { cwd: tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Upstream skill folder: shallow clone, return its path, tree hash and commit. */
export function fetchUpstream(url, tmpRoot = os.tmpdir()) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'rmj-upstream-'));
  git(['clone', '-q', '--depth', '1', url, tmp]);
  const rel = `skills/${SKILL}`;
  return {
    dir: path.join(tmp, ...rel.split('/')),
    root: tmp,
    commit: git(['rev-parse', 'HEAD'], { cwd: tmp }),
    hash: git(['rev-parse', `HEAD:${rel}`], { cwd: tmp }),
  };
}

export function readLock(home) {
  const p = path.join(home, '.agents', '.skill-lock.json');
  if (!fs.existsSync(p)) return { path: p, entry: null };
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { path: p, entry: json.skills?.[SKILL] ?? null };
}

/** Classify one install location. */
export function inspectLocation(label, p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return { label, path: p, kind: 'missing' };
  }
  if (st.isSymbolicLink()) {
    const target = path.resolve(path.dirname(p), fs.readlinkSync(p));
    return { label, path: p, kind: 'symlink', target, ok: fs.existsSync(target) };
  }
  return { label, path: p, kind: st.isDirectory() ? 'directory' : 'other' };
}

export function findLocations(home, env = process.env) {
  const hermesHome =
    env.HERMES_HOME?.trim() ||
    (process.platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'hermes') : path.join(home, '.hermes'));
  const locs = [
    inspectLocation('canonical (.agents)', path.join(home, '.agents', 'skills', SKILL)),
    inspectLocation('claude-code', path.join(home, '.claude', 'skills', SKILL)),
    inspectLocation('codex (own dir)', path.join(home, '.codex', 'skills', SKILL)),
  ];
  const hs = path.join(hermesHome, 'skills');
  if (fs.existsSync(hs)) {
    locs.push(inspectLocation('hermes (root)', path.join(hs, SKILL)));
    for (const cat of fs.readdirSync(hs, { withFileTypes: true })) {
      if (cat.isDirectory() || cat.isSymbolicLink()) {
        const l = inspectLocation(`hermes (${cat.name})`, path.join(hs, cat.name, SKILL));
        if (l.kind !== 'missing') locs.push(l);
      }
    }
  }
  const synced = path.join(home, '.claude', 'skills', 'synced');
  if (fs.existsSync(synced)) {
    for (const d of fs.readdirSync(synced, { withFileTypes: true })) {
      const l = inspectLocation('claude account-synced (not managed by npx)', path.join(synced, d.name, SKILL));
      if (l.kind !== 'missing') locs.push(l);
    }
  }
  return locs.filter((l) => l.kind !== 'missing' || l.label.startsWith('canonical'));
}

/** Decide what to do; pure function over gathered facts. */
export function decide({ canonicalExists, lockEntry, installedHash, upstreamHash }) {
  if (!canonicalExists) return { state: 'NOT_INSTALLED', action: 'install' };
  if (!lockEntry) return { state: 'UNTRACKED', action: 'review', note: 'no skills lock entry; cannot tell local edits from an old version' };
  const pristine = installedHash === lockEntry.skillFolderHash;
  if (installedHash === upstreamHash) return { state: 'UP_TO_DATE', action: 'none' };
  if (!pristine) return { state: 'LOCALLY_MODIFIED', action: 'review', note: 'installed content differs from the version the lock file recorded' };
  return { state: 'OUTDATED', action: 'update' };
}

/** The .mjs files of the roadctl modules folder (scripts/roadctl/) next to the helper, without test files; null when there is no such folder. */
function moduleFiles(srcFile) {
  const dir = path.join(path.dirname(srcFile), 'roadctl');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')).sort();
}

/**
 * Install or refresh the optional roadctl helper at a stable per-user path (hooks point there): roadctl.mjs and, when the source has a
 * roadctl/ folder of modules, its .mjs files in roadctl/ next to it (a mirror: a module that no longer exists upstream is moved aside).
 * Every changed file is kept as <file>.bak-<time>. Returns { dest, action, files: [{ rel, action }] }; action is for the whole helper.
 */
export function syncRoadctl(home, srcFile, apply = true) {
  const destDir = path.join(home, '.local', 'share', 'road-map-journal');
  const dest = path.join(destDir, 'roadctl.mjs');
  const norm = (t) => t.replace(/\r\n/g, '\n');
  const read = (f) => (fs.existsSync(f) ? norm(fs.readFileSync(f, 'utf8')) : null);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const plan = [{ rel: 'roadctl.mjs', from: srcFile }];
  const mods = moduleFiles(srcFile);
  if (mods) for (const n of mods) plan.push({ rel: `roadctl/${n}`, from: path.join(path.dirname(srcFile), 'roadctl', n) });
  const files = [];
  for (const f of plan) {
    const to = path.join(destDir, ...f.rel.split('/'));
    const src = norm(fs.readFileSync(f.from, 'utf8'));
    const cur = read(to);
    if (cur === src) {
      files.push({ rel: f.rel, action: 'unchanged' });
      continue;
    }
    const action = cur === null ? 'install' : 'update';
    if (apply) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (cur !== null) fs.copyFileSync(to, `${to}.bak-${stamp}`);
      fs.writeFileSync(to, src);
    }
    files.push({ rel: f.rel, action });
  }
  if (mods) {
    const destMods = path.join(destDir, 'roadctl');
    const have = fs.existsSync(destMods) ? fs.readdirSync(destMods).filter((n) => n.endsWith('.mjs')) : [];
    for (const n of have.filter((x) => !mods.includes(x)).sort()) {
      if (apply) fs.renameSync(path.join(destMods, n), path.join(destMods, `${n}.bak-${stamp}`));
      files.push({ rel: `roadctl/${n}`, action: 'remove' });
    }
  }
  const changed = files.some((f) => f.action !== 'unchanged');
  // installed.json (P5.9): version, checksum and file list of what is now in destDir, for `roadctl doctor` and `roadctl --version`; written only when it differs
  const record = apply ? writeInstalledJson(destDir, new Date().toISOString()) : null;
  if (!changed) return { dest, action: 'unchanged', files, installedJson: record ?? 'not written' };
  const action = files[0].action === 'install' ? 'install' : 'update';
  return { dest, action: apply ? action : `would ${action}`, files, installedJson: record ?? 'not written' };
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
}

function runCli(cliPkg, args, env) {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npx.cmd' : 'npx', ['--yes', cliPkg, ...args], {
    encoding: 'utf8',
    env,
    shell: win, // .cmd shims need a shell; all arguments here are fixed or validated
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function parseArgs(argv) {
  const o = { apply: false, force: false, agents: [], cli: DEFAULT_CLI, source: null, home: os.homedir(), json: false, roadctl: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--force') o.force = true;
    else if (a === '--json') o.json = true;
    else if (a === '--roadctl') o.roadctl = true;
    else if (a === '--agent') o.agents.push(argv[++i]);
    else if (a === '--cli') o.cli = argv[++i];
    else if (a === '--source') o.source = argv[++i];
    else if (a === '--home') o.home = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const a of o.agents) if (!/^[a-z0-9-]+$/.test(a)) throw new Error(`invalid agent name: ${a}`);
  if (!/^skills@[0-9][0-9a-z.\-]*$/.test(o.cli)) throw new Error(`invalid --cli (expected skills@<version>): ${o.cli}`);
  if (o.source && !/^[\w.-]+\/[\w.-]+$/.test(o.source)) throw new Error(`invalid --source (expected owner/repo): ${o.source}`);
  return o;
}

const HELP = `Usage: node scripts/update-installed.mjs [--apply] [--force] [--roadctl] [--agent <id>]... [--cli skills@x.y.z] [--source owner/repo] [--home <dir>] [--json]
Dry run unless --apply. Default agents: claude-code if ~/.claude exists, plus codex. Hermes is not selected by default
(use --agent hermes-agent only after checking that it will not hide a categorised Hermes link). --roadctl also installs or refreshes the optional helper at ~/.local/share/road-map-journal/roadctl.mjs. Requires Node >= ${MIN_NODE.join('.')}.`;

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) return console.log(HELP), 0;
  if (!nodeOk()) {
    console.error(`Node ${process.versions.node} is too old: the skills CLI needs >= ${MIN_NODE.join('.')}. Run this script with a newer node binary.`);
    return 2;
  }
  const report = { host: os.hostname(), platform: process.platform, home: o.home, apply: o.apply, cli: o.cli, steps: [] };
  const log = (s) => (report.steps.push(s), !o.json && console.log(s));

  const lock = readLock(o.home);
  const source = o.source || lock.entry?.source || DEFAULT_SOURCE;
  const url = lock.entry?.sourceUrl && !o.source ? lock.entry.sourceUrl : `https://github.com/${source}.git`;
  const isRealHome = path.resolve(o.home) === path.resolve(os.homedir());
  // With --home (isolated test) do not read the real Hermes/AppData locations from the environment.
  const envForLookup = isRealHome ? process.env : {};
  const locations = findLocations(o.home, envForLookup);
  const canonical = locations.find((l) => l.label.startsWith('canonical'));
  const canonicalExists = canonical.kind === 'directory';

  log(`Host ${report.host} (${process.platform}), home ${o.home}`);
  log(`Source ${source}; lock: ${lock.entry ? `hash ${lock.entry.skillFolderHash.slice(0, 7)}, updated ${lock.entry.updatedAt}` : 'no entry'}`);
  for (const l of locations) {
    log(`  ${l.label}: ${l.kind}${l.target ? ` -> ${l.target}${l.ok ? '' : ' (BROKEN)'}` : ''}  ${l.path}`);
  }
  const dups = locations.filter((l) => l.kind === 'directory' && !l.label.startsWith('canonical') && !l.label.includes('account-synced'));
  if (dups.length) log(`WARNING: independent copies not controlled by the canonical install: ${dups.map((d) => d.path).join(', ')}`);
  const synced = locations.filter((l) => l.label.includes('account-synced'));
  if (synced.length) log(`NOTE: ${synced.length} account-synced Claude copy/copies exist; npx does not update them and they may shadow this skill.`);

  const upstream = fetchUpstream(url);
  let exit = 0;
  try {
    const installedHash = canonicalExists ? folderHash(canonical.path) : null;
    const d = decide({ canonicalExists, lockEntry: lock.entry, installedHash, upstreamHash: upstream.hash });
    log(`Upstream ${upstream.commit.slice(0, 7)} tree ${upstream.hash.slice(0, 7)}; installed tree ${installedHash ? installedHash.slice(0, 7) : 'n/a'} -> ${d.state}${d.note ? ` (${d.note})` : ''}`);
    report.state = d.state;

    if (o.roadctl) {
      const t = syncRoadctl(o.home, fileURLToPath(new URL('./roadctl.mjs', import.meta.url)), o.apply);
      log(`roadctl helper: ${t.action} ${t.dest}${t.files.length > 1 ? ` (+ ${t.files.length - 1} module file(s) in roadctl/: ${t.files.slice(1).filter((f) => f.action !== 'unchanged').length} changed)` : ''}${t.installedJson === 'write' ? '; installed.json written' : ''}`);
    }
    const wantsRun = d.action === 'update' || d.action === 'install' || (d.action === 'review' && o.force);
    if (!wantsRun) {
      if (d.action === 'review') exit = 1;
      if (o.json) console.log(JSON.stringify(report, null, 2));
      return exit;
    }
    if (!o.apply) {
      log(`Dry run: would ${d.action} with ${o.cli}. Re-run with --apply.`);
      if (o.json) console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    // Backup everything that currently exists before the CLI may overwrite it.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(o.home, '.local', 'share', 'road-map-journal-backups', `update-${stamp}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const l of locations) {
      if (l.kind === 'directory' && !l.label.includes('account-synced')) copyDir(l.path, path.join(backup, l.label.replace(/\W+/g, '_')));
    }
    if (fs.existsSync(lock.path)) fs.copyFileSync(lock.path, path.join(backup, 'skill-lock.json'));
    log(`Backup: ${backup}`);

    const agents = o.agents.length ? o.agents : ['codex', ...(fs.existsSync(path.join(o.home, '.claude')) ? ['claude-code'] : [])];
    const args = ['add', source, '--skill', SKILL, '-g', '-y', ...agents.flatMap((a) => ['-a', a])];
    log(`Running: npx ${o.cli} ${args.join(' ')}`);
    const r = runCli(o.cli, args, { ...process.env, HOME: o.home, USERPROFILE: o.home });
    if (r.code !== 0) {
      log(`CLI failed (exit ${r.code}); nothing is verified. Backup kept. Output tail:\n${r.out.split('\n').slice(-8).join('\n')}`);
      return 1;
    }

    // Verify.
    const after = findLocations(o.home, envForLookup);
    const canon2 = after.find((l) => l.label.startsWith('canonical'));
    const h2 = canon2.kind === 'directory' ? folderHash(canon2.path) : null;
    const lock2 = readLock(o.home).entry;
    const checks = [
      ['canonical content equals upstream', h2 === upstream.hash],
      ['lock hash equals upstream', lock2?.skillFolderHash === upstream.hash],
      ...after.filter((l) => l.kind === 'symlink').map((l) => [`link ok: ${l.label}`, l.ok]),
    ];
    for (const [name, ok] of checks) log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
    exit = checks.every(([, ok]) => ok) ? 0 : 1;
    log(exit === 0 ? 'Updated and verified on files only; running agent sessions must be restarted, and discovery/behavior are not tested here.' : 'Verification failed; restore from the backup if needed.');
    report.state = exit === 0 ? 'UPDATED' : 'VERIFY_FAILED';
    if (o.json) console.log(JSON.stringify(report, null, 2));
    return exit;
  } finally {
    fs.rmSync(upstream.root, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => (console.error(`error: ${e.message}`), process.exit(2)),
  );
}
