// P5.41 a10 (slice 3): roadctl orchestrator form|sync|status and the replacement of `candidates` for a closed limit. No model, no network, no provider is asked:
// the limits come from the cache of P5.17. Run: node --test scripts/roadctl/orchestrator.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { clock, shift, T0 } from '../testkit/time.mjs';
import { compareEntry, compareReport, formOf, mergeCache, profileAgreed, syncState } from './orchestrator.mjs';
import { replacementFor, selectCandidates } from './environment.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, '..', 'roadctl.mjs');
const ME = 'claude-code@home-wsl';
const CODEX = 'codex@home-wsl';
const PI = 'pi-worker@home-wsl';
const OID = 'openbot@home-wsl';

const REG = {
  version: 1,
  roles: { worker: {} },
  agents: {
    [ME]: { host: 'claude-code', roles: ['worker'], fit: { worker: { confirmed: '2026-11-01' } } },
    [CODEX]: { host: 'codex', roles: ['worker'], fit: { worker: { confirmed: '2026-11-01' } } },
    [PI]: { host: 'pi', roles: ['worker'], fit: { worker: { confirmed: '2026-11-01' } } },
  },
  preference: { worker: [ME] },
  agent_profiles: {
    'claude-developer': { executor: ME, model: 'sonnet', openbot: { name: 'claude-developer', id: 'id-claude' } },
    'codex-developer': { executor: CODEX, model: 'gpt-5', openbot: { name: 'codex-developer', id: 'id-codex' } },
    'pi-developer': { executor: PI, model: 'pro', openbot: { name: 'pi-developer', id: 'id-pi' }, openbot_variants: [{ name: 'pi-developer-small', id: 'id-pi-small', model: 'flash' }] },
  },
};
const FULL = () => ({ form: 1, orchestrator: OID, agents: [
  { profile: 'claude-developer', name: 'claude-developer', id: 'id-claude', model: 'Claude Sonnet 5.5', available: true },
  { profile: 'codex-developer', name: 'codex-developer', id: 'id-codex', model: 'gpt-5.5', available: true },
  { profile: 'pi-developer', name: 'pi-developer', id: 'id-pi', model: 'Pro', available: true },
] });

