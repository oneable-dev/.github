/**
 * gitops
 *
 * What: Every git operation the driver performs: protected paths, commits, pushes, credential scrubbing.
 * Why: Fix agents and L0 commands edit a checkout that holds a repository token's reach. Commits must
 *      never carry changes to configuration that would run in a later agent session or workflow, and
 *      pushes must never rewrite history.
 * Not covered: Deciding when to commit (driver.mjs).
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { redact } from './util.mjs';

/** Paths restored from the base branch, the same list claude-code-action protects. */
export const RESTORE_PATHS = [
  '.claude', '.mcp.json', '.claude.json', '.gitmodules', '.ripgreprc',
  'CLAUDE.md', 'CLAUDE.local.md', '.husky',
];
/** Paths that are never staged. `.claude-pr` is the action's snapshot of the PR's own versions. */
export const NO_STAGE_PATHS = [...RESTORE_PATHS, '.claude-pr'];
export const WORKFLOWS_DIR = '.github/workflows';

export const BOT_NAME = 'github-actions[bot]';
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

// Same rules as claude-code-action's validateBranchName.
export function validBranchName(name) {
  if (!name || !name.trim() || name.startsWith('-')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F ~^:?*[\]\\]/.test(name)) return false;
  if (!/^[a-zA-Z0-9@_][a-zA-Z0-9/_.#+,@()-]*$/.test(name)) return false;
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) return false;
  if (name.includes('//') || name.includes('..') || name.includes('@{') || name === '@') return false;
  return true;
}

export function headSha(rt) {
  return rt.git(['rev-parse', 'HEAD']).stdout.trim();
}

export function commitExists(rt, sha) {
  return /^[0-9a-f]{40}$/.test(sha || '') && rt.git(['cat-file', '-e', `${sha}^{commit}`], { check: false }).status === 0;
}

export function isAncestor(rt, ancestor, descendant) {
  return rt.git(['merge-base', '--is-ancestor', ancestor, descendant], { check: false }).status === 0;
}

/** The oldest of several commits on one line of history. Falls back to `fallback` when they diverge. */
export function oldestOf(rt, shas, fallback) {
  const list = [...new Set(shas.filter(Boolean))];
  if (list.length === 0) return fallback;
  let oldest = list[0];
  for (const s of list.slice(1)) {
    if (isAncestor(rt, s, oldest)) oldest = s;
    else if (!isAncestor(rt, oldest, s)) return fallback;
  }
  return oldest;
}

/** Remove credentials from the origin URL (the action puts the token there). */
export function cleanOriginUrl(rt) {
  const r = rt.git(['remote', 'get-url', 'origin'], { check: false });
  if (r.status !== 0) return;
  const url = r.stdout.trim();
  const clean = url.replace(/^(https?:\/\/)[^@/]+@/, '$1');
  if (clean !== url) rt.git(['remote', 'set-url', 'origin', clean]);
}

/** Remove the extraheader that actions/checkout persisted, from local config and from included files. */
export function scrubCheckoutCredentials(rt) {
  const server = (rt.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
  const key = `http.${server}/.extraheader`;
  rt.git(['config', '--local', '--unset-all', key], { check: false });
  const inc = rt.git(['config', '--local', '--get-regexp', '^include(if\\..*)?\\.path$'], { check: false });
  if (inc.status !== 0) return;
  const gitDir = rt.git(['rev-parse', '--absolute-git-dir'], { check: false }).stdout.trim();
  for (const line of inc.stdout.split('\n')) {
    const value = line.replace(/^\S+\s+/, '').trim();
    if (!value) continue;
    const file = isAbsolute(value) ? value : join(gitDir, value);
    rt.git(['config', '--file', file, '--unset-all', key], { check: false });
  }
}

/** Resolve `origin/<base>`; fetch it with an explicit header when the clone does not have it. */
export function ensureBaseRef(rt, state) {
  if (!validBranchName(state.base_ref)) return null;
  const ref = `refs/remotes/origin/${state.base_ref}`;
  const has = () => rt.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { check: false }).status === 0;
  if (has()) return `origin/${state.base_ref}`;
  rt.git([...authArgs(rt), 'fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin',
    `+refs/heads/${state.base_ref}:${ref}`], { check: false, timeout: 120000 });
  return has() ? `origin/${state.base_ref}` : null;
}

export function authArgs(rt) {
  const token = rt.env.GH_TOKEN || rt.env.GITHUB_TOKEN;
  if (!token) return [];
  const server = new URL(rt.env.GITHUB_SERVER_URL || 'https://github.com').origin;
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  rt.secrets.push(token, b64);
  const key = `http.${server}/.extraheader`;
  // The empty value resets any header configured elsewhere, so GitHub never sees two Authorization headers.
  return ['-c', `${key}=`, '-c', `${key}=AUTHORIZATION: basic ${b64}`];
}

function removePaths(rt, paths) {
  for (const p of paths) rmSync(join(rt.cwd, p), { recursive: true, force: true });
}

