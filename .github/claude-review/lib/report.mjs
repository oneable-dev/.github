/**
 * report
 *
 * What: Builds the summary comment, the step summary and the inline comments from the final state, and posts them.
 * Why: The comment is the pipeline's public output and its memory. Its last line is the head marker the next
 *      run reads, and a hidden state marker carries unresolved blocking findings to the next run.
 * Not covered: Deciding anything about the review. This only reports.
 */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { CONFLICT_REOPENS } from './findings.mjs';
import { changedFiles, isAncestor, oldestOf } from './gitops.mjs';
import { NO_PUSH_ROOM } from './state.mjs';
import { REPORT_HEADER, encodeStateMarker, headMarker } from './scope.mjs';
import { LAYERS, clamp, sanitizeText, shortSha } from './util.mjs';

export const LAYER_TITLES = {
  L0: 'L0 Checks (lint, format, types, tests)',
  L1: 'L1 Requirements and correctness',
  L2: 'L2 Security',
  L3: 'L3 Architecture',
};
const MAX_BODY = 60000;
const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

export function fingerprint(f) {
  return createHash('sha1').update(`${f.layer}|${f.file}|${f.line}|${f.title}`).digest('hex').slice(0, 12);
}

export function statusText(f) {
  if (f.severity !== 'blocking') return 'non-blocking';
  if (f.status === 'open') return 'unresolved';
  if (f.status === 'fixed_claimed') return `fixed in ${code(shortSha(f.fix_sha))} (not re-verified)`;
  if (f.status === 'fixed') return `fixed in ${code(shortSha(f.fix_sha))}`;
  return 'resolved without a fix';
}

export const location = (f) => (f.file ? code(f.line ? `${f.file}:${f.line}` : f.file) : '-');

export function allFindings(state) {
  return LAYERS.flatMap((l) => state.layers[l].findings);
}

export function unresolvedBlocking(state) {
  return allFindings(state).filter((f) => f.severity === 'blocking' && f.status === 'open');
}

/** Why a layer has no complete review at the final head, or '' when it has one. */
export function incompleteReason(state, layer) {
  const L = state.layers[layer];
  if (L.reviewed_head === state.head) return '';
  if ((L.attempts[state.head] || 0) >= 2) return `the review failed twice (${L.errors.slice(-1)[0] || 'no usable result'})`;
  const reason = state.stop ? state.stop.reason : stopReasonOf(state);
  if (reason === 'push') return pushFailedByBudget(state) ? 'the run stopped because there was no room left to push a fix commit' : 'the run stopped after a push slot failed';
  const why = {
    time: 'not enough job time was left',
    slots: 'the agent step budget was used up',
    'app-skip': 'the review was skipped for this pull request',
  }[reason] || 'the run stopped before this review';
  return why;
}

/** True when a fix commit stayed unpushed because no push slot could be started (not because a push slot failed). */
function pushFailedByBudget(state) {
  return Boolean(state.stop && state.stop.reason === 'push' && state.stop.detail === NO_PUSH_ROOM);
}

function stopReasonOf(state) {
  return state.done_reason && state.done_reason !== 'complete' ? state.done_reason : '';
}

/** The head recorded in the final marker: the newest commit every layer has reviewed, and that exists on GitHub. */
export function markerHead(rt, state) {
  const shas = LAYERS.map((l) => state.layers[l].last_reviewed_sha);
  if (shas.some((s) => !s)) return state.scope_base || '';
  let m = oldestOf(rt, shas, state.scope_base || '');
  if (m && state.pushed_head && !isAncestor(rt, m, state.pushed_head)) m = state.pushed_head;
  return m;
}

function attentionReasons(state) {
  const r = [];
  const n = unresolvedBlocking(state).length;
  if (n) r.push(`${n} blocking finding${n === 1 ? ' is' : 's are'} unresolved`);
  if (state.l0.status === 'fail') r.push('the L0 checks still fail');
  // A skipped review (the caller workflow changed) is expected, so it does not call for a person by itself.
  if (!state.app_skip) for (const l of LAYERS) if (incompleteReason(state, l)) r.push(`${l} has no complete review`);
  if (state.stop && state.stop.reason === 'push') r.push(pushFailedByBudget(state) ? 'a fix commit could not be pushed: not enough job time or agent steps were left' : 'a fix commit could not be pushed');
  if (state.fatal) r.push('the driver stopped on an error');
  if (state.l0.capped || LAYERS.some((l) => state.layers[l].capped)) r.push('a fix limit was reached');
  if (LAYERS.some((l) => state.layers[l].conflict)) r.push('fixes from different layers kept undoing each other');
  return r;
}

