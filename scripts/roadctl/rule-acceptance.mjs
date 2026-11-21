// A rule acceptance is a record awaiting the owner's separate done.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const RULE_REQUIRES = '0.15.0';

// The registry explicitly maps known aliases to actual canonical models; ambiguity fails closed.
export function canonicalModel(value, registry) {
  if (typeof value !== 'string') return null;
  const clean = (s) => s.toLowerCase().replace(/(?:\[(?:low|medium|high|xhigh|max|ultra)\]|:(?:low|medium|high|xhigh|max|ultra))$/, '');
  const input = clean(value.trim());
  const matches = [];
  for (const [provider, config] of Object.entries(registry?.providers ?? {})) {
    if (!config?.models || typeof config.models !== 'object' || Array.isArray(config.models)) continue;
    for (const [id, aliases] of Object.entries(config.models)) {
      if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string')) continue;
      if ([id, `${provider}/${id}`, ...aliases].some((s) => clean(s) === input)) matches.push(`${provider}/${id}`);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}


export function ruleSnapshot(board, id, repo) {
  const card = board.cards.find((c) => c.header.id === id);
  if (!card || card.errors.length || typeof repo !== 'string' || !repo.trim()) throw new Error('a valid card and --repo are required');
  let revision;
  try {
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    revision = git(['rev-parse', '--verify', 'HEAD']);
    if (!/^[a-f0-9]{40,64}$/.test(revision) || git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error();
  } catch { throw new Error('repository must have a clean checked-out commit'); }
  const ids = (card.header.depends_on ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const dependencies = ids.map((id) => {
    const dep = board.cards.find((c) => c.header.id === id);
    if (!dep || dep.errors.length) throw new Error(`dependency ${id} is missing or invalid`);
    return [id, dep.header.status ?? '', dep.header.accepted ?? '', dep.header.by_mandate ?? ''];
  });
  const data = { revision, criteria: card.criteria, evidence: (card.sections.Evidence ?? '').trim(), approved: card.header.approved ?? '', by_mandate: card.header.by_mandate ?? '', depends_on: dependencies };
  return { revision, basis: `sha256:${crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')}` };
}

export function acceptRule(board, id, as, api, repo) {
  const refuse = (reason) => ({ ok: false, reasons: [reason] });
  if ((api.compareVersions(board.config.requires, RULE_REQUIRES) ?? -1) < 0 || api.boardRequires(board.config)) return refuse(`board must require supported roadctl ${RULE_REQUIRES} or newer`);
  if (!/^[A-Za-z0-9@._:-]+$/.test(as ?? '')) return refuse('an agent is required');
  const c = board.cards.find((x) => x.header.id === id);
  if (!c || c.errors.length) return refuse('card is missing or invalid');
  if ((board.config.status_map?.[c.header.status] ?? c.header.status) !== 'review') return refuse('card must be in review');
  if (c.header.accepted) return refuse('card already has an acceptance');
  if (!c.criteria.length || c.criteria.some((x) => x.mark !== 'x' || !c.evidence.has(x.id))) return refuse('every criterion must be marked and have evidence');
  let proof;
  try { proof = JSON.parse(c.sections['Rule Evidence']); } catch { return refuse('missing or invalid Rule Evidence'); }
  if (proof?.tests?.result !== 'pass' || typeof proof.tests.command !== 'string' || !proof.tests.command.trim()) return refuse('green test record required');
  if (!proof.review || typeof proof.review.agent !== 'string' || !proof.review.agent.trim() || proof.review.result !== 'pass' || !Array.isArray(proof.review.blockers) || proof.review.blockers.length) return refuse('independent review without blockers required');
  const worker = proof.worker, reviewer = proof.review;
  const validRun = (r) => typeof r?.agent === 'string' && /^[A-Za-z0-9@._:-]+$/.test(r.agent) && typeof r.run === 'string' && /^[A-Za-z0-9._:-]+$/.test(r.run) && typeof r.source === 'string' && Boolean(r.source.trim());
  if (!validRun(worker) || !validRun(reviewer) || worker.agent === reviewer.agent || worker.run === reviewer.run) return refuse('review requires a different agent and a separate run with model sources');
  let registry;
  try { registry = api.loadRegistry(); } catch { return refuse('model registry unavailable'); }
  if (/^(?:script|cron):/.test(as) || registry?.agents?.[as]?.host === 'script') return refuse('a script cannot accept work by rule');
  const authorModel = canonicalModel(worker.model, registry), reviewModel = canonicalModel(reviewer.model, registry);
  if (!authorModel || !reviewModel || authorModel === reviewModel) return refuse('review requires a different known canonical model');
  let snapshot;
  try { snapshot = ruleSnapshot(board, id, repo); } catch (e) { return refuse(e.message); }
  if ([proof.tests, proof.review].some((p) => p.revision !== snapshot.revision || p.basis !== snapshot.basis)) return refuse('test or review record is stale for this revision or basis');
  const raw = fs.readFileSync(c.file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const next = raw.replace(/^(---\r?\n[\s\S]*?)(\r?\n---)/, (_, header, end) => `${header}${eol}accepted: rule${end}`);
  fs.writeFileSync(c.file, next);
  api.appendLog(board, id, 'ACCEPTED by rule; awaiting owner', { author: as });
  return { ok: true };
}

export default { name: 'rule-acceptance', cardSections: ['Rule Evidence'] };
