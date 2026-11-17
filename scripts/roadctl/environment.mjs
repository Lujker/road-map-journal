// Work environment apart from the executor's machine, and the choice of an executor (P5.23).
// Where the model runs and where the work lies are two things. The registry (a local file, optional) may describe the environments a routine or a card names in `env`:
//
//   "environments": { "Work-notebook-wsl": { "machine": "work-notebook", "placement": "remote-access",
//                                            "access": [ { "from": "home-wsl", "ssh": "work-notebook", "mcp": ["atom-services"] } ] } }
//   "preference":   { "worker": ["claude-code@home-wsl", "codex@home-wsl"] }                 // the owner's order for a role: the first is the main one, the rest are the agreed reserve
//   agents:         { "claude-code@home-wsl": { "machine": "home-wsl", "tools": ["atom-services"], "data": ["atom"], "fit": { "worker": { "confirmed": "2026-11-10", "evidence": "..." } } } }
//
// `placement` is `on-host` (default: the executor runs on the machine of the environment) or `remote-access` (the executor runs elsewhere and reaches the environment by `access`).
// A registry without the section behaves as before. MCP in `access` and `tools` is a declaration, never proof that the server works now; ssh never stands for MCP.
// Parts: `roadctl env check` (is the environment reachable; used by `supervise` before the model starts), `roadctl candidates` (one read-only choice of executors), lint, `tick`, `routine show`.
// Node standard library only, no side effects at import.
import { spawnSync } from 'node:child_process';

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/; // an ssh destination, as in `doctor --host`: it cannot start with "-", so the registry cannot slip an ssh option in
export const PLACEMENTS = ['remote-access', 'on-host'];
const TOKEN_RE = /^[A-Za-z0-9][\w.:@-]*$/;
const lc = (s) => String(s ?? '').toLowerCase();
const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const strs = (x) => Array.isArray(x) && x.every((v) => typeof v === 'string' && v);
const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f`<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------- the registry's view

export const machineOf = (agent, reg) => lc(reg?.agents?.[agent]?.machine ?? String(agent).split('@')[1] ?? '');
const envKey = (reg, name) => Object.keys(reg?.environments ?? {}).find((k) => lc(k) === lc(name));

/** Problems of the `environments`, `preference` and agent fields of a registry (strings); [] when it is fine or has none of them. */
export function registryProblems(reg) {
  const out = [];
  for (const [name, e] of Object.entries(reg?.environments ?? {})) {
    const w = `environments.${clean(name, 40)}`;
    if (!obj(e)) { out.push(`${w} must be an object`); continue; }
    if (e.placement !== undefined && !PLACEMENTS.includes(e.placement)) out.push(`${w}.placement must be ${PLACEMENTS.join(' or ')}`);
    if (e.machine !== undefined && !(typeof e.machine === 'string' && TOKEN_RE.test(e.machine))) out.push(`${w}.machine must be a machine name`);
    if (e.access !== undefined && !Array.isArray(e.access)) out.push(`${w}.access must be a list`);
    for (const [i, a] of (Array.isArray(e.access) ? e.access : []).entries()) {
      if (!obj(a) || typeof a.from !== 'string' || !a.from) out.push(`${w}.access[${i}] needs "from" (the machine of the executor)`);
      else if (typeof a.ssh !== 'string' || !HOST_RE.test(a.ssh)) out.push(`${w}.access[${i}].ssh ${clean(a.ssh, 40)} is not a host name (letters, digits and . _ @ : -, not starting with "-"): it is never passed to ssh`);
      if (obj(a) && a.mcp !== undefined && !strs(a.mcp)) out.push(`${w}.access[${i}].mcp must be a list of MCP server names`);
    }
  }
  for (const [role, list] of Object.entries(reg?.preference ?? {})) if (!strs(list)) out.push(`preference.${clean(role, 40)} must be a list of agent names`);
  for (const [a, x] of Object.entries(reg?.agents ?? {})) {
    for (const k of ['tools', 'data']) if (x?.[k] !== undefined && !strs(x[k])) out.push(`agents.${clean(a, 60)}.${k} must be a list of names`);
    if (x?.fit !== undefined && !obj(x.fit)) out.push(`agents.${clean(a, 60)}.fit must be an object of roles`);
  }
  return out;
}

/** The way from the machine `from` to the environment `name`: { described, placement, machine, from, via: 'local' | 'ssh' | 'none', ssh?, mcp? }. Only `remote-access` uses `access`. */
export function envPath(reg, from, name) {
  const key = envKey(reg, name);
  const e = key ? reg.environments[key] : null;
  const base = { described: Boolean(e), placement: e?.placement ?? 'on-host', machine: lc(e?.machine ?? name), from: lc(from) };
  if (base.from && base.from === base.machine) return { ...base, via: 'local' };
  const hit = base.placement === 'remote-access' && Array.isArray(e?.access) ? e.access.find((a) => obj(a) && lc(a.from) === base.from) : null;
  return hit ? { ...base, via: 'ssh', ssh: hit.ssh, mcp: strs(hit.mcp) ? [...hit.mcp] : [] } : { ...base, via: 'none' };
}

/** What `tick` and `routine show` say about an environment: only for a described `remote-access` environment; null otherwise (the output stays as before). */
export function accessOf(reg, agent, name) {
  if (!name) return null;
  const p = envPath(reg, machineOf(agent, reg), name);
  if (!p.described || p.placement !== 'remote-access') return null;
  return { placement: p.placement, via: p.via, machine: p.machine, ...(p.ssh ? { ssh: p.ssh } : {}), ...(p.mcp?.length ? { mcp: p.mcp } : {}) };
}

// ---------------------------------------------------------------- is the environment reachable

/** `ssh -o BatchMode=yes -o ConnectTimeout=5 -- HOST true`. `spawn` is injectable (tests); a host that does not fit HOST_RE is never passed to ssh. */
export function probeSsh(host, { spawn = spawnSync, env = process.env, timeoutMs = 8000 } = {}) {
  if (typeof host !== 'string' || !HOST_RE.test(host)) return { ok: false, why: `${clean(host, 40)} is not a valid host name; ssh was not started` };
  const r = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', host, 'true'], { env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'ignore', 'ignore'] });
  if (r.error) return { ok: false, why: `cannot run ssh: ${r.error.code ?? r.error.message}` };
  return r.status === 0 ? { ok: true } : { ok: false, why: `ssh to ${host} failed (${r.status === null ? `killed by ${r.signal ?? 'a signal'}` : `exit ${r.status}`})` };
}

/** { environment, state: 'reachable' | 'unreachable', via, host?, why?, mcp? } for the machine `from`. No path at all is unreachable. */
export function reachability(reg, from, name, opts) {
  const p = envPath(reg, from, name);
  const head = { environment: name, from: p.from, placement: p.placement };
  if (p.via === 'local') return { ...head, state: 'reachable', via: 'local' };
  if (p.via === 'none') return { ...head, state: 'unreachable', via: 'none', why: `no access path from ${p.from || 'this machine'} to ${name} (placement ${p.placement}${p.described ? '' : '; not described in the registry'})` };
  const r = probeSsh(p.ssh, opts);
  return { ...head, state: r.ok ? 'reachable' : 'unreachable', via: 'ssh', host: p.ssh, ...(r.ok ? {} : { why: r.why }), ...(p.mcp.length ? { mcp: { declared: p.mcp, checked: false } } : {}) };
}

/** The gate of `supervise`, before the model starts: a text when the run must be skipped as `unreachable`, else null. Only a described `remote-access` environment is checked. */
export function environmentGate(api, env, board, t, agent, opts = {}) {
  let name = null;
  if (t.kind === 'routine') name = (board?.routines ?? []).find((r) => r.header.id === t.id)?.header.env;
  else if (t.kind === 'task') name = board?.cards.find((c) => c.header.id === t.id)?.header.env;
  if (!name) return null;
  let reg = null;
  try { reg = api.loadRegistry(env); } catch { return null; } // a broken registry stops tick and limits; it is not this gate's business
  const p = envPath(reg, machineOf(agent, reg), name);
  if (!p.described || p.placement !== 'remote-access' || p.via === 'local') return null;
  const r = reachability(reg, machineOf(agent, reg), name, { env, ...opts });
  return r.state === 'reachable' ? null : `environment ${clean(name, 40)} is unreachable: ${r.why}`;
}

// ---------------------------------------------------------------- one read-only choice of executors

/** The need of a card: env, role and tools/data from its header (`env`, `role`, `needs`), the role also from a delegation `to=<role>`. */
export function needOf(card) {
  const h = card.header;
  const to = /(?:^|\s)to=(\S+)/.exec(h.delegate ?? '')?.[1];
  const role = h.role ?? (to && !/[@:]/.test(to) ? to : null);
  return { env: h.env ?? null, role, needs: String(h.needs ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
}

/**
 * The ordered candidates for a need and why each is refused. `reach(agent)` and `limits(agent)` are injected (tests; the command wires the real ones): a refusal that needs no
 * network (permission, role, fitness, tools, data, path) is decided first and nothing is probed for an agent that is already refused. Nothing here changes the environment, the
 * permissions, the data access or the budget of the task: an agent outside the owner's list, or whose path/tools/data do not already fit, is refused, never adapted.
 * chosen = the first eligible one, or null: no candidate means no launch.
 */
export async function selectCandidates(reg, need, { reach, limits }) {
  const agents = reg?.agents ?? {};
  const listed = need.role ? reg?.preference?.[need.role] : null;
  const pool = Array.isArray(listed) ? listed : Object.keys(agents).filter((a) => !need.role || agents[a]?.roles?.includes(need.role));
  const rows = [];
  for (const [i, name] of pool.entries()) {
    const a = agents[name];
    const reasons = [];
    const row = { agent: name, order: i + 1, rank: Array.isArray(listed) ? (i === 0 ? 'main' : 'reserve') : 'any', eligible: false, reasons };
    rows.push(row);
    if (!a) { reasons.push('not in the registry'); continue; }
    if (a.host === 'script' || /^(cron|script):/.test(name)) reasons.push('a script is not an executor of tasks');
    if (need.role && !a.roles?.includes(need.role)) reasons.push(`does not have the role ${need.role}`);
    if (need.role && !a.fit?.[need.role]?.confirmed) reasons.push(`fitness for ${need.role} is not confirmed (agents.${name}.fit.${need.role}.confirmed: checks of similar tasks)`);
    const p = need.env ? envPath(reg, machineOf(name, reg), need.env) : null;
    if (p) {
      row.path = { via: p.via, ...(p.ssh ? { ssh: p.ssh } : {}), ...(p.mcp ? { mcp_declared: p.mcp } : {}) };
      if (p.via === 'none') reasons.push(`no access to the environment ${need.env} from ${p.from || 'its machine'} (placement ${p.placement})`);
    }
    for (const t of need.needs) {
      if (t.startsWith('data:')) { if (!a.data?.includes(t.slice(5))) reasons.push(`no access to data ${t.slice(5)}`); }
      else if (!a.tools?.includes(t) && !p?.mcp?.includes(t)) reasons.push(`missing tool ${t}`); // ssh to the machine is not the MCP server
    }
    if (reasons.length) continue;
    if (p) {
      const r = await reach(name);
      if (r.state !== 'reachable') { reasons.push(`unavailable: ${r.why}`); continue; }
    }
    const l = await limits(name);
    row.limits = l.verdict;
    if (l.verdict === 'reserve') reasons.push(`limits: reserve reached (${l.message})`);
    else if (l.verdict === 'unknown') reasons.push(`limits unknown (${l.message}): no guess is made`);
    else if (l.api && !a.budget) reasons.push('a paid API with no agreed budget (agents.<name>.budget)');
    row.eligible = !reasons.length;
  }
  const chosen = rows.find((r) => r.eligible)?.agent ?? null;
  return { ...need, candidates: rows, chosen, note: 'MCP in the registry is a declaration, not proof that the server works now; the executor is checked again before it starts' };
}

/** The real limits of one agent (the executor's own provider, not the orchestrator's). Never throws. */
export const limitsOf = (api, reg, env) => async (agent) => {
  try {
    const r = await api.checkLimits(agent, reg, { env });
    return { verdict: r.verdict === 'confirmed' ? 'allowed' : r.verdict, message: String(r.message ?? '').slice(0, 160), api: r.result?.state === 'not-applicable' };
  } catch (e) {
    return { verdict: 'unknown', message: clean(e.message, 120), api: false };
  }
};

// ---------------------------------------------------------------- commands

const textOfCandidates = (r) => [
  `candidates for env ${r.env ?? '-'} role ${r.role ?? '-'} needs ${r.needs.join(', ') || '-'}`,
  ...r.candidates.map((c) => `${c.order}. ${c.agent} [${c.rank}] ${c.eligible ? 'eligible' : `refused: ${c.reasons.join('; ')}`}${c.path?.via === 'ssh' ? ` (ssh ${c.path.ssh})` : ''}`),
  r.chosen ? `chosen: ${r.chosen}` : 'no candidate: nothing is launched (no guess, no other environment, no wider rights or budget)',
  `note: ${r.note}`,
].join('\n');

async function candidatesCommand({ flags, out, io, env, api }) {
  const usage = 'usage: roadctl candidates --card ID [--json]   |   roadctl candidates --env NAME [--role ROLE] [--needs a,b,data:x] [--json]';
  const reg = api.loadRegistry(env);
  if (!reg) throw new Error('no registry: the candidates come from the registry (docs/roadctl.md, Registry)');
  let need;
  if (typeof flags.card === 'string') {
    const dir = api.findBoard(process.cwd(), typeof flags.board === 'string' ? flags.board : undefined, env);
    if (!dir) throw new Error('no board found; run inside the project or use --board DIR / --project NAME');
    const card = api.loadBoard(dir).cards.find((c) => c.header.id === flags.card);
    if (!card) throw new Error(`no card ${clean(flags.card, 40)} on the board`);
    need = needOf(card);
  } else if (typeof flags.env === 'string') need = { env: flags.env, role: typeof flags.role === 'string' ? flags.role : null, needs: typeof flags.needs === 'string' ? flags.needs.split(',').map((x) => x.trim()).filter(Boolean) : [] };
  else throw new Error(usage);
  for (const x of [need.env, need.role, ...need.needs.map((t) => t.replace(/^data:/, ''))]) if (x && !TOKEN_RE.test(x)) throw new Error(`${usage}; bad name ${clean(x, 40)}`);
  const bad = registryProblems(reg);
  if (bad.length) { io.err(`roadctl candidates: the registry has problems, nothing is chosen: ${bad.join('; ')}\n`); return 1; }
  if (flags.multiagent) {
    const checked = await selectCandidates(reg, need, { reach: async () => ({ state: 'reachable' }), limits: async () => ({ verdict: 'unknown', message: 'not checked' }) });
    const preferences = checked.candidates.map((row) => {
      const host = reg.agents?.[row.agent]?.host;
      let provider = null;
      try { provider = api.resolveTarget(row.agent, reg).provider; } catch { /* unknown provider */ }
      const model = reg.roles?.[need.role]?.[host] ?? null;
      if (!provider) row.reasons.push('provider is unspecified');
      if (!model) row.reasons.push('model is unspecified for this role and host');
      row.reasons.push('availability and limits not checked');
      return { ...row, provider, model };
    });
    const r = { ...need, preferences, advisory: 'Static registry checks only; availability and limits are not checked. Harness must verify permissions, budget and routes before use. No launch or spending is authorized.' };
    out(flags.json ? JSON.stringify(r, null, 2) : [`role: ${need.role ?? '-'}; env: ${need.env ?? '-'}; needs: ${need.needs.join(', ') || '-'}`, ...preferences.map((p) => `${p.order}. ${p.agent}: provider ${p.provider ?? 'unknown'}, model ${p.model ?? 'unspecified'}; ${p.eligible ? 'eligible' : `not eligible: ${p.reasons.join('; ')}`}`), r.advisory].join('\n'));
    return 0;
  }
  const r = await selectCandidates(reg, need, { reach: async (agent) => reachability(reg, machineOf(agent, reg), need.env, { env }), limits: limitsOf(api, reg, env) });
  out(flags.json ? JSON.stringify(r, null, 2) : textOfCandidates(r));
  return r.chosen ? 0 : 1;
}

function envCommand({ flags, args, out, io, env, api }) {
  const usage = 'usage: roadctl env check ENV [--as AGENT | --from MACHINE] [--json]';
  if (args[1] !== 'check' || !args[2]) throw new Error(usage);
  const reg = api.loadRegistry(env);
  const name = args[2];
  if (!TOKEN_RE.test(name)) throw new Error(`${usage}; bad environment name`);
  if (!reg || !envKey(reg, name)) throw new Error(`${clean(name, 40)} is not described in the registry (environments)`);
  const bad = registryProblems(reg);
  let from;
  if (typeof flags.as === 'string') from = machineOf(flags.as, reg);
  else if (typeof flags.from === 'string') from = lc(flags.from);
  else {
    const only = [...new Set((reg.environments[envKey(reg, name)].access ?? []).map((a) => lc(a?.from)))];
    if (only.length !== 1) throw new Error(`${usage}; the executor's machine is needed (the environment has ${only.length} access paths)`);
    from = only[0];
  }
  const r = reachability(reg, from, name, { env });
  if (bad.length && r.via === 'none') r.why = `${r.why}; registry problems: ${bad.join('; ')}`;
  if (flags.json) out(JSON.stringify(r, null, 2));
  else out(`env ${name} from ${r.from || '-'}: ${r.state}${r.via === 'ssh' ? ` (ssh ${r.host})` : r.via === 'local' ? ' (on this machine)' : ''}${r.why ? `: ${r.why}` : ''}${r.mcp ? `; mcp ${r.mcp.declared.join(', ')} declared, not checked` : ''}`);
  if (r.state === 'unreachable') io.err(`roadctl env check: ${name} is unreachable\n`);
  return r.state === 'reachable' ? 0 : 1;
}