/** Which finding was reopened twice after another layer's fix, for the Notes. */
function conflictNote(state, layer) {
  const L = state.layers[layer];
  const f = L && L.findings.find((x) => x.severity === 'blocking' && x.status === 'open' && x.conflict && (x.cross_reopens || 0) >= CONFLICT_REOPENS);
  const what = f
    ? `${f.id} was reopened twice after fixes from ${f.conflict.layer} (${shortSha(f.conflict.sha)}) changed the same files`
    : 'a finding was reopened twice after fixes from another layer changed the same files';
  return `Fixing stopped at ${layer}: ${what}. Later layers were reviewed once without fixes.`;
}

function resultLine(state) {
  const all = allFindings(state).filter((f) => f.severity === 'blocking');
  const open = all.filter((f) => f.status === 'open').length;
  const fixed = all.filter((f) => f.status === 'fixed' || f.status === 'fixed_claimed').length;
  const incomplete = state.app_skip ? [] : LAYERS.filter((l) => incompleteReason(state, l));
  const bits = [];
  if (state.app_skip) bits.push('review skipped (see Notes)');
  if (open) bits.push(`${open} blocking unresolved`);
  if (fixed) bits.push(`${fixed} blocking fixed by ${state.commits.length} commit${state.commits.length === 1 ? '' : 's'}`);
  if (incomplete.length) bits.push(`review incomplete for ${incomplete.join(', ')}`);
  if (state.l0.status === 'fail') bits.push('L0 checks failing');
  if (!bits.length) return 'No blocking findings.';
  return bits.join('; ') + '.';
}

function l0Section(state, level) {
  const l0 = state.l0;
  const lines = [`### ${LAYER_TITLES.L0}`, ''];
  if (l0.status === 'skipped') lines.push(`Skipped: ${l0.skipped_reason || 'no check commands configured'}.`);
  else if (l0.status === 'unrun') lines.push('Not run.');
  else lines.push(`Status at ${code(shortSha(l0.ran_head))}: **${l0.status}**${l0.skipped_reason && l0.status !== 'pass' ? ` (${l0.skipped_reason})` : ''}.`);
  const fixes = l0.history.filter((h) => h.kind === 'autofix').map((h) => `fix command commit ${code(shortSha(h.sha))}${h.pushed ? '' : ' (not pushed)'}`);
  const agent = state.commits.filter((c) => c.layer === 'L0').map((c) => `agent fix ${code(shortSha(c.sha))} (round ${c.round})${c.pushed ? '' : ' (not pushed)'}`);
  if (fixes.length || agent.length) lines.push('', `Fixes: ${[...fixes, ...agent].join(', ')}.`);
  if (l0.capped) lines.push('', `Fix limit reached (${state.config.max_fix_rounds} agent rounds).`);
  if (level < 2) {
    for (const f of l0.failures) {
      lines.push('', `- ${code(f.command)}: ${f.skipped ? 'not run' : f.timed_out ? 'timed out' : `exit code ${f.exit_code}`}`);
      if (level === 0 && f.tail && !f.skipped) {
        lines.push('', '  ```text', ...f.tail.split('\n').slice(-25).map((x) => `  ${x.replace(/```/g, "'''")}`), '  ```');
      }
    }
  }
  return lines;
}

