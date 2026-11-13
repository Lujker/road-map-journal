// Private-marker check for the public repository: names, hosts, paths or words that must never appear in a tracked file.
// The list of markers lives OUTSIDE the repository (the owner's machine): the path is in $ROADCTL_PRIVATE_MARKERS.
// File format: one marker per line, matched as text, ignoring case; empty lines and lines starting with # are ignored.
// This module never prints a marker: a hit is reported as file:line and the number of the marker in the list.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MARKERS_ENV = 'ROADCTL_PRIVATE_MARKERS';
const MAX_BYTES = 2 * 1024 * 1024;

/** Parses the list text into markers (trimmed, lower-cased, without comments and blanks). */
export const parseMarkers = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.toLowerCase());

/** The marker file named by the environment: { markers } when it is usable, { skip: reason } when there is none (not a failure). Throws when the list is inside the repository. */
export function loadMarkers(env, repoRoot) {
  const file = env[MARKERS_ENV];
  if (!file) return { skip: `${MARKERS_ENV} is not set: no private-marker check` };
  if (!fs.existsSync(file)) return { skip: `${MARKERS_ENV} names a file that does not exist` };
  const rel = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(file));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`${MARKERS_ENV} must name a file outside the repository (it would be published with it)`);
  const markers = parseMarkers(fs.readFileSync(file, 'utf8'));
  return markers.length ? { markers } : { skip: `${MARKERS_ENV} names an empty list` };
}

/** The tracked files of the git repository at `root` (relative paths). */
export const trackedFiles = (root) => execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);

/** Scans the tracked files (text files up to 2 MiB; binary files are skipped) and also the file names. Returns [{ file, line, marker }]; line 0 is the file name. */
export function scanTracked(root, markers, files = trackedFiles(root)) {
  const hits = [];
  for (const file of files) {
    const low = file.toLowerCase();
    markers.forEach((m, i) => {
      if (low.includes(m)) hits.push({ file, line: 0, marker: i + 1 });
    });
    const full = path.join(root, file);
    let buf;
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    buf.toString('utf8').split('\n').forEach((text, n) => {
      const l = text.toLowerCase();
      markers.forEach((m, i) => {
        if (l.includes(m)) hits.push({ file, line: n + 1, marker: i + 1 });
      });
    });
  }
  return hits;
}

export const formatHits = (hits) => hits.map((h) => `${h.file}:${h.line} (marker #${h.marker})`);