function rig(registry = REG) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-orch-'));
  const reg = path.join(root, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify(registry));
  const env = { ...process.env, HOME: root, XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'cfg'), ROADCTL_REGISTRY: reg, ROADCTL_DATE: '2026-11-20', ...clock(T0) };
  delete env.ROADCTL_ORCHESTRATOR;
  const run = (args, { input, over } = {}) => spawnSync(process.execPath, [SELF, ...args], { cwd: root, encoding: 'utf8', input, env: { ...env, ...over } });
  const sync = (data, over = {}) => run(['orchestrator', 'sync', '--orchestrator', OID, '--json'], { input: JSON.stringify(data), over });
  const cacheFile = path.join(root, 'state', 'road-map-journal', `orchestrator-${OID}.json`);
  /** The limits cache of P5.17: claude closed until a time ahead, codex with plenty left. */
  const limits = ({ claudeClosed = true, at = 0 } = {}) => {
    const dir = path.join(root, 'cache', 'road-map-journal');
    fs.mkdirSync(dir, { recursive: true });
    const win = (used, resets) => [{ name: 'five_hour', used_percent: used, resets_at: resets }, { name: 'seven_day', used_percent: 30, resets_at: shift(60 * 24 * 3 + at) }];
    const entry = (provider, windows, extra = {}) => ({ provider, kind: 'subscription', state: 'known', measured_at: shift(at), source: 'synthetic', windows, reserve: { five_hour: 10, seven_day: 10 }, ...extra });
    fs.writeFileSync(path.join(dir, 'limits.json'), JSON.stringify({ version: 1, providers: {
      claude: claudeClosed ? entry('claude', win(97, shift(at + 180)), { closed_until: shift(at + 180) }) : entry('claude', win(20, shift(at + 180))),
      codex: entry('codex', win(20, shift(at + 180))),
    } }));
  };
  return { root, reg, env, run, sync, cacheFile, limits, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const json = (r) => JSON.parse(r.stdout);

test('P5.21 a8: checked proposal, eligible reserve, delegated report and review via CLI', () => {
  const r = rig({ ...REG, preference: { worker: [ME, CODEX] } });
  try {
    const board = path.join(r.root, 'board');
    fs.cpSync(path.join(here, '..', '..', 'examples', 'board-example', 'board'), board, { recursive: true });
    const config = path.join(board, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), requires: '0.13.0' }));
    const proposal = path.join(r.root, 'proposal.json');
    fs.writeFileSync(proposal, JSON.stringify({ plan: 1, cards: [{ key: 'c1', title: 'CSV export', goal: 'Export rows', criteria: [{ id: 'a2', text: 'UTF-8 BOM', check: 'test: csv' }], kind: 'fix', size: 'S', env: 'home-wsl', role: 'worker', effects: 'local files', stop_conditions: 'stop on failure', roadmap: 'P5.21' }] }));
    const check = r.run(['plan', 'check', proposal, '--board', board, '--json']);
    assert.equal(check.status, 0, check.stderr);
    assert.equal(json(check).cards[0].result, 'proposed', 'a proposal grants no permission');
    r.limits();
    const candidate = r.run(['candidates', '--env', 'home-wsl', '--role', 'worker', '--json']);
    assert.equal(candidate.status, 0, candidate.stderr);
    assert.equal(json(candidate).chosen, CODEX);
    const noResource = r.run(['candidates', '--env', 'home-wsl', '--role', 'worker', '--needs', 'missing-tool', '--json']);
    assert.equal(noResource.status, 1);
    assert.equal(json(noResource).chosen, null);
    const limitsFile = path.join(r.root, 'cache', 'road-map-journal', 'limits.json');
    const limits = JSON.parse(fs.readFileSync(limitsFile, 'utf8'));
    delete limits.providers.codex;
    fs.writeFileSync(limitsFile, JSON.stringify(limits));
    const unknown = r.run(['candidates', '--env', 'home-wsl', '--role', 'worker', '--json'], { over: { PATH: '' } });
    assert.equal(unknown.status, 1);
    assert.equal(json(unknown).chosen, null);
    assert.match(json(unknown).candidates.find((x) => x.agent === CODEX).reasons.join(), /limits unknown/);
    // Materializing and approving the checked proposal is a separate manual step; plan check applies nothing.
    const call = (...args) => r.run([...args, '--board', board]);
    const proposed = JSON.parse(fs.readFileSync(proposal, 'utf8')).cards[0];
    assert.equal(call('new', 'P-1', proposed.title).status, 0);
    const file = path.join(board, 'cards', fs.readdirSync(path.join(board, 'cards')).find((x) => x.startsWith('P-1-')));
    let card = fs.readFileSync(file, 'utf8');
    card = card.replace(/(## Goal\n)[\s\S]*?(?=\n## )/, `$1${proposed.goal}\n`)
      .replace(/- \[ \] a1:.*$/m, `- [ ] ${proposed.criteria[0].id}: ${proposed.criteria[0].text}`);
    fs.writeFileSync(file, card);
    assert.match(card, new RegExp(`title: ${proposed.title}`));
    assert.match(card, new RegExp(`- \\[ \\] ${proposed.criteria[0].id}: ${proposed.criteria[0].text}`));
    const approve = call('approve', 'P-1', '--by', 'Owner', '--scope', 'implementation', '--source', 'test decision');
    assert.equal(approve.status, 0, approve.stderr);
    const delegate = call('delegate', 'P-1', '--to', json(candidate).chosen, '--criteria', 'a2', '--by', ME);
    assert.equal(delegate.status, 0, delegate.stderr);
    const claim = call('claim', 'P-1', '--as', CODEX);
    assert.equal(claim.status, 0, claim.stderr);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- [ ] a2:', '- [x] a2:') + '\n## Evidence\n- a2: stub CSV check passed\n');
    const report = call('report', 'P-1', '--as', CODEX, 'stub CSV check passed');
    assert.equal(report.status, 0, report.stderr);
    const accept = call('accept', 'P-1', '--as', ME);
    assert.equal(accept.status, 0, accept.stderr);
    assert.match(fs.readFileSync(file, 'utf8'), /REPORT: stub CSV check passed/);
    // An external effect is escalated explicitly by the worker; plan check does not classify free text.
    const unsafe = { ...proposed, key: 'c2', title: 'Delete remote data', goal: 'Delete remote data', effects: 'delete external data' };
    fs.writeFileSync(proposal, JSON.stringify({ plan: 1, cards: [unsafe] }));
    assert.equal(json(r.run(['plan', 'check', proposal, '--board', board, '--json'])).cards[0].result, 'proposed');
    assert.equal(call('new', 'P-2', unsafe.title).status, 0);
    assert.equal(call('approve', 'P-2', '--by', 'Owner', '--scope', 'implementation', '--source', 'test decision').status, 0);
    assert.equal(call('delegate', 'P-2', '--to', CODEX, '--by', ME).status, 0);
    assert.equal(call('claim', 'P-2', '--as', CODEX).status, 0);
    const ask = r.run(['ask', 'P-2', '--as', CODEX, '--board', board], { input: JSON.stringify({ question: { id: 'external', kind: 'confirm', prompt: 'Delete remote data?', reason: 'outside-mandate', scope: ['external'] }, checkpoint: { did: 'no external changes', next: 'wait for owner', in_flight: 'none' } }) });
    assert.equal(ask.status, 0, ask.stderr);
    const unsafeFile = path.join(board, 'cards', fs.readdirSync(path.join(board, 'cards')).find((x) => x.startsWith('P-2-')));
    assert.match(fs.readFileSync(unsafeFile, 'utf8'), /^status: blocked$/m);
    assert.notEqual(call('report', 'P-2', '--as', CODEX, 'done').status, 0);
  } finally { r.cleanup(); }
});

