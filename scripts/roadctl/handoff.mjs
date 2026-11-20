// `roadctl handoff ID --to WHO [--role worker|reviewer|fixer]` (P5.41 a5): the standard assignment text for one card, built from the card and the registry, so a coordinator
// does not write twenty lines by hand and forget a rule. Plain text for any harness or orchestrator (a chat message, a prompt, a file); nothing is sent, started or written.
// The text names the goal, the criteria, the branch and worktree (the names of `roadctl worktree add`), the test command under the shared lock (`roadctl lock`), the
// prohibitions, the report format and the review rule; no product is named. Node standard library only, no side effects at import.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { branchFor, dirFor } from './worktree.mjs';

const USAGE = 'usage: roadctl handoff ID --to WHO [--role worker|reviewer|fixer] [--tests COMMAND] [--base REF] [--note TEXT] [--repo DIR] [--json]';
export const ROLES = ['worker', 'reviewer', 'fixer'];
const TEMPLATE_RE = /^\(.*\)$/;
const WHO_RE = /^[A-Za-z0-9@._:\/-]{1,100}$/;
const clean = (s, n = 400) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** The review rule of the plan (P5.41): what a reviewer may return a card for, and when to stop. */
export const REVIEW_RULE = [
  'Review rule:',
  '- Return the work only for: (1) a violated criterion of the card, (2) a failing test or an incompatibility, (3) a defect you can reproduce with a concrete scenario (input -> wrong result).',
  '- Everything else (style, naming, a better idea, a risk without a scenario) goes to a "later" list in your verdict. It is not a return.',
  '- At most two review rounds per card; after the second the coordinator decides and what is left goes to a follow-up card.',
  '- A second review looks only at the earlier blockers and the new diff, not at the whole card again.',
  '- First line of the verdict: accept / accept with follow-ups / return.',
];
export const ECONOMY = [
  'Save limits:',
  '- Work and answer in short caveman style: short plans, commits, Log and Evidence lines, no retelling of steps; read files in pieces, not whole.',
  '- Questions about code: `codegraph explore "<symbol or question>"` before reading files, where it is installed.',
  '- Output of git, gh and tests: through `rtk` (`rtk git diff`, `rtk test <command>`), where it is installed; run without it if it hides what you need.',
];

/** A Delegation field of the card ("- Checks: ...") unless it is still the template text. */
const field = (card, name) => {
  const m = new RegExp(`^- ${name}: (.*)$`, 'm').exec(card.sections.Delegation ?? '');
  const v = clean(m?.[1] ?? '');
  return v && !TEMPLATE_RE.test(v) ? v : null;
};
const firstParagraphs = (text, max = 1200) => {
  const t = String(text ?? '').trim().split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return t.length > max ? `${t.slice(0, max).trimEnd()} ...(shortened: roadctl show)` : t;
};
const repoOf = (flags) => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: typeof flags.repo === 'string' ? flags.repo : process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};

/** The assignment as lines. `ctx` = { card, to, role, tests, base, note, repo, executor }. Pure: the same data give the same text. */
export function handoffLines({ card, to, role, tests, base, note, repo, executor }) {
  const id = card.header.id;
  const branch = branchFor(id, card.header.title);
  const dir = repo ? dirFor(repo, id) : `../<repo>-${String(id).toLowerCase()}`;
  const open = card.criteria.filter((c) => c.mark !== 'x');
  const L = [`Assignment ${id}: ${clean(card.header.title, 160)}`, `For: ${to} | role: ${role}${executor ? ` | ${executor}` : ''}`, ''];
  L.push('Goal:', ...firstParagraphs(card.sections.Goal).split('\n').map((l) => `  ${l}`), '');
  L.push(`Criteria${role === 'reviewer' ? ' to check' : ''} (full text: roadctl show ${id}):`, ...(open.length ? open.map((c) => `- ${c.id}: ${clean(c.text, 300)}`) : ['- (no open criterion on the card: ask the coordinator what to do before you start)']), '');
  if (role === 'worker' || role === 'fixer') {
    L.push('Where:', `- Repository: ${repo ?? '<repo>'}; do not work in it directly.`, `- Worktree and branch: \`roadctl worktree add ${id}\` makes ${dir} on branch ${branch} from ${base}. Commit there, in separate small commits.`, '');
  } else L.push('Where:', `- Read-only: look at branch ${branch} (worktree ${dir}) and its diff against ${base}; change no file, commit nothing.`, '');
  const cmd = tests ?? field(card, 'Checks');
  L.push('Tests:', `- Run them only under the shared build lock: \`roadctl lock -- ${cmd ?? '<test command of the project>'}\`.`, ...(cmd ? [] : ['- The card names no test command (Checks): ask the coordinator or take it from the project docs.']), '');
  const stop = field(card, 'Stop conditions');
  const allowed = field(card, 'Allowed changes');
  L.push('Do not:', '- merge into main, push, tag or publish; the coordinator does that after acceptance;', '- run approve or done, or change a card of someone else; the board is changed only with roadctl;', '- touch a worktree of another card or the installed roadctl and its skill;', ...(allowed ? [`- change anything outside: ${allowed}`] : []), ...(stop ? [`Stop and report instead of going on: ${stop}`] : []), '');
  if (role === 'reviewer') {
    L.push(...REVIEW_RULE, '', 'Report:', `- Hand in the verdict as ${to}: first line accept / accept with follow-ups / return; then each blocker with file:line and the scenario; then the "later" list.`, '- You do not run approve, done or accept.', '');
  } else {
    if (role === 'fixer') L.push('Fix only what the review returned (below); one commit per finding, with the test that shows it fixed; do not widen the change.', ...(note ? [`Findings: ${clean(note, 1200)}`] : ['Findings: (not given: ask the coordinator for the review text)']), '');
    L.push('Report:', `- Claim the card if it is delegated to you: \`roadctl claim ${id} --as ${to}\`.`, '- One short Evidence line per criterion with the test or check that shows it (`roadctl log ID --as WHO "aN: ..."`).', `- Then \`roadctl report ${id} --as ${to} "<commits (SHA), the test result, what is not done>"\`. A report without code or without evidence is a claim, not a result.`, '- Answer in a few lines: SHA, test result, what is not done.', '');
  }
  if (note && role !== 'fixer') L.push(`Note from the coordinator: ${clean(note, 800)}`, '');
  L.push(...ECONOMY);
  return L;
}

