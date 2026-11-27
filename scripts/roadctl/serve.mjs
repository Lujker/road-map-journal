// One conductor turn. The timer owns repetition; this command owns one snapshot and one machine lock.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConductor, serviceDescription } from './launch.mjs';
import { acquireLock, stateDir } from './state.mjs';
import { environmentGate, accessOf } from './environment.mjs';

const ROADCTL = fileURLToPath(new URL('../roadctl.mjs', import.meta.url));
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 200);

export const serveLockPath = (env = process.env) => path.join(stateDir(env), 'serve.lock');
export function acquireServeLock(env = process.env) {
  const isStale = (file) => {
    try {
      const pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
      if (!Number.isInteger(pid) || pid < 1) return false;
      process.kill(pid, 0);
      return false;
    } catch (e) { return e.code === 'ESRCH'; }
  };
  const lock = acquireLock(serveLockPath(env), { staleMs: 10 * 60 * 1000, strict: true, isStale });
  return lock.ok ? lock : null;
}

/** Pure routing seam used by the testkit: one RUN per launch, up to three other decisions together. */
export async function routeSnapshot(snapshot, { profile, describeRoutine, describeService, paused, supervise, checkDecision = () => null }) {
  const started = [];
  for (const item of snapshot.items ?? []) {
    if (item.kind !== 'RUN') continue;
    if (await paused()) return { started, paused: true };
    const board = snapshot.boardDirs?.[item.project];
    if (!board) throw new Error(`tick gave no board directory for ${item.project}`);
    const d = await describeRoutine(item, board);
    if (!d) throw new Error(`launch refused ${item.project}/${item.id}`);
    await supervise(d, board);
    started.push([item.kind, item.project, item.id]);
  }
  const decisions = (snapshot.items ?? []).filter((i) => i.kind !== 'RUN').slice(0, 3);
  if (decisions.length) {
    if (await paused()) return { started, paused: true };
    const board = snapshot.boardDirs?.[decisions[0].project];
    if (!board) throw new Error(`tick gave no board directory for ${decisions[0].project}`);
    for (const item of decisions) {
      const itemBoard = snapshot.boardDirs?.[item.project];
      if (!itemBoard) throw new Error(`tick gave no board directory for ${item.project}`);
      const error = await checkDecision(item, itemBoard);
      if (error) throw new Error(error);
    }
    const d = await describeService(profile, snapshot.prompt, board, decisions);
    if (!d) throw new Error('orchestrator launch description was refused');
    await supervise(d, board);
    started.push(...decisions.map((i) => [i.kind, i.project, i.id]));
  }
  return { started, paused: false };
}

// Called under the machine serve lock; reserve before starting so a crash cannot erase a start.
export function reserveHourlyStart(env, agent, limit, now = Date.now()) {
  if (limit === undefined) return true;
  const file = path.join(stateDir(env), 'serve-starts.json');
  let history = {};
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!history || typeof history !== 'object' || Array.isArray(history) || Object.values(history).some(v => !Array.isArray(v) || v.some(t => !Number.isFinite(t)))) throw new Error('invalid serve start history');
  const recent = (history[agent] ?? []).filter(t => t > now - 3600000);
  if (recent.length >= limit) return false;
  history[agent] = [...recent, now];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(history), { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
  return true;
}