test('P5.41 a10: form: per profile what is expected and empty fields to fill; the id is required and checked', () => {
  const r = rig();
  try {
    const f = json(r.run(['orchestrator', 'form', '--orchestrator', OID]));
    assert.equal(f.form, 1);
    assert.equal(f.orchestrator, OID);
    assert.deepEqual(f.agents.map((a) => a.profile), ['claude-developer', 'codex-developer', 'pi-developer']);
    assert.deepEqual(f.agents[2].expect, { executor: PI, model: 'pro', name: 'pi-developer', variants: ['pi-developer-small'] });
    for (const a of f.agents) assert.deepEqual([a.name, a.id, a.model, a.available], [null, null, null, null]);
    assert.deepEqual(f.state.sync, 'none');
    assert.match(f.fill, /roadctl never changes the registry/);
    assert.equal(r.run(['orchestrator', 'form']).status, 2, 'no id');
    assert.match(r.run(['orchestrator', 'form']).stderr, /no orchestrator id/);
    assert.equal(r.run(['orchestrator', 'form', '--orchestrator', 'no at sign']).status, 2);
    assert.equal(r.run(['orchestrator', 'form'], { over: { ROADCTL_ORCHESTRATOR: OID } }).status, 0, 'ROADCTL_ORCHESTRATOR does the same');
    assert.equal(spawnSync(process.execPath, [SELF, 'orchestrator', 'form', '--orchestrator', OID], { env: { ...r.env, ROADCTL_REGISTRY: path.join(r.root, 'none.json') }, encoding: 'utf8' }).status, 2, 'no registry');
  } finally { r.cleanup(); }
});

