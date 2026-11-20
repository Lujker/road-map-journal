// `roadctl orchestrator form|sync|status` (P5.41 slice 3, a10): the reconciliation of an external orchestrator (a chat platform, a scheduler, anything that runs agents) with the registry.
// `form` prints a machine-readable form: for every profile of the registry what roadctl expects, and empty fields for what the orchestrator reports about itself and its agents
// (name, id, model, availability). `sync` reads the filled form on stdin and answers for each entry: `ok` (it matches the registry), `unknown` (the registry does not know it) or
// `mismatch` (it differs). The result is kept in the state directory, per orchestrator id (`orchestrator-<id>.json`) with the time of the reconciliation; a reconciliation older than
// 24 hours (registry `orchestrator_sync.stale_hours`) gives a warning, never a block. What sync NEVER does: change the registry, a card or a permission; create a profile, an executor or
// a link from an unknown name; delete a link because a list was incomplete (a profile that was not reported keeps what the cache has). The cache lives outside the board, in git nothing changes.
// Node standard library only, no side effects at import.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './state.mjs';

export const FORM_VERSION = 1;
export const DEFAULT_STALE_HOURS = 24;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}@[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const MAX_INPUT = 65536;
const USAGE = 'usage: roadctl orchestrator form [--orchestrator ID] [--json]   |   roadctl orchestrator sync [--orchestrator ID] [--json] < filled-form.json   |   roadctl orchestrator status [--orchestrator ID] [--json]';
const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f`<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const low = (s) => String(s ?? '').toLowerCase();

/** The orchestrator id (`system@machine`): `--orchestrator`, else ROADCTL_ORCHESTRATOR; null when none. A bad id is an error for the caller to show. */
export function orchestratorId(flags, env) {
  const v = [flags?.orchestrator, env?.ROADCTL_ORCHESTRATOR].find((x) => typeof x === 'string' && x.trim());
  if (!v) return null;
  if (!ID_RE.test(v.trim())) throw new Error(`bad orchestrator id ${clean(v, 40)}: expected system@machine like openbot@home-wsl`);
  return v.trim();
}
export const cachePath = (env, id) => path.join(stateDir(env), `orchestrator-${id.replace(/[^A-Za-z0-9._@-]/g, '_')}.json`);
export const staleHours = (reg) => (Number.isFinite(reg?.orchestrator_sync?.stale_hours) && reg.orchestrator_sync.stale_hours > 0 ? reg.orchestrator_sync.stale_hours : DEFAULT_STALE_HOURS);

export function readCache(env, id) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(env, id), 'utf8'));
    return c && c.v === 1 && c.id === id && c.agents && typeof c.agents === 'object' ? c : null;
  } catch { return null; }
}
function writeCache(env, id, cache) {
  const file = cachePath(env, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const profilesOf = (reg) => Object.entries(reg?.agent_profiles ?? {}).filter(([, p]) => p && typeof p === 'object' && !Array.isArray(p));
const variantsOfProfile = (p) => (Array.isArray(p?.openbot_variants) ? p.openbot_variants : []).filter((v) => v && typeof v.name === 'string');

/** The form: what roadctl expects per profile, and the empty fields for the orchestrator to fill. */
export function formOf(id, reg, now) {
  return {
    form: FORM_VERSION,
    orchestrator: id,
    created_at: new Date(now).toISOString(),
    fill: 'Fill name, id, model and available for each agent of yours that plays one of these profiles (leave an agent out when you do not have it; add an agent you have that is not listed under extra). Send the result to: roadctl orchestrator sync --orchestrator <id> < form.json. roadctl never changes the registry from it.',
    agents: profilesOf(reg).map(([profile, p]) => ({
      profile,
      expect: { executor: p.executor ?? null, model: p.model ?? null, name: p.openbot?.name ?? null, variants: variantsOfProfile(p).map((v) => v.name) },
      name: null, id: null, model: null, available: null,
    })),
    extra: [],
  };
}

/** Which profile an entry is about: its own `profile`, else the profile whose agent name or variant name it carries. */
function profileFor(entry, reg) {
  const all = profilesOf(reg);
  if (entry.profile) return all.find(([k]) => k === entry.profile) ?? null;
  const name = entry.name;
  return name ? all.find(([k, p]) => k === name || p.openbot?.name === name || variantsOfProfile(p).some((v) => v.name === name)) ?? null : null;
}

/** One entry against the registry: { status: ok|unknown|mismatch, reasons, profile }. */
export function compareEntry(entry, reg) {
  const found = profileFor(entry, reg);
  if (!found) return { status: 'unknown', profile: entry.profile ? clean(entry.profile, 40) : null, reasons: [entry.profile ? `profile ${clean(entry.profile, 40)} is not in the registry` : `${clean(entry.name, 40) || 'an entry'} matches no profile of the registry`] };
  const [profile, p] = found;
  const variants = variantsOfProfile(p);
  const names = [profile, p.openbot?.name, ...variants.map((v) => v.name)].filter(Boolean);
  const reasons = [];
  if (entry.name && !names.includes(entry.name)) reasons.push(`name ${clean(entry.name, 40)} is not an agent of profile ${profile} (expected ${names.join(', ')})`);
  const ids = [p.openbot?.id, ...variants.map((v) => v.id)].filter(Boolean);
  if (entry.id && ids.length && !ids.includes(entry.id)) reasons.push(`id ${clean(entry.id, 40)} differs from the registry for profile ${profile}`);
  const variant = variants.find((v) => v.name === entry.name);
  const expected = variant?.model ?? p.model;
  if (entry.model && expected && !(low(entry.model).includes(low(expected)) || low(expected).includes(low(entry.model)))) reasons.push(`model ${clean(entry.model, 40)} differs from ${clean(expected, 40)} of profile ${profile}`);
  return { status: reasons.length ? 'mismatch' : 'ok', profile, reasons };
}

/** The whole report against the registry. Entries that name no profile and match none are `unknown`; profiles with no entry are `not_reported` (their cache is kept). */
export function compareReport(report, reg) {
  const entries = Array.isArray(report?.agents) ? report.agents.filter((e) => e && typeof e === 'object') : [];
  const results = [];
  for (const e of entries) {
    const r = compareEntry({ profile: typeof e.profile === 'string' ? e.profile : null, name: typeof e.name === 'string' ? e.name : null, id: typeof e.id === 'string' ? e.id : null, model: typeof e.model === 'string' ? e.model : null }, reg);
    results.push({ ...r, name: typeof e.name === 'string' ? clean(e.name, 60) : null, id: typeof e.id === 'string' ? clean(e.id, 60) : null, model: typeof e.model === 'string' ? clean(e.model, 60) : null, available: typeof e.available === 'boolean' ? e.available : null });
  }
  for (const e of Array.isArray(report?.extra) ? report.extra : []) if (e && typeof e === 'object') results.push({ status: 'unknown', profile: null, name: clean(e.name, 60) || null, id: null, model: null, available: null, reasons: [`${clean(e.name, 40) || 'an extra agent'} is not a profile of the registry; nothing is created from it`] });
  const seen = new Set(results.filter((r) => r.status !== 'unknown').map((r) => r.profile));
  return { results, not_reported: profilesOf(reg).map(([k]) => k).filter((k) => !seen.has(k)) };
}

/** The cache after a sync: reported profiles replaced, the others kept as they were (a short list never deletes), unknown names listed (at most 20), never turned into profiles. */
export function mergeCache(prev, id, cmp, now) {
  const at = new Date(now).toISOString();
  const agents = { ...(prev?.agents ?? {}) };
  for (const r of cmp.results) if (r.status !== 'unknown') agents[r.profile] = { status: r.status, name: r.name, id: r.id, model: r.model, available: r.available, reasons: r.reasons, seen_at: at };
  const unknown = cmp.results.filter((r) => r.status === 'unknown').map((r) => r.name ?? r.profile).filter(Boolean).slice(0, 20);
  return { v: 1, id, synced_at: at, agents, unknown };
}

/** The state of the reconciliation for a reader: { sync: none|stale|mismatch|unknown|ok, age_hours, hint }. Stale is a warning, never a block. */
export function syncState(cache, now, hours = DEFAULT_STALE_HOURS) {
  if (!cache) return { sync: 'none', age_hours: null, hint: 'never reconciled: roadctl orchestrator form, fill it, roadctl orchestrator sync' };
  const age = Math.max(0, (now - Date.parse(cache.synced_at)) / 3600e3);
  const rounded = Math.round(age * 10) / 10;
  if (age > hours) return { sync: 'stale', age_hours: rounded, hint: `the last reconciliation is ${rounded} h old (limit ${hours} h): run roadctl orchestrator form and sync again` };
  const entries = Object.values(cache.agents);
  if (entries.some((a) => a.status === 'mismatch')) return { sync: 'mismatch', age_hours: rounded, hint: 'an agent differs from the registry: see roadctl orchestrator status' };
  if (cache.unknown?.length) return { sync: 'unknown', age_hours: rounded, hint: `the orchestrator reported ${cache.unknown.length} name(s) the registry does not know: nothing was created` };
  return { sync: 'ok', age_hours: rounded, hint: 'matches the registry' };
}

/** For `candidates`: may a profile be offered as a replacement? With no orchestrator, or no reconciliation, the registry alone is the agreement; with one, the profile must have matched and not be reported unavailable. */
export function profileAgreed(cache, profile) {
  if (!cache) return { ok: true, why: null };
  const a = cache.agents[profile];
  if (!a) return { ok: false, why: `profile ${profile} was not reported by the orchestrator` };
  if (a.status !== 'ok') return { ok: false, why: `profile ${profile} differs from the registry in the last reconciliation` };
  if (a.available === false) return { ok: false, why: `profile ${profile} is reported unavailable` };
  return { ok: true, why: null };
}

function readStdin() {
  const buf = Buffer.alloc(MAX_INPUT + 1);
  let n = 0;
  while (n < buf.length) {
    const r = fs.readSync(0, buf, n, buf.length - n, null);
    if (!r) break;
    n += r;
  }
  if (n > MAX_INPUT) throw new Error(`input exceeds ${MAX_INPUT} bytes`);
  try { return JSON.parse(buf.subarray(0, n).toString('utf8')); } catch { throw new Error('expected the filled form as JSON on stdin'); }
}

const statusLines = (id, st, cache) => [
  `orchestrator ${id}: ${st.sync}${st.age_hours === null ? '' : `, reconciled ${st.age_hours} h ago`}; ${st.hint}`,
  ...Object.entries(cache?.agents ?? {}).map(([p, a]) => `  ${p}: ${a.status}${a.name ? ` (${a.name})` : ''}${a.available === false ? ', unavailable' : ''}${a.reasons?.length ? `; ${a.reasons.join('; ')}` : ''}`),
  ...(cache?.unknown?.length ? [`  unknown to the registry (nothing created): ${cache.unknown.join(', ')}`] : []),
];

export default {
  name: 'orchestrator',
  commands: {
    orchestrator: {
      group: 'Delegate', effect: 'write', hidden: true,
      summary: 'reconcile an external orchestrator with the registry (form, sync, status)',
      purpose: 'form prints a JSON form: per profile of the registry what roadctl expects (executor, model, agent name, variants) and empty fields for what the orchestrator reports (name, id, model, available). sync reads the filled form on stdin and answers for each entry ok (matches the registry), unknown (the registry does not know it) or mismatch (it differs; exit 1), and for each profile that was not reported: kept. The answer is stored per orchestrator id (--orchestrator system@machine, or ROADCTL_ORCHESTRATOR) in the roadctl state directory with the time of the reconciliation; a reconciliation older than 24 h (registry orchestrator_sync.stale_hours) is stale: a warning, never a block. status shows the stored state. sync never changes the registry, a card or a permission; an unknown name creates no profile, executor or link; a short list deletes nothing. Nothing is written to git.',
      usage: [USAGE.slice(7)],
      flags: [['--orchestrator ID', 'the orchestrator instance, system@machine (default ROADCTL_ORCHESTRATOR)'], ['--json', 'machine-readable output']],
      examples: ['roadctl orchestrator form --orchestrator openbot@home-wsl > form.json', 'roadctl orchestrator sync --orchestrator openbot@home-wsl < form.json', 'roadctl orchestrator status --orchestrator openbot@home-wsl'],
      changes: 'sync writes one file in the roadctl state directory (orchestrator-<id>.json). No board, registry or git change.',
      exits: '0 done (unknown and stale are shown, not failures); 1 sync found a mismatch; 2 usage error, bad id or no registry',
      run({ flags, args, env, api, out }) {
        const sub = args[1];
        if (!['form', 'sync', 'status'].includes(sub) || args.length > 2) throw new Error(USAGE);
        const id = orchestratorId(flags, env);
        if (!id) throw new Error(`no orchestrator id: use --orchestrator system@machine or ROADCTL_ORCHESTRATOR; ${USAGE}`);
        const reg = api.loadRegistry(env);
        if (!reg) throw new Error('no registry: the reconciliation compares with the registry (docs/roadctl.md, Registry)');
        const now = api.nowMs(env);
        const hours = staleHours(reg);
        if (sub === 'form') {
          const st = syncState(readCache(env, id), now, hours);
          out(JSON.stringify({ ...formOf(id, reg, now), state: st }, null, flags.json ? 2 : 0));
          return 0;
        }
        if (sub === 'status') {
          const cache = readCache(env, id);
          const st = syncState(cache, now, hours);
          out(flags.json ? JSON.stringify({ orchestrator: id, ...st, agents: cache?.agents ?? {}, unknown: cache?.unknown ?? [] }, null, 2) : statusLines(id, st, cache).join('\n'));
          return 0;
        }
        const report = readStdin();
        if (report?.orchestrator && report.orchestrator !== id) throw new Error(`the form is for ${clean(report.orchestrator, 40)}, not ${id}`);
        const cmp = compareReport(report, reg);
        const cache = mergeCache(readCache(env, id), id, cmp, now);
        writeCache(env, id, cache);
        const summary = { ok: 0, unknown: 0, mismatch: 0 };
        for (const r of cmp.results) summary[r.status]++;
        const kept = cmp.not_reported.filter((p) => cache.agents[p]);
        const st = syncState(cache, now, hours);
        if (flags.json) out(JSON.stringify({ orchestrator: id, state: st, results: cmp.results, not_reported: cmp.not_reported, kept, summary }, null, 2));
        else out([...cmp.results.map((r) => `${r.profile ?? r.name ?? '?'}: ${r.status}${r.reasons.length ? `; ${r.reasons.join('; ')}` : ''}${r.available === false ? '; unavailable' : ''}`), ...cmp.not_reported.map((p) => `${p}: not reported${cache.agents[p] ? ', kept as in the last reconciliation' : ''}`), `ok ${summary.ok}, unknown ${summary.unknown}, mismatch ${summary.mismatch}, not reported ${cmp.not_reported.length}`].join('\n'));
        return summary.mismatch ? 1 : 0;
      },
    },
  },
};
