// Version and checksum of a roadctl copy (P5.9). Not a module (no default export, not listed in index.mjs): a helper that
// doctor.mjs, `roadctl --version` and scripts/update-installed.mjs share, so that all three compute the same number.
//
// A copy is `roadctl.mjs` plus the `.mjs` files of the `roadctl/` folder next to it (test files excluded: they are not installed).
// The checksum is the SHA-256 over the sorted list of `<relative path> NUL <content with LF line endings> NUL`; a short form (12 hex
// characters) is what people read. Line endings are normalised because a Windows checkout may have CRLF; the installer does the same.
// Node standard library only; no side effects at import.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALLED_JSON = 'installed.json';
const norm = (t) => t.replace(/\r\n/g, '\n');
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** The version a copy declares (`export const VERSION = '0.2.0'` in its roadctl.mjs), read as text; null when the file is missing or has none. */
export function declaredVersion(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'roadctl.mjs'), 'utf8').match(/^export const VERSION = '([^']+)'/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Relative names of the files that make up a copy, sorted: roadctl.mjs and roadctl/*.mjs without *.test.mjs. Empty when there is no roadctl.mjs. */
export function copyFiles(dir) {
  if (!fs.existsSync(path.join(dir, 'roadctl.mjs'))) return [];
  const mods = path.join(dir, 'roadctl');
  let names = [];
  try {
    names = fs.readdirSync(mods, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')).map((e) => `roadctl/${e.name}`);
  } catch {
    /* no modules folder: a lone roadctl.mjs is a (partial) copy */
  }
  return ['roadctl.mjs', ...names.sort()];
}

/** { sha, short, files: { rel: 12 hex }, count, hasModules, version } of the copy in `dir`; sha is null for a directory without roadctl.mjs. */
export function fingerprint(dir) {
  const rels = copyFiles(dir);
  const files = {};
  const h = crypto.createHash('sha256');
  for (const rel of rels) {
    const text = norm(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
    files[rel] = sha256(text).slice(0, 12);
    h.update(`${rel}\0${text}\0`);
  }
  const sha = rels.length ? h.digest('hex') : null;
  return { sha, short: sha ? sha.slice(0, 12) : null, files, count: rels.length, hasModules: rels.length > 1 || fs.existsSync(path.join(dir, 'roadctl', 'index.mjs')), version: declaredVersion(dir) };
}

/** The record `update-installed.mjs --roadctl --apply` leaves next to the installed copy; null when absent or unreadable. */
export function readInstalledJson(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, INSTALLED_JSON), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * Write installed.json for the copy in `dir`: { schema, version, sha, files, installed_at }. `at` is the install time (ISO), a parameter so tests
 * do not read the clock. Nothing is rewritten when version, sha and files are the same (installed_at stays). Returns 'write' or 'unchanged';
 * null when `dir` holds no copy.
 */
export function writeInstalledJson(dir, at) {
  const fp = fingerprint(dir);
  if (!fp.sha) return null;
  const prev = readInstalledJson(dir);
  if (prev && prev.version === fp.version && prev.sha === fp.sha && JSON.stringify(prev.files) === JSON.stringify(fp.files)) return 'unchanged';
  fs.writeFileSync(path.join(dir, INSTALLED_JSON), `${JSON.stringify({ schema: 1, version: fp.version, sha: fp.sha, files: fp.files, installed_at: at }, null, 2)}\n`);
  return 'write';
}

/** `roadctl --version`: one line, "roadctl <version> sha:<12 hex>". `metaUrl` is import.meta.url of roadctl.mjs. */
export function versionLine(version, metaUrl) {
  const { short } = fingerprint(path.dirname(fileURLToPath(metaUrl)));
  return `roadctl ${version} sha:${short ?? 'unknown'}`;
}
