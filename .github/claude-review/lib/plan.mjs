/**
 * plan
 *
 * What: Decides the next step of the loop from the state alone: push a fix commit, run L0, run a review,
 *       run a fix, or stop.
 * Why: The loop order is the core of the pipeline, so it is a pure function that tests can drive.
 *      A fix (fix_command or a fix agent) only commits locally and sets `state.push_pending`. The next decision
 *      is always the push slot, because the driver has no write token. Only after the push is verified does
 *      the cycle start over from L0, then L1, L2, L3, stopping at the first layer with a blocking finding to
 *      fix it; the layers re-review only what changed.
 *      A layer at its fix limit, or whose open finding was reopened twice after fixes of other layers changed the
 *      same files (or any fix-free condition) turns on `fixes_disabled`: the layers after it
 *      are reviewed once without fixes, then the run stops.
 * Not covered: Running anything (driver.mjs).
 */
import { CONFLICT_REOPENS, openBlocking } from './findings.mjs';
import { LAYERS } from './util.mjs';
import { MAX_SLOTS, MIN_SECONDS_FOR_AGENT, MIN_SECONDS_FOR_FIX, MIN_SECONDS_FOR_PUSH, NO_PUSH_ROOM } from './state.mjs';

/** A fix is only worth starting when its push slot and a complete re-review (3 layers) can still follow it. */
const SLOTS_FOR_FIX = 5;

export function secondsLeft(state, nowMs) {
  return state.timeout_minutes * 60 - (nowMs / 1000 - state.started_at);
}

/** Whether a push slot can still be started: one slot and enough job time for its timeout. */
export function pushRoom(state, nowMs) {
  return MAX_SLOTS - state.slots_used >= 1 && secondsLeft(state, nowMs) >= MIN_SECONDS_FOR_PUSH;
}

/**
 * Returns {type: 'done', reason} | {type: 'push'} | {type: 'l0'} | {type: 'review', layer} | {type: 'fix', layer}.
 * Mutates `state` only to record why fixes were turned off or why a pending push could not run.
 */
export function decide(state, nowMs) {
  const cfg = state.config;
  if (state.stop) return { type: 'done', reason: state.stop.reason };

  // A local fix commit must reach the branch before anything else runs on top of it.
  if (state.push_pending) {
    if (pushRoom(state, nowMs)) return { type: 'push' };
    state.stop = { reason: 'push', detail: NO_PUSH_ROOM };
    return { type: 'done', reason: 'push' };
  }

  const left = secondsLeft(state, nowMs);
  const timeOk = left >= MIN_SECONDS_FOR_AGENT;
  const slotsLeft = MAX_SLOTS - state.slots_used;
  const canSpawn = timeOk && slotsLeft >= 1;
  const canFix = canSpawn && slotsLeft >= SLOTS_FOR_FIX && left >= MIN_SECONDS_FOR_FIX;
  const head = state.head;

  const disableFixes = (why) => { if (!state.fixes_disabled) state.fixes_disabled = why; };
  const noFixWhy = () => (timeOk && slotsLeft < SLOTS_FOR_FIX ? 'slots' : 'time');
  const fixesOff = () => Boolean(state.fixes_disabled);

  // L0: deterministic gate.
  const l0 = state.l0;
  if (l0.status !== 'skipped') {
    if (l0.ran_head !== head) {
      if (!timeOk) {
        l0.status = 'incomplete';
        l0.skipped_reason = 'not enough job time left to run the checks';
      } else {
        return { type: 'l0' };
      }
    }
    if (l0.status === 'fail') {
      if (fixesOff()) {
        // No fix will happen; still review.
      } else if (l0.fixes >= cfg.max_fix_rounds) {
        l0.capped = true;
        disableFixes('cap:L0');
      } else if (!canFix) {
        disableFixes(noFixWhy());
      } else {
        return { type: 'fix', layer: 'L0' };
      }
    }
  }

  // The workflow file of this pull request changed, so the Claude GitHub App gets no token: no agent runs.
  if (state.app_skip) return { type: 'done', reason: 'app-skip' };

  for (const layer of LAYERS) {
    const L = state.layers[layer];
    const handled = L.reviewed_head === head || (L.attempts[head] || 0) >= 2;
    if (!handled) {
      if (!canSpawn) return { type: 'done', reason: timeOk ? 'slots' : 'time' };
      return { type: 'review', layer };
    }
    if (L.reviewed_head !== head) continue; // review failed twice; reported as incomplete
    if (openBlocking(L).length === 0 || fixesOff()) continue;
    // Fixes from different layers keep undoing each other: more rounds only repeat that.
    if (openBlocking(L).some((f) => (f.cross_reopens || 0) >= CONFLICT_REOPENS)) {
      L.conflict = true;
      disableFixes(`conflict:${layer}`);
      continue;
    }
    if (L.fixes >= cfg.max_fix_rounds) {
      L.capped = true;
      disableFixes(`cap:${layer}`);
      continue;
    }
    if (!canFix) {
      disableFixes(noFixWhy());
      continue;
    }
    return { type: 'fix', layer };
  }
  return { type: 'done', reason: 'complete' };
}
