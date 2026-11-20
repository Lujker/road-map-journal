// P5.23: the environment apart from the executor's machine (module environment.mjs) and the choice of an executor.
// No model, no network: ssh is a fake of scripts/testkit. Run: node --test scripts/roadctl/environment.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAKES_SKIP, installFakes, readCalls } from '../testkit/fakes.mjs';
import { tickJsonProblems } from '../testkit/tick-schema.mjs';
import { clock, T0 } from '../testkit/time.mjs';
import { envPath, environmentGate, probeSsh, registryProblems, selectCandidates } from './environment.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(scripts, 'roadctl.mjs');
const EXAMPLE_BOARD = path.join(scripts, '..', 'examples', 'board-example', 'board');
const ME = 'claude-code@home-wsl';
const REG = {
  version: 1,
  roles: { worker: {} },
  agents: { [ME]: { host: 'claude-code', roles: ['worker'], tools: ['atom-services'], data: ['atom'], fit: { worker: { confirmed: '2026-11-10' } } } },
  environments: { 'Work-notebook': { machine: 'work-notebook', placement: 'remote-access', access: [{ from: 'home-wsl', ssh: 'work-notebook', mcp: ['atom-services'] }] } },
};

function rig(registry = REG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-env-'));
  const ws = path.join(dir, 'agent-workspace');
  const board = path.join(ws, 'projects', 'my-app', 'board');
  fs.cpSync(EXAMPLE_BOARD, board, { recursive: true });
  const cfg = path.join(board, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), requires: '0.6.0' }));
  const bin = installFakes(path.join(dir, 'bin'));
  const reg = path.join(dir, 'registry.json');
  if (registry) fs.writeFileSync(reg, JSON.stringify(registry));
  const log = path.join(dir, 'calls.jsonl');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'config'), ROADCTL_WORKSPACE: ws, ROADCTL_REGISTRY: reg, ROADCTL_DATE: '2026-11-10', ...clock(T0), FAKE_LOG: log };
  delete env.FAKE_MODE;
  const run = (args, over = {}) => spawnSync(process.execPath, [SELF, ...args], { cwd: ws, encoding: 'utf8', env: { ...env, ...over } });
  const ok = (args) => { const r = run(args); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`); return r; };
  const routine = (id, envName, agent = ME) => {
    ok(['routine', 'new', id, `Routine ${id}`, '--agent', agent, '--model', 'haiku', '--env', envName, '--every', '2h', '--board', board]);
    ok(['routine', 'on', id, '--by', 'Owner', '--source', 'chat 2026-11-12', '--board', board]);
    ok(['autonomy', 'routines', 'on', '--by', 'Owner', '--board', board]);
  };
  return { dir, board, run, ok, routine, log, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const withRig = (fn, registry) => () => { const r = rig(registry); try { fn(r); } finally { r.cleanup(); } };

test('P5.23 a7: a host name from the registry that looks like an ssh option is refused, ssh is never started', () => {
  let started = 0;
  const spawn = () => { started++; return { status: 0 }; };
  for (const h of ['-oProxyCommand=evil', '-J x', 'a b', '', 'a;b', undefined]) assert.equal(probeSsh(h, { spawn }).ok, false, String(h));
  assert.equal(started, 0);
  assert.equal(probeSsh('work-notebook', { spawn }).ok, true);
  const bad = registryProblems({ environments: { E: { placement: 'remote-access', access: [{ from: 'a', ssh: '-oProxyCommand=x' }] } } });
  assert.match(bad.join('\n'), /not a host name/);
});

test('P5.23 a1: a registry without environments behaves as before: no gate, no access in tick, no problems', FAKES_SKIP, withRig((r) => {
  r.routine('mr-status', 'laptop');
  assert.equal(environmentGate({ loadRegistry: () => ({ agents: {}, environments: {} }) }, {}, { routines: [{ header: { id: 'x', env: 'laptop' } }] }, { kind: 'routine', id: 'x' }, ME), null);
  const t = JSON.parse(r.ok(['tick', '--as', ME, '--routine', 'mr-status', '--json']).stdout);
  assert.deepEqual(tickJsonProblems(t), []);
  assert.equal(t.items[0].routine.access, undefined);
  assert.deepEqual(registryProblems({ agents: {} }), []);
}, { version: 1, roles: { worker: {} }, agents: { [ME]: { host: 'claude-code', roles: ['worker'] } } }));

test('P5.23 a2: with placement remote-access RUN carries the environment and the way to it; routine show says it; the tick schema accepts it', FAKES_SKIP, withRig((r) => {
  r.routine('mr-status', 'Work-notebook');
  const t = JSON.parse(r.ok(['tick', '--as', ME, '--routine', 'mr-status', '--json']).stdout);
  assert.deepEqual(tickJsonProblems(t), []);
  assert.deepEqual(t.items[0].routine.access, { placement: 'remote-access', via: 'ssh', machine: 'work-notebook', ssh: 'work-notebook', mcp: ['atom-services'] });
  assert.match(r.ok(['tick', '--as', ME, '--routine', 'mr-status']).stdout, /env Work-notebook, remote-access: ssh work-notebook, mcp atom-services declared/);
  assert.match(r.ok(['routine', 'show', 'mr-status', '--board', r.board]).stdout, /environment: Work-notebook on work-notebook, placement remote-access, executor machine home-wsl: ssh work-notebook, mcp atom-services declared \(not checked\)/);
}));

test('P5.23 a3: lint warns about no access path and about remote-access on the environment\'s own machine', FAKES_SKIP, withRig((r) => {
  r.routine('no-path', 'Work-notebook', 'claude-code@elsewhere');
  const w = (id) => JSON.parse(r.run(['lint', '--board', r.board, '--json']).stdout).filter((x) => x.rule === 32 && x.card === `routines/${id}.md`);
  assert.match(JSON.stringify(w('no-path')), /no access path/);
  assert.match(JSON.stringify(w('no-path')), /module environment/);
  r.routine('own', 'Work-notebook', 'claude-code@work-notebook');
  assert.match(JSON.stringify(w('own')), /remote-access, but .* runs on its own machine/);
  r.routine('fine', 'Work-notebook');
  assert.equal(w('fine').length, 0);
}));

test('P5.23 a6: env check says unreachable when ssh fails; supervise records skipped: unreachable and the model does not start', FAKES_SKIP, withRig((r) => {
  const crash = { FAKE_SSH_MODE: 'crash' };
  const c = r.run(['env', 'check', 'Work-notebook', '--as', ME, '--json'], crash);
  assert.equal(c.status, 1);
  assert.equal(JSON.parse(c.stdout).state, 'unreachable');
  assert.deepEqual(readCalls(r.log, 'ssh')[0].argv, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', 'work-notebook', 'true']);
  assert.equal(r.run(['env', 'check', 'Work-notebook', '--as', ME], {}).status, 0);
  r.routine('mr-status', 'Work-notebook');
  const marker = path.join(r.dir, 'model-started');
  const s = r.run(['supervise', '--routine', 'mr-status', '--as', ME, '--board', r.board, '--', 'sh', '-c', `touch ${marker}`], crash);
  assert.equal(s.status, 4, s.stderr + s.stdout);
  assert.match(s.stdout + s.stderr, /skipped: unreachable/);
  assert.equal(fs.existsSync(marker), false);
  const runs = JSON.parse(r.run(['runs', '--json', '-n', '10']).stdout || '[]');
  assert.ok(runs.some((x) => x.outcome === 'skipped' && x.reason === 'unreachable'), JSON.stringify(runs));
  // P5.4 a4: the skipped:unreachable starts the term of `every` (2h) again, so the tick is not a retry loop; the skip is not lost
  const sup = (over) => r.run(['supervise', '--routine', 'mr-status', '--as', ME, '--board', r.board, '--', 'sh', '-c', `touch ${marker}`], over);
  const again = sup({});
  assert.equal(again.status, 4, 'right after the skip the routine is not due: reachable or not, nothing starts');
  assert.match(again.stderr + again.stdout, /not due/);
  assert.equal(fs.existsSync(marker), false);
  const later = (minutes) => clock(new Date(Date.parse(T0) + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const second = sup({ ...later(121), ...crash });
  assert.equal(second.status, 4, 'a term later it is due again and the environment is still unreachable: skipped again');
  assert.match(second.stdout + second.stderr, /skipped: unreachable/);
  assert.equal(JSON.parse(r.run(['runs', '--json', '-n', '10']).stdout || '[]').filter((x) => x.outcome === 'skipped' && x.reason === 'unreachable').length >= 1, true);
  assert.equal(sup(later(242)).status, 1, 'a term after that the environment is reachable: the command runs (it reports no result, so: failed)');
  assert.equal(fs.existsSync(marker), true);
}));

// ---------------------------------------------------------------- candidates

test('multiagent advisory is read-only and preserves role, needs and preference order', withRig((r) => {
  const before = fs.readFileSync(path.join(r.dir, 'registry.json'), 'utf8');
  const result = JSON.parse(r.ok(['candidates', '--env', 'Work-notebook', '--role', 'worker', '--needs', 'atom-services,data:atom', '--multiagent', '--json']).stdout);
  assert.equal(result.role, 'worker');
  assert.deepEqual(result.needs, ['atom-services', 'data:atom']);
  assert.deepEqual(result.preferences.map((p) => p.agent), [ME, 'codex@home-wsl']);
  assert.equal(result.preferences[0].provider, 'claude');
  assert.equal(result.preferences[0].model, 'sonnet');
  assert.equal(result.preferences[0].eligible, false);
  assert.match(result.preferences[0].reasons.join(' '), /limits unknown/);
  assert.equal(result.preferences[1].provider, 'codex');
  assert.equal(result.preferences[1].model, 'gpt-5.5');
  assert.match(result.preferences[1].reasons.join(' '), /fitness.*not confirmed/);
  assert.match(result.advisory, /No launch or spending is authorized/);
  assert.equal(fs.readFileSync(path.join(r.dir, 'registry.json'), 'utf8'), before);
  assert.deepEqual(readCalls(r.log, 'ssh'), []);
}, { ...REG, roles: { worker: { 'claude-code': 'sonnet', codex: 'gpt-5.5' } }, agents: { ...REG.agents, 'codex@home-wsl': { host: 'codex', roles: ['worker'] } }, preference: { worker: [ME, 'codex@home-wsl'] } }));

test('multiagent reports real example registry mappings and rejects scripts and missing requirements without probes', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(scripts, '..', 'examples', 'agents-registry.example.json'), 'utf8'));
  registry.preference = { worker: ['claude-code@home-wsl', 'codex@home-wsl', 'hermes@windows', 'cron:hermes-nightly@windows'] };
  const r = rig(registry);
  try {
    const result = JSON.parse(r.ok(['candidates', '--env', 'anywhere', '--role', 'worker', '--needs', 'missing,data:secret', '--multiagent', '--json']).stdout);
    assert.deepEqual(result.preferences.map(({ provider, model }) => [provider, model]), [['claude', 'sonnet'], ['codex', 'gpt-5.5'], ['kimi', null], [null, null]]);
    assert.ok(result.preferences.every((p) => p.eligible === false && p.reasons.length));
    assert.match(result.preferences[0].reasons.join(' '), /missing tool missing/);
    assert.match(result.preferences[0].reasons.join(' '), /no access to data secret/);
    assert.match(result.preferences[3].reasons.join(' '), /script is not an executor/);
    assert.deepEqual(readCalls(r.log, 'ssh'), []);
  } finally { r.cleanup(); }
});

const reach = (map = {}) => async (a) => map[a] ?? { state: 'reachable' };
const lim = (map = {}) => async (a) => map[a] ?? { verdict: 'allowed', message: '' };
const reg2 = (over = {}) => ({
  ...REG,
  agents: { ...REG.agents, 'codex@home-wsl': { host: 'codex', roles: ['worker'], tools: ['atom-services'], data: ['atom'], fit: { worker: { confirmed: '2026-11-01' } } }, 'codex@elsewhere': { roles: ['worker'], fit: { worker: { confirmed: 'x' } } } },
  preference: { worker: [ME, 'codex@home-wsl'] }, ...over,
});
const need = { env: 'Work-notebook', role: 'worker', needs: ['atom-services', 'data:atom'] };

test('P5.23 a8: candidates table: main, then reserve; refusals: tool, data, unreachable, reserve reached, limit unknown; none means no launch', async () => {
  let r = await selectCandidates(reg2(), need, { reach: reach(), limits: lim() });
  assert.equal(r.chosen, ME);
  assert.deepEqual(r.candidates.map((c) => c.rank), ['main', 'reserve']);
  r = await selectCandidates(reg2(), { ...need, needs: ['other-tool'] }, { reach: reach(), limits: lim() });
  assert.equal(r.chosen, null);
  assert.match(r.candidates[0].reasons.join(), /missing tool other-tool/);
  r = await selectCandidates(reg2(), { ...need, needs: ['data:secret'] }, { reach: reach(), limits: lim() });
  assert.match(r.candidates[0].reasons.join(), /no access to data secret/);
  r = await selectCandidates(reg2(), need, { reach: reach({ [ME]: { state: 'unreachable', why: 'ssh failed' } }), limits: lim() });
  assert.match(r.candidates[0].reasons.join(), /unavailable: ssh failed/);
  r = await selectCandidates(reg2(), need, { reach: reach(), limits: lim({ [ME]: { verdict: 'reserve', message: '5h 90%' } }) });
  assert.match(r.candidates[0].reasons.join(), /reserve reached/);
  assert.equal(r.chosen, 'codex@home-wsl');
  r = await selectCandidates(reg2(), need, { reach: reach(), limits: lim({ [ME]: { verdict: 'unknown', message: 'no data' }, 'codex@home-wsl': { verdict: 'unknown', message: 'no data' } }) });
  assert.equal(r.chosen, null);
  assert.match(r.candidates[0].reasons.join(), /limits unknown/);
});

test('P5.23 a9: the next permitted agent is taken before the start; an agent outside the list or without fitness, access or budget is never adapted; limits are asked per executor', async () => {
  const asked = [];
  const r = await selectCandidates(reg2(), need, { reach: reach(), limits: async (a) => { asked.push(a); return { verdict: a === ME ? 'reserve' : 'allowed', message: '' }; } });
  assert.deepEqual(asked, [ME, 'codex@home-wsl']);
  assert.equal(r.chosen, 'codex@home-wsl');
  assert.ok(!r.candidates.some((c) => c.agent === 'codex@elsewhere'), 'not in the owner\'s list: not a candidate');
  let x = await selectCandidates(reg2({ preference: { worker: ['codex@elsewhere'] } }), need, { reach: reach(), limits: lim() });
  assert.equal(x.chosen, null); // no path from its machine, no tools, and nothing is probed
  assert.match(x.candidates[0].reasons.join(), /no access to the environment/);
  x = await selectCandidates(reg2(), need, { reach: reach(), limits: lim({ [ME]: { verdict: 'allowed', api: true }, 'codex@home-wsl': { verdict: 'allowed', api: true } }) });
  assert.equal(x.chosen, null);
  assert.match(x.candidates[0].reasons.join(), /no agreed budget/);
  const unfit = reg2(); delete unfit.agents[ME].fit;
  assert.match((await selectCandidates(unfit, need, { reach: reach(), limits: lim() })).candidates[0].reasons.join(), /fitness for worker is not confirmed/);
  assert.equal(envPath(REG, 'home-wsl', 'Work-notebook').via, 'ssh');
});