test('P5.41 a10: sync answers ok, unknown or mismatch for each entry; mismatch exits 1', () => {
  const r = rig();
  try {
    const ok = r.sync(FULL());
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    const j = json(ok);
    assert.deepEqual(j.results.map((x) => [x.profile, x.status]), [['claude-developer', 'ok'], ['codex-developer', 'ok'], ['pi-developer', 'ok']]);
    assert.deepEqual(j.summary, { ok: 3, unknown: 0, mismatch: 0 });
    assert.equal(j.state.sync, 'ok');
    // a variant is the profile's agent: its own name, id and model are right
    const variant = FULL(); variant.agents[2] = { profile: 'pi-developer', name: 'pi-developer-small', id: 'id-pi-small', model: 'Flash', available: true };
    assert.equal(json(r.sync(variant)).results[2].status, 'ok');
    // unknown: a profile or a name the registry has not heard of
    const unk = r.sync({ form: 1, orchestrator: OID, agents: [{ profile: 'ghost-developer', name: 'ghost' }, { name: 'stranger' }], extra: [{ name: 'side-agent' }] });
    assert.equal(unk.status, 0, 'unknown is shown, not a failure');
    const u = json(unk);
    assert.deepEqual(u.results.map((x) => x.status), ['unknown', 'unknown', 'unknown']);
    assert.match(u.results[0].reasons[0], /profile ghost-developer is not in the registry/);
    // mismatch: name, id and model differ
    const bad = FULL();
    bad.agents[0].name = 'someone-else';
    bad.agents[1].id = 'wrong-id';
    bad.agents[2].model = 'Flash';
    const m = r.sync(bad);
    assert.equal(m.status, 1, 'a mismatch exits 1');
    const mj = json(m);
    assert.deepEqual(mj.results.map((x) => x.status), ['mismatch', 'mismatch', 'mismatch']);
    assert.match(mj.results[0].reasons.join(), /name someone-else is not an agent of profile claude-developer/);
    assert.match(mj.results[1].reasons.join(), /id wrong-id differs/);
    assert.match(mj.results[2].reasons.join(), /model Flash differs from pro/);
    assert.equal(mj.state.sync, 'mismatch');
    // the text form says it too
    const txt = r.run(['orchestrator', 'sync', '--orchestrator', OID], { input: JSON.stringify(FULL()) });
    assert.match(txt.stdout, /^claude-developer: ok$/m);
    assert.match(txt.stdout, /ok 3, unknown 0, mismatch 0, not reported 0$/m);
    assert.equal(r.run(['orchestrator', 'sync', '--orchestrator', OID], { input: 'not json' }).status, 2);
    assert.equal(r.run(['orchestrator', 'sync', '--orchestrator', 'other@home-wsl'], { input: JSON.stringify(FULL()) }).status, 2, 'a form of another orchestrator');
  } finally { r.cleanup(); }
});

test('P5.41 a10: the reconciliation is kept per orchestrator id with its age; older than 24 h is a warning, never a block', () => {
  const r = rig();
  try {
    assert.equal(json(r.run(['orchestrator', 'status', '--orchestrator', OID, '--json'])).sync, 'none');
    r.sync(FULL());
    assert.ok(fs.existsSync(r.cacheFile), 'in the state directory, named by the id');
    assert.equal(fs.statSync(r.cacheFile).mode & 0o777, 0o600);
    const at = (h) => clock(shift(h * 60));
    const fresh = json(r.run(['orchestrator', 'status', '--orchestrator', OID, '--json'], { over: at(5) }));
    assert.deepEqual([fresh.sync, fresh.age_hours], ['ok', 5]);
    const old = r.run(['orchestrator', 'status', '--orchestrator', OID], { over: at(25) });
    assert.equal(old.status, 0, 'stale does not fail');
    assert.match(old.stdout, /orchestrator openbot@home-wsl: stale, reconciled 25 h ago; the last reconciliation is 25 h old \(limit 24 h\)/);
    // the limit is the registry's
    const wide = rig({ ...REG, orchestrator_sync: { stale_hours: 48 } });
    try { wide.sync(FULL()); assert.equal(json(wide.run(['orchestrator', 'status', '--orchestrator', OID, '--json'], { over: clock(shift(60 * 30)) })).sync, 'ok'); } finally { wide.cleanup(); }
    // another orchestrator has its own cache
    assert.equal(json(r.run(['orchestrator', 'status', '--orchestrator', 'hermes@home-wsl', '--json'])).sync, 'none');
    assert.equal(syncState(null, 0).sync, 'none');
  } finally { r.cleanup(); }
});

