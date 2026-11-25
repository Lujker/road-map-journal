// A single machine's opt-in escalation journal. Call only while holding the card's supervise lock.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function escalationFile(dir, board, id) {
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: board, encoding: 'utf8' });
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: board, encoding: 'utf8' });
  if (root.status !== 0 || common.status !== 0) throw new Error('automatic escalation requires a git board');
  const top = fs.realpathSync(root.stdout.trim());
  const repository = fs.realpathSync(path.resolve(board, common.stdout.trim()));
  const identity = `${repository}\0${path.relative(top, fs.realpathSync(board))}`;
  const key = crypto.createHash('sha256').update(`${identity}\0${id}`).digest('hex');
  return path.join(dir, `escalation-${key}.json`);
}

export function readEscalation(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error('escalation state is unreadable'); }
}

export function writeEscalation(file, state, { create = false } = {}) {
  const body = JSON.stringify(state) + '\n';
  if (create) { fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 }); return; }
  const temp = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, body, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

export function conductorDigest(conductor) {
  const h = crypto.createHash('sha256').update(JSON.stringify(conductor));
  const files = new Set();
  for (const entry of [...Object.values(conductor.templates ?? {}), ...Object.values(conductor.profiles ?? {})])
    for (const key of ['settings', 'mcp_config']) if (entry[key]) files.add(entry[key]);
  for (const file of [...files].sort()) h.update(file).update(fs.readFileSync(file));
  return h.digest('hex');
}

export function ledgerIsReadable(files) {
  try {
    for (const file of files) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      for (const line of text.split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.event !== 'string') return false;
      }
    }
    return true;
  } catch { return false; }
}

export function escalationAdmission(state, { profile, agent, model }) {
  if (!state || state.version !== 1 || state.phase !== 'ready' || state.outcome !== 'escalated'
      || state.group_gone !== true || !state.run_id || !state.checkpoint || state.checkpoint.run_id !== state.run_id
      || state.checkpoint.in_flight !== 'none' || !state.checkpoint.did?.trim?.() || !state.checkpoint.next?.trim?.()
      || !Number.isFinite(state.used_s) || state.used_s < 0 || !Number.isFinite(state.limit_s)
      || state.limit_s <= state.used_s || !state.strong || state.strong.profile !== profile
      || state.strong.agent !== agent || state.strong.model !== model) return null;
  return state.limit_s - state.used_s;
}