export default {
  name: 'handoff',
  commands: {
    handoff: {
      group: 'Delegate', effect: 'read', hidden: true,
      summary: 'print the standard assignment text for a card (worker, reviewer, fixer)',
      purpose: 'Builds the assignment for one card from the card and the registry and prints it: the goal, the open criteria, the branch and worktree (the names that `roadctl worktree add ID` creates), the test command under the shared build lock (--tests, else the Checks line of the card Delegation section), what the executor must not do (main, push, tags, approve, done, other worktrees, the installed roadctl), the report format and how to save limits (short caveman style, codegraph, rtk). --role reviewer adds the review rule (return only for a violated criterion, a failing test or incompatibility, or a reproducible defect; otherwise a "later" list; at most two rounds; verdict first); --role fixer lists the findings from --note and tells to fix only those. --to is any name the coordinator uses (an executor, a profile, an orchestrator pair): it is printed and used in the report commands; a name that the registry knows adds its roles. The text is the same for every harness and orchestrator; nothing is sent or written.',
      usage: [USAGE.slice(7)],
      flags: [['--to WHO', 'who gets the assignment (the value they will give to --as)'], ['--role ROLE', 'worker (default), reviewer or fixer'], ['--tests COMMAND', 'the test command to run under the lock (default: Checks of the card)'], ['--base REF', 'the branch the work starts from (default main)'], ['--note TEXT', 'fixer: the review findings; other roles: a note from the coordinator'], ['--repo DIR', 'the repository (default: the git work tree of the current directory)'], ['--json', 'machine-readable: { card, to, role, text }']],
      examples: ['roadctl handoff P5.41 --to pi-developer', 'roadctl handoff P5.41 --to pi-developer --role reviewer', 'roadctl handoff W-3 --to claude-code@home-wsl --role fixer --note "a2: empty file on export" --tests "node --test"'],
      changes: 'Nothing: prints text.',
      exits: '0 printed; 2 usage error, unknown card or no board found',
      run({ flags, args, api, out }) {
        const id = args[1];
        const to = flags.to;
        const role = flags.role === undefined ? 'worker' : flags.role;
        if (args.length !== 2 || !id || typeof to !== 'string' || !WHO_RE.test(to) || !ROLES.includes(role)) throw new Error(USAGE);
        let board;
        try { board = api.loadBoard(api.findBoard(process.cwd(), typeof flags.board === 'string' ? flags.board : undefined)); } catch { throw new Error('no board found; use --board DIR'); }
        const card = board.cards.find((c) => c.header.id === id);
        if (!card) throw new Error(`no card ${id} on the board`);
        let executor = null;
        try {
          const reg = api.loadRegistry();
          const a = reg?.agents?.[to];
          if (a) executor = `registry: roles ${(a.roles ?? []).join(', ') || '-'}${a.model ? `, model ${clean(a.model, 40)}` : ''}`;
        } catch { /* a broken registry is not the business of a text */ }
        const lines = handoffLines({ card, to, role, tests: typeof flags.tests === 'string' ? clean(flags.tests, 300) : null, base: typeof flags.base === 'string' ? clean(flags.base, 60) : 'main', note: typeof flags.note === 'string' ? flags.note : null, repo: repoOf(flags), executor });
        if (flags.json) out(JSON.stringify({ card: id, to, role, text: lines.join('\n') }, null, 2));
        else out(lines.join('\n'));
        return 0;
      },
    },
  },
};