test('P5.41 a10: an incomplete list deletes nothing, an unknown name creates nothing, no right is widened: the registry is byte-identical after every sync', () => {
  const r = rig();
  try {
    const sha = () => crypto.createHash('sha256').update(fs.readFileSync(r.reg)).digest('hex');
    const before = sha();
    r.sync(FULL());
    const first = JSON.parse(fs.readFileSync(r.cacheFile, 'utf8'));
    // a short list: only one agent; the others are `not reported` and keep what the cache had
    const short = r.sync({ form: 1, orchestrator: OID, agents: [{ profile: 'claude-developer', name: 'claude-developer', id: 'id-claude', model: 'sonnet', available: false }] }, clock(shift(60)));
    const sj = json(short);
    assert.deepEqual(sj.not_reported, ['codex-developer', 'pi-developer']);
    assert.deepEqual(sj.kept, ['codex-developer', 'pi-developer']);
    const second = JSON.parse(fs.readFileSync(r.cacheFile, 'utf8'));
    assert.deepEqual(second.agents['codex-developer'], first.agents['codex-developer'], 'kept as it was, with its own seen_at');
    assert.deepEqual(second.agents['pi-developer'], first.agents['pi-developer']);
    assert.equal(second.agents['claude-developer'].available, false);
    assert.equal(Date.parse(second.synced_at), Date.parse(shift(60)));
    // names the registry does not know, extra rights claimed by an entry: cached as unknown names, never as a profile or a link; the rights fields are ignored
    r.sync({ form: 1, orchestrator: OID, agents: [{ profile: 'claude-developer', name: 'claude-developer', roles: ['accept', 'orchestrator'], can_accept: true, may_delegate_to: ['everyone'], executor: 'evil@elsewhere' }, { profile: 'new-profile', name: 'new-one', executor: 'new@elsewhere', roles: ['worker'] }], extra: [{ name: 'extra-agent', executor: 'x@y' }] });
    const third = JSON.parse(fs.readFileSync(r.cacheFile, 'utf8'));
    assert.deepEqual(Object.keys(third.agents).sort(), ['claude-developer', 'codex-developer', 'pi-developer'], 'no new profile');
    assert.deepEqual(third.unknown, ['new-one', 'extra-agent']);
    assert.equal(JSON.stringify(third).includes('evil@elsewhere'), false);
    assert.equal(JSON.stringify(third).includes('accept'), false);
    assert.equal(sha(), before, 'the registry never changes');
    assert.equal(json(r.run(['orchestrator', 'status', '--orchestrator', OID, '--json'])).unknown.length, 2);
  } finally { r.cleanup(); }
});

test('P5.41 a10: the pure steps: entry by name, variants, models in both directions, merge keeps the old', () => {
  assert.equal(compareEntry({ name: 'pi-developer-small' }, REG).profile, 'pi-developer', 'a variant name finds its profile');
  assert.equal(compareEntry({ profile: 'pi-developer', model: 'PRO tier' }, REG).status, 'ok');
  assert.equal(compareEntry({ profile: 'pi-developer', name: 'pi-developer-small', model: 'pro' }, REG).status, 'mismatch', 'the variant has its own model');
  assert.equal(compareEntry({}, REG).status, 'unknown');
  const cmp = compareReport({ agents: [{ profile: 'claude-developer' }] }, REG);
  assert.deepEqual(cmp.not_reported, ['codex-developer', 'pi-developer']);
  const merged = mergeCache({ agents: { 'pi-developer': { status: 'ok' } } }, OID, cmp, 0);
  assert.deepEqual(Object.keys(merged.agents).sort(), ['claude-developer', 'pi-developer']);
  assert.equal(formOf(OID, null, 0).agents.length, 0);
  assert.deepEqual(profileAgreed(null, 'x'), { ok: true, why: null });
  assert.equal(profileAgreed({ agents: { x: { status: 'ok', available: false } } }, 'x').ok, false);
});