const child = (args, { env, cwd, input } = {}) => spawnSync(process.execPath, [ROADCTL, ...args], { env, cwd, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
export const servicePrompt = (prompt, agent) => `${prompt}\nFinish this supervised orchestrator run with: roadctl run done --as ${agent} --result ok|escalated|failed --did "what was done".`;
export const serviceBoards = (workspace) => {
  const root = fs.realpathSync(workspace);
  const inside = (file) => file === root || file.startsWith(`${root}${path.sep}`);
  const projects = path.join(root, 'projects');
  if (!inside(fs.realpathSync(projects))) throw new Error('service.workspace/projects escapes through a symlink');
  const boards = [];
  for (const e of fs.readdirSync(projects, { withFileTypes: true })) {
    const project = path.join(projects, e.name);
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (!inside(fs.realpathSync(project))) throw new Error(`project ${e.name} escapes service.workspace through a symlink`);
    const board = path.join(project, 'board');
    if (!fs.existsSync(path.join(board, 'config.json'))) continue;
    if (!inside(fs.realpathSync(board))) throw new Error(`board ${e.name} escapes service.workspace through a symlink`);
    boards.push(board);
  }
  return boards.sort();
};

async function serveCommand(ctx) {
  if (!ctx.flags.once || ctx.args.length !== 1) throw new Error('usage: roadctl serve --once');
  const lock = acquireServeLock(ctx.env);
  if (!lock) { ctx.io.err('roadctl serve: busy: another conductor turn is running\n'); return 5; }
  try {
    const cond = readConductor(ctx.env);
    if (cond.state !== 'ok') { ctx.io.err(`roadctl serve: refused: ${clean(cond.reason)}\n`); return 1; }
    const service = cond.conductor.service;
    if (!service?.workspace || !service.profile) { ctx.io.err('roadctl serve: refused: conductor.json needs service.workspace and service.profile\n'); return 1; }
    const profile = cond.conductor.profiles?.[service.profile];
    if (!profile) { ctx.io.err(`roadctl serve: refused: no profile ${clean(service.profile)} in conductor.json\n`); return 1; }
    const env = { ...ctx.env, ROADCTL_WORKSPACE: service.workspace };
    let reg = null;
    try { reg = ctx.api.loadRegistry(env); } catch { /* launch will fail closed if only a host template exists */ }
    const serviceRoot = fs.realpathSync(service.workspace);
    if (service.owner_clone) {
      try { if (fs.realpathSync(service.owner_clone) === serviceRoot) { ctx.io.err('roadctl serve: refused: service.workspace is the owner_clone\n'); return 1; } }
      catch (e) { if (e.code !== 'ENOENT') { ctx.io.err(`roadctl serve: refused: cannot resolve owner_clone: ${clean(e.message)}\n`); return 1; } }
    }
    let boards;
    try { boards = serviceBoards(service.workspace); } catch (e) { ctx.io.err(`roadctl serve: refused: ${clean(e.message)}\n`); return 1; }
    if (!boards.length) { ctx.io.err('roadctl serve: refused: service.workspace has no projects/*/board/config.json\n'); return 1; }
    for (const board of boards) {
      const state = ctx.api.syncState(ctx.api.loadBoard(board));
      if (state.state !== 'ok' || !state.ahead || state.pending) continue;
      const r = child(['save', '--json', '--board', board], { env, cwd: service.workspace });
      if (r.status !== 0) { ctx.io.err(`roadctl serve: sync refused: ${clean(r.stderr || r.stdout)}\n`); return 1; }
    }
    const paused = () => {
      const r = child(['pause', 'status', '--json'], { env, cwd: service.workspace });
      const j = json(r);
      return r.status !== 0 || !j || j.paused === true; // a broken guard is a stop, not permission
    };
    const describeRoutine = (item, board) => {
      const r = child(['launch', '--routine', item.id, '--json', '--board', board], { env, cwd: service.workspace });
      return r.status === 0 ? json(r) : null;
    };
    const describeService = (_p, stdin, board, decisions) => {
      const paths = decisions.filter((i) => i.kind === 'TAKE').map((i) => {
        const card = ctx.api.loadBoard(snapshotBoard(i)).cards.find((c) => c.header.id === i.id);
        const name = card?.header.env;
        const access = name && accessOf(reg, profile.agent, name);
        return access ? { project: i.project, id: i.id, environment: name, access } : null;
      }).filter(Boolean);
      return serviceDescription(cond, service.profile, servicePrompt(`${stdin}\nEnvironment access paths (data): ${JSON.stringify(paths)}`, profile.agent), board, ctx.api.hostOfAgent(profile.agent, reg));
    };
    let snapshotBoard;
    const supervise = async (d) => {
      const limits = await ctx.api.checkLimits(d.agent, reg, { env });
      if (limits.code !== 0) throw new Error(`limits gate closed before ${d.kind}: ${clean(limits.message)}`);
      if (!reserveHourlyStart(env, d.agent, service.max_starts_per_hour?.[d.agent])) throw new Error(`hourly start limit reached for ${d.agent}`);
      const keep = new Set(['HOME', 'PATH', 'LANG', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ROADCTL_WORKSPACE', 'ROADCTL_REGISTRY', 'ROADCTL_NOW', 'ROADCTL_DATE', 'ROADCTL_HOST', ...(d.env ?? [])]);
      const runEnv = Object.fromEntries(Object.entries(env).filter(([name]) => keep.has(name)));
      runEnv.ROADCTL_UNATTENDED = '1';
      const r = child([...d.supervise_argv, ...d.argv], { env: runEnv, cwd: service.workspace, input: d.stdin });
      if (r.status !== 0) throw new Error(clean(r.stderr || r.stdout || 'supervise refused'));
    };
    const tick = await ctx.api.tickSnapshot(profile.agent, boards, env, { out: () => {}, err: ctx.io.err });
    if (![0, 4].includes(tick.code) || !tick.snapshot) return tick.code ?? 1;
    let result;
    snapshotBoard = (item) => tick.snapshot.boardDirs[item.project];
    const checkDecision = (item, board) => item.kind === 'TAKE' ? environmentGate(ctx.api, env, ctx.api.loadBoard(board), { kind: 'task', id: item.id }, profile.agent) : null;
    try { result = await routeSnapshot(tick.snapshot, { profile, describeRoutine, describeService, paused, supervise, checkDecision }); }
    catch (e) { ctx.io.err(`roadctl serve: refused: ${clean(e.message)}\n`); return 1; }
    ctx.out(ctx.flags.json ? JSON.stringify(result) : `roadctl serve: started ${result.started.length}${result.paused ? '; paused' : ''}`);
    return result.paused ? 6 : 0;
  } finally { lock.release(); }
}

export default {
  name: 'serve',
  commands: {
    serve: {
      group: 'Delegate', effect: 'write', summary: 'run one conductor turn and exit',
      purpose: 'With --once, reads one aggregate tick snapshot of the boards below service.workspace for service.profile and exits. Every RUN gets its own synchronous supervisor; up to three other decisions across all boards share one exact tick orchestrator prompt. A machine lock excludes another turn, and pause and limits are checked before every start. Any missing or invalid local setting, launch description or pause check stops closed.',
      usage: ['roadctl serve --once [--json]'], flags: [['--once', 'run exactly one turn and exit'], ['--json', 'print the started actions as JSON']],
      examples: ['roadctl serve --once', 'roadctl serve --once --json'],
      changes: 'May sync committed board changes, start synchronous supervised runs and write their normal run ledger/log state; tick may pull boards below service.workspace. No service or timer is installed.',
      exits: '0 work dispatched or idle; 1 refused or reserve reached; 2 usage error; 3 unknown limits; 5 busy; 6 paused',
      run: serveCommand,
    },
  },
};