// ---------------------------------------------------------------- lint

const tryRegistry = (api, env) => { try { return api.loadRegistry(env); } catch { return null; } };

/** Warning text for an executor on `agent`'s machine and the environment `name`, or null. */
function pathFinding(reg, agent, name) {
  const p = envPath(reg, machineOf(agent, reg), name);
  if (!p.described) return null;
  if (p.via === 'none') return `${agent} runs on ${p.from || 'an unknown machine'}, the environment ${name} is on ${p.machine}, and the registry gives no access path from there (placement ${p.placement}; add environments.${name}.access with placement remote-access, or use an executor on ${p.machine})`;
  if (p.via === 'local' && p.placement === 'remote-access') return `placement of ${name} is remote-access, but ${agent} runs on its own machine (${p.machine}); the access path is not used (use an executor elsewhere, or set placement on-host)`;
  return null;
}

export default {
  name: 'environment',
  headerKeys: ['env', 'role', 'needs'], // card keys (P5.23): the environment, the role and the tools/data a task needs; a routine already has `env`
  hooks: {
    'routine-lint'({ routine, env, api }) {
      const reg = tryRegistry(api, env);
      const h = routine.header;
      const text = reg?.environments && h.env && h.agent ? pathFinding(reg, h.agent, h.env) : null;
      return text ? { findings: [{ level: 'warning', text }] } : {};
    },
    'board-lint'({ board, env, api }) {
      const reg = tryRegistry(api, env);
      const findings = [];
      for (const text of registryProblems(reg)) findings.push({ level: 'warning', file: 'registry', text });
      for (const c of board.cards) {
        const h = c.header;
        if (h.env && !TOKEN_RE.test(h.env)) findings.push({ level: 'warning', file: c.name, text: `env ${clean(h.env, 30)} must be an environment name without spaces` });
        if (h.role && !TOKEN_RE.test(h.role)) findings.push({ level: 'warning', file: c.name, text: `role ${clean(h.role, 30)} must be a role name` });
        for (const t of String(h.needs ?? '').split(',').map((x) => x.trim()).filter(Boolean)) if (!TOKEN_RE.test(t.replace(/^data:/, ''))) findings.push({ level: 'warning', file: c.name, text: `needs: ${clean(t, 30)} is not a tool or data name` });
        if (!reg?.environments || !h.env || !h.delegate || ['done', 'dropped'].includes(board.config.status_map?.[h.status ?? ''] ?? h.status)) continue;
        const to = /(?:^|\s)to=(\S+)/.exec(h.delegate)?.[1];
        if (!to) continue;
        const who = /[@:]/.test(to) ? [to] : Object.keys(reg.agents ?? {}).filter((a) => reg.agents[a]?.roles?.includes(to)); // a role: every executor that holds it
        const texts = who.map((a) => pathFinding(reg, a, h.env));
        if (who.length && texts.every(Boolean)) findings.push({ level: 'warning', file: c.name, text: `delegation to ${to}: ${who.length > 1 ? `no executor with this role can reach ${h.env}; ${texts[0]}` : texts[0]}` });
      }
      return { findings };
    },
    /** `tick`: the environment and the way to it for RUN (routine.access) and TAKE (delegate.env, delegate.access), only for a described remote-access environment. */
    'tick-before'({ agent, env, items, boardDirs, api }) {
      const reg = tryRegistry(api, env);
      if (!reg?.environments || !Object.keys(reg.environments).length) return {};
      const run = {};
      const take = {};
      const boards = {};
      for (const i of items) {
        const k = `${i.project}/${i.id}`;
        if (i.kind === 'RUN') { const a = accessOf(reg, agent, i.routine?.env); if (a) run[k] = { access: a }; }
        else if (i.kind === 'TAKE') {
          try {
            boards[i.project] ??= api.loadBoard(boardDirs[i.project]);
            const name = boards[i.project].cards.find((c) => c.header.id === i.id)?.header.env;
            const a = accessOf(reg, agent, name);
            if (a) take[k] = { env: name, access: a };
          } catch { /* a board that cannot be read adds nothing */ }
        }
      }
      return { run, take };
    },
    'routine-show'({ routine, env, api }) {
      const reg = tryRegistry(api, env);
      const h = routine.header;
      const e = reg?.environments && h.env && h.agent ? envPath(reg, machineOf(h.agent, reg), h.env) : null;
      if (!e?.described) return {};
      const how = e.via === 'ssh' ? `ssh ${e.ssh}${e.mcp.length ? `, mcp ${e.mcp.join('+')} declared (not checked)` : ''}` : e.via === 'local' ? 'on the executor\'s own machine' : 'NO ACCESS PATH from the executor\'s machine';
      return { lines: [`environment: ${h.env} on ${e.machine}, placement ${e.placement}, executor machine ${e.from || '-'}: ${how}`] };
    },
  },
  commands: {
    env: {
      group: 'Look', effect: 'read', hidden: true, summary: 'is a work environment reachable from the executor\'s machine (ssh, read only)',
      purpose: 'Checks one environment of the registry (environments) before a model starts: from this executor\'s machine the environment is on the same machine (reachable), reached by an access path with `ssh -o BatchMode=yes -o ConnectTimeout=5 HOST true` (placement remote-access), or has no path (unreachable). `--as AGENT` or `--from MACHINE` names the executor\'s machine (not needed when the environment has one access path). The host name must look like a host name (letters, digits and . _ @ : -, not starting with "-"): a registry cannot slip an ssh option in, and such a name is refused without starting ssh. `supervise` runs this check before the model and records `skipped: unreachable` instead of starting it. MCP servers named in the registry are shown as declared, never as checked.',
      usage: ['roadctl env check ENV [--as AGENT | --from MACHINE] [--json]'],
      flags: [['--as AGENT', 'the executor whose machine reaches the environment'], ['--from MACHINE', 'the executor\'s machine by name'], ['--json', 'machine-readable output']],
      examples: ['roadctl env check Work-notebook-wsl --as claude-code@home-wsl', 'roadctl env check Work-notebook-wsl --from home-wsl --json'],
      changes: 'Nothing (it starts ssh with the harmless command true).', exits: '0 reachable; 1 unreachable; 2 usage error, or the environment is not in the registry',
      run: envCommand,
    },
    candidates: {
      group: 'Look', effect: 'read', hidden: true, summary: 'the ordered executors for a task and why the others are refused (read only)',
      purpose: 'One read-only choice of an executor for a card (its header keys `env`, `role`, `needs`; the role also from `delegate to=<role>`) or for the values given by flags. It walks the owner\'s list `preference.<role>` of the registry (the first is the main one, the rest the agreed reserve; without a list, every agent with the role) and shows for each: the owner\'s permission (not in the list: not a candidate), the role, the fitness confirmed by checks of similar tasks (`agents.NAME.fit.ROLE.confirmed`), the tools and data (`agents.NAME.tools`, `data`; an MCP server counts when declared in the agent or in the access path of the environment, ssh alone is not MCP), the access path to the environment, availability (`env check`), and the executor\'s own limits with its reserve (an unknown limit is a refusal, not a guess; a paid API needs an agreed `budget`). It never changes the environment, the rights, the data access or the budget, never learns and never picks a model by the size of the task. The first eligible agent is `chosen`; none means exit 1: no launch. A declared MCP path is not proof that the server works now.',
      usage: ['roadctl candidates --card ID [--multiagent] [--json]', 'roadctl candidates --env NAME [--role ROLE] [--needs a,b,data:x] [--multiagent] [--json]'],
      flags: [['--card ID', 'take env, role and needs from this card'], ['--env NAME', 'the environment the task works in'], ['--role ROLE', 'the role the task needs'], ['--needs LIST', 'comma-separated tools or MCP servers; data:NAME for data access'], ['--multiagent', 'advisory: static checks only; no availability or limits probes, no executor chosen'], ['--json', 'machine-readable output']],
      examples: ['roadctl candidates --card P5.23', 'roadctl candidates --env Work-notebook-wsl --role worker --needs atom-services,data:atom --json'],
      changes: 'Nothing (it may start ssh with the harmless command true and ask the executor\'s limits, as `limits --check` does).', exits: '0 a candidate is chosen; 1 no candidate, or the registry has problems; 2 usage error, no registry, or no board or card',
      run: candidatesCommand,
    },
  },
};
