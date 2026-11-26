// One conductor turn. The timer owns repetition; this command owns one snapshot and one machine lock.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConductor, serviceDescription } from './launch.mjs';
import { acquireLock, stateDir } from './state.mjs';

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
export async function routeSnapshot(snapshot, { profile, describeRoutine, describeService, paused, supervise }) {
  const started = [];
  for (const item of snapshot.items ?? []) {
    if (item.kind !== 'RUN') continue;
    if (await paused()) return { started, paused: true };
    const board = snapshot.board_dirs?.[item.project];
    if (!board) throw new Error(`tick gave no board directory for ${item.project}`);
    const d = await describeRoutine(item, board);
    if (!d) throw new Error(`launch refused ${item.project}/${item.id}`);
    await supervise(d, board);
    started.push([item.kind, item.project, item.id]);
  }
  const decisions = (snapshot.items ?? []).filter((i) => i.kind !== 'RUN').slice(0, 3);
  if (decisions.length) {
    if (await paused()) return { started, paused: true };
    const board = snapshot.board_dirs?.[decisions[0].project];
    if (!board) throw new Error(`tick gave no board directory for ${decisions[0].project}`);
    const d = await describeService(profile, snapshot.prompt, board);
    if (!d) throw new Error('orchestrator launch description was refused');
    await supervise(d, board);
    started.push(...decisions.map((i) => [i.kind, i.project, i.id]));
  }
  return { started, paused: false };
}

const child = (args, { env, cwd, input } = {}) => spawnSync(process.execPath, [ROADCTL, ...args], { env, cwd, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const serviceBoards = (workspace) => {
  const projects = path.join(fs.realpathSync(workspace), 'projects');
  try {
    return fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(projects, e.name, 'board')).filter((dir) => fs.existsSync(path.join(dir, 'config.json'))).sort();
  } catch { return []; }
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
    const boards = serviceBoards(service.workspace); // resolved before tick: a registered owner board is never pulled by this process
    if (!boards.length) { ctx.io.err('roadctl serve: refused: service.workspace has no projects/*/board/config.json\n'); return 1; }
    const paused = () => {
      const r = child(['pause', 'status', '--json'], { env, cwd: service.workspace });
      const j = json(r);
      return r.status !== 0 || !j || j.paused === true; // a broken guard is a stop, not permission
    };
    const describeRoutine = (item, board) => {
      const r = child(['launch', '--routine', item.id, '--json', '--board', board], { env, cwd: service.workspace });
      return r.status === 0 ? json(r) : null;
    };
    const describeService = (_p, stdin, board) => serviceDescription(cond, service.profile, stdin, board, ctx.api.hostOfAgent(profile.agent, reg));
    const supervise = (d) => {
      const keep = new Set(['HOME', 'PATH', 'LANG', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ROADCTL_WORKSPACE', 'ROADCTL_REGISTRY', 'ROADCTL_NOW', 'ROADCTL_DATE', 'ROADCTL_HOST', ...(d.env ?? [])]);
      const runEnv = Object.fromEntries(Object.entries(env).filter(([name]) => keep.has(name)));
      runEnv.ROADCTL_UNATTENDED = '1';
      const r = child([...d.supervise_argv, ...d.argv], { env: runEnv, cwd: service.workspace, input: d.stdin });
      if (r.status !== 0) throw new Error(clean(r.stderr || r.stdout || 'supervise refused'));
    };
    const result = { started: [], paused: false };
    for (const board of boards) {
      const tick = child(['tick', '--as', profile.agent, '--json', '--prompt', '--board', board], { env, cwd: service.workspace });
      if (![0, 4].includes(tick.status)) { if (tick.stderr) ctx.io.err(tick.stderr); return tick.status ?? 1; }
      const snapshot = json(tick);
      if (!snapshot || !Array.isArray(snapshot.items)) { ctx.io.err('roadctl serve: tick returned invalid JSON\n'); return 1; }
      try {
        const one = await routeSnapshot(snapshot, { profile, describeRoutine, describeService, paused, supervise });
        result.started.push(...one.started);
        if (one.paused) { result.paused = true; break; }
      } catch (e) { ctx.io.err(`roadctl serve: refused: ${clean(e.message)}\n`); return 1; }
    }
    ctx.out(ctx.flags.json ? JSON.stringify(result) : `roadctl serve: started ${result.started.length}${result.paused ? '; paused' : ''}`);
    return result.paused ? 6 : 0;
  } finally { lock.release(); }
}

export default {
  name: 'serve',
  commands: {
    serve: {
      group: 'Delegate', effect: 'write', hidden: true, summary: 'run one conductor turn and exit',
      purpose: 'With --once, reads one tick snapshot per board for service.profile in the local conductor.json and exits. Every RUN gets its own synchronous supervisor; up to three other decisions share the exact tick orchestrator prompt. A machine lock excludes another turn, and pause is checked before every start. Only projects/*/board below service.workspace are read or pulled. Any missing or invalid local setting, launch description or pause check stops closed.',
      usage: ['roadctl serve --once [--json]'], flags: [['--once', 'run exactly one turn and exit'], ['--json', 'print the started actions as JSON']],
      examples: ['roadctl serve --once', 'roadctl serve --once --json'],
      changes: 'May start synchronous supervised runs and writes their normal run ledger/log state; tick may pull boards below service.workspace. No service or timer is installed.',
      exits: '0 turn dispatched; 1 refused; 2 usage error; 4 no work; 5 another turn is running; 6 paused',
      run: serveCommand,
    },
  },
};
