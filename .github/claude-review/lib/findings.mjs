/**
 * findings
 *
 * What: Validates agent output and folds it into the loop state: finding lifecycle, per-layer severity
 *       policy, requirement table, and fix results.
 * Why: The model proposes, the driver decides. Policies that the layer rules promise (hardening is never
 *      blocking, a blocking security finding needs an attack path, a blocking architecture finding needs a
 *      code location, unknown requirements never block) are enforced here
 *      instead of trusting the prompt.
 * Not covered: Scheduling (plan.mjs) and rendering (report.mjs).
 */
import { clamp, sanitizeText } from './util.mjs';

const SEVERITIES = new Set(['blocking', 'non_blocking']);
const REQ_STATUS = new Set(['met', 'unmet', 'unknown']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateReviewOutput(out, layer) {
  const errors = [];
  if (!isObj(out)) return ['output is not an object'];
  if (out.layer !== layer) errors.push(`layer is ${JSON.stringify(out.layer)}, expected ${layer}`);
  if (typeof out.completed !== 'boolean') errors.push('completed is missing');
  if (!Array.isArray(out.findings)) errors.push('findings is missing');
  else {
    out.findings.forEach((f, i) => {
      if (!isObj(f)) { errors.push(`findings[${i}] is not an object`); return; }
      if (typeof f.id !== 'string' || !f.id.trim()) errors.push(`findings[${i}].id is missing`);
      if (!SEVERITIES.has(f.severity)) errors.push(`findings[${i}].severity is invalid`);
      if (typeof f.title !== 'string' || !f.title.trim()) errors.push(`findings[${i}].title is missing`);
    });
  }
  if (out.requirements !== undefined) {
    if (!Array.isArray(out.requirements)) errors.push('requirements is not an array');
    else {
      out.requirements.forEach((r, i) => {
        if (!isObj(r) || typeof r.criterion !== 'string' || !REQ_STATUS.has(r.status)) errors.push(`requirements[${i}] is invalid`);
      });
    }
  }
  return errors;
}

export function validateFixOutput(out) {
  if (!isObj(out)) return ['output is not an object'];
  const errors = [];
  if (!Array.isArray(out.addressed) || out.addressed.some((x) => typeof x !== 'string')) errors.push('addressed is invalid');
  if (!Array.isArray(out.not_addressed) || out.not_addressed.some((x) => !isObj(x) || typeof x.id !== 'string')) errors.push('not_addressed is invalid');
  return errors;
}

function cleanPath(p) {
  const s = String(p ?? '').trim().replace(/^\.\//, '').replace(/^\/+/, '');
  return s.split('/').includes('..') ? '' : clamp(sanitizeText(s), 300);
}

function normalize(raw) {
  const line = Number.isInteger(raw.line) && raw.line > 0 ? raw.line : 0;
  return {
    severity: raw.severity,
    category: clamp(sanitizeText(raw.category || 'other'), 40),
    file: cleanPath(raw.file),
    line,
    title: clamp(sanitizeText(raw.title), 200),
    detail: clamp(sanitizeText(raw.detail), 2500),
    attack_path: clamp(sanitizeText(raw.attack_path), 1200),
    fix_hint: clamp(sanitizeText(raw.fix_hint), 1200),
  };
}

/** Layer rules the prompts promise, enforced after the fact. */
export function applyPolicy(layer, f, ctx = {}) {
  if (f.severity !== 'blocking') return f;
  const cat = f.category.toLowerCase();
  let reason = '';
  if (layer === 'L2') {
    if (cat === 'hardening') reason = 'hardening items are not blocking';
    else if (!String(f.attack_path ?? '').trim()) reason = 'a blocking security finding needs an attack_path (attacker, entry point, steps, impact)';
  }
  if (layer === 'L3') {
    const rulesChanged = ctx.rulesChanged || [];
    if (cat === 'preference') reason = 'preferences are not blocking';
    else if (!f.file || !(f.line > 0)) reason = 'a blocking architecture finding needs a code location (file and line) to fix';
    else if (rulesChanged.some((p) => `${f.title} ${f.detail}`.includes(p))) {
      reason = 'it depends on a rule document that this pull request changes, so a person should confirm';
    }
  }
  if (reason) {
    f.severity = 'non_blocking';
    f.detail = `${f.detail} (Downgraded to non-blocking: ${reason}.)`;
  }
  return f;
}

export const isOpenBlocking = (f) => f.severity === 'blocking' && f.status === 'open';
export const openBlocking = (layerState) => layerState.findings.filter(isOpenBlocking);

const sameFinding = (a, b) => a.file === b.file && a.title.toLowerCase() === b.title.toLowerCase();

export function nextId(state, layer) {
  state.counter[layer] = (state.counter[layer] || 0) + 1;
  return `${layer}-${state.counter[layer]}`;
}

/** Fold one completed review into the state. Returns the number of new blocking findings. */
export function applyReview(state, layer, out, head) {
  const L = state.layers[layer];
  const ctx = { rulesChanged: state.rules_docs_changed || [] };
  const prior = new Map(L.findings.map((f) => [f.id, f]));
  const mentioned = new Set();
  // Reviewer-chosen id (a prior id, or a placeholder such as new-1) -> the id the finding has in the state.
  const idMap = new Map();
  let added = 0;

  for (const raw of out.findings) {
    const p = prior.get(raw.id);
    if (p) {
      mentioned.add(p.id);
      idMap.set(raw.id, p.id);
      if (p.severity !== 'blocking' || p.status === 'resolved' || p.status === 'fixed') continue;
      if (raw.prior_status === 'resolved') {
        p.status = p.status === 'fixed_claimed' ? 'fixed' : 'resolved';
        p.note = '';
      } else {
        if (p.status === 'fixed_claimed') { p.reopened = (p.reopened || 0) + 1; p.last_fix_sha = p.fix_sha; p.fix_sha = ''; }
        p.status = 'open';
        const n = normalize({ ...raw, severity: 'blocking' });
        Object.assign(p, { detail: n.detail || p.detail, attack_path: n.attack_path || p.attack_path || '', fix_hint: n.fix_hint || p.fix_hint, line: n.line || p.line });
        p.note = '';
      }
      continue;
    }
    if (raw.prior_status) continue; // refers to a finding this run does not know
    const n = applyPolicy(layer, normalize(raw), ctx);
    const dup = L.findings.find((x) => sameFinding(x, n) && x.status !== 'resolved' && x.status !== 'fixed');
    if (dup) { idMap.set(raw.id, dup.id); continue; }
    const f = { ...n, id: nextId(state, layer), layer, status: 'open', introduced_head: head, fix_sha: '', note: '' };
    L.findings.push(f);
    idMap.set(raw.id, f.id);
    if (f.severity === 'blocking') added++;
  }

  // A prior finding the reviewer did not mention is not confirmed either way: keep it open.
  for (const p of L.findings) {
    if (p.severity !== 'blocking' || mentioned.has(p.id)) continue;
    if (p.status === 'fixed_claimed') {
      p.status = 'open';
      p.reopened = (p.reopened || 0) + 1;
      p.last_fix_sha = p.fix_sha;
      p.fix_sha = '';
      p.note = 'The re-review did not confirm the fix.';
    } else if (p.status === 'open' && prior.has(p.id)) {
      p.note = 'The re-review did not mention this finding, so it stays open.';
    }
  }

  if (layer === 'L1') added += applyRequirements(state, out.requirements || [], head, idMap);
  L.last_reviewed_sha = head;
  L.reviewed_head = head;
  L.review_passes += 1;
  return added;
}

const isLive = (f) => f.status !== 'resolved' && f.status !== 'fixed';

/**
 * Fold the requirement table into the layer. A criterion's finding_id is first mapped from the reviewer's
 * own id (often a placeholder such as new-1) to the id the driver gave the finding. Then:
 *   unmet   -> blocking. The linked finding is raised to blocking when needed; without a usable link
 *              the driver adds its own finding.
 *   unknown -> never blocking. A finding linked to it is lowered to non-blocking, unless an unmet
 *              criterion links to the same finding.
 * Returns the number of findings that became blocking here.
 */
function applyRequirements(state, reqs, head, idMap = new Map()) {
  const L = state.layers.L1;
  let added = 0;
  L.requirements = reqs.slice(0, 40).map((r) => {
    const raw = typeof r.finding_id === 'string' ? r.finding_id : '';
    return {
      criterion: clamp(sanitizeText(r.criterion), 300),
      status: r.status,
      evidence: clamp(sanitizeText(r.evidence), 600),
      finding_id: idMap.get(raw) ?? raw,
    };
  });
  const linkedOf = (r) => (r.finding_id ? L.findings.find((f) => f.id === r.finding_id) : undefined);
  const unmetIds = new Set(L.requirements.filter((r) => r.status === 'unmet').map((r) => r.finding_id).filter(Boolean));

  for (const r of L.requirements) {
    if (r.status !== 'unknown') continue;
    const linked = linkedOf(r);
    if (linked && linked.severity === 'blocking' && isLive(linked) && !unmetIds.has(linked.id)) {
      linked.severity = 'non_blocking';
      linked.detail = `${linked.detail} (Downgraded to non-blocking: it is linked to a requirement that could not be verified, and an unknown requirement never blocks.)`;
    }
  }

  for (const r of L.requirements) {
    if (r.status !== 'unmet') continue;
    const linked = linkedOf(r);
    // Only when the id did not map to a usable finding, match by title before adding a finding of our own.
    const target = linked && isLive(linked)
      ? linked
      : L.findings.find((f) => f.category === 'requirement' && f.title.includes(r.criterion.slice(0, 60)) && isLive(f));
    if (target) {
      r.finding_id = target.id;
      if (target.severity !== 'blocking') {
        target.severity = 'blocking';
        target.detail = `${target.detail} (Raised to blocking: it is linked to an unmet requirement.)`;
        added++;
      }
      continue;
    }
    const f = {
      id: nextId(state, 'L1'), layer: 'L1', severity: 'blocking', category: 'requirement',
      file: '', line: 0, title: clamp(`Requirement not met: ${r.criterion}`, 200),
      detail: r.evidence || 'The reviewer marked this criterion as unmet.', attack_path: '', fix_hint: '',
      status: 'open', introduced_head: head, fix_sha: '', note: '',
    };
    L.findings.push(f);
    r.finding_id = f.id;
    added++;
  }
  return added;
}

/** Fold one fix result into the state. `sha` is the new commit, or null when nothing changed. */
export function applyFix(state, layer, out, sha, round) {
  const L = state.layers[layer];
  const addressed = new Set(out ? out.addressed : []);
  const reasons = new Map((out ? out.not_addressed : []).map((x) => [x.id, clamp(sanitizeText(x.reason), 400)]));
  for (const f of L.findings) {
    if (!isOpenBlocking(f)) continue;
    f.fix_rounds = (f.fix_rounds || 0) + 1;
    if (sha && addressed.has(f.id)) {
      f.status = 'fixed_claimed';
      f.fix_sha = sha;
      f.fixed_round = round;
      f.note = '';
    } else if (reasons.has(f.id)) {
      f.note = reasons.get(f.id);
    } else if (!sha) {
      f.note = 'The fix attempt made no changes.';
    } else {
      f.note = 'The fix attempt did not list this finding as addressed.';
    }
  }
}
