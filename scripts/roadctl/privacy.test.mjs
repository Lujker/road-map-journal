// Private markers in the tracked files of this public repository (P5.10 a4).
// The list of markers is kept outside the repository; set ROADCTL_PRIVATE_MARKERS to its path (one marker per line, case-insensitive, # comments).
// Without the list the check is SKIPPED (not failed), so CI and other clones are not affected. Run locally:
//   ROADCTL_PRIVATE_MARKERS=/path/to/private-markers.txt node --test scripts/roadctl/privacy.test.mjs
// The tests of the checker itself use synthetic markers only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatHits, loadMarkers, MARKERS_ENV, parseMarkers, scanTracked, trackedFiles } from '../testkit/privacy.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'ignore' });

test('markers: comments and blank lines are ignored, matching ignores case, a hit is reported as file:line and marker number, never the marker', () => {
  assert.deepEqual(parseMarkers('# a comment\n\n  Alpha-Host  \r\nBeta Corp\n'), ['alpha-host', 'beta corp']);
  const root = tmp('rc-priv-');
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'clean.md'), 'nothing here\nmore text\n');
  fs.writeFileSync(path.join(root, 'docs', 'leak.md'), 'line one\nconnect to ALPHA-host now\nline three\n');
  fs.writeFileSync(path.join(root, 'beta-corp-notes.txt'), 'the name is in the file name only\n');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, ...Buffer.from('alpha-host')]));
  fs.writeFileSync(path.join(root, 'untracked.md'), 'alpha-host in an untracked file\n');
  git(root, 'add', 'docs', 'beta-corp-notes.txt', 'blob.bin');
  git(root, 'commit', '-q', '-m', 'init');
  assert.deepEqual(trackedFiles(root).sort(), ['beta-corp-notes.txt', 'blob.bin', 'docs/clean.md', 'docs/leak.md']);
  const hits = scanTracked(root, parseMarkers('alpha-host\nbeta corp\nbeta-corp'));
  assert.deepEqual(formatHits(hits), ['beta-corp-notes.txt:0 (marker #3)', 'docs/leak.md:2 (marker #1)'], 'binary and untracked files are not scanned; a file name counts');
  assert.ok(!formatHits(hits).join('\n').toLowerCase().includes('alpha-host'), 'the marker text is not printed');
  assert.deepEqual(scanTracked(root, ['no-such-marker']), []);
});

test('marker list: not set, missing or empty is a skip; a list inside the repository is refused; a good list loads', () => {
  const root = tmp('rc-priv-root-');
  const outside = tmp('rc-priv-out-');
  assert.match(loadMarkers({}, root).skip, /not set/);
  assert.match(loadMarkers({ [MARKERS_ENV]: path.join(outside, 'none.txt') }, root).skip, /does not exist/);
  fs.writeFileSync(path.join(outside, 'empty.txt'), '# nothing\n');
  assert.match(loadMarkers({ [MARKERS_ENV]: path.join(outside, 'empty.txt') }, root).skip, /empty/);
  fs.writeFileSync(path.join(root, 'inside.txt'), 'marker\n');
  assert.throws(() => loadMarkers({ [MARKERS_ENV]: path.join(root, 'inside.txt') }, root), /outside the repository/);
  fs.writeFileSync(path.join(outside, 'good.txt'), 'Marker-One\n');
  assert.deepEqual(loadMarkers({ [MARKERS_ENV]: path.join(outside, 'good.txt') }, root), { markers: ['marker-one'] });
});

// The real check. Skipped without the list; with it, no tracked file of this repository may contain a marker.
const loaded = (() => {
  try {
    return loadMarkers(process.env, repo);
  } catch (error) {
    return { error };
  }
})();
test('no tracked file of the repository contains a private marker', { skip: loaded.skip }, () => {
  if (loaded.error) throw loaded.error;
  const hits = formatHits(scanTracked(repo, loaded.markers));
  assert.deepEqual(hits, [], 'private markers in tracked files (the list is outside the repository; fix the files, not the list)');
});
