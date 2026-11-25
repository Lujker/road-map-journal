// A rule acceptance is a record awaiting the owner's separate done.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readMandate } from './mandate.mjs';
import { changeHeader } from './owner-questions.mjs';

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


const deps = (card) => (card.header.depends_on ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const status = (board, card) => board.config.status_map?.[card.header.status] ?? card.header.status;
export const ruleContent = (card) => crypto.createHash('sha256').update(JSON.stringify({ criteria: card.criteria, evidence: (card.sections.Evidence ?? '').trim(), proof: (card.sections['Rule Evidence'] ?? '').trim(), approved: card.header.approved ?? '', by_mandate: card.header.by_mandate ?? '', depends_on: card.header.depends_on ?? '' })).digest('hex');

/** A unique acceptance id changes on each rule acceptance; dependencies are checked recursively without rewriting cards. */
export function dependencyBasis(board, card, seen = new Set()) {
  if (seen.has(card.header.id)) throw new Error('dependency cycle');
  const next = new Set(seen).add(card.header.id);
  const entries = deps(card).map((id) => {
    const dep = board.cards.find((c) => c.header.id === id);
    if (!dep || dep.errors.length) throw new Error(`dependency ${id} is missing or invalid`);
    const st = status(board, dep);
    if (st !== 'done' && !(st === 'review' && dep.header.accepted === 'rule')) throw new Error(`dependency ${id} is not accepted`);
    if (dep.header.rule_id) {
      if (dep.header.rule_content !== ruleContent(dep)) throw new Error(`dependency ${id} has stale evidence`);
      const current = dependencyBasis(board, dep, next);
      if (dep.header.rule_deps !== current) throw new Error(`dependency ${id} has stale basis`);
    } else if (st !== 'done') throw new Error(`dependency ${id} has no acceptance identity`);
    return [id, dep.header.rule_id ?? dep.header.accepted ?? 'done'];
  });
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function ruleDependencySatisfied(board, card, api) {
  const mandate = readMandate(board, api);
  if (!mandate || mandate.state !== 'approved' || mandate.problems.length || !['L3', 'L4'].includes(mandate.level)) return false;
  if ((api.compareVersions(board.config.requires, RULE_REQUIRES) ?? -1) < 0 || api.boardRequires(board.config)) return false;
  if (card.header.accepted !== 'rule' || !/^[a-f0-9]{64}$/.test(card.header.rule_id ?? '')) return false;
  try { return card.header.rule_content === ruleContent(card) && card.header.rule_deps === dependencyBasis(board, card); } catch { return false; }
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
    return [id, dep.header.status ?? '', dep.header.accepted ?? '', dep.header.by_mandate ?? '', dep.header.rule_id ?? '', dep.header.rule_deps ?? ''];
  });
  const data = { revision, criteria: card.criteria, evidence: (card.sections.Evidence ?? '').trim(), approved: card.header.approved ?? '', by_mandate: card.header.by_mandate ?? '', depends_on: dependencies };
  return { revision, basis: `sha256:${crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')}` };
}

export function acceptRule(board, id, as, api, repo, { recheck = false } = {}) {
  const refuse = (reason) => ({ ok: false, reasons: [reason] });
  if ((api.compareVersions(board.config.requires, RULE_REQUIRES) ?? -1) < 0 || api.boardRequires(board.config)) return refuse(`board must require supported roadctl ${RULE_REQUIRES} or newer`);
  const mandate = readMandate(board, api);
  if (!mandate || mandate.state !== 'approved' || mandate.problems.length || !['L3', 'L4'].includes(mandate.level)) return refuse('an approved, unchanged L3 or L4 mandate is required');
  if (!/^[A-Za-z0-9@._:-]+$/.test(as ?? '')) return refuse('an agent is required');
  const c = board.cards.find((x) => x.header.id === id);
  if (!c || c.errors.length) return refuse('card is missing or invalid');
  const st = board.config.status_map?.[c.header.status] ?? c.header.status;
  if (recheck) {
    if (!['review', 'done'].includes(st) || !c.header.rule_id) return refuse('recheck needs a prior rule acceptance in review or done');
    try { if (c.header.rule_content === ruleContent(c) && c.header.rule_deps === dependencyBasis(board, c)) return refuse('acceptance is already current'); } catch { /* validate dependencies below */ }
  } else {
    if (st !== 'review') return refuse('card must be in review');
    if (c.header.accepted) return refuse('card already has an acceptance');
  }
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
  let dependencyHash;
  try { dependencyHash = dependencyBasis(board, c); } catch (e) { return refuse(e.message); }
  const raw = fs.readFileSync(c.file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let next = raw.replace(/\r\n/g, '\n');
  if (!recheck) next = changeHeader(next, 'accepted', 'rule');
  next = changeHeader(next, 'rule_id', crypto.randomBytes(32).toString('hex'));
  next = changeHeader(next, 'rule_deps', dependencyHash);
  next = changeHeader(next, 'rule_content', ruleContent(c));
  fs.writeFileSync(c.file, eol === '\r\n' ? next.replace(/\n/g, eol) : next);
  api.appendLog(board, id, recheck ? 'RECHECKED rule acceptance' : 'ACCEPTED by rule; awaiting owner', { author: as });
  return { ok: true };
}

export default { name: 'rule-acceptance', cardSections: ['Rule Evidence'], headerKeys: ['rule_id', 'rule_deps', 'rule_content'], hooks: { 'dep-satisfied'({ board, by, api }) { return { satisfied: ruleDependencySatisfied(board, by, api) }; } } };