function layerSection(state, layer, level, inlined) {
  const L = state.layers[layer];
  const lines = [`### ${LAYER_TITLES[layer]}`, ''];
  const why = incompleteReason(state, layer);
  if (state.app_skip && L.reviewed_head !== state.head) lines.push('**Review skipped.** The Claude GitHub App could not review this pull request (see Notes).');
  else if (L.reviewed_head === state.head) lines.push(`Reviewed at ${code(shortSha(state.head))}${L.review_passes > 1 ? ` after ${L.review_passes} passes` : ''}.`);
  else if (L.last_reviewed_sha && L.review_passes) lines.push(`**Review incomplete.** Last completed at ${code(shortSha(L.last_reviewed_sha))}; ${why}.`);
  else lines.push(`**Review incomplete.** ${why || 'No review completed.'}`);
  if (L.capped) lines.push('', `Fix limit reached (${state.config.max_fix_rounds} rounds).`);
  if (L.conflict) lines.push('', 'Fixing stopped: fixes from different layers kept undoing each other.');

  if (layer === 'L1' && L.requirements.length && level < 2) {
    lines.push('', 'Acceptance criteria:', '', '| Criterion | Status | Evidence |', '| --- | --- | --- |');
    for (const r of L.requirements) lines.push(`| ${mdCell(r.criterion)} | ${r.status} | ${mdCell(r.evidence)}${r.finding_id ? ` (${r.finding_id})` : ''} |`);
  } else if (layer === 'L1' && !state.has_requirements) {
    lines.push('', 'No requirements found in the pull request description or linked issues; correctness only.');
  }

  const items = L.findings;
  if (items.length) {
    lines.push('', '| ID | Status | Location | Finding |', '| --- | --- | --- | --- |');
    for (const f of items) lines.push(`| ${f.id} | ${statusText(f)} | ${location(f)} | ${mdCell(f.title)} |`);
    if (level === 0) {
      for (const f of items.filter((x) => x.severity === 'blocking' && x.status === 'open' && !inlined.has(x.id))) {
        lines.push('', `**${f.id}** ${mdCell(f.title)}`, '', f.detail, ...(f.attack_path ? ['', `Attack path: ${f.attack_path}`] : []), ...(f.fix_hint ? ['', `Fix: ${f.fix_hint}`] : []), ...(f.note ? ['', `Note: ${f.note}`] : []));
      }
    }
  } else if (L.reviewed_head === state.head) {
    lines.push('', 'No findings.');
  }
  return lines;
}

function statePayload(state, head, level) {
  const unresolved = unresolvedBlocking(state).map((f) => ({
    id: f.id, layer: f.layer, category: f.category, file: f.file, line: f.line, title: f.title,
    detail: clamp(f.detail, level ? 300 : 700), attack_path: clamp(f.attack_path || '', level ? 200 : 500), fix_hint: clamp(f.fix_hint, level ? 100 : 300),
  }));
  const requirements = state.layers.L1.requirements.map((r) => ({
    criterion: clamp(r.criterion, 200), status: r.status, evidence: clamp(r.evidence, level ? 100 : 250), finding_id: r.finding_id,
  }));
  return { v: 1, head, unresolved, requirements };
}

