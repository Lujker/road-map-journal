// Module registry for roadctl (seam, see docs/developing-roadctl.md).
// A module is a plain object (the default export of its file):
//
//   export default {
//     name: 'run-ledger',                       // unique, [a-z][a-z0-9-]*
//     commands: { 'my-command': { ...help fields, run(ctx) } },   // optional
//     headerKeys: ['run_id'],                   // optional: extra card header keys that are not "unknown"
//     tick(ctx) {},                             // optional: observer called once per finished `tick` decision
//   };
//
// A command entry has the same help fields as an entry of COMMANDS in roadctl.mjs (group, effect, summary, purpose,
// usage, flags, examples, changes, exits), optionally `hidden: true` (kept out of the `roadctl help` overview, `help <name>`
// still works), and `run(ctx)`, which returns the exit code. ctx = { flags, args, io, out, env, api, modules }.
// `api` is the small set of roadctl.mjs helpers a module may use; modules do not import roadctl.mjs themselves.
// The tick hook gets ctx = { agent, decision, limits, items, sync, boardDirs, env, api }: copies of the data of one finished tick
// (not called when tick was busy or failed). It observes; it cannot change the decision or the output, and a hook that throws
// only prints a warning on stderr.
//
// Node standard library only, no side effects at import.

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const EFFECTS = ['read', 'write', 'git'];
const STRING_FIELDS = ['summary', 'purpose', 'changes', 'exits'];
const ARRAY_FIELDS = ['usage', 'flags', 'examples'];

function fail(mod, msg) {
  throw new Error(`roadctl module ${mod}: ${msg}`);
}

/**
 * Validate modules and merge them. Throws (the whole CLI refuses to start) on a malformed module, a name that is taken by a
 * built-in command or another module, or a header key that is already known: a silent clash would change old behaviour.
 * opts: builtin (object of built-in command entries), groups (allowed help groups), knownKeys (Set of known header keys).
 */
export function buildRegistry(modules, { builtin = {}, groups = [], knownKeys = new Set() } = {}) {
  const names = new Set();
  const commands = {};
  const headerKeys = new Set();
  const tickHooks = [];
  for (const [i, m] of modules.entries()) {
    const label = typeof m?.name === 'string' ? m.name : `#${i}`;
    if (!m || typeof m !== 'object' || !NAME_RE.test(m.name ?? '')) fail(label, 'needs a name like "run-ledger"');
    if (names.has(m.name)) fail(label, 'duplicate module name');
    names.add(m.name);
    for (const [cmd, c] of Object.entries(m.commands ?? {})) {
      if (!NAME_RE.test(cmd)) fail(label, `bad command name ${JSON.stringify(cmd)}`);
      if (Object.hasOwn(builtin, cmd) || Object.hasOwn(commands, cmd)) fail(label, `command ${cmd} already exists`);
      if (typeof c?.run !== 'function') fail(label, `command ${cmd} needs run(ctx)`);
      if (!groups.includes(c.group)) fail(label, `command ${cmd}: group must be one of ${groups.join(', ')}`);
      if (!EFFECTS.includes(c.effect)) fail(label, `command ${cmd}: effect must be one of ${EFFECTS.join(', ')}`);
      for (const f of STRING_FIELDS) if (typeof c[f] !== 'string' || !c[f]) fail(label, `command ${cmd}: help field ${f} is missing`);
      for (const f of ARRAY_FIELDS) if (!Array.isArray(c[f])) fail(label, `command ${cmd}: help field ${f} must be an array`);
      if (!c.usage.length || !c.examples.length) fail(label, `command ${cmd}: usage and examples must not be empty`);
      commands[cmd] = c;
    }
    for (const k of m.headerKeys ?? []) {
      if (!KEY_RE.test(k)) fail(label, `bad header key ${JSON.stringify(k)}`);
      if (knownKeys.has(k) || headerKeys.has(k)) fail(label, `header key ${k} is already known`);
      headerKeys.add(k);
    }
    if (m.tick !== undefined) {
      if (typeof m.tick !== 'function') fail(label, 'tick must be a function');
      tickHooks.push({ module: m.name, fn: m.tick });
    }
  }
  return {
    modules: [...names],
    commands,
    headerKeys,
    tickHooks,
    /** Call every tick hook with its own copy of the data; never throws. No hooks: returns at once. */
    async runTickHooks(ctx, io) {
      for (const h of tickHooks) {
        try {
          await h.fn({ ...ctx, items: structuredClone(ctx.items), sync: structuredClone(ctx.sync), limits: structuredClone(ctx.limits), boardDirs: { ...ctx.boardDirs } });
        } catch (e) {
          io.err(`roadctl tick: warning: module ${h.module}: tick hook failed: ${String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)}\n`);
        }
      }
    },
  };
}
