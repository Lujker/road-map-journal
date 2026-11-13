import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, folderHash, nodeOk, syncRoadctl } from './update-installed.mjs';
import { MODULES } from './roadctl/index.mjs';

test('nodeOk enforces the skills CLI minimum', () => {
  assert.equal(nodeOk('20.17.0'), false);
  assert.equal(nodeOk('22.19.9'), false);
  assert.equal(nodeOk('22.20.0'), true);
  assert.equal(nodeOk('26.12.1'), true);
});

test('folderHash ignores CRLF and detects edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmj-test-'));
  try {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    for (const d of [a, b]) fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    fs.writeFileSync(path.join(a, 'SKILL.md'), 'one\ntwo\n');
    fs.writeFileSync(path.join(a, 'references', 'x.md'), 'x\n');
    fs.writeFileSync(path.join(b, 'SKILL.md'), 'one\r\ntwo\r\n');
    fs.writeFileSync(path.join(b, 'references', 'x.md'), 'x\r\n');
    assert.equal(folderHash(a), folderHash(b));
    fs.appendFileSync(path.join(b, 'SKILL.md'), 'local\n');
    assert.notEqual(folderHash(a), folderHash(b));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('decide covers the update states', () => {
  const lock = { skillFolderHash: 'old' };
  assert.equal(decide({ canonicalExists: false }).state, 'NOT_INSTALLED');
  assert.equal(decide({ canonicalExists: true, lockEntry: null, installedHash: 'old', upstreamHash: 'new' }).state, 'UNTRACKED');
  assert.equal(decide({ canonicalExists: true, lockEntry: lock, installedHash: 'new', upstreamHash: 'new' }).state, 'UP_TO_DATE');
  assert.equal(decide({ canonicalExists: true, lockEntry: lock, installedHash: 'old', upstreamHash: 'new' }).state, 'OUTDATED');
  assert.equal(decide({ canonicalExists: true, lockEntry: lock, installedHash: 'edited', upstreamHash: 'new' }).state, 'LOCALLY_MODIFIED');
});

test('syncRoadctl installs, updates with a backup, and is a no-op when equal (CRLF ignored)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmj-sync-'));
  try {
    const src = path.join(root, 'roadctl.mjs');
    const home = path.join(root, 'home');
    fs.writeFileSync(src, 'v1\n');
    assert.match(syncRoadctl(home, src, false).action, /would install/);
    assert.equal(fs.existsSync(path.join(home, '.local')), false, 'dry run writes nothing');
    assert.equal(syncRoadctl(home, src).action, 'install');
    assert.equal(syncRoadctl(home, src).action, 'unchanged');
    fs.writeFileSync(src, 'v1\r\n');
    assert.equal(syncRoadctl(home, src).action, 'unchanged');
    fs.writeFileSync(src, 'v2\n');
    const r = syncRoadctl(home, src);
    assert.equal(r.action, 'update');
    assert.equal(fs.readFileSync(r.dest, 'utf8'), 'v2\n');
    assert.ok(fs.readdirSync(path.dirname(r.dest)).some((n) => n.includes('.bak-')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- P5.16: roadctl is a core file plus a roadctl/ folder of modules

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const runInstalled = (bin, args, cwd) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: path.join(cwd, '.cfg'), XDG_STATE_HOME: path.join(cwd, '.state') } });

