// `roadctl worktree add|list|prune ID` (P5.41 a6): one git worktree and one branch per card, so two agents never share a working copy and a handoff can name both.
// Names follow the card id: branch `<id>-<slug>` (the id in lower case, the slug from the ASCII words of the title, else `work`), directory `<repo>-<id>` next to the
// repository. `prune` removes only the worktrees of that card, never one with uncommitted changes or a branch that is not merged into the base without --force.
// The repository is the git work tree of the current directory, or --repo. Node standard library only, no side effects at import.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USAGE = 'usage: roadctl worktree add ID [--base REF] [--branch NAME] [--dir PATH]   |   roadctl worktree list [ID]   |   roadctl worktree prune ID [--base REF] [--force]   (--repo DIR, --board DIR)';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

const git = (cwd, args, { ok = false } = {}) => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    if (ok) return { ok: false, out: '', err: String(e.stderr ?? e.message).trim() };
    throw new Error(`git ${args[0]} failed: ${String(e.stderr ?? e.message).trim().split('\n')[0]}`);
  }
};

/** Lower-case card id usable in a branch and a directory name. */
export const idSlug = (id) => String(id).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
/** Branch of a card: `<id>-<up to three ASCII words of the title>`; `<id>-work` when the title has none. */
export function branchFor(id, title = '') {
  const words = String(title).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return `${idSlug(id)}-${words.slice(0, 3).join('-') || 'work'}`;
}
/** Directory of a card's worktree: next to the repository, `<repo>-<id>`. */
export const dirFor = (repo, id) => path.join(path.dirname(repo), `${path.basename(repo)}-${idSlug(id)}`);

/** The worktrees of a repository: [{ dir, branch, main }]. */
export function worktrees(repo) {
  const blocks = git(repo, ['worktree', 'list', '--porcelain']).out.split('\n\n').filter(Boolean);
  return blocks.map((b, i) => ({ dir: /^worktree (.+)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? null, main: i === 0 })).filter((w) => w.dir);
}
/** A worktree belongs to the card when its branch is `<id>` or starts with `<id>-`, or its directory is `<repo>-<id>`. The main work tree never does. */
export const ofCard = (w, repo, id) => !w.main && (w.branch === idSlug(id) || (w.branch ?? '').startsWith(`${idSlug(id)}-`) || path.basename(w.dir) === path.basename(dirFor(repo, id)));

const dirty = (dir) => git(dir, ['status', '--porcelain'], { ok: true }).out !== '';
const unmerged = (repo, branch, base) => (branch ? Number(git(repo, ['rev-list', '--count', `${base}..${branch}`]).out) : 0);
const defaultBase = (repo) => (git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { ok: true }).ok ? 'main' : 'HEAD');

export default {
  name: 'worktree',
  commands: {
    worktree: {
      group: 'Record', effect: 'write', hidden: true,
      summary: 'a git worktree and branch per card (add, list, prune)',
      purpose: 'add ID creates the branch <id>-<slug> from --base (default main, else HEAD) and its worktree <repo>-<id> next to the repository, for a card that exists on the board; if the card already has that worktree it is shown, nothing is changed. list [ID] shows the worktrees of one card or of every card of the repository with branch, clean or dirty, and merged or unmerged into the base. prune ID removes the worktrees and branches of that card and nothing else; a worktree with uncommitted changes, or a branch that is not merged into the base, is refused unless --force. The main work tree and the worktrees of other cards are never touched. The repository is the git work tree of the current directory, or --repo.',
      usage: [USAGE.slice(7)],
      flags: [['--repo DIR', 'the repository (default: the git work tree of the current directory)'], ['--base REF', 'branch or commit to start from and to test "merged" against (default main, else HEAD)'], ['--branch NAME', 'branch name instead of <id>-<slug> (add)'], ['--dir PATH', 'worktree directory instead of <repo>-<id> (add)'], ['--force', 'prune: also remove a dirty worktree or an unmerged branch']],
      examples: ['roadctl worktree add P5.41', 'roadctl worktree list', 'roadctl worktree prune P5.41'],
      changes: 'add: a new branch and worktree (git). prune: removes worktrees and branches of that card (git). No board file.',
      exits: '0 done; 1 refused (a dirty or unmerged worktree without --force, the worktree already exists elsewhere); 2 usage error, unknown card or not a git repository',
      run({ flags, args, api, out }) {
        const sub = args[1];
        const id = args[2];
        if (!['add', 'list', 'prune'].includes(sub) || (sub !== 'list' && !id) || (id !== undefined && !ID_RE.test(id)) || args.length > 3) throw new Error(USAGE);
        const start = typeof flags.repo === 'string' ? path.resolve(flags.repo) : process.cwd();
        let repo;
        try { repo = fs.realpathSync(git(start, ['rev-parse', '--show-toplevel']).out); } catch { throw new Error(`${start} is not inside a git repository (use --repo DIR)`); }
        const base = typeof flags.base === 'string' ? flags.base : defaultBase(repo);
        const all = worktrees(repo);
        if (sub === 'add') {
          let card;
          try { card = api.loadBoard(api.findBoard(process.cwd(), typeof flags.board === 'string' ? flags.board : undefined)).cards.find((c) => c.header.id === id); }
          catch { throw new Error('no board found; use --board DIR'); }
          if (!card) throw new Error(`no card ${id} on the board`);
          const have = all.filter((w) => ofCard(w, repo, id));
          if (have.length) { for (const w of have) out(`${id}: already ${w.dir} (branch ${w.branch ?? 'detached'})`); return 0; }
          const branch = typeof flags.branch === 'string' ? flags.branch : branchFor(id, card.header.title);
          const dir = typeof flags.dir === 'string' ? path.resolve(flags.dir) : dirFor(repo, id);
          if (!BRANCH_RE.test(branch) || branch.includes('..')) throw new Error(`bad branch name ${branch}`);
          if (fs.existsSync(dir)) { out(`refused: ${dir} already exists`); return 1; }
          if (git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { ok: true }).ok) { out(`refused: branch ${branch} already exists (use --branch)`); return 1; }
          git(repo, ['worktree', 'add', '-b', branch, dir, base]);
          out(`${id}: ${dir} (branch ${branch} from ${base})`);
          return 0;
        }
        if (sub === 'list') {
          const rows = all.filter((w) => !w.main && (id ? ofCard(w, repo, id) : true));
          if (!rows.length) return out(id ? `${id}: no worktree` : 'no worktrees besides the main one'), 0;
          for (const w of rows) out(`${w.branch ?? 'detached'} | ${w.dir} | ${dirty(w.dir) ? 'dirty' : 'clean'} | ${unmerged(repo, w.branch, base) ? 'unmerged' : 'merged'} into ${base}`);
          return 0;
        }
        const mine = all.filter((w) => ofCard(w, repo, id));
        if (!mine.length) return out(`${id}: no worktree; nothing to do`), 0;
        const force = flags.force === true;
        const refused = mine.flatMap((w) => [dirty(w.dir) && !force ? `${w.dir}: uncommitted changes` : null, unmerged(repo, w.branch, base) && !force ? `${w.branch}: not merged into ${base}` : null]).filter(Boolean);
        if (refused.length) { for (const r of refused) out(`refused: ${r} (use --force to remove it anyway)`); return 1; }
        for (const w of mine) {
          git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), w.dir]);
          if (w.branch) git(repo, ['branch', force ? '-D' : '-d', w.branch], { ok: true });
          out(`${id}: removed ${w.dir}${w.branch ? ` and branch ${w.branch}` : ''}`);
        }
        return 0;
      },
    },
  },
};
