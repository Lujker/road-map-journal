// `roadctl doctor` (P5.9): read-only check of the environment a machine runs roadctl in. The checks are in doctor-checks.mjs; this file is the
// command: flags, the runner (a failing check becomes a warning), text and --json output, redaction and the exit code.
// It changes no file, starts no model and reaches no network unless --online is given. Output never contains the VALUE of an environment variable
// (only names), and anything that looks like a secret held in the environment is replaced by [redacted] as a last guard.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, loadRegistryResult } from './doctor-checks.mjs';
import { fingerprint } from './fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/;
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|AUTH|PRIVATE_?KEY)/i;
export const DOCTOR_SCHEMA = 1;

/** Replace the value of every secret-looking environment variable in `text` (values shorter than 4 characters are not worth hiding). */
export function redact(text, env) {
  let t = String(text);
  for (const [k, v] of Object.entries(env)) if (SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 4) t = t.split(v).join('[redacted]');
  return t;
}

/** Run every check; returns { checks, summary }. `ctx` as in doctor-checks.mjs; one check that throws becomes a warning. */
export function runChecks(ctx) {
  const loaded = loadRegistryResult(ctx);
  const checks = [];
  for (const [id, fn] of CHECKS) {
    try {
      const r = fn(ctx, loaded);
      checks.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      checks.push({ id, subject: null, status: 'warn', detail: `the check could not run: ${String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)}`, hint: 'this is a bug or an unusual environment; the other checks are unaffected' });
    }
  }
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return { checks, summary };
}

export function toJson(ctx, result) {
  const fp = fingerprint(ctx.runDir);
  return {
    schema: DOCTOR_SCHEMA,
    roadctl: { version: ctx.api.VERSION, sha: fp.short },
    platform: ctx.platform,
    node: ctx.nodeVersion,
    online: Boolean(ctx.online),
    agent: ctx.agent ?? null,
    ok: result.summary.fail === 0,
    summary: result.summary,
    checks: result.checks,
  };
}

export function toText(ctx, result) {
  const fp = fingerprint(ctx.runDir);
  const L = [`roadctl doctor: roadctl ${ctx.api.VERSION} (sha ${fp.short ?? 'unknown'}), ${ctx.platform}, node ${ctx.nodeVersion}${ctx.agent ? `, agent ${ctx.agent}` : ''}`];
  L.push(ctx.online ? 'online checks are on (--online): network is used where a line says so' : 'offline: no network and no limits are used (--online adds the network checks)');
  const line = (c, tag) => {
    L.push(`  ${tag} ${c.id}${c.subject ? ` [${c.subject}]` : ''}: ${c.detail}`);
    if (c.hint) L.push(`       hint: ${c.hint}`);
  };
  const section = (title, status, tag) => {
    const list = result.checks.filter((c) => c.status === status);
    if (!list.length) return;
    L.push('', `${title} (${list.length}):`);
    for (const c of list) line(c, tag);
  };
  section('Failures', 'fail', 'FAIL');
  section('Warnings', 'warn', 'warn');
  section('Passed', 'ok', 'ok  ');
  section('Not checked', 'skip', '--  ');
  const s = result.summary;
  L.push('', `result: ${s.fail} failure(s), ${s.warn} warning(s), ${s.ok} ok, ${s.skip} not checked; exit ${s.fail ? 1 : 0}`);
  return L.join('\n');
}

function parseFlags(flags) {
  if ('agent' in flags && (typeof flags.agent !== 'string' || !AGENT_RE.test(flags.agent))) throw new Error('usage: --agent NAME (a name like claude-code@home-wsl)');
  if ('host' in flags && (typeof flags.host !== 'string' || !HOST_RE.test(flags.host))) throw new Error('usage: --host HOST (an ssh destination, with --online)');
  if (flags.host && !flags.online) throw new Error('--host contacts HOST over ssh: add --online to allow the network');
  return { agent: flags.agent ?? null, online: Boolean(flags.online), host: flags.host ?? null };
}

export function buildContext({ flags, env, api }, over = {}) {
  const f = parseFlags(flags);
  return {
    env,
    home: os.homedir(),
    platform: process.platform,
    cwd: process.cwd(),
    flags,
    agent: f.agent,
    online: f.online,
    host: f.host,
    api,
    runDir: path.join(HERE, '..'),
    nodeVersion: process.version,
    spawn: spawnSync,
    ...over,
  };
}

export default {
  name: 'doctor',
  commands: {
    doctor: {
      group: 'Setup', effect: 'read', summary: 'check the environment of this machine (read only)',
      purpose: 'Finds the differences between machines before the first real run: the version and checksum of the installed copy and whether its modules folder is complete, Node and git, the registry and the command that starts the agent (found in PATH the way a non-interactive shell finds it), the paths of the workspace, boards list and registry (letter case included), the state directory and a second one on WSL or native Windows, whether ROADCTL_* variables pass through WSLENV and wsl.exe (and, with --online --host, through ssh), the machine clock against the newest fetched commit of origin, and for each board its "requires", write access to the repository, uncommitted work and the consistency of its routines. Each check has a name, a result (ok, warn, fail, not checked), a detail and a hint. Warnings and failures are listed apart; an environment variable is only ever named, never printed. It changes nothing, starts no model, does not poll limits and does not touch the network unless --online is given.',
      usage: ['roadctl doctor [--agent NAME] [--json] [--online [--host HOST]]'],
      flags: [
        ['--agent NAME', 'also check the executor that runs this agent here: the registry entry and its command in PATH (a missing command is a failure)'],
        ['--json', 'machine-readable result: {schema, roadctl:{version,sha}, platform, node, online, agent, ok, summary:{ok,warn,fail,skip}, checks:[{id,subject,status,detail,hint}]}'],
        ['--online', 'also ask each board repository\'s origin (git ls-remote, read only); uses the network, never a model or the limits'],
        ['--host HOST', 'with --online: test over ssh whether the server passes a ROADCTL_* variable to a remote command (contacts HOST)'],
      ],
      examples: ['roadctl doctor', 'roadctl doctor --agent claude-code@home-wsl', 'roadctl doctor --json', 'roadctl doctor --online --host work-notebook'],
      changes: 'Nothing: no file, no git state, no network (unless --online), no model.',
      exits: '0 no failure (warnings may be present); 1 at least one failure; 2 usage error',
      run({ flags, env, out, api }) {
        const ctx = buildContext({ flags, env, api });
        const prev = process.env.GIT_OPTIONAL_LOCKS;
        process.env.GIT_OPTIONAL_LOCKS = '0'; // git status must not refresh the index: doctor is read only
        let result;
        try {
          result = runChecks(ctx);
        } finally {
          if (prev === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
          else process.env.GIT_OPTIONAL_LOCKS = prev;
        }
        const body = flags.json ? JSON.stringify(toJson(ctx, result), null, 2) : toText(ctx, result);
        out(redact(body, env));
        return result.summary.fail ? 1 : 0;
      },
    },
  },
};