export function buildReport(rt, state, inlined = new Set()) {
  const head = markerHead(rt, state);
  const reasons = attentionReasons(state);
  const mention = state.assignee && reasons.length ? `@${state.assignee} this pull request needs a person to look at it: ${reasons.join('; ')}.` : '';
  const build = (level) => {
    const lines = [REPORT_HEADER, '', `**Result:** ${resultLine(state)}`, ''];
    const scope = state.scope === 'incremental' ? `incremental, since ${code(shortSha(state.scope_base))}` : 'full';
    lines.push(`Scope: ${scope}. Head: ${code(shortSha(state.head))}.${state.bot_trigger ? ' Triggered by a bot, so this was a review only: no checks and no fixes.' : ''}`);
    if (state.commits.length) {
      lines.push('', 'Fix commits:');
      for (const c of state.commits) lines.push(`- ${code(shortSha(c.sha))} ${mdCell(c.subject)}${c.ids.length ? ` (${c.ids.join(', ')})` : ''}${c.pushed ? '' : ' (not pushed)'}`);
    }
    lines.push('', ...l0Section(state, level));
    for (const l of LAYERS) lines.push('', ...layerSection(state, l, level, inlined));
    const notes = [...state.notes];
    if (pushFailedByBudget(state)) notes.push(`A fix commit was made but not pushed: ${NO_PUSH_ROOM}.`);
    else if (state.stop && state.stop.reason === 'push') notes.push(`The push slot did not put the fix commit on the branch, so it is not there: ${state.stop.detail || 'unknown reason'}. Another push may have landed in the meantime.`);
    if (state.fatal) notes.push(`The driver stopped on an error: ${state.fatal}`);
    if (state.fixes_disabled && state.fixes_disabled.startsWith('cap:')) notes.push(`Fixing stopped at ${state.fixes_disabled.slice(4)}: the fix limit was reached. Later layers were reviewed once without fixes.`);
    if (state.fixes_disabled && state.fixes_disabled.startsWith('conflict:')) notes.push(conflictNote(state, state.fixes_disabled.slice(9)));
    if (state.fixes_disabled === 'disabled') notes.push('Fixes disabled: automatic fixes are turned off for this workflow (enable_fix is false), so blocking findings are only reported.');
    if (state.fixes_disabled === 'slots') notes.push('Fixing stopped because the agent step budget was nearly used up.');
    if (state.fixes_disabled === 'time') notes.push('Fixing stopped because the job time budget was nearly used up.');
    if (inlined.failed && inlined.failed.size) notes.push(`${inlined.failed.size} inline comment${inlined.failed.size === 1 ? '' : 's'} could not be placed on the diff; their details are in the sections above.`);
    if (notes.length) lines.push('', '### Notes', '', ...notes.map((n) => `- ${sanitizeText(n)}`));
    if (mention) lines.push('', mention);
    const visible = lines.join('\n');
    const hidden = [encodeStateMarker(statePayload(state, head, level)), ...(head ? [headMarker(head)] : [])].join('\n');
    return { visible, body: `${visible}\n\n${hidden}\n`, head };
  };
  for (const level of [0, 1, 2]) {
    const r = build(level);
    if (r.body.length <= MAX_BODY) return r;
  }
  return build(2);
}

/** Post one inline comment per unresolved blocking finding. Returns the ids placed and the ids that failed. */
export function postInline(rt, state) {
  const placed = new Set();
  const failed = new Set();
  const commit = state.pushed_head;
  const files = new Set(changedFiles(rt, state.pr_base_sha, commit, true));
  const existing = [];
  const r = rt.gh(['api', '--paginate', `repos/${state.repo}/pulls/${state.pr}/comments`,
    '--jq', '.[] | select(.user.login == "github-actions[bot]") | {body, position} | @json'], { check: false });
  if (r.status === 0) for (const line of r.stdout.split('\n')) { try { existing.push(JSON.parse(line)); } catch { /* skip */ } }
  for (const f of unresolvedBlocking(state)) {
    if (!f.file || !f.line || !files.has(f.file)) continue; // lives in the summary only
    const fp = fingerprint(f);
    if (existing.some((e) => e.position !== null && String(e.body).includes(`claude-review:finding=${fp}`))) { placed.add(f.id); continue; }
    const body = [
      `**${f.layer} ${f.id}, blocking:** ${f.title}`, '', f.detail, ...(f.attack_path ? ['', `Attack path: ${f.attack_path}`] : []), ...(f.fix_hint ? ['', `Suggested fix: ${f.fix_hint}`] : []),
      '', `<!-- claude-review:finding=${fp} -->`,
    ].join('\n');
    const res = rt.gh(['api', '-X', 'POST', `repos/${state.repo}/pulls/${state.pr}/comments`, '--input', '-'], {
      input: JSON.stringify({ body, commit_id: commit, path: f.file, line: f.line, side: 'RIGHT' }), check: false,
    });
    if (res.status === 0) placed.add(f.id); else failed.add(f.id);
  }
  placed.failed = failed;
  return placed;
}

export function postSummary(rt, state, body) {
  const r = rt.gh(['api', '-X', 'POST', `repos/${state.repo}/issues/${state.pr}/comments`, '--input', '-'], {
    input: JSON.stringify({ body }), check: false,
  });
  if (r.status !== 0) throw new Error(`could not post the summary comment: ${r.stderr.trim().slice(0, 300)}`);
}

export function writeStepSummary(rt, visible) {
  if (!rt.env.GITHUB_STEP_SUMMARY) return;
  try { appendFileSync(rt.env.GITHUB_STEP_SUMMARY, `${visible}\n`); } catch { /* best effort */ }
}
