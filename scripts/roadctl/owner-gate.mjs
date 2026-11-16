// Owner-only commands in an unattended run, the audit of owner commands, bounds of the project mandate, lint of broad permission rules (P5.3).
//
// A command entry marks what only the owner runs: `owner: true` (every call, except the first words in the entry's `ownerReads`, where '' is "no first word"), or
// `owner: { sub: [...], flags: [...] }` (a call whose first word is in `sub`, or that has one of the flags). The gate in main() of roadctl.mjs asks `ownerGate` before the command runs:
//   - always: a call of an owner command writes one line to owner-commands.jsonl of the machine state directory (the audit; detection, not prevention: dropping a variable
//     does not remove it). { time, command, target, by, outcome ok|refused, via, run_id, unattended }; a usage error (exit 2) did nothing and writes none;
//   - in an unattended run (ROADCTL_UNATTENDED set and not 0, or ROADCTL_RUN_ID): the call is refused with exit code 1, and the line says so (`digest` tells the owner at once);
//   - in an unattended run, on a board whose mandate is L3 or L4: a card command (MANDATE_WRITES) on a card that is neither approved by hand nor admitted by the mandate
//     (kind, size, level, goal, budget, a mandate edited after approval) is refused the same way (reason in the line).
// This is an agreement made visible, not a sandbox: a process that can unset the variables or edit the board files is not stopped by it.
import fs from 'node:fs';
import path from 'node:path';
import { ownerCommandsFile } from './digest.mjs';
import { admission, readMandate } from './mandate.mjs';
import { cleanText, nowMs } from './run-store.mjs';
import { xdgDir } from './state.mjs';

export const MANDATE_WRITES = ['claim', 'delegate', 'report', 'review', 'accept', 'return', 'undelegate'];
export const unattended = (env) => Boolean((env.ROADCTL_UNATTENDED ?? '').trim() && env.ROADCTL_UNATTENDED !== '0') || Boolean((env.ROADCTL_RUN_ID ?? '').trim());
export const ownerGateFile = (env = process.env) => path.join(xdgDir(env, 'XDG_CONFIG_HOME', ['.config']), 'road-map-journal', 'owner-gate.json');