test('syncRoadctl installs roadctl.mjs and its roadctl/ modules without tests; the installed copy runs from the install directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmj-inst-'));
  try {
    const home = path.join(root, 'home');
    const t = syncRoadctl(home, path.join(scriptsDir, 'roadctl.mjs'));
    assert.equal(t.action, 'install');
    const dir = path.dirname(t.dest);
    const installed = fs.readdirSync(path.join(dir, 'roadctl')).sort();
    assert.ok(installed.includes('index.mjs') && installed.includes('registry.mjs') && installed.includes('probe.mjs'), installed.join(','));
    assert.deepEqual(installed.filter((n) => n.includes('test')), [], 'test files are not installed');
    // run it from a directory that is not a checkout: a project with a board
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.cpSync(path.join(scriptsDir, '..', 'examples', 'board-example', 'board'), path.join(project, 'board'), { recursive: true });
    const help = runInstalled(t.dest, ['help'], project);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^roadctl: read and update a project board/);
    assert.equal(runInstalled(t.dest, ['module-probe'], project).stdout, `module-probe: ok; modules: ${MODULES.map((m) => m.name).join(', ')}\n`);
    assert.match(runInstalled(t.dest, ['help', 'module-probe'], project).stdout, /^roadctl module-probe \[read\]:/);
    const where = runInstalled(t.dest, ['where'], project);
    assert.equal(where.status, 0, where.stderr);
    assert.equal(fs.realpathSync(where.stdout.trim()), fs.realpathSync(path.join(project, 'board')));
    // a second run changes nothing
    const again = syncRoadctl(home, path.join(scriptsDir, 'roadctl.mjs'));
    assert.equal(again.action, 'unchanged');
    assert.ok(again.files.every((f) => f.action === 'unchanged'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('syncRoadctl mirrors the modules folder: a dry run writes nothing, a changed module is backed up, a vanished module is moved aside', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmj-mirror-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'roadctl'), { recursive: true });
    fs.writeFileSync(path.join(src, 'roadctl.mjs'), 'core\n');
    fs.writeFileSync(path.join(src, 'roadctl', 'a.mjs'), 'a1\n');
    fs.writeFileSync(path.join(src, 'roadctl', 'a.test.mjs'), 'test\n');
    const home = path.join(root, 'home');
    assert.match(syncRoadctl(home, path.join(src, 'roadctl.mjs'), false).action, /would install/);
    assert.equal(fs.existsSync(path.join(home, '.local')), false, 'dry run writes nothing');
    const first = syncRoadctl(home, path.join(src, 'roadctl.mjs'));
    assert.deepEqual(first.files, [{ rel: 'roadctl.mjs', action: 'install' }, { rel: 'roadctl/a.mjs', action: 'install' }]);
    const mods = path.join(path.dirname(first.dest), 'roadctl');
    fs.writeFileSync(path.join(mods, 'gone.mjs'), 'old module\n');
    // only a module changed: the helper as a whole is an update
    fs.writeFileSync(path.join(src, 'roadctl', 'a.mjs'), 'a2\n');
    fs.writeFileSync(path.join(src, 'roadctl', 'b.mjs'), 'b1\n');
    const dry = syncRoadctl(home, path.join(src, 'roadctl.mjs'), false);
    assert.equal(dry.action, 'would update');
    assert.equal(fs.readFileSync(path.join(mods, 'a.mjs'), 'utf8'), 'a1\n');
    const second = syncRoadctl(home, path.join(src, 'roadctl.mjs'));
    assert.equal(second.action, 'update');
    assert.deepEqual(second.files, [{ rel: 'roadctl.mjs', action: 'unchanged' }, { rel: 'roadctl/a.mjs', action: 'update' }, { rel: 'roadctl/b.mjs', action: 'install' }, { rel: 'roadctl/gone.mjs', action: 'remove' }]);
    assert.equal(fs.readFileSync(path.join(mods, 'a.mjs'), 'utf8'), 'a2\n');
    const names = fs.readdirSync(mods);
    assert.ok(names.some((n) => n.startsWith('a.mjs.bak-')), 'the changed module is backed up');
    assert.ok(names.some((n) => n.startsWith('gone.mjs.bak-')) && !names.includes('gone.mjs'), 'the vanished module is moved aside');
    assert.equal(names.includes('a.test.mjs'), false);
    assert.equal(syncRoadctl(home, path.join(src, 'roadctl.mjs')).action, 'unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
