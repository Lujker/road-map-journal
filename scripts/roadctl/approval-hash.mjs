// Approval bound to the content of a routine (P5.15). `routine on` records `approved_hash` in the routine header: a hash of the fields and
// sections that decide what the routine does. A routine whose content no longer matches its hash does not run until the owner runs `routine on`
// again; `routine list`, `tick`, `status`, `digest` and `lint` (rule 30) say why. No command of its own: it plugs into three seams
// (`routine-on` writes the hash, `routine-reasons` compares it, `routine-lint` warns about an approval that has no hash yet).
//
// The hash covers: every header key except the ones listed below (agent, model, env, every, hours, timeout, id, title, and any key a later card adds,
// such as allow or mcp: a new key is covered until its card decides otherwise); the scope of `approved`; the sections Goal, Steps, May write, Escalate and
// also any other section or text before the first section (a routine is read as a whole by the model, so an extra section would be a way round).
// It does not cover: enabled, notify, last_run, last_result, the Log section, the rest of the `approved` line (who, when, source), the hash itself and
// `approval_id` (a random id of the approval, new with every `routine on` that writes the hash; the digest tells two approvals of the same text apart by it).
// Before hashing: line ends are LF, trailing whitespace of a line and blank lines around a section go, header order does not matter; the order of the sections does.
// The Log section is outside the hash and is not an instruction: the executor must not read it as part of the task.
// Not covered because it is outside the board: the local watchdog script and the settings file of the agent (docs/roadctl.md).
//
// Boards: the hash is written by `routine on` only on a board whose `requires` is at least HASH_REQUIRES (a board that has not raised it behaves as
// before: nothing is written). There a missing hash counts as "not approved" (removing the key must not return the routine to the old mode); below it
// a routine without a hash keeps the old rule (it runs) and lint warns. A hash that is present is always checked. A hash with a version this copy does
// not know is a mismatch (fail closed). Node standard library only, no side effects at import.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const HASH_KEY = 'approved_hash';
export const ID_KEY = 'approval_id'; // written by every `routine on` that writes a hash: unique per approval, so the digest can tell approvals apart without the (trimmed) Log
export const HASH_REQUIRES = '0.6.0'; // the first roadctl that writes and checks the hash: a board raises `requires` to it
export const OUTSIDE_KEYS = ['enabled', 'notify', 'last_run', 'last_result', 'last_reason', 'fails', 'hold', 'hold_id', 'approved', HASH_KEY, ID_KEY]; // header keys that are not in the hash (`approved` counts through its scope); a new key is in the hash unless a card adds it here; last_reason, fails, hold (P5.4) are run state, not instructions
const PREFIX = 'sha256-v1:';
const norm = (s) => s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');

/** The approval hash of routine text (header and sections), or null when the text has no header. The same text always gives the same hash. */
export function approvalHash(raw) {
  const m = String(raw).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const header = Object.create(null); // no prototype: a key named __proto__ is just a key
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (kv) header[kv[1]] = kv[2].trim();
  }
  const scope = [...new Set((header.approved ?? '').match(/scope=([a-z+]+)/)?.[1].split('+') ?? [])].sort().join('+');
  const parts = m[2].split(/^## (.+)$/m);
  const sections = [['', norm(parts[0])]]; // in file order: moving a section is a change
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim();
    if (name !== 'Log') sections.push([name, norm(parts[i + 1] ?? '')]);
  }
  const body = JSON.stringify({ v: 1, header: Object.keys(header).filter((k) => !OUTSIDE_KEYS.includes(k)).sort().map((k) => [k, header[k]]), scope, sections });
  return PREFIX + crypto.createHash('sha256').update(body).digest('hex');
}

const raised = (board, api) => (board.config?.requires === undefined ? false : (api.compareVersions(board.config.requires, HASH_REQUIRES) ?? -1) >= 0); // an unreadable `requires` is null: the core refuses that board anyway

const hasKey = (text) => new RegExp(`^${HASH_KEY}:`, 'm').test(String(text).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '');

/** The state of one routine: 'ok' | 'changed' | 'missing' | 'unreadable'. */
export function approvalState(board, routine) {
  const stored = routine.header[HASH_KEY];
  let current;
  try {
    current = approvalHash(fs.readFileSync(path.join(board.dir, routine.file), 'utf8'));
  } catch {
    return 'unreadable';
  }
  if (current === null) return 'unreadable';
  if (stored === undefined || stored === '') return 'missing';
  return stored === current ? 'ok' : 'changed';
}

const WHY = {
  changed: 'changed after approval: the owner approves it again with routine on',
  missing: 'not approved: no approval hash (the owner approves it with routine on)',
  unreadable: 'approval hash cannot be checked: the routine file cannot be read',
};

export default {
  name: 'approval-hash',
  routineKeys: [HASH_KEY, ID_KEY],
  hooks: {
    /** `routine on`: the hash of the text as it is now, after the approval line and `enabled` were set (neither is part of the hash except the scope). Written on a board that raised `requires` to HASH_REQUIRES, or when the routine already has the key (the owner re-approves it on any board); otherwise nothing is written. */
    'routine-on'({ board, text, api }) {
      const hash = raised(board, api) || hasKey(text) ? approvalHash(text) : null;
      return hash ? { header: { [HASH_KEY]: hash, [ID_KEY]: crypto.randomBytes(6).toString('hex') } } : {};
    },
    /** Why an enabled, approved routine does not run: its content changed, or (board requires the hash) it has none. Disabled or unapproved: the core says so. */
    'routine-reasons'({ board, routine, facts, api }) {
      if (!facts.enabled || !facts.approved.length) return {};
      const st = approvalState(board, routine);
      if (st === 'ok' || (st === 'missing' && !raised(board, api))) return {};
      return { reasons: [WHY[st]], lint: 'error', immediate: true };
    },
    /** `lint`: an approval that predates the hash still works on a board below HASH_REQUIRES, but an edit would go unnoticed. */
    'routine-lint'({ board, routine, api }) {
      const h = routine.header;
      if (h.enabled !== 'true' || !/scope=/.test(h.approved ?? '') || raised(board, api) || approvalState(board, routine) !== 'missing') return {};
      return { findings: [{ level: 'warning', text: `approved without a content hash: an edit after approval is not detected (the hash needs roadctl ${HASH_REQUIRES} set in config.json, see docs/roadctl.md)` }] };
    },
  },
};
