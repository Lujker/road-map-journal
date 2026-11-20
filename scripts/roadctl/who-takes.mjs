// who-takes (P5.41 slice 1, line A): resolve a `--as`/`--to` name against the registry's `agent_profiles`.
// Pure functions only; the core (roadctl.mjs) imports this file. No import from roadctl.mjs (no cycle).

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const hasAt = (s) => /@/.test(String(s ?? ''));

/** profile name -> the profile object of `agent_profiles` (variants are NOT profiles themselves). */
export const profilesOf = (reg) => {
  const out = new Map();
  for (const [name, p] of Object.entries(reg?.agent_profiles ?? {})) if (p && typeof p === 'object' && !Array.isArray(p)) out.set(name, p);
  return out;
};

/** variant name -> its base profile name (pi-developer-small -> pi-developer). */
export const variantsOf = (reg) => {
  const out = new Map();
  for (const [name, p] of profilesOf(reg)) for (const v of Array.isArray(p?.openbot_variants) ? p.openbot_variants : []) if (v && typeof v.name === 'string') out.set(v.name, name);
  return out;
};

/** One-line hint for a refused name: what is known, and that the registry is reconciled by the owner / slice 3. */
export const hintOf = (reg) => {
  const profiles = [...profilesOf(reg).keys()];
  const executors = Object.keys(reg?.agents ?? {});
  const parts = [];
  if (profiles.length) parts.push(`profiles: ${profiles.join(', ')}`);
  if (executors.length) parts.push(`executors: ${executors.join(', ')}`);
  parts.push('or "system@machine/profile"');
  return parts.join('; ');
};

/** Two names for the Log: the profile (or pair) and the executor it maps to. */
const display = (w) => {
  if (w.kind === 'profile') {
    const name = w.orchestrator ? `${w.orchestrator}/${w.variant ?? w.profile}` : (w.variant ?? w.profile);
    return name !== w.executor ? `${name} (${w.executor})` : name;
  }
  return w.executor;
};

/**
 * Resolve a `--as` value (and ROADCTL_AS): an executor, a profile, a variant, or `orchestrator/profile`.
 * Returns { kind, executor, profile?, variant?, orchestrator?, display } or { error, hint? }.
 * Without a registry any valid name is an executor, exactly as before.
 */
export function resolveAs(name, reg) {
  const s = String(name ?? '').trim();
  if (!s) return { error: 'an empty name' };
  const slash = s.indexOf('/');
  if (slash >= 0) {
    const orch = s.slice(0, slash);
    const rest = s.slice(slash + 1);
    if (!NAME.test(orch) || !hasAt(orch)) return { error: `bad orchestrator ${orch}: expected system@machine like openbot@home-wsl` };
    const inner = resolveAs(rest, reg);
    if (inner.error || inner.kind !== 'profile') return { error: inner.error ?? `not a profile: ${rest}`, hint: hintOf(reg) };
    return { kind: 'profile', executor: inner.executor, profile: inner.profile, variant: inner.variant, orchestrator: orch, display: display({ ...inner, orchestrator: orch }) };
  }
  if (reg?.agent_profiles?.[s]) return { kind: 'profile', executor: reg.agent_profiles[s].executor, profile: s, display: display({ kind: 'profile', executor: reg.agent_profiles[s].executor, profile: s }) };
  const base = variantsOf(reg).get(s);
  if (base) return { kind: 'profile', executor: reg.agent_profiles[base].executor, profile: base, variant: s, display: display({ kind: 'profile', executor: reg.agent_profiles[base].executor, profile: base, variant: s }) };
  if (reg?.agents?.[s]) return { kind: 'executor', executor: s, display: s };
  if (!reg && NAME.test(s)) return { kind: 'executor', executor: s, display: s };
  return { error: `unknown ${s}`, hint: hintOf(reg) };
}

/**
 * Resolve a `delegate --to` value: a role, a profile, an executor, or an orchestrator (`system@machine` not in the registry).
 * Without a registry a role is a name without `@` and an executor is a name with `@`, as before. Returns { kind, ... } or { kind: 'unknown', error, hint? }.
 */
export function resolveTo(to, reg) {
  const s = String(to ?? '').trim();
  if (reg?.roles?.[s]) return { kind: 'role', role: s };
  if (reg?.agent_profiles?.[s]) return { kind: 'profile', profile: s };
  if (reg?.agents?.[s]) return { kind: 'executor', executor: s };
  if (!reg) return NAME.test(s) ? (hasAt(s) ? { kind: 'executor', executor: s } : { kind: 'role', role: s }) : { kind: 'unknown', error: `bad name ${s}` };
  if (NAME.test(s) && hasAt(s)) return { kind: 'orchestrator', orchestrator: s };
  return { kind: 'unknown', error: `unknown ${s}`, hint: hintOf(reg) };
}