test('P5.41 a10: candidates does not offer an executor whose limit is closed (the P5.17 cache) and shows the replacement with the reason', () => {
  const r = rig({ ...REG, preference: { worker: [ME, CODEX] } });
  try {
    r.limits();
    const c = r.run(['candidates', '--env', 'home-wsl', '--role', 'worker', '--json']);
    assert.equal(c.status, 0, c.stderr + c.stdout);
    const j = json(c);
    assert.equal(j.chosen, CODEX, 'the closed one is not chosen');
    const main = j.candidates.find((x) => x.agent === ME);
    assert.equal(main.eligible, false);
    assert.match(main.reasons.join(), /limits: reserve reached/);
    assert.equal(main.closed_until, shift(180));
    assert.equal(main.provider, 'claude');
    assert.deepEqual([j.replacement.for, j.replacement.use, j.replacement.profile, j.replacement.source], [ME, CODEX, 'codex-developer', 'list']);
    assert.match(j.replacement.because, new RegExp(`${ME} \\(profile claude-developer\\): the limit of provider claude is closed until ${shift(180)}`));
    const text = r.run(['candidates', '--env', 'home-wsl', '--role', 'worker']).stdout;
    assert.match(text, /^replacement: codex@home-wsl \(profile codex-developer\) instead of claude-code@home-wsl: .*closed until /m);
    // nothing closed: no replacement block
    r.limits({ claudeClosed: false });
    const open = json(r.run(['candidates', '--env', 'home-wsl', '--role', 'worker', '--json']));
    assert.equal(open.chosen, ME);
    assert.equal(open.replacement, undefined);
  } finally { r.cleanup(); }
});

test('P5.41 a10: no replacement when the chosen candidate is open and only a reserve behind it is closed (claude open, codex closed)', () => {
  const r = rig({ ...REG, preference: { worker: [ME, CODEX] } });
  try {
    const dir = path.join(r.root, 'cache', 'road-map-journal');
    fs.mkdirSync(dir, { recursive: true });
    const win = (used) => [{ name: 'five_hour', used_percent: used, resets_at: shift(180) }, { name: 'seven_day', used_percent: 30, resets_at: shift(60 * 24 * 3) }];
    const entry = (provider, windows, extra = {}) => ({ provider, kind: 'subscription', state: 'known', measured_at: T0, source: 'synthetic', windows, reserve: { five_hour: 10, seven_day: 10 }, ...extra });
    fs.writeFileSync(path.join(dir, 'limits.json'), JSON.stringify({ version: 1, providers: { claude: entry('claude', win(20)), codex: entry('codex', win(97), { closed_until: shift(180) }) } }));
    const c = r.run(['candidates', '--env', 'home-wsl', '--role', 'worker', '--json']);
    assert.equal(c.status, 0, c.stderr + c.stdout);
    const j = json(c);
    assert.equal(j.chosen, ME);
    assert.match(j.candidates.find((x) => x.agent === CODEX).reasons.join(), /limits: reserve reached/, 'the closed reserve is still refused and shown');
    assert.equal(j.replacement, undefined, 'but nothing replaces a candidate that was never going to be used');
    assert.doesNotMatch(r.run(['candidates', '--env', 'home-wsl', '--role', 'worker']).stdout, /replacement:/);
  } finally { r.cleanup(); }
});

