// Tests of the module seams (registry.mjs, index.mjs, probe.mjs and their wiring in roadctl.mjs).
// Run: node --test scripts/roadctl/registry.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rc from '../roadctl.mjs';
import { buildRegistry } from './registry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..');
const EXAMPLE = path.join(scripts, '..', 'examples', 'board-example', 'board');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (script, args, { cwd, env = {} } = {}) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ROADCTL_DATE: '2026-11-10', ...env } });
const SELF = path.join(scripts, 'roadctl.mjs');

const help = (extra = {}) => ({ group: 'Look', effect: 'read', summary: 's', purpose: 'p', usage: ['u'], flags: [], examples: ['e'], changes: 'Nothing.', exits: '0', run: () => 0, ...extra });
const opts = { builtin: { status: {} }, groups: ['Look', 'Setup'], knownKeys: new Set(['id']) };

test('buildRegistry merges commands, header keys and tick hooks of valid modules', () => {
  const tick = () => {};
  const r = buildRegistry([{ name: 'a', commands: { 'a-cmd': help() }, headerKeys: ['a_key'] }, { name: 'b', tick }], opts);
  assert.deepEqual(r.modules, ['a', 'b']);
  assert.deepEqual(Object.keys(r.commands), ['a-cmd']);
  assert.deepEqual([...r.headerKeys], ['a_key']);
  assert.deepEqual(r.tickHooks.map((h) => [h.module, h.fn]), [['b', tick]]);
  const none = buildRegistry([], opts);
  assert.deepEqual([none.modules, Object.keys(none.commands), none.headerKeys.size, none.tickHooks.length], [[], [], 0, 0]);
});

test('buildRegistry refuses clashes and malformed modules instead of changing old behaviour', () => {
  const bad = (m, re) => assert.throws(() => buildRegistry(Array.isArray(m) ? m : [m], opts), re);
  bad({ name: 'x', commands: { status: help() } }, /command status already exists/); // a built-in command
  bad([{ name: 'x', commands: { c: help() } }, { name: 'y', commands: { c: help() } }], /command c already exists/);
  bad([{ name: 'x' }, { name: 'x' }], /duplicate module name/);
  bad({ commands: {} }, /needs a name/);
  bad({ name: 'Bad Name' }, /needs a name/);
  bad({ name: 'x', commands: { 'Bad': help() } }, /bad command name/);
  bad({ name: 'x', commands: { c: help({ run: undefined }) } }, /needs run/);
  bad({ name: 'x', commands: { c: help({ group: 'Nope' }) } }, /group must be one of/);
  bad({ name: 'x', commands: { c: help({ effect: 'delete' }) } }, /effect must be one of/);
  bad({ name: 'x', commands: { c: help({ purpose: '' }) } }, /help field purpose is missing/);
  bad({ name: 'x', commands: { c: help({ examples: [] }) } }, /usage and examples must not be empty/);
  bad({ name: 'x', headerKeys: ['id'] }, /header key id is already known/);
  bad([{ name: 'x', headerKeys: ['k'] }, { name: 'y', headerKeys: ['k'] }], /header key k is already known/);
  bad({ name: 'x', headerKeys: ['Bad Key'] }, /bad header key/);
  bad({ name: 'x', tick: 'no' }, /tick must be a function/);
});

test('runTickHooks gives each hook its own copy and survives a failing hook', async () => {
  const seen = [];
  const r = buildRegistry([
    { name: 'a', tick: (c) => { c.items.push('mutated'); c.boardDirs.x = 1; seen.push(['a', c.decision]); } },
    { name: 'b', tick: () => { throw new Error('boom\nsecond line'); } },
    { name: 'c', tick: async (c) => { seen.push(['c', c.items.length, 'x' in c.boardDirs]); } },
  ], opts);
  const items = ['one'];
  let err = '';
  await r.runTickHooks({ agent: 'x', decision: 'idle', limits: { state: 'not-checked' }, items, sync: [], boardDirs: {} }, { err: (s) => { err += s; } });
  assert.deepEqual(items, ['one'], 'the caller data is not changed by a hook');
  assert.deepEqual(seen, [['a', 'idle'], ['c', 1, false]]);
  assert.equal(err, 'roadctl tick: warning: module b: tick hook failed: boom second line\n');
  await buildRegistry([], opts).runTickHooks({ items: [] }, { err: () => assert.fail('no hooks: nothing is printed') });
});

// ---------------------------------------------------------------- the shipped probe module (criterion a3)