/** The local setting `{ "bridge": "NAME" }` (P5.26, P5.32): once a bridge is connected, an owner command whose `via` is not NAME is told to the owner at once. null: not set. */
export function bridgeSetting(env = process.env) {
  try {
    const v = JSON.parse(fs.readFileSync(ownerGateFile(env), 'utf8'))?.bridge;
    return typeof v === 'string' && /^[A-Za-z0-9][\w.-]{0,39}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** { label, target } when this call of the command `entry` is an owner call, else null. */
export function ownerCall(cmd, entry, args, flags) {
  const o = entry?.owner;
  if (!o) return null;
  const sub = args[1] ?? '';
  if (o === true) {
    if (!entry.ownerReads) return { label: cmd, target: args[1] };
    return entry.ownerReads.includes(sub) ? null : sub ? { label: `${cmd} ${sub}`, target: args[2] } : { label: cmd, target: undefined };
  }
  if ((o.sub ?? []).includes(sub)) return { label: `${cmd} ${sub}`, target: args[2] };
  const f = (o.flags ?? []).find((x) => Object.hasOwn(flags, x));
  return f ? { label: `${cmd} --${f}`, target: typeof flags[f] === 'string' ? flags[f] : args[1] } : null;
}

function writeAudit(env, row) {
  try {
    const f = ownerCommandsFile(env);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${JSON.stringify(row)}\n`);
  } catch { /* best effort: the command itself is in the board files */ }
}

/**
 * Before a command runs: null (nothing to say: not an owner call, not a checked card command, or an unattended-free card command), or
 * { refused: 'why' } (the line is written, the caller prints it and exits 1), or { record(code, extra) } (call it with the exit code after the command).
 * ctx: { cmd, args, flags, env, api, board() -> loaded board or null }.
 */
export function ownerGate(entry, { cmd, args, flags, env, api, board }) {
  const un = unattended(env);
  const call = ownerCall(cmd, entry, args, flags);
  let refusal = null;
  let label = cmd;
  let target = args[1];
  if (call) ({ label, target } = call);
  else if (un && MANDATE_WRITES.includes(cmd) && args[1]) {
    const b = board();
    const m = b && readMandate(b, api);
    const card = m?.gated ? b.cards.find((c) => c.header.id === args[1]) : null;
    if (!card || card.header.approved) return null; // no mandate, or the card is approved by hand: unchanged
    const v = admission(b, card, m, cmd === 'delegate' && card.header.by_mandate !== m.hash ? 'delegate' : 'work', api);
    if (v.ok) return null;
    refusal = `outside the project mandate: ${v.reasons.join('; ')}`;
  } else return null;
  if (call && un) refusal = `an unattended run (ROADCTL_UNATTENDED or ROADCTL_RUN_ID) never runs ${label}; only the owner does, in person`;
  const row = (outcome, extra = {}) => {
    const project = () => { try { const b = board(); return b ? path.basename(b.project) : ''; } catch { return ''; } };
    return { time: new Date(nowMs(env)).toISOString(), command: label, target: cleanText(String(target ?? '') || project(), 60), by: cleanText(typeof flags.by === 'string' ? flags.by : '', 40), outcome, via: cleanText(env.ROADCTL_VIA ?? '', 40) || 'direct', run_id: cleanText(env.ROADCTL_RUN_ID ?? '', 60) || null, unattended: un, ...extra };
  };
  if (refusal) {
    writeAudit(env, row('refused', { reason: cleanText(refusal, 200) }));
    return { refused: refusal };
  }
  return { record: (code, extra = {}) => { if (code === 0 || code === 1) writeAudit(env, row(code === 0 ? 'ok' : 'refused', extra)); } };
}

// ---------------------------------------------------------------- lint: broad permission rules in routine files

const RULES = [
  ['error', /\bBash\(\s*roadctl\s*(?::\*|\s\*)\s*\)/g, 'Bash(roadctl:*) allows every roadctl command, approve and done included: name the subcommands the routine needs (Bash(roadctl show:*), ...)'],
  ['warning', /\bBash\(\s*git\s*(?::\*|\s\*)\s*\)/g, 'Bash(git:*) allows every git command, push and reset included: name the subcommands'],
  ['error', /\bmcp__(?:[A-Za-z0-9-]|_(?!_))+(?:__\*)?(?![A-Za-z0-9_*-])/g, 'a whole MCP server in a permission rule allows all its tools: name the tools (mcp__server__tool)'],
  ['error', /(["'`])Bash\1|--allowedTools[ =]+Bash(?![\w(])/g, 'a bare Bash rule allows every shell command: name the command prefixes'],
  ['warning', /(["'`])(?:Write|Edit)\1|\b(?:Write|Edit)\(\s*\**\s*\)/g, 'Write or Edit without a path allows changing any file: give the path (Edit(/path/**))'],
];

/** Findings for the text of one file: [{ level, text }], one per rule that matches. A prefix rule is not "read only": the text after the prefix is whatever the agent writes. */
export function broadRules(text) {
  return RULES.filter(([, re]) => { re.lastIndex = 0; return re.test(text); }).map(([level, re, why]) => ({ level, text: `broad permission rule ${cleanText(text.match(new RegExp(re.source, re.flags.replace('g', '')))[0], 40)}: ${why}` }));
}

export default {
  name: 'owner-gate',
  hooks: {
    /** `lint`: routine files that carry a broad permission rule (rule 33). */
    'board-lint'({ board }) {
      const findings = [];
      for (const r of board.routines ?? []) {
        let text = '';
        try {
          text = fs.readFileSync(r.file, 'utf8');
        } catch { /* a missing file is not this module's finding */ }
        for (const f of broadRules(text)) findings.push({ ...f, file: `routines/${r.name}` });
      }
      return { findings };
    },
  },
};