test('P5.41 a10: outside the owner\'s list a replacement is advice only: it is shown with its profile, never chosen; the exit code stays 1', () => {
  const r = rig(); // preference worker: [ME] only
  try {
    r.limits();
    const c = r.run(['candidates', '--env', 'home-wsl', '--role', 'worker', '--json']);
    assert.equal(c.status, 1, 'no candidate of the owner\'s list');
    const j = json(c);
    assert.equal(j.chosen, null);
    assert.deepEqual([j.replacement.use, j.replacement.profile, j.replacement.source], [CODEX, 'codex-developer', 'profiles']);
    assert.match(j.replacement.advice_only, /outside the owner's list: not chosen, nothing is launched/);
    assert.match(r.run(['candidates', '--env', 'home-wsl', '--role', 'worker']).stdout, /\[advice only: outside the owner's list/);
    // an agent with no profile in the registry is not an agreed replacement
    const lone = rig({ ...REG, preference: { worker: [ME, CODEX] }, agent_profiles: { 'claude-developer': REG.agent_profiles['claude-developer'] } });
    try {
      lone.limits();
      const lj = json(lone.run(['candidates', '--env', 'home-wsl', '--role', 'worker', '--json']));
      assert.equal(lj.chosen, CODEX, 'the owner\'s list still chooses it');
      assert.equal(lj.replacement.use, null);
      assert.match(lj.replacement.skipped.join(), /codex@home-wsl: no profile in the registry/);
    } finally { lone.cleanup(); }
  } finally { r.cleanup(); }
});

test('P5.41 a10: with an orchestrator the replacement must be a profile its reconciliation matched and did not report unavailable; stale is a warning on stderr', () => {
  const r = rig({ ...REG, preference: { worker: [ME, CODEX] } });
  try {
    r.limits();
    const ask = (over) => r.run(['candidates', '--env', 'home-wsl', '--role', 'worker', '--orchestrator', OID, '--json'], { over });
    // never reconciled: a warning, the registry alone agrees
    const none = ask({});
    assert.match(none.stderr, /warning: orchestrator openbot@home-wsl: never reconciled/);
    assert.equal(json(none).orchestrator.sync, 'none');
    assert.equal(json(none).replacement.use, CODEX);
    // matched: offered
    r.sync(FULL());
    const ok = ask({});
    assert.equal(ok.stderr, '');
    assert.deepEqual([json(ok).orchestrator.sync, json(ok).replacement.use], ['ok', CODEX]);
    // the codex agent of the orchestrator is reported unavailable: skipped with the reason, no replacement
    const down = FULL(); down.agents[1].available = false;
    r.sync(down);
    const j = json(ask({}));
    assert.equal(j.replacement.use, null);
    assert.match(j.replacement.skipped.join(), /codex@home-wsl: profile codex-developer is reported unavailable/);
    assert.equal(j.chosen, CODEX, 'the owner\'s list still decides what is chosen');
    // differs from the registry: not agreed
    const diff = FULL(); diff.agents[1].id = 'wrong';
    r.sync(diff);
    assert.match(json(ask({})).replacement.skipped.join(), /differs from the registry in the last reconciliation/);
    // stale: a warning, the answer is the same
    r.sync(FULL());
    r.limits({ at: 60 * 30 }); // the limits cache is read at the later time too
    const stale = ask(clock(shift(60 * 30)));
    assert.equal(stale.status, 0);
    assert.match(stale.stderr, /warning: orchestrator openbot@home-wsl: the last reconciliation is 30 h old/);
    assert.equal(json(stale).orchestrator.sync, 'stale');
    assert.equal(json(stale).replacement.use, CODEX);
  } finally { r.cleanup(); }
});

test('P5.41 a10: the unit: replacementFor with injected limits (no cache, no CLI)', async () => {
  const reg = { ...REG, preference: { worker: [ME, CODEX] } };
  const need = { env: null, role: 'worker', needs: [] };
  const deps = { reach: async () => ({ state: 'reachable' }), limits: async (a) => (a === ME ? { verdict: 'reserve', message: '5h 97%', provider: 'claude', closed_until: '2026-11-10T13:00:00Z' } : { verdict: 'allowed', message: '', provider: 'codex' }) };
  const checked = await selectCandidates(reg, need, deps);
  assert.equal(checked.chosen, CODEX);
  const rep = await replacementFor(reg, need, checked, deps);
  assert.deepEqual([rep.for, rep.use, rep.profile], [ME, CODEX, 'codex-developer']);
  // both closed: nothing from the list; pi has no provider (unknown limits), so no advice either
  const allClosed = { ...deps, limits: async (a) => (a === PI ? { verdict: 'unknown', message: 'no data' } : { verdict: 'reserve', message: 'x', provider: a === ME ? 'claude' : 'codex' }) };
  const c2 = await selectCandidates(reg, need, allClosed);
  assert.equal(c2.chosen, null);
  const r2 = await replacementFor(reg, need, c2, allClosed);
  assert.equal(r2.use, null);
  assert.match(r2.note, /no replacement among the agreed profiles/);
  assert.equal(await replacementFor(reg, need, await selectCandidates(reg, need, { ...deps, limits: async () => ({ verdict: 'allowed', message: '' }) }), deps), null);
});