test('probe module: registers a hidden command and its help through the real CLI, old tables unchanged', () => {
  assert.deepEqual(rc.ALL_COMMANDS['module-probe'] && Object.keys(rc.ALL_COMMANDS).filter((c) => !Object.hasOwn(rc.COMMANDS, c)), ['module-probe']);
  assert.equal(Object.hasOwn(rc.COMMANDS, 'module-probe'), false, 'COMMANDS stays the built-in table');
  const r = run(SELF, ['module-probe']);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'module-probe: ok; modules: probe\n', '']);
  assert.deepEqual(JSON.parse(run(SELF, ['module-probe', '--json']).stdout), { modules: ['probe'] });
  const h = run(SELF, ['help', 'module-probe']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^roadctl module-probe \[read\]:/);
  for (const part of ['Usage:', 'Examples:', 'Changes:', 'Exit codes:']) assert.ok(h.stdout.includes(part), part);
  assert.equal(run(SELF, ['module-probe', '--help']).stdout, h.stdout);
  assert.doesNotMatch(run(SELF, ['help']).stdout, /module-probe/, 'hidden: not in the overview');
});

// ---------------------------------------------------------------- criterion a2: help = dispatcher = docs, module commands included

test('help and docs: every command of ALL_COMMANDS (built-in and module) has help and --help with the same text; visible module commands are in the overview and in docs/roadctl.md', () => {
  const overview = run(SELF, ['help']).stdout;
  const docs = fs.readFileSync(path.join(scripts, '..', 'docs', 'roadctl.md'), 'utf8');
  const names = Object.keys(rc.ALL_COMMANDS);
  assert.ok(names.length > Object.keys(rc.COMMANDS).length, 'at least one module command is registered');
  for (const c of names) {
    const h = run(SELF, ['help', c]);
    assert.equal(h.status, 0, c);
    assert.match(h.stdout, new RegExp(`^roadctl ${c} \\[(read|write|git)\\]:`), c);
    for (const part of ['Usage:', 'Examples:', 'Changes:', 'Exit codes:']) assert.ok(h.stdout.includes(part), `${c}: ${part}`);
    assert.equal(run(SELF, [c, '--help']).stdout, h.stdout, `${c} --help`);
    if (Object.hasOwn(rc.COMMANDS, c) || rc.ALL_COMMANDS[c].hidden) continue;
    assert.match(overview, new RegExp(`^  ${c} +\\[(read|write|git)\\]`, 'm'), `${c} in the overview`);
    assert.match(docs, new RegExp(`roadctl ${c}\\b`), `${c} in docs/roadctl.md`);
  }
});

// ---------------------------------------------------------------- the whole mechanism end to end in a throwaway install (fixture modules, nothing shipped)

const FIXTURE = `export default {
  name: 'fixture',
  commands: {
    'fixture-cmd': {
      group: 'Look', effect: 'read', summary: 'fixture command', purpose: 'A fixture.', usage: ['roadctl fixture-cmd'], flags: [], examples: ['roadctl fixture-cmd'], changes: 'Nothing.', exits: '0',
      run({ args, flags, env, api, modules }) {
        console.log(JSON.stringify({ args, flags, version: api.VERSION, helpers: Object.keys(api).sort(), modules, board: api.findBoard(process.cwd(), flags.board) }));
        return Number(env.FIXTURE_EXIT ?? 0);
      },
    },
  },
  headerKeys: ['fx_note'],
};
`;
const FIXTURE_TICK = `import fs from 'node:fs';
export default {
  name: 'fixture-tick',
  tick(ctx) { fs.appendFileSync(process.env.FIXTURE_TICK_LOG, JSON.stringify({ agent: ctx.agent, decision: ctx.decision, items: ctx.items.length, api: typeof ctx.api.findBoard }) + '\\n'); },
};
`;
const FIXTURE_BAD = `export default { name: 'fixture-bad', tick() { throw new Error('hook exploded'); } };\n`;

/** A copy of roadctl.mjs and its roadctl/ folder in a temp dir with extra modules appended to index.mjs. */
function install(extra = {}) {
  const dir = tmp('rcm-install-');
  fs.copyFileSync(SELF, path.join(dir, 'roadctl.mjs'));
  fs.cpSync(here, path.join(dir, 'roadctl'), { recursive: true, filter: (s) => !s.endsWith('.test.mjs') });
  let index = fs.readFileSync(path.join(dir, 'roadctl', 'index.mjs'), 'utf8');
  const names = [];
  for (const [file, text] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, 'roadctl', `${file}.mjs`), text);
    const id = file.replace(/\W/g, '_');
    index = index.replace("import probe from './probe.mjs';", `import probe from './probe.mjs';\nimport ${id} from './${file}.mjs';`);
    names.push(id);
  }
  fs.writeFileSync(path.join(dir, 'roadctl', 'index.mjs'), index.replace('[probe]', `[probe, ${names.join(', ')}]`));
  return path.join(dir, 'roadctl.mjs');
}
function project() {
  const root = tmp('rcm-proj-');
  fs.cpSync(EXAMPLE, path.join(root, 'board'), { recursive: true });
  return root;
}

