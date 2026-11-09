/**
 * scope
 *
 * What: Decides the review scope from the markers in earlier summary comments, and reads or writes
 *       the hidden state marker that carries unresolved findings to the next run.
 * Why: Same rule as the original workflow: the base of an incremental review is the head recorded in the
 *      newest `claude-review:head` marker of a github-actions[bot] comment, never github.event.before.
 *      A failed or cancelled run posts no marker, so its changes are reviewed next time.
 *      A comment only counts when it looks like the driver's own report: it is from github-actions[bot],
 *      its first line is REPORT_HEADER, and it carries both the state marker and the head marker.
 *      Any workflow in the repository can comment as github-actions[bot], so this narrows what a stray
 *      or forged comment can do; it is not authentication. Whoever can write such a comment already has
 *      write access to the repository.
 * Not covered: Posting comments (report.mjs).
 */
import { commitExists, isAncestor } from './gitops.mjs';

const HEAD_RE = /<!-- claude-review:head=([0-9a-f]{40}) -->/g;
const STATE_RE = /<!-- claude-review:state=([A-Za-z0-9_-]+) -->/;

/** First line of every summary comment the driver posts. */
export const REPORT_HEADER = '## Claude Review';

/** True for a comment body that has the driver report's header and both of its markers. */
export function isDriverReport(body) {
  const text = String(body ?? '');
  if (text.split('\n', 1)[0].trim() !== REPORT_HEADER) return false;
  return STATE_RE.test(text) && new RegExp(HEAD_RE.source).test(text);
}

export const headMarker = (sha) => `<!-- claude-review:head=${sha} -->`;

export function encodeStateMarker(payload) {
  return `<!-- claude-review:state=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')} -->`;
}

export function decodeStateMarker(body) {
  const m = STATE_RE.exec(body || '');
  if (!m) return null;
  try {
    const data = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return data && data.v === 1 ? data : null;
  } catch {
    return null;
  }
}

/** Bodies of all github-actions[bot] issue comments on the PR, oldest first. */
export function fetchBotComments(rt, repo, pr) {
  const r = rt.gh([
    'api', '--paginate', `repos/${repo}/issues/${pr}/comments`,
    '--jq', '.[] | select(.user.login == "github-actions[bot]") | .body | @json',
  ], { check: false });
  if (r.status !== 0) return [];
  const bodies = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try { bodies.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return bodies;
}

/** The newest head marker, and the state marker from the same comment. Comments that are not driver reports are skipped. */
export function lastMarkers(bodies) {
  for (let i = bodies.length - 1; i >= 0; i--) {
    if (!isDriverReport(bodies[i])) continue;
    const all = [...String(bodies[i]).matchAll(HEAD_RE)];
    if (all.length) return { base: all[all.length - 1][1], state: decodeStateMarker(bodies[i]) };
  }
  return { base: '', state: null };
}

export function resolveScope(rt, { action, headSha, repo, pr, bodies }) {
  let scope = 'full';
  let base = '';
  let prior = null;
  if (action === 'synchronize') {
    const found = lastMarkers(bodies ?? fetchBotComments(rt, repo, pr));
    base = found.base;
    if (base && base !== headSha && commitExists(rt, base) && isAncestor(rt, base, headSha)) {
      scope = 'incremental';
      prior = found.state;
    }
  }
  return { scope, base: scope === 'incremental' ? base : '', prior };
}