function resetIndex(rt, paths) {
  rt.git(['reset', '-q', '--', ...paths], { check: false });
}

/** Protected paths come from the base branch, so a later agent session never loads PR-authored config. */
export function restoreProtectedFromBase(rt, state) {
  const base = ensureBaseRef(rt, state);
  removePaths(rt, RESTORE_PATHS);
  let restored = false;
  if (base) {
    for (const p of RESTORE_PATHS) rt.git(['checkout', base, '--', p], { check: false });
    restored = true;
  }
  resetIndex(rt, RESTORE_PATHS);
  return restored;
}

/** Protected paths as the PR has them, so L0 checks the real tree. */
export function restoreProtectedFromHead(rt) {
  removePaths(rt, RESTORE_PATHS);
  for (const p of RESTORE_PATHS) rt.git(['checkout', 'HEAD', '--', p], { check: false });
  resetIndex(rt, RESTORE_PATHS);
}

function walk(root, rel, hash) {
  const abs = join(root, rel);
  let st;
  try { st = lstatSync(abs); } catch { hash.update(`${rel}\0missing\0`); return; }
  if (st.isSymbolicLink()) hash.update(`${rel}\0link\0${readlinkSync(abs)}\0`);
  else if (st.isDirectory()) {
    hash.update(`${rel}\0dir\0`);
    for (const name of readdirSync(abs).sort()) walk(root, join(rel, name), hash);
  } else {
    hash.update(`${rel}\0file\0${st.mode & 0o111 ? 'x' : '-'}\0`);
    hash.update(readFileSync(abs));
    hash.update('\0');
  }
}

/** One hash over the working-tree state of the protected paths. */
export function snapshotProtected(rt) {
  const hash = createHash('sha256');
  for (const p of RESTORE_PATHS) walk(rt.cwd, p, hash);
  return hash.digest('hex');
}

/** Undo any edit under .github/workflows. Returns the changed paths. */
export function revertWorkflows(rt) {
  const r = rt.git(['status', '--porcelain', '--untracked-files=all', '-z', '--', WORKFLOWS_DIR], { check: false });
  const changed = r.stdout.split('\0').filter(Boolean).map((l) => l.slice(3));
  if (changed.length === 0) return [];
  rt.git(['checkout', 'HEAD', '--', WORKFLOWS_DIR], { check: false });
  rt.git(['clean', '-fdq', '--', WORKFLOWS_DIR], { check: false });
  return changed;
}

export function listUntracked(rt) {
  const r = rt.git(['ls-files', '--others', '--exclude-standard', '-z'], { check: false });
  return r.stdout.split('\0').filter(Boolean);
}

/** Throw away everything a failed agent slot left behind (tracked edits and untracked non-ignored files). */
export function discardChanges(rt, keepUntracked = []) {
  rt.git(['reset', '-q', '--hard', 'HEAD']);
  const keep = new Set(keepUntracked);
  const now = listUntracked(rt).filter((p) => !keep.has(p) && !NO_STAGE_PATHS.some((n) => p === n || p.startsWith(`${n}/`)));
  for (const p of now) {
    if (p.split('/').includes('..') || isAbsolute(p)) continue;
    rmSync(join(rt.cwd, p), { recursive: true, force: true });
  }
}

/**
 * Stage and commit as github-actions[bot]. Returns the new sha, or null when there is nothing to commit.
 * `skipUntracked` are files that were already untracked before the change (L0 build output and similar).
 */
export function commitAll(rt, message, skipUntracked = []) {
  const pathspec = ['.', ...NO_STAGE_PATHS.map((p) => `:(exclude)${p}`), `:(exclude)${WORKFLOWS_DIR}`];
  rt.git(['add', '-A', '--', ...pathspec]);
  if (skipUntracked.length) {
    rt.git(['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${skipUntracked.join('\0')}\0`, check: false });
  }
  if (rt.git(['diff', '--cached', '--quiet'], { check: false }).status === 0) return null;
  const env = {
    ...rt.trusted(),
    GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL,
  };
  rt.git([
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false',
    '-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`,
    'commit', '--no-verify', '--no-gpg-sign', '-F', '-',
  ], { input: message, env });
  return headSha(rt);
}

/** Non-force push of HEAD to the PR branch. */
export function pushHead(rt, state) {
  if (!validBranchName(state.head_ref)) return { ok: false, error: 'invalid head branch name' };
  const r = rt.git([...authArgs(rt), 'push', 'origin', `HEAD:refs/heads/${state.head_ref}`], { check: false, timeout: 120000 });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: redact(r.stderr.trim().split('\n').slice(-6).join('\n'), rt.secrets).slice(0, 800) };
}

/** Changed files between two commits (three-dot when `triple` is true). */
export function changedFiles(rt, from, to, triple = false) {
  const r = rt.git(['diff', '--name-only', '-z', triple ? `${from}...${to}` : `${from}`, ...(triple ? [] : [to])], { check: false });
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : [];
}