test('a module command runs from an installed copy: dispatch, help, overview, ctx and exit code', () => {
  const bin = install({ fixture: FIXTURE });
  const root = project();
  const r = run(bin, ['fixture-cmd', 'x', '--flag'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual([o.args, o.flags, o.version, o.modules], [['fixture-cmd', 'x'], { flag: true }, rc.VERSION, ['probe', 'fixture']]);
  assert.equal(fs.realpathSync(o.board), fs.realpathSync(path.join(root, 'board')));
  assert.deepEqual(o.helpers, ['VERSION', 'findBoard', 'hasBoardSources', 'knownBoards', 'lint', 'loadBoard', 'loadRegistry', 'sanitize', 'today']);
  assert.equal(run(bin, ['fixture-cmd'], { cwd: root, env: { FIXTURE_EXIT: '1' } }).status, 1);
  assert.match(run(bin, ['help'], { cwd: root }).stdout, /^  fixture-cmd +\[read\] +fixture command$/m);
  assert.match(run(bin, ['fixture-cmd', '--help'], { cwd: root }).stdout, /^roadctl fixture-cmd \[read\]: fixture command/);
  assert.equal(run(bin, ['module-probe'], { cwd: root }).stdout, 'module-probe: ok; modules: probe, fixture\n');
  // the built-in commands are unaffected
  assert.equal(run(bin, ['version'], { cwd: root }).stdout, `${rc.VERSION}\n`);
  assert.equal(run(bin, ['lint'], { cwd: root }).status, run(SELF, ['lint'], { cwd: root }).status);
});

test('a module header key is not an unknown key; without the module it is', () => {
  const root = project();
  const card = fs.readdirSync(path.join(root, 'board', 'cards')).find((f) => f.startsWith('W-6'));
  const p = path.join(root, 'board', 'cards', card);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^as_of: .*$/m, (m) => `${m}\nfx_note: hello`));
  const warn = (bin) => JSON.parse(run(bin, ['lint', '--json'], { cwd: root }).stdout).filter((x) => /unknown key/.test(x.msg)).map((x) => x.msg);
  assert.deepEqual(warn(SELF), ['unknown key fx_note']);
  assert.deepEqual(warn(install({ fixture: FIXTURE })), []);
});

test('tick hooks of all modules run once per finished tick; a failing hook is a warning and changes neither output nor exit code', () => {
  const root = project();
  const state = tmp('rcm-state-');
  const log = path.join(state, 'hook.log');
  const env = { XDG_STATE_HOME: state, ROADCTL_REGISTRY: path.join(state, 'none.json'), FIXTURE_TICK_LOG: log };
  const stock = run(SELF, ['tick', '--as', 'worker', '--no-pull'], { cwd: root, env });
  const bin = install({ fixture_tick: FIXTURE_TICK, fixture_bad: FIXTURE_BAD });
  const r = run(bin, ['tick', '--as', 'worker', '--no-pull'], { cwd: root, env });
  assert.deepEqual([r.status, r.stdout], [stock.status, stock.stdout], 'output and exit code as without modules');
  assert.equal(r.stderr, 'roadctl tick: warning: module fixture-bad: tick hook failed: hook exploded\n');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].agent, lines[0].decision, lines[0].api], ['worker', 'idle', 'function']);
  assert.equal(JSON.parse(run(bin, ['tick', '--as', 'worker', '--no-pull', '--json'], { cwd: root, env }).stdout).decision, 'idle');
});

test('a copy of roadctl.mjs without its roadctl/ folder still runs the built-in commands, without module commands', () => {
  const dir = tmp('rcm-lone-');
  fs.copyFileSync(SELF, path.join(dir, 'roadctl.mjs'));
  const bin = path.join(dir, 'roadctl.mjs');
  assert.equal(run(bin, ['version']).stdout, `${rc.VERSION}\n`);
  assert.match(run(bin, ['help']).stdout, /^Look:$/m);
  const r = run(bin, ['module-probe']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command module-probe/);
});

test('a broken modules folder is not hidden: a module that fails to load stops roadctl with the error', () => {
  const bin = install({ broken: "import './missing-dependency.mjs';\nexport default { name: 'broken' };\n" });
  const r = run(bin, ['version']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing-dependency\.mjs/);
});
